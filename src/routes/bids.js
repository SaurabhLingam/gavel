const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { bidLimiter } = require('../middleware/rateLimiter');
const Auction = require('../models/Auction');
const Bid = require('../models/Bid');
const User = require('../models/User');
const AutoBid = require('../models/AutoBid');
const SnipeLog = require('../models/SnipeLog');
const AuditLog = require('../models/AuditLog');
const { pushNotification } = require('../utils/auctionHelpers');
const { broadcastAuction, broadcastGlobalActivity, trackBidActivity } = require('../services/websocket');

async function createBidRecord({ auctionId, bidderEmail, bidderName, amount, triggeredSnipe = false, session }) {
    const [newBid] = await Bid.create([{
        auctionId,
        bidderEmail,
        bidderName,
        amount,
        triggeredSnipe
    }], { session });
    return newBid;
}

async function settlePreviousLeader({ auction, previousLeaderEmail, previousLeaderAmount, nextAmount, session }) {
    if (!previousLeaderEmail) return;
    const prevUser = await User.findOne({ email: previousLeaderEmail }).session(session);
    if (!prevUser) return;
    prevUser.walletBalance = Number(prevUser.walletBalance || 0) + Number(previousLeaderAmount || 0);
    await prevUser.save({ session });
    await pushNotification(previousLeaderEmail, {
        type: 'outbid',
        title: 'You have been outbid',
        message: `Someone bid ₹${Number(nextAmount || 0).toLocaleString('en-IN')} on "${auction.title}"`,
        actionUrl: `/item-detail.html?id=${auction._id}`,
        metadata: { auctionId: auction._id.toString() }
    });
}

async function applyBidToAuction({ auction, bidderEmail, bidderName, amount, session, source = 'manual' }) {
    const numericAmount = Number(amount);
    const latestBid = await Bid.findOne({ auctionId: auction._id }).sort({ placedAt: -1, _id: -1 }).session(session);
    const previousLeaderEmail = latestBid ? latestBid.bidderEmail : null;
    const previousLeaderAmount = latestBid ? Number(latestBid.amount || 0) : 0;
    const sameLeader = previousLeaderEmail === bidderEmail;
    const holdRequired = sameLeader ? Math.max(0, numericAmount - previousLeaderAmount) : numericAmount;

    const bidder = await User.findOne({ email: bidderEmail }).session(session);
    if (!bidder || Number(bidder.walletBalance || 0) < holdRequired) {
        return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
    }

    if (!sameLeader) {
        await settlePreviousLeader({ auction, previousLeaderEmail, previousLeaderAmount, nextAmount: numericAmount, session });
    }

    bidder.walletBalance = Number(bidder.walletBalance || 0) - holdRequired;
    await bidder.save({ session });

    const newBid = await createBidRecord({ auctionId: auction._id, bidderEmail, bidderName, amount: numericAmount, session });
    auction.currentBid = numericAmount;
    auction.bidCount = (auction.bidCount || 0) + 1;
    await auction.save({ session });

    return {
        ok: true,
        bid: newBid,
        previousLeaderEmail,
        previousLeaderAmount,
        source
    };
}

