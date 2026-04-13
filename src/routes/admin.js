const express = require('express');
const router = express.Router();
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Auction = require('../models/Auction');
const Bid = require('../models/Bid');
const Media = require('../models/Media');
const AuditLog = require('../models/AuditLog');
const { mapAuction, pushNotification } = require('../utils/auctionHelpers');
const { closeAuction } = require('../services/auctionScheduler');
const { getOnlineUserEmails, isUserOnline } = require('../services/websocket');

async function getAssignableAdmins(onlineOnly = false) {
    const admins = await User.find({ $or: [{ isAdmin: true }, { role: 'admin' }], isSuperAdmin: false }).sort({ fullname: 1 });
    if (!onlineOnly) return admins;
    return admins.filter((admin) => isUserOnline(admin.email));
}

async function assignPendingReviewsToOnlineAdmins() {
    const onlineAdmins = await getAssignableAdmins(true);
    const pending = await Auction.find({
        status: 'pending_review',
        $or: [
            { assignedAdminEmail: { $exists: false } },
            { assignedAdminEmail: null }
        ]
    }).sort({ createdAt: 1 });

    if (!onlineAdmins.length || !pending.length) {
        return { assigned: 0, queued: pending.length };
    }

    for (let i = 0; i < pending.length; i += 1) {
        const admin = onlineAdmins[i % onlineAdmins.length];
        pending[i].assignedAdminEmail = admin.email;
        pending[i].assignedAt = new Date();
        pending[i].status = 'under_review';
        await pending[i].save();
        await pushNotification(admin.email, {
            type: 'sell_request_assigned',
            title: 'New item assigned',
            message: `New item assigned: ${pending[i].title}`,
            actionUrl: `/workspace/review.html?id=${pending[i]._id}`,
            metadata: { auctionId: pending[i]._id.toString(), auctionTitle: pending[i].title }
        });
    }

    return { assigned: pending.length, queued: 0 };
}

