/**
 * ============================================
 * Analytics Event Model
 * ============================================
 * Stores first-party analytics events for reporting.
 */

const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema(
    {
        eventName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80
        },
        visitorId: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120
        },
        sessionId: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        authenticated: {
            type: Boolean,
            default: false
        },
        path: {
            type: String,
            trim: true,
            maxlength: 300
        },
        fullUrl: {
            type: String,
            trim: true,
            maxlength: 1000
        },
        referrer: {
            type: String,
            trim: true,
            maxlength: 1000
        },
        pageTitle: {
            type: String,
            trim: true,
            maxlength: 300
        },
        appSection: {
            type: String,
            trim: true,
            maxlength: 120
        },
        elementTag: {
            type: String,
            trim: true,
            maxlength: 40
        },
        elementId: {
            type: String,
            trim: true,
            maxlength: 120
        },
        elementClasses: {
            type: String,
            trim: true,
            maxlength: 300
        },
        elementText: {
            type: String,
            trim: true,
            maxlength: 300
        },
        elementHref: {
            type: String,
            trim: true,
            maxlength: 1000
        },
        dataAction: {
            type: String,
            trim: true,
            maxlength: 120
        },
        durationMs: {
            type: Number,
            min: 0
        },
        statusCode: {
            type: Number,
            min: 100,
            max: 599
        },
        deviceType: {
            type: String,
            trim: true,
            maxlength: 40
        },
        os: {
            type: String,
            trim: true,
            maxlength: 60
        },
        browser: {
            type: String,
            trim: true,
            maxlength: 60
        },
        source: {
            type: String,
            trim: true,
            maxlength: 30
        },
        referrerHost: {
            type: String,
            trim: true,
            maxlength: 255
        },
        utmSource: {
            type: String,
            trim: true,
            maxlength: 120
        },
        utmMedium: {
            type: String,
            trim: true,
            maxlength: 120
        },
        utmCampaign: {
            type: String,
            trim: true,
            maxlength: 160
        },
        utmTerm: {
            type: String,
            trim: true,
            maxlength: 160
        },
        utmContent: {
            type: String,
            trim: true,
            maxlength: 160
        },
        viewportWidth: {
            type: Number,
            min: 0
        },
        viewportHeight: {
            type: Number,
            min: 0
        },
        viewportBucket: {
            type: String,
            trim: true,
            maxlength: 40
        },
        screenWidth: {
            type: Number,
            min: 0
        },
        screenHeight: {
            type: Number,
            min: 0
        },
        networkType: {
            type: String,
            trim: true,
            maxlength: 40
        },
        networkEffectiveType: {
            type: String,
            trim: true,
            maxlength: 40
        },
        networkDownlink: {
            type: Number,
            min: 0
        },
        networkRtt: {
            type: Number,
            min: 0
        },
        networkSaveData: {
            type: Boolean,
            default: false
        },
        networkQuality: {
            type: String,
            trim: true,
            maxlength: 40
        },
        pwaInstalled: {
            type: Boolean,
            default: false
        },
        displayMode: {
            type: String,
            trim: true,
            maxlength: 40
        },
        cardId: {
            type: String,
            trim: true,
            maxlength: 120
        },
        cardAction: {
            type: String,
            trim: true,
            maxlength: 80
        },
        cardNoAddress: {
            type: Boolean,
            default: null
        },
        cardHasCoords: {
            type: Boolean,
            default: null
        },
        language: {
            type: String,
            trim: true,
            maxlength: 20
        },
        country: {
            type: String,
            trim: true,
            maxlength: 10
        },
        ipHash: {
            type: String,
            trim: true,
            maxlength: 128
        },
        userAgent: {
            type: String,
            trim: true,
            maxlength: 600
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },
        clientTimestamp: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

analyticsEventSchema.index({ createdAt: -1 });
analyticsEventSchema.index({ eventName: 1, createdAt: -1 });
analyticsEventSchema.index({ path: 1, createdAt: -1 });
analyticsEventSchema.index({ appSection: 1, createdAt: -1 });
analyticsEventSchema.index({ visitorId: 1, createdAt: -1 });
analyticsEventSchema.index({ sessionId: 1, createdAt: -1 });
analyticsEventSchema.index({ userId: 1, createdAt: -1 });
analyticsEventSchema.index({ deviceType: 1, createdAt: -1 });
analyticsEventSchema.index({ source: 1, createdAt: -1 });
analyticsEventSchema.index({ referrerHost: 1, createdAt: -1 });
analyticsEventSchema.index({ utmSource: 1, utmCampaign: 1, createdAt: -1 });
analyticsEventSchema.index({ viewportBucket: 1, createdAt: -1 });
analyticsEventSchema.index({ networkQuality: 1, createdAt: -1 });
analyticsEventSchema.index({ pwaInstalled: 1, createdAt: -1 });
analyticsEventSchema.index({ cardId: 1, createdAt: -1 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
