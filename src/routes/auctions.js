const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const Auction = require('../models/Auction');
const Bid = require('../models/Bid');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { getBidCountMap, mapAuction, normalizeAuctionDescription, pushNotification, attachAuctionMedia } = require('../utils/auctionHelpers');
const { closeAuction } = require('../services/auctionScheduler');
const { broadcastAuction, broadcastGlobalActivity } = require('../services/websocket');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

router.get('/', async (req, res) => {
    try {
        const query = {};
        const now = new Date();
        const status = String(req.query.status || '').trim();
        if (status) {
            query.status = status;
        } else {
            query.status = 'active';
            query.endTime = { $gt: now };
        }
        if (status === 'active' && !query.endTime) {
            query.endTime = { $gt: now };
        }
        if (req.query.campus) {
            query.$or = [
                { sellerCollege: req.query.campus },
                { campus: req.query.campus }
            ];
        }

        const sortField = String(req.query.sort || 'endTime');
        const sortMap = {
            endtime: 'endTime',
            endingsoon: 'endTime',
            endTime: 'endTime',
            createdat: 'createdAt',
            price: 'currentBid',
            currentbid: 'currentBid',
            title: 'title'
        };
        const sortKey = sortMap[sortField] || sortMap[sortField.toLowerCase()] || 'endTime';
        const order = String(req.query.order || '').toLowerCase() === 'desc' ? -1 : 1;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 50);

        let cursor = Auction.find(query).sort({ [sortKey]: order, _id: 1 });
        if (limit) cursor = cursor.limit(limit);
        const rows = await cursor;
        const bidCountMap = await getBidCountMap(rows.map(r => r._id));
        res.json(await Promise.all(rows.map(r => mapAuction(r, bidCountMap))));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/price-suggestions', async (req, res) => {
    try {
        const category = String(req.query.category || '').trim();
        const title = String(req.query.title || '').trim();
        const match = { status: 'closed', winningBid: { $gt: 0 } };
        if (category) match.category = category;
        if (title) {
            match.title = { $regex: title.split(/\s+/).slice(0, 2).join('|'), $options: 'i' };
        }
        const rows = await Auction.find(match).sort({ createdAt: -1 }).limit(12).select('winningBid category title');
        if (!rows.length) return res.json({ min: 0, max: 0, sampleSize: 0 });
        const bids = rows.map((row) => Number(row.winningBid || 0)).filter(Boolean).sort((a, b) => a - b);
        res.json({
            min: bids[0] || 0,
            max: bids[bids.length - 1] || 0,
            average: Math.round(bids.reduce((sum, value) => sum + value, 0) / bids.length),
            sampleSize: bids.length
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/closed', async (req, res) => {
    try {
        const rows = await Auction.find({ status: 'closed' }).sort({ createdAt: -1 });
        res.json(await Promise.all(rows.map(mapAuction)));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/bid-wars', async (req, res) => {
    try {
        const rows = await Auction.find({ status: 'active', endTime: { $gt: new Date() } }).sort({ bidCount: -1, endTime: 1 }).limit(20);
        const bidCountMap = await getBidCountMap(rows.map(r => r._id));
        res.json(await Promise.all(rows.map(r => mapAuction(r, bidCountMap))));
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ message: 'Not found' });
        Auction.updateOne({ _id: row._id }, { $inc: { viewCount: 1 } }).catch(() => null);
        res.json(await mapAuction(row));
    } catch (e) { res.status(404).json({ message: 'Not found' }); }
});

router.get('/:id/winner', async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ message: 'Not found' });
        if (!row.winnerEmail) return res.json({ noBids: true });
        return res.json({ email: row.winnerEmail, name: row.winnerName, winningBid: row.winningBid });
    } catch (e) {
        res.status(404).json({ message: 'Not found' });
    }
});