router.get('/review', requireAdmin, async (req, res) => {
    try {
        const query = req.adminUser.isSuperAdmin
            ? { status: { $in: ['pending_review', 'under_review', 'rejected'] } }
            : { assignedAdminEmail: req.adminUser.email, status: { $in: ['pending_review', 'under_review'] } };
        const rows = await Auction.find(query).sort({ createdAt: 1 });
        res.json(await Promise.all(rows.map(mapAuction)));
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/stats', requireAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const activeAuctions = await Auction.countDocuments({ status: 'active' });
        const pendingCount = await Auction.countDocuments({ status: { $in: ['pending_review', 'under_review'] } });
        const totalBidsToday = await Bid.countDocuments({ placedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
        const totalVolume = await Auction.aggregate([
            { $match: { status: 'closed', winnerEmail: { $exists: true } } },
            { $group: { _id: null, total: { $sum: '$currentBid' } } }
        ]);
        res.json({
            totalUsers, activeAuctions, totalBidsToday,
            totalVolume: totalVolume[0]?.total || 0, pendingCount,
            adminCount: await User.countDocuments({ $or: [{ isAdmin: true }, { isSuperAdmin: true }, { role: 'admin' }] })
        });
    } catch (e) { res.status(500).json({ error: 'Server error fetching stats' }); }
});

router.get('/pending', requireAdmin, async (req, res) => {
    try {
        const query = req.adminUser.isSuperAdmin
            ? { status: { $in: ['pending_review', 'under_review', 'rejected'] } }
            : { assignedAdminEmail: req.adminUser.email, status: { $in: ['pending_review', 'under_review'] } };
        const pending = await Auction.find(query).sort({ createdAt: 1 });
        res.json(await Promise.all(pending.map(mapAuction)));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/users', requireAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
        res.json(users);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/logs', requireAdmin, async (req, res) => {
    try {
        const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const sellerAuctions = await Auction.find({ sellerEmail: user.email });
        for (const a of sellerAuctions) {
            await Media.deleteMany({ ownerId: a._id });
            await Bid.deleteMany({ auctionId: a._id });
            await Auction.findByIdAndDelete(a._id);
        }
        await Bid.deleteMany({ bidderEmail: user.email });
        await User.findByIdAndDelete(req.params.id);
        await AuditLog.create({ action: 'USER_DELETED', userEmail: req.adminUser.email, details: `Deleted user ${user.email}`, ipAddress: req.ip });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/auctions/:id', requireAdmin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.id);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        await Bid.deleteMany({ auctionId: auction._id });
        await Auction.findByIdAndDelete(req.params.id);
        await AuditLog.create({ action: 'AUCTION_DELETED', userEmail: req.adminUser.email, details: `Deleted auction ${auction.title} (${auction._id})`, ipAddress: req.ip });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/early-sell', requireAdmin, async (req, res) => {
    try {
        const listing = await Auction.findById(req.body.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found.' });
        if (listing.status !== 'active') return res.status(400).json({ error: 'Only active listings can enter early sell.' });
        const deadline = new Date(Date.now() + 5 * 60 * 1000);
        listing.endTime = deadline;
        listing.earlySellActivatedAt = new Date();
        listing.earlySellDeadline = deadline;
        listing.earlySellActivatedBy = req.adminUser.email;
        await listing.save();
        await pushNotification(listing.sellerEmail, { type: 'early_sell_activated', title: 'Early sell activated', message: `"${listing.title}" is now in a 5 minute closing window.`, actionUrl: `/item-detail.html?id=${listing._id}`, metadata: { auctionId: listing._id.toString(), deadline: deadline.toISOString() } });
        await AuditLog.create({ action: 'EARLY_SELL_ACTIVATED', userEmail: req.adminUser.email, details: `Early sell for ${listing.title} until ${deadline.toISOString()}`, ipAddress: req.ip });
        res.json({ success: true, deadline: deadline.toISOString() });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/team-overview', requireSuperAdmin, async (req, res) => {
    try {
        const admins = await User.find({ $or: [{ isAdmin: true }, { isSuperAdmin: true }, { role: 'admin' }] }).select('-passwordHash').sort({ fullname: 1 });
        const adminEmails = admins.map(a => a.email);
        const [assignedAgg, approvedAgg, rejectedAgg] = await Promise.all([
            Auction.aggregate([{ $match: { assignedAdminEmail: { $in: adminEmails }, status: { $in: ['pending_review', 'under_review'] } } }, { $group: { _id: '$assignedAdminEmail', count: { $sum: 1 } } }]),
            Auction.aggregate([{ $match: { reviewedByEmail: { $in: adminEmails }, status: 'active' } }, { $group: { _id: '$reviewedByEmail', count: { $sum: 1 } } }]),
            Auction.aggregate([{ $match: { reviewedByEmail: { $in: adminEmails }, status: 'rejected' } }, { $group: { _id: '$reviewedByEmail', count: { $sum: 1 } } }])
        ]);
        const assignedMap = Object.fromEntries(assignedAgg.map(r => [r._id, r.count]));
        const approvedMap = Object.fromEntries(approvedAgg.map(r => [r._id, r.count]));
        const rejectedMap = Object.fromEntries(rejectedAgg.map(r => [r._id, r.count]));
        const team = admins.map(a => ({
            id: a._id.toString(), fullname: a.fullname, email: a.email,
            isSuperAdmin: Boolean(a.isSuperAdmin), isAdmin: Boolean(a.isAdmin || a.isSuperAdmin || a.role === 'admin'),
            assignedProducts: assignedMap[a.email] || 0, approvedProducts: approvedMap[a.email] || 0, rejectedProducts: rejectedMap[a.email] || 0,
            online: isUserOnline(a.email)
        }));
        res.json(team);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/set-admin', requireSuperAdmin, async (req, res) => {
    try {
        const target = await User.findById(req.body.id);
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.isSuperAdmin) return res.status(400).json({ error: 'Super admin status is managed separately.' });
        const wasAdmin = Boolean(target.isAdmin);
        target.isAdmin = Boolean(req.body.isAdmin);
        await target.save();
        if (!wasAdmin && target.isAdmin) {
            await pushNotification(target.email, { type: 'admin_access_granted', title: 'Admin access granted', message: 'Review the admin handbook before validating listings.', actionUrl: '/admin-handbook.html', metadata: { handbook: true } });
        }
        await AuditLog.create({ action: target.isAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED', userEmail: req.superAdminUser.email, details: `${req.superAdminUser.email} ${target.isAdmin ? 'granted' : 'revoked'} admin for ${target.email}`, ipAddress: req.ip });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/assign-sell-requests', requireSuperAdmin, async (req, res) => {
    try {
        const result = await assignPendingReviewsToOnlineAdmins();
        res.json({ success: true, assignedCount: result.assigned, queuedCount: result.queued, onlineAdmins: getOnlineUserEmails().length });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/process-queued-assignments', requireAdmin, async (req, res) => {
    try {
        if (!req.adminUser.isAdmin && !req.adminUser.isSuperAdmin && req.adminUser.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const result = await assignPendingReviewsToOnlineAdmins();
        res.json({ success: true, assignedCount: result.assigned, queuedCount: result.queued });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/assign-reviewer', requireSuperAdmin, async (req, res) => {
    try {
        const auctionId = req.body.auctionId || req.body.listingId;
        const { reviewerEmail } = req.body;
        const auction = await Auction.findById(auctionId);
        if (!auction) return res.status(404).json({ error: 'Listing not found' });
        if (!reviewerEmail) {
            auction.assignedAdminEmail = null;
            auction.assignedAt = null;
            auction.status = 'pending_review';
            await auction.save();
            return res.json({ success: true, unassigned: true });
        }
        const admin = await User.findOne({ email: reviewerEmail });
        if (!admin || !(admin.isAdmin || admin.isSuperAdmin || admin.role === 'admin'))
            return res.status(400).json({ error: 'Invalid reviewer' });
        if (!isUserOnline(reviewerEmail)) {
            return res.status(400).json({ error: 'Reviewer is offline. Manual assignment only works for online admins.' });
        }
        auction.assignedAdminEmail = reviewerEmail;
        auction.assignedAt = new Date();
        auction.status = 'under_review';
        await auction.save();
        await pushNotification(reviewerEmail, { type: 'sell_request_assigned', title: 'New item assigned', message: `New item assigned: ${auction.title}`, actionUrl: `/workspace/review.html?id=${auction._id}`, metadata: { auctionId: auction._id.toString(), auctionTitle: auction.title } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/review-request', requireAdmin, async (req, res) => {
    try {
        const auctionId = req.body.auctionId || req.body.id;
        const decision = req.body.decision;
        const reviewNotes = req.body.reviewNotes || req.body.notes || req.body.rejectionReason;
        const item = await Auction.findById(auctionId);
        if (!item) return res.status(404).json({ error: 'Listing not found' });
        if (!req.adminUser.isSuperAdmin && item.assignedAdminEmail !== req.adminUser.email)
            return res.status(403).json({ error: 'This listing is not assigned to you.' });

        if (decision === 'approve') {
            const mc = item.moderationChecklist || {};
            const allChecked = Object.values(mc).every(Boolean);
            item.status = 'active';
            item.verified = true;
            item.reviewNotes = reviewNotes || 'Approved';
            item.moderationChecklist = req.body.moderationChecklist || item.moderationChecklist;
            item.reviewedAt = new Date();
            item.reviewedByEmail = req.adminUser.email;
            await item.save();
            await pushNotification(item.sellerEmail, { type: 'approved', title: 'Listing approved!', message: `"${item.title}" is now live.`, actionUrl: `/item-detail.html?id=${item._id}`, metadata: { auctionId: item._id.toString() } });
            await AuditLog.create({ action: 'SELL_REQUEST_APPROVED', userEmail: req.adminUser.email, details: `Approved ${item.title} (${item._id})` });
        } else if (decision === 'reject') {
            item.status = 'rejected';
            item.rejectionReason = reviewNotes || 'Rejected';
            item.reviewNotes = req.body.notes || '';
            item.reviewedAt = new Date();
            item.reviewedByEmail = req.adminUser.email;
            await item.save();
            await pushNotification(item.sellerEmail, { type: 'rejected', title: 'Listing rejected', message: `"${item.title}" was not approved. Reason: ${reviewNotes || 'N/A'}`, actionUrl: '/my-products.html', metadata: { auctionId: item._id.toString() } });
            await AuditLog.create({ action: 'SELL_REQUEST_REJECTED', userEmail: req.adminUser.email, details: `Rejected ${item.title} (${item._id}): ${reviewNotes}` });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/close-auction', requireAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        await closeAuction(id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.patch('/auctions/:id/reorder-images', requireAdmin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.id);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (!req.adminUser.isSuperAdmin && auction.assignedAdminEmail !== req.adminUser.email) {
            return res.status(403).json({ error: 'This listing is not assigned to you.' });
        }
        const orderedImages = Array.isArray(req.body.images) ? req.body.images.filter(Boolean) : [];
        if (!orderedImages.length) return res.status(400).json({ error: 'At least one image is required.' });
        auction.images = orderedImages;
        auction.image = orderedImages[0] || auction.image;
        await auction.save();
        res.json({ success: true, images: auction.images });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
