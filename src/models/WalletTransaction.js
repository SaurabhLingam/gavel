const mongoose = require('mongoose');

const WalletTransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userEmail: { type: String, required: true, index: true },
    direction: { type: String, required: true, enum: ['credit', 'debit', 'info'] },
    type: {
        type: String,
        required: true,
        enum: [
            'wallet_topup',
            'wallet_withdrawal',
            'escrow_reserved',
            'escrow_released',
            'commitment_notice',
            'auction_settlement'
        ]
    },
    title: { type: String, required: true },
    details: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },
    availableBefore: { type: Number, default: null },
    availableAfter: { type: Number, default: null },
    auctionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Auction', default: null },
    auctionTitle: { type: String, default: '' },
    counterpartyEmail: { type: String, default: '' },
    counterpartyName: { type: String, default: '' },
    source: { type: String, default: 'system' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

WalletTransactionSchema.index({ userEmail: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
