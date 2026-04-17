const WalletTransaction = require('../models/WalletTransaction');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const Auction = require('../models/Auction');
const { normalizeCurrencyAmount } = require('./treasury');

function formatCurrency(amount) {
    return `₹${normalizeCurrencyAmount(amount).toLocaleString('en-IN')}`;
}

function toViewModel(doc) {
    if (!doc) return null;
    return {
        id: doc._id,
        userEmail: doc.userEmail,
        direction: doc.direction,
        type: doc.type,
        title: doc.title,
        details: doc.details || '',
        amount: normalizeCurrencyAmount(doc.amount),
        balanceBefore: doc.balanceBefore,
        balanceAfter: doc.balanceAfter,
        availableBefore: doc.availableBefore,
        availableAfter: doc.availableAfter,
        auctionId: doc.auctionId ? String(doc.auctionId) : '',
        auctionTitle: doc.auctionTitle || '',
        counterpartyEmail: doc.counterpartyEmail || '',
        counterpartyName: doc.counterpartyName || '',
        source: doc.source || 'system',
        meta: doc.meta || {},
        createdAt: doc.createdAt
    };
}

async function recordWalletTransaction(entry) {
    const payload = {
        userEmail: String(entry.userEmail || '').toLowerCase(),
        direction: entry.direction,
        type: entry.type,
        title: entry.title,
        details: entry.details || '',
        amount: normalizeCurrencyAmount(entry.amount),
        balanceBefore: Number.isFinite(Number(entry.balanceBefore)) ? Number(entry.balanceBefore) : null,
        balanceAfter: Number.isFinite(Number(entry.balanceAfter)) ? Number(entry.balanceAfter) : null,
        availableBefore: Number.isFinite(Number(entry.availableBefore)) ? Number(entry.availableBefore) : null,
        availableAfter: Number.isFinite(Number(entry.availableAfter)) ? Number(entry.availableAfter) : null,
        auctionId: entry.auctionId || null,
        auctionTitle: entry.auctionTitle || '',
        counterpartyEmail: String(entry.counterpartyEmail || '').toLowerCase(),
        counterpartyName: entry.counterpartyName || '',
        source: entry.source || 'system',
        meta: entry.meta || {}
    };

    if (!payload.userEmail || !payload.direction || !payload.type || !payload.title) {
        throw new Error('Missing wallet transaction fields.');
    }

    const doc = await WalletTransaction.create(payload);
    return toViewModel(doc);
}

function parseAmountFromText(text) {
    const match = String(text || '').match(/₹([\d,]+)/);
    if (!match) return 0;
    return normalizeCurrencyAmount(match[1].replace(/,/g, ''));
}

function normalizeLegacyWalletTransaction(entry) {
    if (!entry) return null;
    return {
        id: entry.id,
        userEmail: entry.userEmail,
        direction: entry.direction,
        type: entry.type,
        title: entry.title,
        details: entry.details,
        amount: normalizeCurrencyAmount(entry.amount),
        balanceBefore: entry.balanceBefore ?? null,
        balanceAfter: entry.balanceAfter ?? null,
        availableBefore: entry.availableBefore ?? null,
        availableAfter: entry.availableAfter ?? null,
        auctionId: entry.auctionId || '',
        auctionTitle: entry.auctionTitle || '',
        counterpartyEmail: entry.counterpartyEmail || '',
        counterpartyName: entry.counterpartyName || '',
        source: entry.source || 'legacy',
        meta: entry.meta || {},
        createdAt: entry.createdAt
    };
}

