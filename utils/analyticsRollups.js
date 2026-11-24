/**
 * ============================================
 * Analytics Rollup Jobs
 * ============================================
 * Builds daily aggregates for fast long-range analytics reporting.
 */

const AnalyticsEvent = require('../models/AnalyticsEvent');
const AnalyticsDailyRollup = require('../models/AnalyticsDailyRollup');
const { buildNonAlmightyMatch } = require('./analyticsFilters');

function startOfUtcDay(input) {
    const date = new Date(input);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function countDistinct(field, match) {
    const rows = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                [field]: { $nin: [null, ''] }
            }
        },
        { $group: { _id: `$${field}` } },
        { $count: 'count' }
    ]);
    return rows[0]?.count || 0;
}

async function aggregateLabelCounts(match, field, limit = 10) {
    return AnalyticsEvent.aggregate([
        { $match: match },
        {
            $group: {
                _id: { $ifNull: [`$${field}`, 'unknown'] },
                count: { $sum: 1 }
            }
        },
        {
            $project: {
                _id: 0,
                label: '$_id',
                count: 1
            }
        },
        { $sort: { count: -1 } },
        { $limit: limit }
    ]);
}

async function getTopPagesForMatch(match, limit = 10) {
    const pageViews = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                eventName: 'page_view',
                path: { $nin: [null, ''] }
            }
        },
        {
            $group: {
                _id: '$path',
                pageViews: { $sum: 1 },
                visitors: { $addToSet: '$visitorId' }
            }
        },
        {
            $project: {
                _id: 0,
                path: '$_id',
                pageViews: 1,
                uniqueVisitors: { $size: '$visitors' }
            }
        },
        { $sort: { pageViews: -1 } },
        { $limit: limit }
    ]);

    const exits = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                eventName: 'page_exit',
                path: { $nin: [null, ''] }
            }
        },
        {
            $group: {
                _id: '$path',
                exits: { $sum: 1 },
                avgDurationMs: { $avg: '$durationMs' }
            }
        }
    ]);

    const exitMap = new Map(
        exits.map((row) => [
            row._id,
            {
                exits: row.exits || 0,
                avgDurationSec: row.avgDurationMs ? Math.round((row.avgDurationMs / 1000) * 10) / 10 : 0
            }
        ])
    );

    return pageViews.map((row) => {
        const extra = exitMap.get(row.path) || { exits: 0, avgDurationSec: 0 };
        return {
            ...row,
            exits: extra.exits,
            avgDurationSec: extra.avgDurationSec
        };
    });
}

async function getTopSectionsForMatch(match, limit = 10) {
    return AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                appSection: { $nin: [null, ''] }
            }
        },
        {
            $group: {
                _id: '$appSection',
                events: { $sum: 1 },
                visitors: { $addToSet: '$visitorId' }
            }
        },
        {
            $project: {
                _id: 0,
                section: '$_id',
                events: 1,
                uniqueVisitors: { $size: '$visitors' }
            }
        },
        { $sort: { events: -1 } },
        { $limit: limit }
    ]);
}

async function buildDailyRollup(dayInput) {
    const day = startOfUtcDay(dayInput);
    const nextDay = addUtcDays(day, 1);
    const match = await buildNonAlmightyMatch({
        createdAt: {
            $gte: day,
            $lt: nextDay
        }
    });

    const [
        totalEvents,
        pageViews,
        apiErrors,
        jsErrors,
        uniqueVisitors,
        sessions,
        sourceBreakdown,
        countryBreakdown,
        languageBreakdown,
        viewportBreakdown,
        networkBreakdown,
        topPages,
        topSections
    ] = await Promise.all([
        AnalyticsEvent.countDocuments(match),
        AnalyticsEvent.countDocuments({ ...match, eventName: 'page_view' }),
        AnalyticsEvent.countDocuments({ ...match, eventName: 'api_error' }),
        AnalyticsEvent.countDocuments({ ...match, eventName: 'js_error' }),
        countDistinct('visitorId', match),
        countDistinct('sessionId', match),
        aggregateLabelCounts(match, 'source', 8),
        aggregateLabelCounts(match, 'country', 10),
        aggregateLabelCounts(match, 'language', 10),
        aggregateLabelCounts(match, 'viewportBucket', 8),
        aggregateLabelCounts(match, 'networkQuality', 8),
        getTopPagesForMatch(match, 10),
        getTopSectionsForMatch(match, 10)
    ]);

    const pwaBreakdown = await AnalyticsEvent.aggregate([
        { $match: match },
        {
            $project: {
                label: {
                    $cond: [{ $eq: ['$pwaInstalled', true] }, 'installed', 'browser']
                }
            }
        },
        { $group: { _id: '$label', count: { $sum: 1 } } },
        { $project: { _id: 0, label: '$_id', count: 1 } },
        { $sort: { count: -1 } }
    ]);

    const payload = {
        day,
        totalEvents,
        pageViews,
        uniqueVisitors,
        sessions,
        apiErrors,
        jsErrors,
        sourceBreakdown,
        countryBreakdown,
        languageBreakdown,
        viewportBreakdown,
        networkBreakdown,
        pwaBreakdown,
        topPages,
        topSections,
        generatedAt: new Date()
    };

    await AnalyticsDailyRollup.findOneAndUpdate(
        { day },
        { $set: payload },
        { upsert: true, setDefaultsOnInsert: true }
    );

    return payload;
}

async function refreshRecentRollups(days = 30) {
    const lookbackDays = Math.max(1, Number(days) || 30);
    const today = startOfUtcDay(new Date());
    const startedAt = Date.now();
    let built = 0;

    for (let offset = lookbackDays - 1; offset >= 0; offset -= 1) {
        const day = addUtcDays(today, -offset);
        await buildDailyRollup(day);
        built += 1;
    }

    return {
        built,
        lookbackDays,
        durationMs: Date.now() - startedAt
    };
}

let schedulerTimer = null;
let schedulerRunning = false;

function startAnalyticsRollupScheduler(options = {}) {
    if (schedulerTimer) return;

    const intervalMs = Math.max(
        60 * 1000,
        Number(options.intervalMs || process.env.ANALYTICS_ROLLUP_INTERVAL_MS) || (6 * 60 * 60 * 1000)
    );
    const lookbackDays = Math.max(
        1,
        Number(options.lookbackDays || process.env.ANALYTICS_ROLLUP_LOOKBACK_DAYS) || 30
    );

    async function runOnce() {
        if (schedulerRunning) return;
        schedulerRunning = true;
        try {
            const result = await refreshRecentRollups(lookbackDays);
            console.log(
                `[AnalyticsRollups] Refreshed ${result.built} days in ${result.durationMs}ms (lookback=${lookbackDays})`
            );
        } catch (error) {
            console.error('[AnalyticsRollups] Refresh failed:', error);
        } finally {
            schedulerRunning = false;
        }
    }

    runOnce().catch(() => {});
    schedulerTimer = setInterval(runOnce, intervalMs);
    if (typeof schedulerTimer.unref === 'function') {
        schedulerTimer.unref();
    }
    console.log(`[AnalyticsRollups] Scheduler started (interval=${intervalMs}ms, lookback=${lookbackDays} days)`);
}

module.exports = {
    buildDailyRollup,
    refreshRecentRollups,
    startAnalyticsRollupScheduler,
    startOfUtcDay
};