async function resolveAutoBidsTransaction({ auctionId, triggerBidderEmail = null, session }) {
    const auction = await Auction.findById(auctionId).session(session);
    if (!auction || auction.status !== 'active') return { resolved: false, auction };

    const currentBid = Number(auction.currentBid || 0);
    const increment = Math.max(1, Number(auction.increment || 1));
    const activeAutoBids = await AutoBid.find({
        auctionId,
        active: true,
        maxAmount: { $gt: currentBid }
    }).sort({ maxAmount: -1, createdAt: 1, _id: 1 }).session(session);

    if (!activeAutoBids.length) return { resolved: false, auction };

    const eligible = activeAutoBids.filter((entry) => entry.bidderEmail !== triggerBidderEmail || activeAutoBids.length > 1);
    if (!eligible.length) return { resolved: false, auction };

    const top = eligible[0];
    const second = eligible[1] || null;
    let winningAmount = Math.max(currentBid + increment, 0);
    let outbidEmails = [];

    if (!second) {
        winningAmount = Math.max(currentBid + increment, Math.min(Number(top.maxAmount), currentBid + increment));
    } else if (Number(top.maxAmount) === Number(second.maxAmount)) {
        winningAmount = Number(top.maxAmount);
        outbidEmails = eligible.slice(1).map((entry) => entry.bidderEmail);
    } else {
        winningAmount = Math.min(Number(top.maxAmount), Number(second.maxAmount) + increment);
        outbidEmails = eligible.slice(1).map((entry) => entry.bidderEmail);
    }

    if (winningAmount <= currentBid) return { resolved: false, auction };

    const applied = await applyBidToAuction({
        auction,
        bidderEmail: top.bidderEmail,
        bidderName: top.bidderName,
        amount: winningAmount,
        session,
        source: 'auto'
    });

    if (!applied.ok) {
        top.active = false;
        await top.save({ session });
        return { resolved: false, auction };
    }

    return {
        resolved: true,
        auction,
        autoBidWinner: top.bidderEmail,
        outbidEmails,
        finalAmount: winningAmount
    };
}

async function maybeExtendAuction({ auction, bidId, session, listingId }) {
    let extensionTriggered = false;
    let maxSnipeReached = false;
    if (!auction.endTime) return { extensionTriggered, maxSnipeReached };

    const timeLeft = auction.endTime.getTime() - Date.now();
    const threeMinutes = 3 * 60 * 1000;
    if (timeLeft > 0 && timeLeft <= threeMinutes && (auction.snipeCount || 0) < 5) {
        const newEndTime = new Date(Date.now() + threeMinutes);
        auction.endTime = newEndTime;
        auction.snipeCount = (auction.snipeCount || 0) + 1;
        await auction.save({ session });
        await SnipeLog.create([{
            listingId: auction._id,
            bidId,
            extensionNum: auction.snipeCount,
            newEndTime
        }], { session });
        extensionTriggered = true;
        broadcastAuction(listingId, { type: 'snipe:extended', listingId, newEndTime: newEndTime.toISOString(), extensionNum: auction.snipeCount });
    } else if (timeLeft <= threeMinutes && (auction.snipeCount || 0) >= 5) {
        maxSnipeReached = true;
    }

    return { extensionTriggered, maxSnipeReached };
}

