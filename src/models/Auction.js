const mongoose = require('mongoose');

const AuctionSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String },
    currentBid: { type: Number, required: true },
    bidCount: { type: Number, default: 0 },
    increment: { type: Number, default: 500 },
    images: [{ type: String }],
    image: { type: String },
    video: { type: String },
    videoUrl: { type: String },
    verified: { type: Boolean, default: false },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sellerEmail: { type: String, required: true },
    sellerName: { type: String },
    startTime: { type: Date, default: Date.now },
    endTime: { type: Date },
    status: { type: String, default: 'pending_review', enum: ['draft', 'pending_review', 'under_review', 'active', 'rejected', 'closed', 'cancelled'] },
    category: { type: String },
    reviewNotes: { type: String, default: '' },
    rejectionReason: { type: String, default: '' },
    reviewedAt: { type: Date },
    reviewedByEmail: { type: String },
    assignedAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAdminEmail: { type: String },
    assignedAt: { type: Date },
    submissionChecklist: {
        authenticityStatement: { type: Boolean, default: false },
        ownershipConfirmed: { type: Boolean, default: false },
        mediaQualityConfirmed: { type: Boolean, default: false },
        orientationConfirmed: { type: Boolean, default: false },
        termsAccepted: { type: Boolean, default: false }
    },
    moderationChecklist: {
        clearMediaOnly: { type: Boolean, default: false },
        noFacesVisible: { type: Boolean, default: false },
        noSexualContent: { type: Boolean, default: false },
        noViolenceOrHarm: { type: Boolean, default: false },
        categoryAndClaimsVerified: { type: Boolean, default: false }
    },
    specifications: { type: mongoose.Schema.Types.Mixed, default: {} },
    mediaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }],
    startingPrice: { type: Number, default: 0 },
    reservePrice: { type: Number, default: 0 },
    shippingDetails: {
        weight: { type: Number },
        dimensions: { type: String },
        cost: { type: Number, default: 0 }
    },
    winnerEmail: { type: String },
    winnerName: { type: String },
    winningBid: { type: Number },
    meetupSchedule: {
        slotLabel: { type: String, default: '' },
        notes: { type: String, default: '' },
        scheduledByEmail: { type: String, default: '' },
        scheduledAt: { type: Date }
    },
    deliveryChecklist: {
        itemMatchedDescription: { type: Boolean, default: false },
        meetupCompleted: { type: Boolean, default: false },
        paymentCompleted: { type: Boolean, default: false },
        markedReceivedBy: { type: String, default: '' },
        markedReceivedAt: { type: Date }
    },
    buyerReview: {
        rating: { type: Number },
        comment: { type: String, default: '' },
        reviewerEmail: { type: String, default: '' },
        createdAt: { type: Date }
    },
    sellerReview: {
        rating: { type: Number },
        comment: { type: String, default: '' },
        reviewerEmail: { type: String, default: '' },
        createdAt: { type: Date }
    },
    earlySellActivatedAt: { type: Date },
    earlySellDeadline: { type: Date },
    earlySellActivatedBy: { type: String },
    snipeCount: { type: Number, default: 0 },
    isWar: { type: Boolean, default: false },
    velocityScore: { type: Number, default: 0 },
    velocityUpdatedAt: { type: Date },
    viewCount: { type: Number, default: 0 }
}, { timestamps: true });

AuctionSchema.virtual('isExpired').get(function() {
    return this.endTime && this.endTime <= new Date() && this.status === 'active';
});

module.exports = mongoose.model('Auction', AuctionSchema);
