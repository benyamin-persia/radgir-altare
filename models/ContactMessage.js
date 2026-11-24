/**
 * ============================================
 * ContactMessage Model
 * ============================================
 * Stores public contact-form submissions from about-contact.html
 * so messages are not lost when SMTP delivery fails or lands in spam.
 */

const mongoose = require('mongoose');

const contactMessageSchema = new mongoose.Schema({
    firstName: { type: String, trim: true, maxlength: 80, default: '' },
    lastName: { type: String, trim: true, maxlength: 80, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        maxlength: 120
    },
    message: {
        type: String,
        required: true,
        trim: true,
        maxlength: 4000
    },
    destinationEmail: { type: String, trim: true, maxlength: 120, default: '' }, // Owner inbox the notification targeted
    emailDelivered: { type: Boolean, default: false }, // True only when SMTP accepted the outbound mail
    emailError: { type: String, trim: true, maxlength: 500, default: '' },
    emailMessageId: { type: String, trim: true, maxlength: 200, default: '' },
    isRead: { type: Boolean, default: false, index: true },
    ipAddress: { type: String, trim: true, maxlength: 80, default: '' },
    userAgent: { type: String, trim: true, maxlength: 400, default: '' }
}, {
    timestamps: true
});

contactMessageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