async function handlePlaceBid(req, res) {
    const { bidAmount, isAuto } = req.body;
    const id = req.params.listingId;
    const amount = Number(bidAmount);

    try {
        const auction = await Auction.findById(id);
        if (!auction) return res.status(404).json({ success: false, message: 'Item not found.' });
        if (auction.status !== 'active') return res.status(400).json({ success: false, message: 'This listing is not live for bidding.' });
        if (auction.endTime && auction.endTime <= new Date()) return res.status(400).json({ success: false, message: 'This auction has expired.' });
        if (auction.sellerEmail === req.user.email) return res.status(403).json({ success: false, message: 'You cannot bid on your own listing.' });
        if (!Number.isInteger(amount)) return res.status(400).json({ success: false, message: 'Bid amount must be in whole rupees only.' });
        if (amount <= Number(auction.currentBid || 0)) return res.status(400).json({ success: false, message: `Bid must be higher than ₹${Number(auction.currentBid || 0).toLocaleString('en-IN')}.` });

        const latestBid = await Bid.findOne({ auctionId: auction._id }).sort({ placedAt: -1, _id: -1 });
        const isCurrentLeader = latestBid && latestBid.bidderEmail === req.user.email;
        if (isCurrentLeader && !isAuto) return res.status(400).json({ success: false, message: 'You already hold the top bid.' });

        const session = await mongoose.startSession();
        let finalAuction;
        let newBid;
        let extensionTriggered = false;
        let maxSnipeReached = false;
        let autoResolved = null;

        try {
            await session.withTransaction(async () => {
                const txAuction = await Auction.findById(id).session(session);
                const applied = await applyBidToAuction({
                    auction: txAuction,
                    bidderEmail: req.user.email,
                    bidderName: req.user.name,
                    amount,
                    session,
                    source: isAuto ? 'auto' : 'manual'
                });
                if (!applied.ok) {
                    throw new Error(applied.reason || 'BID_FAILED');
                }

                newBid = applied.bid;

                if (isAuto) {
                    await AutoBid.findOneAndUpdate(
                        { auctionId: txAuction._id, bidderEmail: req.user.email },
                        { bidderName: req.user.name, maxAmount: amount, active: true },
                        { upsert: true, new: true, session, setDefaultsOnInsert: true }
                    );
                }

                const snipe = await maybeExtendAuction({ auction: txAuction, bidId: newBid._id, session, listingId: id });
                extensionTriggered = snipe.extensionTriggered;
                maxSnipeReached = snipe.maxSnipeReached;

                autoResolved = await resolveAutoBidsTransaction({
                    auctionId: txAuction._id,
                    triggerBidderEmail: isAuto ? null : req.user.email,
                    session
                });

                finalAuction = await Auction.findById(txAuction._id).session(session);

                await AuditLog.create([{
                    action: 'BID_PLACED',
                    userEmail: req.user.email,
                    details: `Bid ₹${amount} on ${txAuction.title} (${txAuction._id})`
                }], { session });
            });
        } catch (error) {
            session.endSession();
            if (error.message === 'INSUFFICIENT_FUNDS') {
                return res.status(400).json({ success: false, message: 'Insufficient funds. Please deposit to continue.' });
            }
            throw error;
        }

        session.endSession();

        trackBidActivity(finalAuction._id, req.user.email);
        const bidCount = await Bid.countDocuments({ auctionId: finalAuction._id });
        broadcastAuction(id, {
            type: 'bid_update',
            itemId: id,
            newBid: finalAuction.currentBid,
            bidCount,
            reserve_met: finalAuction.currentBid >= Number(finalAuction.reservePrice || 0)
        });
        if (autoResolved?.resolved) {
            (autoResolved.outbidEmails || []).forEach((email) => {
                if (email && email !== autoResolved.autoBidWinner) {
                    pushNotification(email, {
                        type: 'outbid',
                        title: 'Auto-bid outbid',
                        message: `Your auto-bid on "${finalAuction.title}" was outbid.`,
                        actionUrl: `/item-detail.html?id=${finalAuction._id}`,
                        metadata: { auctionId: finalAuction._id.toString() }
                    }).catch(() => null);
                }
            });
            broadcastAuction(id, {
                type: 'outbid',
                auctionId: id,
                winnerEmail: autoResolved.autoBidWinner,
                outbidEmails: autoResolved.outbidEmails || [],
                amount: autoResolved.finalAmount
            });
        }
        broadcastGlobalActivity({
            message: `${req.user.name} placed ₹${Number(finalAuction.currentBid || 0).toLocaleString('en-IN')} on "${finalAuction.title}"`,
            itemId: id,
            timestamp: new Date().toISOString()
        });

        return res.json({
            success: true,
            newBid: finalAuction.currentBid,
            bidCount,
            extensionTriggered,
            message: maxSnipeReached ? 'Bid placed, max extensions reached.' : 'Bid placed successfully!'
        });
    } catch (e) {
        console.error('Bid Error:', e);
        return res.status(500).json({ success: false, message: 'Server error placing bid' });
    }
}

router.get('/auto-bid/:listingId', requireLogin, async (req, res) => {
    try {
        const autoBid = await AutoBid.findOne({
            auctionId: req.params.listingId,
            bidderEmail: req.user.email,
            active: true
        }).sort({ createdAt: -1 });
        if (!autoBid) return res.json({ active: false });
        res.json({ active: true, ceiling: autoBid.maxAmount, createdAt: autoBid.createdAt });
    } catch (e) {
        res.status(500).json({ active: false });
    }
});

