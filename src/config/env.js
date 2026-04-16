const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

[
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), 'src/.env'),
    path.resolve(process.cwd(), 'src/.env.local'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '..', '.env.local')
].forEach((candidate) => {
    if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false });
    }
});

module.exports = {
    JWT_SECRET: process.env.JWT_SECRET || '',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/gavel',
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
    RAZORPAY_PAYMENT_LINK: process.env.RAZORPAY_PAYMENT_LINK || '',
    SMS_OTP_PROVIDER_URL: process.env.SMS_OTP_PROVIDER_URL || '',
    SMS_OTP_PROVIDER_TOKEN: process.env.SMS_OTP_PROVIDER_TOKEN || '',
    SUPER_ADMIN_EMAILS: (process.env.SUPER_ADMIN_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean),
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 3000
};