async function buildLegacyWalletHistory(userEmail, limit = 12) {
    const payments = await Payment.find({ userEmail }).sort({ createdAt: -1 }).limit(limit * 2);
    const auditLogs = await AuditLog.find({
        userEmail,
        action: { $in: ['WALLET_TOP_UP', 'WALLET_WITHDRAWAL'] }
    }).sort({ createdAt: -1 }).limit(limit * 2);

    const ledgers = [];
    payments.forEach((payment) => {
        if (payment.status !== 'paid') return;
        ledgers.push({
            id: `payment:${payment._id}`,
            userEmail,
            direction: 'credit',
            type: 'wallet_topup',
            title: 'Wallet top-up',
            details: `Top-up verified through Razorpay.`,
            amount: payment.amount,
            source: 'payment',
            meta: { paymentId: String(payment._id), provider: payment.provider },
            createdAt: payment.paidAt || payment.updatedAt || payment.createdAt
        });
    });

    auditLogs.forEach((log) => {
        const amount = parseAmountFromText(log.details);
        if (log.action === 'WALLET_WITHDRAWAL') {
            ledgers.push({
                id: `audit:${log._id}`,
                userEmail,
                direction: 'debit',
                type: 'wallet_withdrawal',
                title: 'Wallet withdrawal',
                details: log.details,
                amount,
                source: 'audit_log',
                meta: { action: log.action, auditLogId: String(log._id) },
                createdAt: log.createdAt
            });
        }
        if (log.action === 'WALLET_TOP_UP' && /^(Bypass|Manual)/i.test(String(log.details || ''))) {
            ledgers.push({
                id: `audit:${log._id}`,
                userEmail,
                direction: 'credit',
                type: 'wallet_topup',
                title: 'Wallet top-up',
                details: log.details,
                amount,
                source: 'audit_log',
                meta: { action: log.action, auditLogId: String(log._id) },
                createdAt: log.createdAt
            });
        }
    });

    const auctions = await Auction.find({
        $or: [
            { sellerEmail: userEmail, 'settlement.sellerWalletCredited': true },
            { winnerEmail: userEmail, status: 'closed', 'settlement.securedAmount': { $gt: 0 } }
        ]
    }).select('title sellerEmail winnerEmail winningBid currentBid settlement updatedAt createdAt');

    auctions.forEach((auction) => {
        const isSeller = auction.sellerEmail === userEmail && Boolean(auction.settlement?.sellerWalletCredited);
        const isBuyer = auction.winnerEmail === userEmail && normalizeCurrencyAmount(auction.settlement?.securedAmount) > 0;

        if (isSeller) {
            const amount = normalizeCurrencyAmount(auction.settlement?.treasuryReleasedAmount || auction.settlement?.securedAmount || auction.winningBid || auction.currentBid || 0);
            ledgers.push({
                id: `auction-seller:${auction._id}`,
                userEmail,
                direction: 'credit',
                type: 'escrow_released',
                title: 'Escrow released to wallet',
                details: `Escrow for "${auction.title}" was released after both settlement codes were verified.`,
                amount,
                source: 'auction_fallback',
                meta: { auctionId: String(auction._id), sellerEmail: auction.sellerEmail, winnerEmail: auction.winnerEmail },
                createdAt: auction.settlement?.creditedAt || auction.updatedAt || auction.createdAt
            });
        }

        if (isBuyer) {
            const amount = normalizeCurrencyAmount(auction.settlement?.securedAmount || 0);
            ledgers.push({
                id: `auction-buyer:${auction._id}`,
                userEmail,
                direction: 'debit',
                type: 'escrow_reserved',
                title: 'Reserve escrow locked',
                details: `Reserve escrow for "${auction.title}" was locked when the auction closed.`,
                amount,
                source: 'auction_fallback',
                meta: { auctionId: String(auction._id), sellerEmail: auction.sellerEmail, winnerEmail: auction.winnerEmail },
                createdAt: auction.updatedAt || auction.createdAt
            });
        }
    });

    const unique = new Map();
    ledgers
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .forEach((entry) => {
            if (!unique.has(entry.id)) unique.set(entry.id, entry);
        });

    return Array.from(unique.values())
        .slice(0, limit)
        .map(normalizeLegacyWalletTransaction);
}

async function getWalletTransactions(userEmail, limit = 12) {
    const docs = await WalletTransaction.find({ userEmail }).sort({ createdAt: -1 }).limit(limit);
    if (docs.length) {
        return docs.map(toViewModel);
    }
    return buildLegacyWalletHistory(userEmail, limit);
}

module.exports = {
    formatCurrency,
    recordWalletTransaction,
    getWalletTransactions,
    toViewModel
};