router.delete('/auto-bid/:listingId', requireLogin, async (req, res) => {
    try {
        await AutoBid.findOneAndUpdate(
            { auctionId: req.params.listingId, bidderEmail: req.user.email, active: true },
            { active: false }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error cancelling auto bid' });
    }
});

router.post('/auto-bid', requireLogin, bidLimiter, async (req, res) => {
    const listingId = req.body.listingId || req.body.auctionId;
    const ceiling = Number(req.body.maxAmount || req.body.ceiling);
    try {
        const item = await Auction.findById(listingId);
        if (!item || item.status !== 'active') return res.status(400).json({ success: false, message: 'Only live listings can accept auto-bids.' });
        if (item.sellerEmail === req.user.email) return res.status(403).json({ success: false, message: 'Cannot auto-bid on your own listing.' });
        if (!Number.isInteger(ceiling) || ceiling <= Number(item.currentBid || 0)) {
            return res.status(400).json({ success: false, message: `Auto-bid max must be higher than ₹${Number(item.currentBid || 0).toLocaleString('en-IN')}.` });
        }

        await AutoBid.findOneAndUpdate(
            { auctionId: item._id, bidderEmail: req.user.email },
            { bidderName: req.user.name, maxAmount: ceiling, active: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const session = await mongoose.startSession();
        let resolved = null;
        await session.withTransaction(async () => {
            resolved = await resolveAutoBidsTransaction({ auctionId: item._id, session });
        });
        session.endSession();

        if (resolved && resolved.resolved) {
            const bidCount = await Bid.countDocuments({ auctionId: item._id });
            broadcastAuction(String(item._id), {
                type: 'bid_update',
                itemId: String(item._id),
                newBid: resolved.finalAmount,
                bidCount,
                reserve_met: resolved.finalAmount >= Number(item.reservePrice || 0)
            });
        }

        res.json({ success: true, message: 'Auto-bid ceiling set.', ceiling });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error setting auto bid' });
    }
});

router.post('/place-bid', requireLogin, bidLimiter, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Missing auction ID.' });
    req.params.listingId = id;
    return handlePlaceBid(req, res);
});

router.post('/:listingId', requireLogin, bidLimiter, handlePlaceBid);

router.get('/wars/active', async (req, res) => {
    try {
        const wars = await Auction.find({ isWar: true, status: 'active' }).select('title currentBid bidCount endTime');
        res.json(wars);
    } catch (e) {
        res.json([]);
    }
});

router.get('/:listingId', async (req, res) => {
    try {
        const rows = await Bid.find({ auctionId: req.params.listingId }).sort({ placedAt: -1, amount: -1 });
        const enrichedBids = await Promise.all(rows.map(async (r) => {
            const user = await User.findOne({ email: r.bidderEmail }).select('college campusVerified fullname avatar');
            return {
                bidderName: r.bidderName || user?.fullname || 'Bidder',
                amount: r.amount,
                placedAt: r.placedAt,
                triggeredSnipe: r.triggeredSnipe || false,
                college: user?.college,
                campusVerified: user?.campusVerified,
                avatar: user?.avatar || null,
                maskedName: (r.bidderName || user?.fullname || 'Bidder').replace(/(.{2}).+/, '$1***')
            };
        }));

        let isRivalry = false;
        let rivalryDetails = null;
        const campusBidders = enrichedBids.filter((b) => b.campusVerified && b.college);
        const uniqueCampus = [...new Set(campusBidders.map((b) => b.college))];
        if (uniqueCampus.length >= 2) {
            isRivalry = true;
            rivalryDetails = { colleges: uniqueCampus };
        }

        res.json({ bids: enrichedBids, isRivalry, rivalryDetails });
    } catch (e) {
        res.json({ bids: [], isRivalry: false });
    }
});

router.get('/:listingId/snipe-log', async (req, res) => {
    try {
        const logs = await SnipeLog.find({ listingId: req.params.listingId }).sort({ triggeredAt: -1 });
        res.json(logs);
    } catch (e) {
        res.json([]);
    }
});

module.exports = router;
