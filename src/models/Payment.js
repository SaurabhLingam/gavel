const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userEmail: { type: String, required: true },
    provider: { type: String, default: 'razorpay', enum: ['razorpay'] },
    type: { type: String, default: 'wallet_topup', enum: ['wallet_topup'] },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, default: 'created', enum: ['created', 'paid', 'failed'] },
    razorpayOrderId: { type: String, default: '', index: true },
    razorpayPaymentId: { type: String, default: '' },
    razorpaySignature: { type: String, default: '' },
    receipt: { type: String, default: '' },
    notes: { type: mongoose.Schema.Types.Mixed, default: {} },
    paidAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Payment', PaymentSchema);