router.get('/:id/winner-summary', requireLogin, async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Auction not found' });
        if (row.status !== 'closed' || !row.winnerEmail) return res.status(400).json({ error: 'Auction is not closed with a winner' });
        if (req.user.email !== row.winnerEmail && req.user.email !== row.sellerEmail && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const seller = await User.findOne({ email: row.sellerEmail }).select('fullname trustScore college');
        const winner = await User.findOne({ email: row.winnerEmail }).select('fullname trustScore college');
        res.json({
            auction: await mapAuction(row),
            seller: seller ? { email: seller.email, name: seller.fullname, trustScore: seller.trustScore, college: seller.college } : null,
            winner: winner ? { email: winner.email, name: winner.fullname, trustScore: winner.trustScore, college: winner.college } : null,
            isWinner: req.user.email === row.winnerEmail,
            isSeller: req.user.email === row.sellerEmail
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/sell', requireLogin, upload.fields([
    { name: 'images', maxCount: 6 }, { name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }
]), async (req, res) => {
    try {
        const { title, price, reservePrice, description, endTime, category, increment } = req.body;
        const specifications = req.body.specifications ? JSON.parse(req.body.specifications) : {};
        const checklist = req.body.checklist ? JSON.parse(req.body.checklist) : {};
        const startingPrice = parseInt(price, 10) || 0;
        const parsedIncrement = parseInt(increment, 10);
        const computedIncrement = Number.isFinite(parsedIncrement) && parsedIncrement > 0
            ? parsedIncrement
            : Math.max(1, Math.round(startingPrice * 0.02));

        let endTimeObj = endTime ? new Date(endTime) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        if (endTimeObj <= new Date()) return res.status(400).send('Auction end time must be in the future.');

        const newAuction = await Auction.create({
            title,
            description: normalizeAuctionDescription(description),
            currentBid: startingPrice,
            startingPrice,
            reservePrice: parseInt(reservePrice) || 0,
            increment: computedIncrement,
            category,
            verified: false,
            sellerEmail: req.user.email,
            sellerName: req.user.name,
            endTime: endTimeObj,
            status: 'pending_review',
            specifications,
            submissionChecklist: {
                authenticityStatement: Boolean(checklist.authenticityStatement),
                ownershipConfirmed: Boolean(checklist.ownershipConfirmed),
                mediaQualityConfirmed: Boolean(checklist.mediaQualityConfirmed),
                orientationConfirmed: Boolean(checklist.orientationConfirmed),
                termsAccepted: Boolean(checklist.termsAccepted)
            }
        });

        await attachAuctionMedia(newAuction, req.files || {});

        await pushNotification(req.user.email, {
            type: 'sell_request_submitted',
            title: 'Listing submitted',
            message: `"${title}" was submitted for review.`,
            actionUrl: '/my-products.html',
            metadata: { auctionId: newAuction._id.toString() }
        });

        await AuditLog.create({
            action: 'SELL_REQUEST_CREATED', userEmail: req.user.email,
            details: `Created sell request: ${title} (${newAuction._id})`, ipAddress: req.ip
        });

        res.json({ success: true, auctionId: newAuction._id });
    } catch (err) {
        console.error('Sell error:', err);
        res.status(500).send('Error listing the item.');
    }
});

router.post('/:id/relist', requireLogin, async (req, res) => {
    try {
        const source = await Auction.findById(req.params.id);
        if (!source) return res.status(404).json({ error: 'Listing not found' });
        if (source.sellerEmail !== req.user.email && !req.user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
        const relisted = await Auction.create({
            title: source.title,
            description: source.description,
            currentBid: source.startingPrice || source.currentBid || 0,
            startingPrice: source.startingPrice || source.currentBid || 0,
            reservePrice: source.reservePrice || 0,
            increment: source.increment || 1,
            images: source.images || [],
            image: source.image || null,
            video: source.video || null,
            videoUrl: source.videoUrl || null,
            sellerEmail: source.sellerEmail,
            sellerName: source.sellerName,
            endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            status: 'pending_review',
            category: source.category,
            specifications: source.specifications || {},
            mediaIds: source.mediaIds || []
        });
        res.json({ success: true, auctionId: relisted._id });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/meetup', requireLogin, async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Auction not found' });
        if (row.status !== 'closed' || !row.winnerEmail) return res.status(400).json({ error: 'Meetup scheduling is only available after a completed auction.' });
        if (req.user.email !== row.winnerEmail && req.user.email !== row.sellerEmail) return res.status(403).json({ error: 'Forbidden' });
        row.meetupSchedule = {
            slotLabel: String(req.body.slotLabel || '').trim(),
            notes: String(req.body.notes || '').trim(),
            scheduledByEmail: req.user.email,
            scheduledAt: new Date()
        };
        await row.save();
        const otherParty = req.user.email === row.winnerEmail ? row.sellerEmail : row.winnerEmail;
        await pushNotification(otherParty, {
            type: 'meetup_scheduled',
            title: 'Meetup scheduled',
            message: `${req.user.name} scheduled a meetup for "${row.title}"`,
            actionUrl: `/chat.html?auction=${row._id}&with=${encodeURIComponent(otherParty)}`,
            metadata: { auctionId: row._id.toString(), slotLabel: row.meetupSchedule.slotLabel }
        });
        res.json({ success: true, meetupSchedule: row.meetupSchedule });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/delivery-checklist', requireLogin, async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Auction not found' });
        if (req.user.email !== row.winnerEmail && req.user.email !== row.sellerEmail) return res.status(403).json({ error: 'Forbidden' });
        row.deliveryChecklist = {
            itemMatchedDescription: Boolean(req.body.itemMatchedDescription),
            meetupCompleted: Boolean(req.body.meetupCompleted),
            paymentCompleted: Boolean(req.body.paymentCompleted),
            markedReceivedBy: req.user.email,
            markedReceivedAt: new Date()
        };
        await row.save();
        res.json({ success: true, deliveryChecklist: row.deliveryChecklist });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/review', requireLogin, async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Auction not found' });
        if (row.status !== 'closed' || !row.winnerEmail) return res.status(400).json({ error: 'Review not allowed.' });
        const rating = Math.max(1, Math.min(5, Number(req.body.rating || 0)));
        if (!rating) return res.status(400).json({ error: 'Rating is required.' });
        const comment = String(req.body.comment || '').trim().slice(0, 500);
        let targetEmail = '';

        if (req.user.email === row.winnerEmail) {
            row.buyerReview = { rating, comment, reviewerEmail: req.user.email, createdAt: new Date() };
            targetEmail = row.sellerEmail;
        } else if (req.user.email === row.sellerEmail) {
            row.sellerReview = { rating, comment, reviewerEmail: req.user.email, createdAt: new Date() };
            targetEmail = row.winnerEmail;
        } else {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await row.save();
        const target = await User.findOne({ email: targetEmail });
        if (target) {
            const currentRatings = Array.isArray(target.ratings) ? target.ratings : [];
            currentRatings.push({ score: rating, comment, raterId: req.user.id });
            target.ratings = currentRatings;
            const average = currentRatings.reduce((sum, entry) => sum + Number(entry.score || 0), 0) / currentRatings.length;
            target.trustScore = Math.max(0, Math.min(500, Math.round(average * 20)));
            await target.save();
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id/receipt', requireLogin, async (req, res) => {
    try {
        const row = await Auction.findById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Auction not found' });
        if (req.user.email !== row.winnerEmail && req.user.email !== row.sellerEmail && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        res.json({
            receiptNumber: `GVL-${String(row._id).slice(-6).toUpperCase()}`,
            issuedAt: new Date().toISOString(),
            title: row.title,
            amount: row.winningBid || row.currentBid || 0,
            sellerEmail: row.sellerEmail,
            buyerEmail: row.winnerEmail,
            meetupSchedule: row.meetupSchedule || {},
            deliveryChecklist: row.deliveryChecklist || {}
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/end-auction', requireLogin, async (req, res) => {
    const { id } = req.body;
    try {
        const item = await Auction.findById(id);
        if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });
        if (item.status === 'closed') return res.status(400).json({ success: false, message: 'Already closed.' });
        if (item.sellerEmail !== req.user.email && !req.user.isAdmin)
            return res.status(403).json({ success: false, message: 'Only the seller can end this auction.' });
        await closeAuction(id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Error' }); }
});

router.post('/remove-item', requireLogin, async (req, res) => {
    const { id } = req.body;
    try {
        const item = await Auction.findById(id);
        if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });
        if (item.sellerEmail !== req.user.email && !req.user.isAdmin)
            return res.status(403).json({ success: false, message: 'You can only remove your own listings.' });
        const bidCount = await Bid.countDocuments({ auctionId: item._id });
        if (bidCount > 0 && !req.user.isAdmin)
            return res.status(400).json({ success: false, message: 'Cannot withdraw a lot that already has bids.' });
        await Auction.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Error' }); }
});

module.exports = router;
