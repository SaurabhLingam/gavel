const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const User = require('../models/User');
const Auction = require('../models/Auction');
const Bid = require('../models/Bid');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const { getWalletTransactions, recordWalletTransaction } = require('../services/walletLedger');
const { mapAuction, getBidCountMap, pushNotification } = require('../utils/auctionHelpers');
const {
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_PAYMENT_LINK,
    SMS_OTP_PROVIDER_URL,
    SMS_OTP_PROVIDER_TOKEN
} = require('../config/env');
const {
    getTreasuryUser,
    ensureTreasuryUser,
    creditTreasury,
    debitTreasury,
    normalizeCurrencyAmount
} = require('../services/treasury');

const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
    ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
    : null;

function normalizeIndianPhoneNumber(input) {
    const digits = String(input || '').replace(/\D/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
    return '';
}

function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(phoneNumber, otp) {
    return crypto.createHash('sha256').update(`${phoneNumber}:${otp}`).digest('hex');
}

async function sendSmsOtp(phoneNumber, otp) {
    if (!SMS_OTP_PROVIDER_URL || !SMS_OTP_PROVIDER_TOKEN) {
        return { delivered: false, fallbackOtp: otp };
    }

    const response = await fetch(SMS_OTP_PROVIDER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SMS_OTP_PROVIDER_TOKEN}`
        },
        body: JSON.stringify({
            phoneNumber: `+91${phoneNumber}`,
            message: `Your Gavel verification OTP is ${otp}. It expires in 10 minutes.`
        })
    });

    if (!response.ok) {
        throw new Error('SMS_DELIVERY_FAILED');
    }

    return { delivered: true };
}

function getAuctionEscrowAmount(auction) {
    const reservePrice = normalizeCurrencyAmount(auction?.reservePrice);
    if (reservePrice > 0) return reservePrice;
    return normalizeCurrencyAmount(auction?.settlement?.securedAmount);
}

function generateSettlementCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function calculateTrustScoreFromRatings(ratings) {
    const list = Array.isArray(ratings) ? ratings.filter((entry) => Number(entry.score) >= 1 && Number(entry.score) <= 5) : [];
    if (!list.length) return 100;
    const average = list.reduce((sum, entry) => sum + Number(entry.score || 0), 0) / list.length;
    return Math.max(0, Math.min(100, Math.round((average / 5) * 100)));
}

function calculateAverageRating(ratings, context) {
    const list = (Array.isArray(ratings) ? ratings : []).filter((entry) => entry.context === context);
    if (!list.length) return 0;
    return Number((list.reduce((sum, entry) => sum + Number(entry.score || 0), 0) / list.length).toFixed(1));
}

async function refreshUserReputation(user) {
    user.ratings = Array.isArray(user.ratings) ? user.ratings : [];
    user.buyerStats = user.buyerStats || {};
    user.sellerStats = user.sellerStats || {};
    const sellerRatings = user.ratings.filter((entry) => entry.context === 'seller');
    const buyerRatings = user.ratings.filter((entry) => entry.context === 'buyer');
    user.sellerStats.averageRating = calculateAverageRating(user.ratings, 'seller');
    user.sellerStats.ratingCount = sellerRatings.length;
    user.buyerStats.averageRating = calculateAverageRating(user.ratings, 'buyer');
    user.buyerStats.ratingCount = buyerRatings.length;
    user.trustScore = calculateTrustScoreFromRatings(user.ratings);
    await user.save();
}

async function applyWalletTopupFromPayment(payment, options = {}) {
    const paymentAmount = normalizeCurrencyAmount(payment.amount);
    if (payment.status === 'paid') {
        const existingUser = await User.findById(payment.userId);
        const committedBidBalance = existingUser?.email ? await getCommittedBidBalance(existingUser.email) : 0;
        return {
            success: true,
            newBalance: normalizeCurrencyAmount(existingUser?.walletBalance || 0),
            committedBidBalance,
            availableToWithdraw: Math.max(0, normalizeCurrencyAmount(existingUser?.walletBalance || 0) - committedBidBalance),
            alreadyApplied: true
        };
    }

    const user = await User.findById(payment.userId);
    if (!user) {
        throw new Error('User account not found.');
    }

    const balanceBefore = normalizeCurrencyAmount(user.walletBalance);
    const treasury = await creditTreasury(paymentAmount);
    if (!treasury) {
        throw new Error('Treasury account could not be prepared.');
    }

    try {
        user.walletBalance = balanceBefore + paymentAmount;
        await user.save();
    } catch (error) {
        await debitTreasury(paymentAmount).catch(() => {});
        throw error;
    }

    payment.status = 'paid';
    payment.razorpayPaymentId = options.razorpayPaymentId || payment.razorpayPaymentId || '';
    payment.razorpaySignature = options.razorpaySignature || payment.razorpaySignature || '';
    payment.paidAt = options.paidAt || new Date();
    await payment.save();

    const committedBidBalance = await getCommittedBidBalance(user.email);
    const balanceAfter = normalizeCurrencyAmount(user.walletBalance);

    await recordWalletTransaction({
        userId: user._id,
        userEmail: user.email,
        direction: 'credit',
        type: 'wallet_topup',
        title: 'Wallet top-up',
        details: `Razorpay top-up of ₹${paymentAmount.toLocaleString('en-IN')} credited to your wallet.`,
        amount: paymentAmount,
        balanceBefore,
        balanceAfter,
        availableBefore: Math.max(0, balanceBefore - committedBidBalance),
        availableAfter: Math.max(0, balanceAfter - committedBidBalance),
        source: 'razorpay',
        meta: {
            paymentId: String(payment._id),
            razorpayOrderId: payment.razorpayOrderId,
            razorpayPaymentId: payment.razorpayPaymentId
        }
    }).catch((error) => console.error('wallet transaction log failed:', error));

    await AuditLog.create({
        action: 'WALLET_TOP_UP',
        userEmail: payment.userEmail,
        details: `Verified Razorpay top-up ₹${paymentAmount} into treasury and user wallet`,
        ipAddress: options.ipAddress || ''
    });

    return {
        success: true,
        newBalance: user.walletBalance,
        committedBidBalance,
        availableToWithdraw: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance),
        alreadyApplied: false
    };
}

async function getSuccessfulRazorpayOrderPayment(orderId) {
    if (!razorpay) return null;
    const order = await razorpay.orders.fetch(orderId);
    let paymentItems = [];
    try {
        const paymentsResponse = await razorpay.orders.fetchPayments(orderId);
        paymentItems = Array.isArray(paymentsResponse?.items)
            ? paymentsResponse.items
            : Array.isArray(paymentsResponse)
                ? paymentsResponse
                : [];
    } catch (error) {
        paymentItems = [];
    }

    const successfulPayment = paymentItems.find((item) => ['captured', 'authorized', 'paid'].includes(String(item?.status || '').toLowerCase()));
    return {
        order,
        successfulPayment: successfulPayment || null
    };
}

async function getCommittedBidBalance(userEmail) {
    const activeAuctions = await Auction.find({ status: 'active' }).select('_id reservePrice');
    if (!activeAuctions.length) return 0;
    const activeAuctionIds = activeAuctions.map((auction) => auction._id);
    const activeBids = await Bid.find({ bidderEmail: userEmail, auctionId: { $in: activeAuctionIds } }).select('auctionId');
    const participatingIds = new Set(activeBids.map((bid) => String(bid.auctionId)));
    return activeAuctions
        .filter((auction) => participatingIds.has(String(auction._id)))
        .reduce((sum, auction) => sum + normalizeCurrencyAmount(auction.reservePrice || 0), 0);
}

function buildUserRecommendationScore(auction, signals) {
    if (!auction || auction.status !== 'active') return -Infinity;
    let score = 0;
    const category = String(auction.category || '').trim();
    const categorySignal = signals.categoryWeights[category] || 0;
    score += categorySignal * 20;

    const normalizedPrice = normalizeCurrencyAmount(auction.currentBid || auction.startingPrice || 0);
    if (signals.preferredPrice > 0) {
        const priceDelta = Math.abs(normalizedPrice - signals.preferredPrice);
        score += Math.max(0, 30 - Math.round(priceDelta / Math.max(200, signals.preferredPrice * 0.1)));
    }

    if (signals.savedSearchTerms.some((term) => String(auction.title || '').toLowerCase().includes(term) || String(auction.description || '').toLowerCase().includes(term))) {
        score += 18;
    }
    if (signals.college && auction.sellerCollege && auction.sellerCollege === signals.college) score += 8;
    score += Math.min(15, Number(auction.bidCount || 0) * 2);
    score += Math.min(10, Number(auction.viewCount || 0));
    if (auction.endTime) {
        const timeLeft = new Date(auction.endTime).getTime() - Date.now();
        if (timeLeft > 0 && timeLeft < 24 * 60 * 60 * 1000) score += 10;
    }
    if (signals.watchlistIds.has(String(auction.id))) score += 12;
    return score;
}

async function finalizeTreasuryRelease(auction, actorEmail) {
    auction.settlement = auction.settlement || {};
    const alreadyReleased = Boolean(auction.settlement.sellerWalletCredited);
    const buyerConfirmed = Boolean(auction.settlement.buyerConfirmedAt);
    const sellerConfirmed = Boolean(auction.settlement.sellerConfirmedAt);
    const escrowAmount = getAuctionEscrowAmount(auction);
    if (alreadyReleased || !buyerConfirmed || !sellerConfirmed || escrowAmount <= 0) {
        return { released: false };
    }

    const seller = await User.findOne({ email: auction.sellerEmail });
    if (!seller) {
        throw new Error('SELLER_NOT_FOUND');
    }

    const sellerBalanceBefore = normalizeCurrencyAmount(seller.walletBalance);
    await debitTreasury(escrowAmount);
    seller.walletBalance = sellerBalanceBefore + escrowAmount;
    seller.sellerStats = seller.sellerStats || {};
    seller.sellerStats.completedSales = Number(seller.sellerStats.completedSales || 0) + 1;
    await seller.save();

    const buyer = await User.findOne({ email: auction.winnerEmail });
    if (buyer) {
        buyer.buyerStats = buyer.buyerStats || {};
        buyer.buyerStats.completedBuys = Number(buyer.buyerStats.completedBuys || 0) + 1;
        await buyer.save();
    }

    auction.settlement.sellerWalletCredited = true;
    auction.settlement.treasuryReleasedAmount = escrowAmount;
    auction.settlement.creditedAt = new Date();
    auction.settlement.deliveryConfirmedAt = new Date();
    auction.settlement.releasedByEmail = actorEmail;
    await auction.save();

    await recordWalletTransaction({
        userId: seller._id,
        userEmail: seller.email,
        direction: 'credit',
        type: 'escrow_released',
        title: 'Escrow released to wallet',
        details: `Escrow of ₹${escrowAmount.toLocaleString('en-IN')} for "${auction.title}" was released to your wallet.`,
        amount: escrowAmount,
        balanceBefore: sellerBalanceBefore,
        balanceAfter: normalizeCurrencyAmount(seller.walletBalance),
        auctionId: auction._id,
        auctionTitle: auction.title,
        counterpartyEmail: auction.winnerEmail || '',
        counterpartyName: auction.winnerName || '',
        source: 'settlement',
        meta: {
            buyerConfirmedAt: auction.settlement.buyerConfirmedAt,
            sellerConfirmedAt: auction.settlement.sellerConfirmedAt,
            releasedByEmail: actorEmail
        }
    }).catch((error) => console.error('wallet transaction log failed:', error));

    await pushNotification(auction.sellerEmail, {
        type: 'seller_wallet_credited',
        title: 'Seller wallet credited',
        message: `Escrow for "${auction.title}" has been released to your wallet.`,
        actionUrl: `/receipt.html?id=${auction._id}`,
        metadata: { auctionId: auction._id.toString(), amount: escrowAmount }
    });

    if (auction.winnerEmail) {
        await pushNotification(auction.winnerEmail, {
            type: 'delivery_confirmed',
            title: 'Both parties confirmed handover',
            message: `Escrow for "${auction.title}" was released to the seller after both confirmations.`,
            actionUrl: `/receipt.html?id=${auction._id}`,
            metadata: { auctionId: auction._id.toString(), amount: escrowAmount }
        });
    }

    await AuditLog.create({
        action: 'TREASURY_ESCROW_RELEASED',
        userEmail: actorEmail,
        details: `Released ₹${escrowAmount} from treasury to seller ${auction.sellerEmail} for auction ${auction._id}`,
        ipAddress: ''
    });

    return { released: true, amount: escrowAmount };
}

router.get('/profile', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-passwordHash');
        const activeListings = await Auction.countDocuments({ sellerEmail: user.email, status: 'active' });
        const closedListings = await Auction.countDocuments({ sellerEmail: user.email, status: 'closed' });
        const pendingListings = await Auction.countDocuments({ sellerEmail: user.email, status: { $in: ['pending_review', 'under_review'] } });
        const rejectedListings = await Auction.countDocuments({ sellerEmail: user.email, status: 'rejected' });
        const totalBids = await Bid.countDocuments({ bidderEmail: user.email });
        const activeBids = await Bid.distinct('auctionId', { bidderEmail: user.email });
        const auctionsWon = await Auction.countDocuments({ winnerEmail: user.email, status: 'closed' });
        const watchlistCount = user.watchlist?.length || 0;
        const committedBidBalance = await getCommittedBidBalance(user.email);

        res.json({
            id: user._id, email: user.email, name: user.fullname, role: user.role,
            college: user.college, campusVerified: user.campusVerified,
            trustScore: Number.isFinite(Number(user.trustScore)) ? Number(user.trustScore) : 100,
            walletBalance: user.walletBalance,
            committedBidBalance,
            availableToWithdraw: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance),
            avatar: user.avatar, bio: user.bio, location: user.location,
            phoneNumber: user.phoneNumber || '',
            phoneVerified: Boolean(user.phoneVerification?.verified),
            buyerStats: user.buyerStats || {},
            sellerStats: user.sellerStats || {},
            stats: { activeListings, closedListings, pendingListings, rejectedListings, totalBids, activeBids: activeBids.length, auctionsWon, watchlistCount },
            createdAt: user.createdAt
        });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/my-listings', requireLogin, async (req, res) => {
    try {
        const listings = await Auction.find({ sellerEmail: req.user.email }).sort({ createdAt: -1 });
        res.json(await Promise.all(listings.map(mapAuction)));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/watchlist', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const auctions = await Auction.find({ _id: { $in: user.watchlist || [] } });
        res.json(await Promise.all(auctions.map(mapAuction)));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/presence/ping', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        user.lastSeenAt = new Date();
        await user.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/profile/contact', requireLogin, async (req, res) => {
    try {
        const phoneNumber = normalizeIndianPhoneNumber(req.body.phoneNumber);
        if (!phoneNumber) return res.status(400).json({ error: 'Enter a valid 10 digit phone number' });
        const user = await User.findById(req.user.id);
        user.phoneNumber = phoneNumber;
        user.phoneVerification = user.phoneVerification || {};
        user.phoneVerification.verified = false;
        user.phoneVerification.verifiedAt = null;
        user.phoneVerification.pendingPhoneNumber = '';
        user.phoneVerification.otpHash = '';
        user.phoneVerification.otpExpiresAt = null;
        await user.save();
        res.json({ success: true, phoneNumber: user.phoneNumber, phoneVerified: false });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/phone/send-otp', requireLogin, async (req, res) => {
    try {
        const phoneNumber = normalizeIndianPhoneNumber(req.body.phoneNumber);
        if (!phoneNumber) return res.status(400).json({ error: 'Enter a valid 10 digit phone number' });

        const user = await User.findById(req.user.id);
        user.phoneVerification = user.phoneVerification || {};
        const lastSentAt = user.phoneVerification.lastSentAt ? new Date(user.phoneVerification.lastSentAt).getTime() : 0;
        if (lastSentAt && Date.now() - lastSentAt < 60 * 1000) {
            return res.status(429).json({ error: 'Please wait at least 60 seconds before requesting another OTP.' });
        }

        const otp = generateOtp();
        user.phoneVerification.pendingPhoneNumber = phoneNumber;
        user.phoneVerification.otpHash = hashOtp(phoneNumber, otp);
        user.phoneVerification.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        user.phoneVerification.lastSentAt = new Date();
        user.phoneVerification.attemptsRemaining = 5;
        user.phoneVerification.verified = false;
        user.phoneVerification.verifiedAt = null;
        await user.save();

        const smsResult = await sendSmsOtp(phoneNumber, otp);
        await AuditLog.create({
            action: 'PHONE_OTP_SENT',
            userEmail: req.user.email,
            details: `OTP requested for ${phoneNumber}`,
            ipAddress: req.ip
        });

        res.json({
            success: true,
            phoneNumber,
            devOtp: process.env.NODE_ENV === 'production' ? undefined : smsResult.fallbackOtp
        });
    } catch (e) {
        res.status(500).json({ error: 'Could not send OTP right now.' });
    }
});

router.post('/phone/verify-otp', requireLogin, async (req, res) => {
    try {
        const otp = String(req.body.otp || '').replace(/\D/g, '').slice(0, 6);
        if (otp.length !== 6) return res.status(400).json({ error: 'Enter the 6 digit OTP.' });

        const user = await User.findById(req.user.id);
        const verification = user.phoneVerification || {};
        const pendingPhoneNumber = normalizeIndianPhoneNumber(verification.pendingPhoneNumber || user.phoneNumber);
        if (!pendingPhoneNumber || !verification.otpHash || !verification.otpExpiresAt) {
            return res.status(400).json({ error: 'Request a fresh OTP first.' });
        }
        if (new Date(verification.otpExpiresAt) < new Date()) {
            return res.status(400).json({ error: 'OTP expired. Request a new code.' });
        }
        if (Number(verification.attemptsRemaining || 0) <= 0) {
            return res.status(400).json({ error: 'No OTP attempts remaining. Request a new code.' });
        }

        const incomingHash = hashOtp(pendingPhoneNumber, otp);
        if (incomingHash !== verification.otpHash) {
            user.phoneVerification.attemptsRemaining = Math.max(0, Number(verification.attemptsRemaining || 0) - 1);
            await user.save();
            return res.status(400).json({ error: 'Invalid OTP.' });
        }

        user.phoneNumber = pendingPhoneNumber;
        user.phoneVerification.verified = true;
        user.phoneVerification.verifiedAt = new Date();
        user.phoneVerification.pendingPhoneNumber = '';
        user.phoneVerification.otpHash = '';
        user.phoneVerification.otpExpiresAt = null;
        user.phoneVerification.attemptsRemaining = 5;
        await user.save();

        await AuditLog.create({
            action: 'PHONE_VERIFIED',
            userEmail: req.user.email,
            details: `Phone verified: ${pendingPhoneNumber}`,
            ipAddress: req.ip
        });

        res.json({ success: true, phoneNumber: user.phoneNumber, phoneVerified: true });
    } catch (e) {
        res.status(500).json({ error: 'Could not verify OTP right now.' });
    }
});

router.post('/watchlist/toggle', requireLogin, async (req, res) => {
    try {
        const { auctionId } = req.body;
        const user = await User.findById(req.user.id);
        const watchlist = user.watchlist || [];
        const idx = watchlist.indexOf(auctionId);
        let added;
        if (idx > -1) { watchlist.splice(idx, 1); added = false; }
        else { watchlist.push(auctionId); added = true; }
        user.watchlist = watchlist;
        await user.save();
        res.json({ success: true, added, watchlist });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/saved-searches', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('savedSearches');
        res.json(user.savedSearches || []);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/saved-searches', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        user.savedSearches = user.savedSearches || [];
        user.savedSearches.push({
            query: String(req.body.query || '').trim(),
            category: String(req.body.category || '').trim(),
            condition: String(req.body.condition || '').trim(),
            maxPrice: Number(req.body.maxPrice || 0),
            notify: req.body.notify !== false
        });
        await user.save();
        res.json({ success: true, savedSearches: user.savedSearches });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/saved-searches/:id', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        user.savedSearches = (user.savedSearches || []).filter((search) => String(search._id) !== String(req.params.id));
        await user.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/block-user', requireLogin, async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const user = await User.findById(req.user.id);
        user.blockedUsers = user.blockedUsers || [];
        if (!user.blockedUsers.includes(email)) user.blockedUsers.push(email);
        await user.save();
        res.json({ success: true, blockedUsers: user.blockedUsers });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/notifications', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json((user.notifications || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/notifications/read', requireLogin, async (req, res) => {
    try {
        const { id } = req.body;
        const user = await User.findById(req.user.id);
        if (id) {
            const n = user.notifications?.find(n => n._id.toString() === id);
            if (n) n.read = true;
        } else {
            user.notifications?.forEach(n => n.read = true);
        }
        await user.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/my-bids', requireLogin, async (req, res) => {
    try {
        const bids = await Bid.find({ bidderEmail: req.user.email }).sort({ placedAt: -1 }).limit(30).populate('auctionId');
        const enriched = bids.filter(b => b.auctionId).map(b => ({
            auctionId: b.auctionId._id, auctionTitle: b.auctionId.title,
            auctionStatus: b.auctionId.status, currentBid: b.auctionId.currentBid,
            sellerEmail: b.auctionId.sellerEmail, winnerEmail: b.auctionId.winnerEmail,
            amount: b.amount, placedAt: b.placedAt
        }));
        res.json(enriched);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/wallet/history', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User account not found.' });
        const committedBidBalance = await getCommittedBidBalance(req.user.email);
        const transactions = await getWalletTransactions(req.user.email, 24);
        res.json({
            success: true,
            transactions,
            walletBalance: normalizeCurrencyAmount(user.walletBalance),
            committedBidBalance,
            availableToWithdraw: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance)
        });
    } catch (e) {
        console.error('wallet/history error:', e);
        res.status(500).json({ error: 'Could not load wallet history.' });
    }
});

router.get('/payments/razorpay/config', (req, res) => {
    res.json({
        enabled: Boolean(razorpay),
        keyId: RAZORPAY_KEY_ID,
        paymentLink: RAZORPAY_PAYMENT_LINK || ''
    });
});

router.post('/wallet/topup-bypass', requireLogin, async (req, res) => {
    try {
        const amount = normalizeCurrencyAmount(req.body.amount);
        if (amount < 1) return res.status(400).json({ error: 'Enter a valid amount.' });
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User account not found.' });
        const balanceBefore = normalizeCurrencyAmount(user.walletBalance);
        user.walletBalance = balanceBefore + amount;
        await user.save();
        const treasury = await creditTreasury(amount);
        if (!treasury) return res.status(500).json({ error: 'Treasury account could not be prepared.' });
        const committedBidBalance = await getCommittedBidBalance(req.user.email);
        await recordWalletTransaction({
            userId: user._id,
            userEmail: req.user.email,
            direction: 'credit',
            type: 'wallet_topup',
            title: 'Wallet top-up',
            details: `Manual top-up of ₹${amount.toLocaleString('en-IN')} credited to your wallet.`,
            amount,
            balanceBefore,
            balanceAfter: normalizeCurrencyAmount(user.walletBalance),
            availableBefore: Math.max(0, balanceBefore - committedBidBalance),
            availableAfter: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance),
            source: 'admin_tool',
            meta: { bypass: true }
        }).catch((error) => console.error('wallet transaction log failed:', error));
        await AuditLog.create({
            action: 'WALLET_TOP_UP',
            userEmail: req.user.email,
            details: `Bypass top-up ₹${amount} credited to user wallet and treasury`,
            ipAddress: req.ip
        });
        res.json({ success: true, newBalance: user.walletBalance });
    } catch (e) {
        console.error('wallet/topup-bypass error:', e);
        res.status(500).json({ error: e.message === 'Validation failed' ? 'Top-up failed validation.' : (e.message || 'Top-up failed.') });
    }
});

router.post('/wallet/withdraw', requireLogin, async (req, res) => {
    try {
        const amount = normalizeCurrencyAmount(req.body.amount);
        if (amount < 1) return res.status(400).json({ error: 'Enter a valid withdrawal amount.' });
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User account not found.' });
        const committedBidBalance = await getCommittedBidBalance(req.user.email);
        const availableToWithdraw = Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance);
        if (amount > availableToWithdraw) {
            return res.status(400).json({
                error: `Withdrawal blocked. ₹${availableToWithdraw.toLocaleString('en-IN')} is available after reserving active auction commitments.`,
                availableToWithdraw,
                committedBidBalance
            });
        }
        const originalBalance = normalizeCurrencyAmount(user.walletBalance);
        user.walletBalance = originalBalance - amount;
        await user.save();
        try {
            await debitTreasury(amount);
        } catch (error) {
            user.walletBalance = originalBalance;
            await user.save().catch(() => {});
            throw error;
        }
        await AuditLog.create({
            action: 'WALLET_WITHDRAWAL',
            userEmail: req.user.email,
            details: `Withdrew ₹${amount} from wallet`,
            ipAddress: req.ip
        });
        const committedBidBalanceAfter = await getCommittedBidBalance(req.user.email);
        await recordWalletTransaction({
            userId: user._id,
            userEmail: req.user.email,
            direction: 'debit',
            type: 'wallet_withdrawal',
            title: 'Wallet withdrawal',
            details: `Withdrew ₹${amount.toLocaleString('en-IN')} from your wallet.`,
            amount,
            balanceBefore: originalBalance,
            balanceAfter: normalizeCurrencyAmount(user.walletBalance),
            availableBefore: Math.max(0, originalBalance - committedBidBalance),
            availableAfter: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalanceAfter),
            source: 'wallet',
            meta: { requestedBy: req.user.email }
        }).catch((error) => console.error('wallet transaction log failed:', error));
        res.json({ success: true, newBalance: user.walletBalance, committedBidBalance, availableToWithdraw: Math.max(0, user.walletBalance - committedBidBalance) });
    } catch (e) {
        console.error('wallet/withdraw error:', e);
        if (e.message === 'TREASURY_INSUFFICIENT_FUNDS') {
            return res.status(400).json({ error: 'Withdrawal failed because the treasury does not have enough funds yet.' });
        }
        res.status(500).json({ error: e.message || 'Withdrawal failed.' });
    }
});

router.post('/payments/razorpay/order', requireLogin, async (req, res) => {
    try {
        if (!razorpay) return res.status(400).json({ error: 'Razorpay not configured' });
        const amount = normalizeCurrencyAmount(req.body.amount);
        if (amount < 100) return res.status(400).json({ error: 'Minimum wallet top-up is ₹100.' });

        const receipt = `gwl_${Date.now().toString(36)}_${String(req.user.id).slice(-8)}`;
        const order = await razorpay.orders.create({
            amount: amount * 100,
            currency: 'INR',
            receipt,
            notes: {
                userId: String(req.user.id),
                userEmail: req.user.email,
                purpose: 'wallet_topup'
            }
        });

        await Payment.create({
            userId: req.user.id,
            userEmail: req.user.email,
            amount,
            receipt,
            razorpayOrderId: order.id,
            notes: { purpose: 'wallet_topup' }
        });

        res.json({ keyId: RAZORPAY_KEY_ID, order, paymentLink: RAZORPAY_PAYMENT_LINK || '' });
    } catch (e) {
        console.error('payments/razorpay/order error:', e);
        res.status(500).json({ error: e.message || 'Order creation failed' });
    }
});

router.post('/payments/razorpay/verify', requireLogin, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay) return res.status(400).json({ error: 'Razorpay not configured' });
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing Razorpay verification fields.' });
        }
        const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
        if (expectedSig !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });

        const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id, userId: req.user.id });
        if (!payment) return res.status(404).json({ error: 'Payment order not found.' });
        const result = await applyWalletTopupFromPayment(payment, {
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            paidAt: new Date(),
            ipAddress: req.ip
        });
        res.json(result);
    } catch (e) {
        console.error('payments/razorpay/verify error:', e);
        res.status(500).json({ error: e.message || 'Verification failed' });
    }
});

router.get('/payments/razorpay/status/:orderId', requireLogin, async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '').trim();
        if (!orderId) return res.status(400).json({ error: 'Missing order id.' });

        const payment = await Payment.findOne({ razorpayOrderId: orderId, userId: req.user.id });
        if (!payment) return res.status(404).json({ error: 'Payment order not found.' });

        if (payment.status === 'paid') {
            const currentUser = await User.findById(req.user.id);
            const committedBidBalance = currentUser?.email ? await getCommittedBidBalance(currentUser.email) : 0;
            return res.json({
                success: true,
                status: 'paid',
                newBalance: normalizeCurrencyAmount(currentUser?.walletBalance || 0),
                committedBidBalance,
                availableToWithdraw: Math.max(0, normalizeCurrencyAmount(currentUser?.walletBalance || 0) - committedBidBalance)
            });
        }

        if (!razorpay) {
            return res.json({ success: false, status: payment.status, paymentLink: RAZORPAY_PAYMENT_LINK || '' });
        }

        const { order, successfulPayment } = await getSuccessfulRazorpayOrderPayment(orderId);
        if (successfulPayment || normalizeCurrencyAmount((order?.amount_paid || 0) / 100) >= normalizeCurrencyAmount(payment.amount)) {
            const result = await applyWalletTopupFromPayment(payment, {
                razorpayPaymentId: successfulPayment?.id || payment.razorpayPaymentId || '',
                paidAt: successfulPayment?.created_at ? new Date(Number(successfulPayment.created_at) * 1000) : new Date(),
                ipAddress: req.ip
            });
            return res.json({ ...result, status: 'paid' });
        }

        const remoteStatus = String(order?.status || payment.status || 'created').toLowerCase();
        if (['failed', 'cancelled'].includes(remoteStatus) && payment.status !== 'failed') {
            payment.status = 'failed';
            await payment.save();
        }

        return res.json({
            success: false,
            status: ['failed', 'cancelled'].includes(remoteStatus) ? 'failed' : 'created',
            amount: payment.amount,
            paymentLink: RAZORPAY_PAYMENT_LINK || ''
        });
    } catch (e) {
        console.error('payments/razorpay/status error:', e);
        res.status(500).json({ error: e.message || 'Unable to fetch payment status.' });
    }
});

router.get('/dashboard/summary', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-passwordHash');
        const email = user.email;
        const treasuryUser = await getTreasuryUser();
        const committedBidBalance = await getCommittedBidBalance(email);
        const me = {
            id: user._id,
            email: user.email,
            fullname: user.fullname,
            name: user.fullname,
            role: user.role,
            walletBalance: user.walletBalance,
            trustScore: Number.isFinite(Number(user.trustScore)) ? Number(user.trustScore) : 100,
            isAdmin: user.isAdmin || user.isSuperAdmin,
            isSuperAdmin: user.isSuperAdmin,
            campusVerified: user.campusVerified,
            college: user.college,
            avatar: user.avatar,
            phoneNumber: user.phoneNumber || '',
            phoneVerified: Boolean(user.phoneVerification?.verified),
            committedBidBalance,
            availableToWithdraw: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance),
            buyerStats: user.buyerStats || {},
            sellerStats: user.sellerStats || {}
        };
        const result = { user: me, me };
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const closedSales = await Auction.find({ sellerEmail: email, status: 'closed', updatedAt: { $gte: monthStart } });
        const closedWins = await Auction.find({ winnerEmail: email, status: 'closed', updatedAt: { $gte: monthStart } });
        const campusBuyers = await Auction.find({ winnerEmail: { $exists: true, $ne: null }, status: 'closed' }).select('winnerEmail winnerName updatedAt');
        const profileFields = [user.fullname, user.college, user.hostelBlock, user.bio, user.avatar].filter((value) => String(value || '').trim());
        const completeness = Math.round((profileFields.length / 5) * 100);
        const reviewsGiven = await Auction.countDocuments({ 'reviews.reviewerEmail': email });

        result.stats = {
            activeListings: await Auction.countDocuments({ sellerEmail: email, status: 'active' }),
            pendingListings: await Auction.countDocuments({ sellerEmail: email, status: { $in: ['pending_review', 'under_review'] } }),
            rejectedListings: await Auction.countDocuments({ sellerEmail: email, status: 'rejected' }),
            soldListings: await Auction.countDocuments({ sellerEmail: email, status: 'closed' }),
            activeBids: (await Bid.distinct('auctionId', { bidderEmail: email })).length,
            won: await Auction.countDocuments({ winnerEmail: email, status: 'closed' }),
            watchlistCount: user.watchlist?.length || 0,
            totalUsers: await User.countDocuments(),
            totalAuctions: await Auction.countDocuments(),
            totalBids: await Bid.countDocuments(),
            monthlySpent: closedWins.reduce((sum, item) => sum + Number(item.winningBid || item.currentBid || 0), 0),
            monthlyEarned: closedSales.reduce((sum, item) => sum + Number(item.winningBid || item.currentBid || 0), 0),
            unreadNotifications: (user.notifications || []).filter((n) => !n.read).length,
            profileCompleteness: completeness,
            wonPurchases: await Auction.countDocuments({ winnerEmail: email, status: 'closed' }),
            platformUsers: await User.countDocuments(),
            committedBidBalance,
            availableToWithdraw: Math.max(0, normalizeCurrencyAmount(user.walletBalance) - committedBidBalance)
        };
        if (user.isSuperAdmin) {
            result.stats.treasuryBalance = treasuryUser?.walletBalance || 0;
        }

        const myListings = await Auction.find({ sellerEmail: email }).sort({ createdAt: -1 }).limit(10);
        const bidCountMap = await getBidCountMap(myListings.map(a => a._id));
        result.listings = await Promise.all(myListings.map(a => mapAuction(a, bidCountMap)));

        const recentBids = await Bid.find({ bidderEmail: email }).sort({ placedAt: -1 }).limit(10).populate('auctionId');
        result.recentBids = recentBids.filter(b => b.auctionId).map(b => ({ auctionId: b.auctionId._id, title: b.auctionId.title, amount: b.amount, placedAt: b.placedAt, status: b.auctionId.status }));

        result.notifications = (user.notifications || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20);
        result.savedSearches = user.savedSearches || [];
        result.gamification = {
            biddingStreak: closedWins.length,
            campusRank: Math.max(1, campusBuyers.filter((entry) => entry.winnerEmail === email).length),
            profileCompleteness: completeness,
            monthlySpent: result.stats.monthlySpent,
            monthlyEarned: result.stats.monthlyEarned,
            reviewsGiven
        };
        const watchlistItems = await Auction.find({ _id: { $in: user.watchlist || [] } }).sort({ endTime: 1 }).limit(10);
        result.watchlist = await Promise.all(watchlistItems.map(mapAuction));
        result.salesHistory = closedSales.slice(0, 10).map((item) => ({
            id: item._id,
            title: item.title,
            winningBid: item.winningBid,
            currentBid: item.currentBid,
            winnerEmail: item.winnerEmail
        }));
        result.purchaseHistory = closedWins.slice(0, 10).map((item) => ({
            id: item._id,
            title: item.title,
            winningBid: item.winningBid,
            currentBid: item.currentBid,
            sellerEmail: item.sellerEmail
        }));
        const walletLogs = await AuditLog.find({ userEmail: email, action: { $in: ['WALLET_TOP_UP', 'BID_PLACED', 'WINNER_ESCROW_DEBITED', 'TREASURY_ESCROW_RELEASED'] } }).sort({ createdAt: -1 }).limit(10);
        result.walletActivity = walletLogs;
        result.walletHistory = await getWalletTransactions(email, 8);

        if (user.isAdmin || user.isSuperAdmin) {
            const assignedRequests = await Auction.find({ assignedAdminEmail: email, status: { $in: ['pending_review', 'under_review'] } }).sort({ createdAt: 1 });
            result.adminWorkspace = {
                assignedReviews: assignedRequests.length,
                assignedRequests: await Promise.all(assignedRequests.map(mapAuction)),
                pendingTally: assignedRequests.length
            };
        }
        if (user.isSuperAdmin) {
            const admins = await User.find({ $or: [{ isAdmin: true }, { isSuperAdmin: true }, { role: 'admin' }] }).select('-passwordHash');
            const pendingReview = await Auction.find({ status: 'pending_review' });
            const underReview = await Auction.find({ status: 'under_review' });
            const rejected = await Auction.find({ status: 'rejected' }).sort({ reviewedAt: -1 }).limit(20);
            const onlineWindow = new Date(Date.now() - 2 * 60 * 1000);
            const adminEmails = admins.map((a) => a.email);
            const assignedCountsAgg = await Auction.aggregate([
                { $match: { assignedAdminEmail: { $in: adminEmails }, status: { $in: ['pending_review', 'under_review'] } } },
                { $group: { _id: '$assignedAdminEmail', count: { $sum: 1 } } }
            ]);
            const approvedCountsAgg = await Auction.aggregate([
                { $match: { reviewedByEmail: { $in: adminEmails }, status: 'active' } },
                { $group: { _id: '$reviewedByEmail', count: { $sum: 1 } } }
            ]);
            const rejectedCountsAgg = await Auction.aggregate([
                { $match: { reviewedByEmail: { $in: adminEmails }, status: 'rejected' } },
                { $group: { _id: '$reviewedByEmail', count: { $sum: 1 } } }
            ]);
            const assignedMap = Object.fromEntries(assignedCountsAgg.map((row) => [row._id, row.count]));
            const approvedMap = Object.fromEntries(approvedCountsAgg.map((row) => [row._id, row.count]));
            const rejectedMap = Object.fromEntries(rejectedCountsAgg.map((row) => [row._id, row.count]));
            result.superAdminWorkspace = {
                reviewQueue: pendingReview,
                admins: admins.map(a => ({ id: a._id, fullname: a.fullname, email: a.email, isSuperAdmin: a.isSuperAdmin, online: Boolean(a.lastSeenAt && a.lastSeenAt >= onlineWindow), assignedCount: assignedMap[a.email] || 0, approvedCount: approvedMap[a.email] || 0, rejectedCount: rejectedMap[a.email] || 0 })),
                candidates: (await User.find({ isAdmin: false, isSuperAdmin: false }).limit(20).select('fullname email role')).map((candidate) => ({ id: candidate._id, fullname: candidate.fullname, email: candidate.email, role: candidate.role })),
                metrics: { reviewQueue: pendingReview.length, unassigned: pendingReview.length, underReview: underReview.length, rejected: rejected.length },
                assignableReviewers: admins.filter((a) => a.lastSeenAt && a.lastSeenAt >= onlineWindow).map(a => ({ id: a._id, fullname: a.fullname, email: a.email, online: true })),
                adminOverview: admins.map(a => ({ id: a._id, fullname: a.fullname, email: a.email, isSuperAdmin: a.isSuperAdmin })),
                rejectionLog: rejected.map((item) => ({ title: item.title, sellerEmail: item.sellerEmail, reviewedByEmail: item.reviewedByEmail, rejectionReason: item.rejectionReason, reviewNotes: item.reviewNotes, reviewedAt: item.reviewedAt }))
            };
        }

        res.json(result);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

router.get('/analytics', async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const activeAuctions = await Auction.countDocuments({ status: 'active' });
        const closedAuctions = await Auction.countDocuments({ status: 'closed' });
        const pendingRequests = await Auction.countDocuments({ status: { $in: ['pending_review', 'under_review', 'rejected'] } });
        const adminCount = await User.countDocuments({ $or: [{ isAdmin: true }, { isSuperAdmin: true }, { role: 'admin' }] });
        const closed = await Auction.find({ status: 'closed', winningBid: { $gt: 0 } });
        const totalVolume = closed.reduce((acc, c) => acc + (c.winningBid || 0), 0);
        const totalBids = await Bid.countDocuments();
        res.json({ totalUsers, activeAuctions, closedAuctions, totalVolume, totalBids, pendingRequests, adminCount });
    } catch (e) { res.status(500).json({ error: 'Failed to fetch analytics' }); }
});

router.get('/recommendations/for-you', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-passwordHash');
        const activeAuctions = await Auction.find({
            status: 'active',
            sellerEmail: { $ne: user.email }
        }).sort({ endTime: 1, createdAt: -1 }).limit(100);
        const mapped = await Promise.all(activeAuctions.map((auction) => mapAuction(auction)));

        const userBids = await Bid.find({ bidderEmail: user.email }).populate('auctionId').limit(50);
        const categoryWeights = {};
        const trackCategory = (category, weight) => {
            const key = String(category || '').trim();
            if (!key) return;
            categoryWeights[key] = (categoryWeights[key] || 0) + weight;
        };

        userBids.forEach((bid) => trackCategory(bid.auctionId?.category, 3));
        (user.savedSearches || []).forEach((search) => trackCategory(search.category, 2));
        const watchedAuctions = await Auction.find({ _id: { $in: user.watchlist || [] } }).select('category currentBid startingPrice');
        watchedAuctions.forEach((auction) => trackCategory(auction.category, 4));

        const priceSamples = [
            ...watchedAuctions.map((auction) => Number(auction.currentBid || auction.startingPrice || 0)),
            ...userBids.map((bid) => Number(bid.amount || 0))
        ].filter((value) => value > 0);
        const preferredPrice = priceSamples.length
            ? Math.round(priceSamples.reduce((sum, value) => sum + value, 0) / priceSamples.length)
            : 0;

        const signals = {
            categoryWeights,
            preferredPrice,
            watchlistIds: new Set((user.watchlist || []).map((id) => String(id))),
            savedSearchTerms: (user.savedSearches || []).map((search) => String(search.query || '').trim().toLowerCase()).filter(Boolean),
            college: user.college || ''
        };

        const scored = mapped
            .map((auction) => ({ auction, score: buildUserRecommendationScore(auction, signals) }))
            .filter((row) => Number.isFinite(row.score))
            .sort((a, b) => b.score - a.score || Number(b.auction.bidCount || 0) - Number(a.auction.bidCount || 0))
            .slice(0, 8)
            .map((row) => row.auction);

        res.json(scored);
    } catch (e) {
        res.status(500).json({ error: 'Could not load recommendations.' });
    }
});

router.post('/admin-application', requireLogin, async (req, res) => {
    try {
        const { qualificationChecklist, note } = req.body;
        const user = await User.findById(req.user.id);
        user.adminApplication = {
            status: 'pending',
            qualificationChecklist: Array.isArray(qualificationChecklist) ? qualificationChecklist : [],
            note: String(note || '').trim(),
            appliedAt: new Date(),
            reviewedAt: null
        };
        await user.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save application' });
    }
});

router.get('/winner/:auctionId', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (!auction.winnerEmail) return res.json({ noBids: true });
        res.json({ email: auction.winnerEmail, name: auction.winnerName, winningBid: auction.winningBid, sellerEmail: auction.sellerEmail });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/meetup/:auctionId', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (![auction.sellerEmail, auction.winnerEmail].includes(req.user.email) && !(req.user.isAdmin || req.user.isSuperAdmin)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        auction.meetupSchedule = {
            proposedByEmail: req.user.email,
            proposedSlot: String(req.body.slot || '').trim(),
            location: String(req.body.location || '').trim(),
            notes: String(req.body.notes || '').trim(),
            status: 'proposed'
        };
        await auction.save();
        const other = req.user.email === auction.sellerEmail ? auction.winnerEmail : auction.sellerEmail;
        if (other) {
            await pushNotification(other, {
                type: 'meetup_proposed',
                title: 'Meetup proposed',
                message: `${req.user.name} suggested ${auction.meetupSchedule.proposedSlot || 'a meetup time'} for "${auction.title}".`,
                actionUrl: `/chat.html?auction=${auction._id}&with=${encodeURIComponent(req.user.email)}`,
                metadata: { auctionId: auction._id.toString() }
            });
        }
        res.json({ success: true, meetupSchedule: auction.meetupSchedule });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/delivery/:auctionId/confirm', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (req.user.email !== auction.winnerEmail) return res.status(403).json({ error: 'Only the buyer can confirm delivery' });
        const code = String(req.body.code || '').trim();
        if (!code || code !== String(auction.settlement?.sellerCode || '')) return res.status(400).json({ error: 'Invalid seller code' });
        auction.settlement = auction.settlement || {};
        auction.settlement.sellerCodeVerifiedAt = new Date();
        auction.settlement.buyerConfirmedAt = new Date();
        await auction.save();
        const releaseResult = await finalizeTreasuryRelease(auction, req.user.email);
        await pushNotification(auction.sellerEmail, {
            type: 'delivery_confirmed',
            title: 'Buyer verified seller code',
            message: releaseResult.released
                ? `The buyer verified the seller code for "${auction.title}" and escrow has been released.`
                : `The buyer verified the seller code for "${auction.title}". Seller must still verify the buyer code before escrow release.`,
            actionUrl: `/receipt.html?id=${auction._id}`,
            metadata: { auctionId: auction._id.toString() }
        });
        res.json({ success: true, released: releaseResult.released });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/delivery/:auctionId/seller-confirm', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (req.user.email !== auction.sellerEmail) return res.status(403).json({ error: 'Only the seller can confirm handover' });
        if (!auction.winnerEmail) return res.status(400).json({ error: 'This auction has no winning buyer.' });
        const code = String(req.body.code || '').trim();
        if (!code || code !== String(auction.settlement?.buyerCode || '')) return res.status(400).json({ error: 'Invalid buyer code' });

        auction.settlement = auction.settlement || {};
        auction.settlement.buyerCodeVerifiedAt = new Date();
        auction.settlement.sellerConfirmedAt = new Date();
        await auction.save();

        const releaseResult = await finalizeTreasuryRelease(auction, req.user.email);
        await pushNotification(auction.winnerEmail, {
            type: 'seller_confirmed_handover',
            title: 'Seller verified buyer code',
            message: releaseResult.released
                ? `The seller verified the buyer code for "${auction.title}" and escrow has been released.`
                : `The seller verified the buyer code for "${auction.title}". Buyer must still verify the seller code before escrow release.`,
            actionUrl: `/receipt.html?id=${auction._id}`,
            metadata: { auctionId: auction._id.toString() }
        });
        res.json({ success: true, released: releaseResult.released });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/disputes/:auctionId', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (![auction.sellerEmail, auction.winnerEmail].includes(req.user.email)) return res.status(403).json({ error: 'Unauthorized' });
        auction.dispute = {
            status: 'open',
            raisedByEmail: req.user.email,
            reason: String(req.body.reason || '').trim(),
            notes: String(req.body.notes || '').trim(),
            createdAt: new Date(),
            resolvedAt: null,
            resolvedByEmail: ''
        };
        await auction.save();
        const admins = await User.find({ $or: [{ isAdmin: true }, { isSuperAdmin: true }, { role: 'admin' }] }).select('email');
        for (const admin of admins) {
            await pushNotification(admin.email, {
                type: 'post_auction_dispute',
                title: 'Post-auction dispute opened',
                message: `A dispute was opened for "${auction.title}".`,
                actionUrl: `/dispute-center.html?id=${auction._id}`,
                metadata: { auctionId: auction._id.toString() }
            });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/disputes', requireLogin, async (req, res) => {
    try {
        const query = req.user.isAdmin || req.user.isSuperAdmin
            ? { 'dispute.status': 'open' }
            : { $or: [{ sellerEmail: req.user.email }, { winnerEmail: req.user.email }], 'dispute.status': 'open' };
        const auctions = await Auction.find(query).sort({ 'dispute.createdAt': -1 }).limit(50);
        const users = await User.find({
            email: {
                $in: auctions.flatMap((auction) => [auction.sellerEmail, auction.winnerEmail]).filter(Boolean)
            }
        }).select('email fullname phoneNumber phoneVerification');
        const userMap = Object.fromEntries(users.map((user) => [user.email, user]));
        res.json(auctions.map((auction) => ({
            id: auction._id,
            title: auction.title,
            sellerEmail: auction.sellerEmail,
            winnerEmail: auction.winnerEmail,
            dispute: auction.dispute || {},
            settlement: auction.settlement || {},
            seller: userMap[auction.sellerEmail] ? {
                name: userMap[auction.sellerEmail].fullname,
                phoneNumber: userMap[auction.sellerEmail].phoneNumber || '',
                phoneVerified: Boolean(userMap[auction.sellerEmail].phoneVerification?.verified)
            } : null,
            buyer: userMap[auction.winnerEmail] ? {
                name: userMap[auction.winnerEmail].fullname,
                phoneNumber: userMap[auction.winnerEmail].phoneNumber || '',
                phoneVerified: Boolean(userMap[auction.winnerEmail].phoneVerification?.verified)
            } : null
        })));
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/disputes/:auctionId/resolve', requireLogin, async (req, res) => {
    try {
        if (!(req.user.isAdmin || req.user.isSuperAdmin)) return res.status(403).json({ error: 'Admin access required' });
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        auction.dispute = auction.dispute || {};
        auction.dispute.status = 'resolved';
        auction.dispute.notes = String(req.body.notes || auction.dispute.notes || '').trim();
        auction.dispute.resolvedAt = new Date();
        auction.dispute.resolvedByEmail = req.user.email;
        await auction.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/reviews/:auctionId', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (![auction.sellerEmail, auction.winnerEmail].includes(req.user.email)) return res.status(403).json({ error: 'Unauthorized' });
        const reviewerRole = req.user.email === auction.sellerEmail ? 'seller' : 'buyer';
        const reviewTargetContext = reviewerRole === 'seller' ? 'buyer' : 'seller';
        const score = Math.max(1, Math.min(5, Number(req.body.score || 0)));
        if (!score) return res.status(400).json({ error: 'A star rating from 1 to 5 is required.' });
        auction.reviews = auction.reviews || [];
        const alreadyReviewed = auction.reviews.some((review) => review.reviewerEmail === req.user.email && review.reviewerRole === reviewerRole);
        if (alreadyReviewed) return res.status(400).json({ error: 'You have already reviewed this transaction.' });
        auction.reviews.push({
            reviewerEmail: req.user.email,
            reviewerRole,
            score,
            comment: String(req.body.comment || '').trim()
        });
        await auction.save();
        const otherEmail = req.user.email === auction.sellerEmail ? auction.winnerEmail : auction.sellerEmail;
        const otherUser = otherEmail ? await User.findOne({ email: otherEmail }) : null;
        if (otherUser) {
            otherUser.ratings = otherUser.ratings || [];
            otherUser.ratings.push({
                raterId: req.user.id,
                raterEmail: req.user.email,
                context: reviewTargetContext,
                score,
                comment: String(req.body.comment || '').trim()
            });
            await refreshUserReputation(otherUser);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/receipt/:auctionId', requireLogin, async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.auctionId);
        if (!auction) return res.status(404).json({ error: 'Auction not found' });
        if (![auction.sellerEmail, auction.winnerEmail].includes(req.user.email)) return res.status(403).json({ error: 'Unauthorized' });
        const [seller, buyer] = await Promise.all([
            User.findOne({ email: auction.sellerEmail }).select('fullname phoneNumber walletBalance trustScore phoneVerification sellerStats'),
            User.findOne({ email: auction.winnerEmail }).select('fullname phoneNumber walletBalance trustScore phoneVerification buyerStats')
        ]);
        res.json({
            id: auction._id,
            title: auction.title,
            finalPrice: auction.winningBid || auction.currentBid,
            sellerEmail: auction.sellerEmail,
            winnerEmail: auction.winnerEmail,
            date: auction.updatedAt,
            meetupSchedule: auction.meetupSchedule || null,
            settlement: auction.settlement || {},
            dispute: auction.dispute || {},
            seller: seller ? {
                name: seller.fullname,
                phoneNumber: seller.phoneNumber || '',
                trustScore: Number.isFinite(Number(seller.trustScore)) ? Number(seller.trustScore) : 100,
                phoneVerified: Boolean(seller.phoneVerification?.verified),
                sellerStats: seller.sellerStats || {}
            } : null,
            buyer: buyer ? {
                name: buyer.fullname,
                phoneNumber: buyer.phoneNumber || '',
                trustScore: Number.isFinite(Number(buyer.trustScore)) ? Number(buyer.trustScore) : 100,
                phoneVerified: Boolean(buyer.phoneVerification?.verified),
                buyerStats: buyer.buyerStats || {}
            } : null
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/listings/:id/velocity', async (req, res) => {
    try {
        const auction = await Auction.findById(req.params.id);
        if (!auction) return res.status(404).json({ error: 'Not found' });
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const recentBids = await Bid.countDocuments({ auctionId: auction._id, placedAt: { $gte: tenMinAgo } });
        const velocityScore = Math.min(100, recentBids * 20);
        if (!auction.velocityUpdatedAt || Date.now() - new Date(auction.velocityUpdatedAt).getTime() > 60000) {
            auction.velocityScore = velocityScore;
            auction.velocityUpdatedAt = new Date();
            await auction.save();
        }
        res.json({ velocityScore: auction.velocityScore || velocityScore });
    } catch (e) { res.json({ velocityScore: 0 }); }
});

module.exports = router;
