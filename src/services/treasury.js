const User = require('../models/User');

const TREASURY_EMAIL = 'treasury@gavel.local';

async function getTreasuryUser() {
    return User.findOne({ email: TREASURY_EMAIL });
}

async function ensureTreasuryUser() {
    return User.findOneAndUpdate(
        { email: TREASURY_EMAIL },
        {
            $setOnInsert: {
                fullname: 'Gavel Treasury',
                email: TREASURY_EMAIL,
                walletBalance: 0
            },
            $set: {
                isSuperAdmin: false,
                isAdmin: false,
                role: 'bidder'
            }
        },
        { new: true, upsert: true }
    );
}

function normalizeCurrencyAmount(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

async function creditTreasury(amount) {
    const treasury = await ensureTreasuryUser();
    treasury.walletBalance = normalizeCurrencyAmount(treasury.walletBalance) + normalizeCurrencyAmount(amount);
    await treasury.save();
    return treasury;
}

async function debitTreasury(amount) {
    const treasury = await ensureTreasuryUser();
    const nextBalance = normalizeCurrencyAmount(treasury.walletBalance) - normalizeCurrencyAmount(amount);
    if (nextBalance < 0) {
        throw new Error('TREASURY_INSUFFICIENT_FUNDS');
    }
    treasury.walletBalance = nextBalance;
    await treasury.save();
    return treasury;
}

module.exports = {
    TREASURY_EMAIL,
    getTreasuryUser,
    ensureTreasuryUser,
    normalizeCurrencyAmount,
    creditTreasury,
    debitTreasury
};
