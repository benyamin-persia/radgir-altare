/**
 * ============================================
 * Analytics Daily Rollup Model
 * ============================================
 * Stores pre-computed daily analytics aggregates for fast long-range reports.
 */

const mongoose = require('mongoose');

const countLabelSchema = new mongoose.Schema(
    {
        label: { type: String, required: true, trim: true, maxlength: 200 },
        count: { type: Number, default: 0, min: 0 }
    },
    { _id: false }
);

const topPageSchema = new mongoose.Schema(
    {
        path: { type: String, trim: true, maxlength: 300 },
        pageViews: { type: Number, default: 0, min: 0 },
        uniqueVisitors: { type: Number, default: 0, min: 0 },
        exits: { type: Number, default: 0, min: 0 },
        avgDurationSec: { type: Number, default: 0, min: 0 }
    },
    { _id: false }
);

const topSectionSchema = new mongoose.Schema(
    {
        section: { type: String, trim: true, maxlength: 120 },
        events: { type: Number, default: 0, min: 0 },
        uniqueVisitors: { type: Number, default: 0, min: 0 }
    },
    { _id: false }
);

const analyticsDailyRollupSchema = new mongoose.Schema(
    {
        day: {
            type: Date,
            required: true,
            unique: true,
            index: true
        },
        totalEvents: { type: Number, default: 0, min: 0 },
        pageViews: { type: Number, default: 0, min: 0 },
        uniqueVisitors: { type: Number, default: 0, min: 0 },
        sessions: { type: Number, default: 0, min: 0 },
        apiErrors: { type: Number, default: 0, min: 0 },
        jsErrors: { type: Number, default: 0, min: 0 },
        sourceBreakdown: { type: [countLabelSchema], default: [] },
        countryBreakdown: { type: [countLabelSchema], default: [] },
        languageBreakdown: { type: [countLabelSchema], default: [] },
        viewportBreakdown: { type: [countLabelSchema], default: [] },
        networkBreakdown: { type: [countLabelSchema], default: [] },
        pwaBreakdown: { type: [countLabelSchema], default: [] },
        topPages: { type: [topPageSchema], default: [] },
        topSections: { type: [topSectionSchema], default: [] },
        generatedAt: { type: Date, default: Date.now }
    },
    {
        timestamps: true
    }
);

analyticsDailyRollupSchema.index({ day: -1 });

module.exports = mongoose.model('AnalyticsDailyRollup', analyticsDailyRollupSchema);
