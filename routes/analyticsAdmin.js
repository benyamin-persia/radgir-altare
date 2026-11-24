/**
 * ============================================
 * Almighty Analytics Reporting Routes
 * ============================================
 */

const mongoose = require('mongoose');
const os = require('os');
const express = require('express');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const AnalyticsDailyRollup = require('../models/AnalyticsDailyRollup');
const Person = require('../models/Person');
const User = require('../models/User');
const authenticate = require('../middleware/auth');
const { isAlmighty } = require('../middleware/authorize');
const { buildNonAlmightyMatch } = require('../utils/analyticsFilters');

const router = express.Router();

router.use(authenticate);
router.use(isAlmighty);

function parseDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseRange(query = {}) {
    const now = new Date();
    const toRaw = parseDate(query.to);
    const fromRaw = parseDate(query.from);

    const to = toRaw || now;
    const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    let from = fromRaw || defaultFrom;

    if (from > to) {
        const tmp = from;
        from = to;
        return { from, to: tmp };
    }

    const maxWindowMs = 730 * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > maxWindowMs) {
        from = new Date(to.getTime() - maxWindowMs);
    }

    return { from, to };
}

function getLimit(raw, fallback = 10, max = 100) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.floor(parsed));
}

function startOfUtcDay(input) {
    const date = new Date(input);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKey(input) {
    const date = new Date(input);
    return date.toISOString().slice(0, 10);
}

function weekStartUtc(input) {
    const day = startOfUtcDay(input);
    const weekday = (day.getUTCDay() + 6) % 7;
    day.setUTCDate(day.getUTCDate() - weekday);
    return day;
}

function mongoReadyStateLabel(state) {
    switch (state) {
        case 0:
            return 'disconnected';
        case 1:
            return 'connected';
        case 2:
            return 'connecting';
        case 3:
            return 'disconnecting';
        default:
            return 'unknown';
    }
}

function formatBytes(bytes) {
    const num = Number(bytes || 0);
    if (!Number.isFinite(num) || num <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = num;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function safeText(value) {
    if (value === null || value === undefined) return '-';
    const text = String(value).trim();
    return text || '-';
}

/**
 * Match only unexpected API failures for health alerts.
 * Excludes auth denials, invalid logins, verify-email gates, and network/offline noise.
 */
function buildUnexpectedApiErrorMatch(match = {}) {
    return {
        ...match,
        eventName: 'api_error',
        $nor: [
            { statusCode: { $in: [0, 401, 403] } },
            { statusCode: { $exists: false } },
            { statusCode: null },
            {
                'metadata.message': {
                    $regex: /invalid credentials|verify your email|access denied|no token|network error/i
                }
            }
        ]
    };
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

async function getTopPages(match, limit = 10) {
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

async function getTopClicks(match, limit = 12) {
    return AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                eventName: 'ui_click'
            }
        },
        {
            $project: {
                label: {
                    $ifNull: [
                        '$elementText',
                        {
                            $ifNull: ['$elementId', { $ifNull: ['$dataAction', '$path'] }]
                        }
                    ]
                },
                appSection: { $ifNull: ['$appSection', 'unknown'] },
                action: {
                    $ifNull: [
                        '$cardAction',
                        { $ifNull: ['$metadata.action', { $ifNull: ['$dataAction', 'click'] }] }
                    ]
                },
                zone: { $ifNull: ['$metadata.appZone', 'unknown'] }
            }
        },
        {
            $group: {
                _id: { label: '$label', appSection: '$appSection', action: '$action', zone: '$zone' },
                clicks: { $sum: 1 }
            }
        },
        {
            $project: {
                _id: 0,
                label: {
                    $cond: [{ $or: [{ $eq: ['$_id.label', null] }, { $eq: ['$_id.label', ''] }] }, 'unknown', '$_id.label']
                },
                appSection: '$_id.appSection',
                action: '$_id.action',
                zone: '$_id.zone',
                clicks: 1
            }
        },
        { $sort: { clicks: -1 } },
        { $limit: limit }
    ]);
}

/**
 * Tab + click engagement: which tabs, when (hour), where (path/country/zone), recent activity.
 * Includes dedicated tab_change events and legacy ui_click tab_change actions.
 */
async function getEngagementInsights(match, limit = 20) {
    const tabEventMatch = {
        ...match,
        $or: [
            { eventName: 'tab_change' },
            { eventName: 'ui_click', cardAction: 'tab_change' },
            { eventName: 'ui_click', 'metadata.action': 'tab_change' }
        ]
    };

    const tabProjection = {
        $addFields: {
            tabGroup: {
                $ifNull: [
                    '$metadata.tabGroup',
                    {
                        $cond: [
                            { $regexMatch: { input: { $ifNull: ['$elementClasses', ''] }, regex: 'portal-tab|data-portal-tab' } },
                            'portal',
                            {
                                $cond: [
                                    { $regexMatch: { input: { $ifNull: ['$elementClasses', ''] }, regex: 'dashboard-tab' } },
                                    'dashboard',
                                    {
                                        $cond: [
                                            { $regexMatch: { input: { $ifNull: ['$elementClasses', ''] }, regex: 'mobile-list-tab' } },
                                            'people_address_mobile',
                                            'people_address'
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            tabName: {
                $ifNull: [
                    '$metadata.tabName',
                    { $ifNull: ['$elementText', { $ifNull: ['$elementId', 'unknown'] }] }
                ]
            },
            previousTab: { $ifNull: ['$metadata.previousTab', null] },
            tabTransition: { $ifNull: ['$metadata.tabTransition', null] },
            appZone: { $ifNull: ['$metadata.appZone', 'unknown'] },
            pathWithHash: { $ifNull: ['$metadata.pathWithHash', '$path'] },
            hourBucket: {
                $ifNull: [
                    '$metadata.localHour',
                    { $hour: { date: '$createdAt', timezone: 'UTC' } }
                ]
            }
        }
    };

    const [
        tabClicks,
        tabsByHour,
        tabsByWhere,
        tabTransitions,
        clickActions,
        clickZones,
        recentTabClicks,
        uiClickCount,
        tabChangeCount
    ] = await Promise.all([
        AnalyticsEvent.aggregate([
            { $match: tabEventMatch },
            tabProjection,
            {
                $group: {
                    _id: { tabGroup: '$tabGroup', tabName: '$tabName', appSection: { $ifNull: ['$appSection', 'unknown'] } },
                    clicks: { $sum: 1 },
                    uniqueVisitors: { $addToSet: '$visitorId' },
                    lastClickedAt: { $max: '$createdAt' }
                }
            },
            {
                $project: {
                    _id: 0,
                    tabGroup: '$_id.tabGroup',
                    tabName: '$_id.tabName',
                    appSection: '$_id.appSection',
                    clicks: 1,
                    uniqueVisitors: { $size: '$uniqueVisitors' },
                    lastClickedAt: 1
                }
            },
            { $sort: { clicks: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: tabEventMatch },
            tabProjection,
            {
                $group: {
                    _id: { hour: '$hourBucket', tabName: '$tabName', tabGroup: '$tabGroup' },
                    clicks: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    hour: '$_id.hour',
                    tabGroup: '$_id.tabGroup',
                    tabName: '$_id.tabName',
                    clicks: 1
                }
            },
            { $sort: { hour: 1, clicks: -1 } },
            { $limit: Math.max(limit * 2, 48) }
        ]),
        AnalyticsEvent.aggregate([
            { $match: tabEventMatch },
            tabProjection,
            {
                $group: {
                    _id: {
                        path: { $ifNull: ['$pathWithHash', 'unknown'] },
                        country: { $ifNull: ['$country', 'unknown'] },
                        viewportBucket: { $ifNull: ['$viewportBucket', { $ifNull: ['$metadata.viewportBucket', 'unknown'] }] },
                        appZone: '$appZone'
                    },
                    clicks: { $sum: 1 },
                    uniqueVisitors: { $addToSet: '$visitorId' }
                }
            },
            {
                $project: {
                    _id: 0,
                    path: '$_id.path',
                    country: '$_id.country',
                    viewportBucket: '$_id.viewportBucket',
                    appZone: '$_id.appZone',
                    clicks: 1,
                    uniqueVisitors: { $size: '$uniqueVisitors' }
                }
            },
            { $sort: { clicks: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: tabEventMatch },
            tabProjection,
            { $match: { tabTransition: { $nin: [null, ''] } } },
            {
                $group: {
                    _id: { transition: '$tabTransition', tabGroup: '$tabGroup' },
                    clicks: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    transition: '$_id.transition',
                    tabGroup: '$_id.tabGroup',
                    clicks: 1
                }
            },
            { $sort: { clicks: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: { ...match, eventName: 'ui_click' } },
            {
                $group: {
                    _id: {
                        $ifNull: [
                            '$cardAction',
                            { $ifNull: ['$metadata.action', { $ifNull: ['$dataAction', 'click'] }] }
                        ]
                    },
                    clicks: { $sum: 1 },
                    uniqueVisitors: { $addToSet: '$visitorId' }
                }
            },
            {
                $project: {
                    _id: 0,
                    action: '$_id',
                    clicks: 1,
                    uniqueVisitors: { $size: '$uniqueVisitors' }
                }
            },
            { $sort: { clicks: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: { ...match, eventName: 'ui_click' } },
            {
                $group: {
                    _id: { $ifNull: ['$metadata.appZone', 'unknown'] },
                    clicks: { $sum: 1 },
                    uniqueVisitors: { $addToSet: '$visitorId' }
                }
            },
            {
                $project: {
                    _id: 0,
                    zone: '$_id',
                    clicks: 1,
                    uniqueVisitors: { $size: '$uniqueVisitors' }
                }
            },
            { $sort: { clicks: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: tabEventMatch },
            tabProjection,
            { $sort: { createdAt: -1 } },
            { $limit: Math.min(limit, 30) },
            {
                $project: {
                    _id: 0,
                    createdAt: 1,
                    tabGroup: 1,
                    tabName: 1,
                    previousTab: 1,
                    tabTransition: 1,
                    appSection: { $ifNull: ['$appSection', 'unknown'] },
                    path: { $ifNull: ['$pathWithHash', '$path'] },
                    country: { $ifNull: ['$country', 'unknown'] },
                    viewportBucket: { $ifNull: ['$viewportBucket', { $ifNull: ['$metadata.viewportBucket', 'unknown'] }] },
                    appZone: 1,
                    visitorId: 1
                }
            }
        ]),
        AnalyticsEvent.countDocuments({ ...match, eventName: 'ui_click' }),
        AnalyticsEvent.countDocuments({
            ...match,
            $or: [
                { eventName: 'tab_change' },
                { eventName: 'ui_click', cardAction: 'tab_change' }
            ]
        })
    ]);

    return {
        tabClicks,
        tabsByHour,
        tabsByWhere,
        tabTransitions,
        clickActions,
        clickZones,
        recentTabClicks,
        totals: {
            uiClicks: uiClickCount,
            tabChanges: tabChangeCount
        }
    };
}

async function getDeviceBreakdown(match, limit = 10) {
    const [devices, browsers, os] = await Promise.all([
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$deviceType', 'unknown'] },
                    count: { $sum: 1 }
                }
            },
            { $project: { _id: 0, label: '$_id', count: 1 } },
            { $sort: { count: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$browser', 'unknown'] },
                    count: { $sum: 1 }
                }
            },
            { $project: { _id: 0, label: '$_id', count: 1 } },
            { $sort: { count: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$os', 'unknown'] },
                    count: { $sum: 1 }
                }
            },
            { $project: { _id: 0, label: '$_id', count: 1 } },
            { $sort: { count: -1 } },
            { $limit: limit }
        ])
    ]);

    return { devices, browsers, os };
}

// --- continued below ---
async function getTimelineFromRaw(match) {
    return AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                eventName: 'page_view'
            }
        },
        {
            $group: {
                _id: {
                    $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                },
                pageViews: { $sum: 1 },
                visitors: { $addToSet: '$visitorId' },
                sessions: { $addToSet: '$sessionId' }
            }
        },
        {
            $project: {
                _id: 0,
                date: '$_id',
                pageViews: 1,
                uniqueVisitors: { $size: '$visitors' },
                sessions: { $size: '$sessions' }
            }
        },
        { $sort: { date: 1 } }
    ]);
}

async function getTimelineFromRollups(range) {
    const fromDay = startOfUtcDay(range.from);
    const toDay = startOfUtcDay(range.to);

    const rows = await AnalyticsDailyRollup.find({
        day: {
            $gte: fromDay,
            $lte: toDay
        }
    }).sort({ day: 1 }).lean();

    return rows.map((row) => ({
        date: dateKey(row.day),
        pageViews: row.pageViews || 0,
        uniqueVisitors: row.uniqueVisitors || 0,
        sessions: row.sessions || 0
    }));
}

async function getTimeline(match, range) {
    const windowMs = range.to.getTime() - range.from.getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    if (windowMs > ninetyDaysMs) {
        const rollupRows = await getTimelineFromRollups(range);
        if (rollupRows.length > 0) {
            return {
                source: 'rollup',
                rows: rollupRows
            };
        }
    }

    return {
        source: 'raw',
        rows: await getTimelineFromRaw(match)
    };
}

async function getTopSections(match, limit = 10) {
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

async function getNavigationFlows(match, limit = 12) {
    const sessions = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                eventName: { $in: ['page_view', 'route_change'] },
                path: { $nin: [null, ''] },
                sessionId: { $nin: [null, ''] }
            }
        },
        { $sort: { sessionId: 1, createdAt: 1 } },
        {
            $group: {
                _id: '$sessionId',
                paths: { $push: '$path' }
            }
        }
    ]);

    const flowMap = new Map();
    for (const session of sessions) {
        const paths = Array.isArray(session.paths) ? session.paths : [];
        let prev = null;
        for (const rawPath of paths) {
            const current = String(rawPath || '').trim();
            if (!current) continue;
            if (prev && prev !== current) {
                const key = `${prev} -> ${current}`;
                flowMap.set(key, (flowMap.get(key) || 0) + 1);
            }
            prev = current;
        }
    }

    return Array.from(flowMap.entries())
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

async function countUniqueVisitorsByStep(match, extraMatch) {
    const rows = await AnalyticsEvent.aggregate([
        { $match: { ...match, ...extraMatch, visitorId: { $nin: [null, ''] } } },
        { $group: { _id: '$visitorId' } },
        { $count: 'count' }
    ]);
    return rows[0]?.count || 0;
}

async function getFunnel(match) {
    const steps = [
        {
            key: 'landing',
            label: 'Landing (home)',
            condition: { eventName: 'page_view', path: { $in: ['/', '/index.html'] } }
        },
        {
            key: 'register_view',
            label: 'Register page view',
            condition: { eventName: 'page_view', path: '/register.html' }
        },
        {
            key: 'register_success',
            label: 'Register success',
            condition: { eventName: 'auth_register_success' }
        },
        {
            key: 'login_success',
            label: 'Login success',
            condition: { eventName: 'auth_login_success' }
        },
        {
            key: 'dashboard_view',
            label: 'Dashboard view',
            condition: { eventName: 'page_view', path: '/dashboard.html' }
        },
        {
            key: 'create_person_view',
            label: 'Create-person view',
            condition: { eventName: 'page_view', path: '/create-person.html' }
        },
        {
            key: 'create_person_submit',
            label: 'Create-person form submit',
            condition: {
                eventName: 'form_submit',
                $or: [{ 'metadata.formId': 'personForm' }, { elementId: 'personForm' }]
            }
        },
        {
            key: 'create_person_success',
            label: 'Create-person success',
            condition: { eventName: 'create_person_submit_success' }
        }
    ];

    const results = [];
    for (const step of steps) {
        const uniqueVisitors = await countUniqueVisitorsByStep(match, step.condition);
        results.push({
            key: step.key,
            label: step.label,
            uniqueVisitors
        });
    }
    return results;
}

async function getOverview(match) {
    const unexpectedApiErrorMatch = buildUnexpectedApiErrorMatch(match);

    const [
        totalEvents,
        pageViews,
        apiErrors,
        jsErrors,
        uniqueVisitors,
        sessions,
        authVisitors,
        returningVisitorsRows,
        bounceRows,
        avgDurationRows,
        pwaInstalledEvents,
        searchTraffic,
        socialTraffic
    ] = await Promise.all([
        AnalyticsEvent.countDocuments(match),
        AnalyticsEvent.countDocuments({ ...match, eventName: 'page_view' }),
        AnalyticsEvent.countDocuments(unexpectedApiErrorMatch),
        AnalyticsEvent.countDocuments({ ...match, eventName: 'js_error' }),
        countDistinct('visitorId', match),
        countDistinct('sessionId', match),
        countDistinct('visitorId', { ...match, authenticated: true }),
        AnalyticsEvent.aggregate([
            { $match: { ...match, visitorId: { $nin: [null, ''] }, sessionId: { $nin: [null, ''] } } },
            { $group: { _id: '$visitorId', sessions: { $addToSet: '$sessionId' } } },
            { $project: { sessionCount: { $size: '$sessions' } } },
            { $match: { sessionCount: { $gt: 1 } } },
            { $count: 'count' }
        ]),
        AnalyticsEvent.aggregate([
            { $match: { ...match, eventName: 'page_view', sessionId: { $nin: [null, ''] } } },
            { $group: { _id: '$sessionId', pageViews: { $sum: 1 } } },
            {
                $group: {
                    _id: null,
                    totalSessions: { $sum: 1 },
                    bounceSessions: {
                        $sum: { $cond: [{ $lte: ['$pageViews', 1] }, 1, 0] }
                    }
                }
            }
        ]),
        AnalyticsEvent.aggregate([
            { $match: { ...match, eventName: 'page_exit', durationMs: { $gt: 0 } } },
            { $group: { _id: null, avgDurationMs: { $avg: '$durationMs' } } }
        ]),
        AnalyticsEvent.countDocuments({ ...match, pwaInstalled: true }),
        AnalyticsEvent.countDocuments({ ...match, source: 'search' }),
        AnalyticsEvent.countDocuments({ ...match, source: 'social' })
    ]);

    const returningVisitors = returningVisitorsRows[0]?.count || 0;
    const bounce = bounceRows[0] || { totalSessions: 0, bounceSessions: 0 };
    const bounceRate = bounce.totalSessions > 0
        ? Math.round((bounce.bounceSessions / bounce.totalSessions) * 1000) / 10
        : 0;
    const avgDurationSec = avgDurationRows[0]?.avgDurationMs
        ? Math.round((avgDurationRows[0].avgDurationMs / 1000) * 10) / 10
        : 0;

    return {
        totalEvents,
        pageViews,
        uniqueVisitors,
        sessions,
        returningVisitors,
        authVisitors,
        bounceRate,
        avgSessionDurationSec: avgDurationSec,
        apiErrors,
        jsErrors,
        pwaInstalledEvents,
        searchTraffic,
        socialTraffic
    };
}

async function getSignedInUsers(match, limit = 10) {
    const rows = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                authenticated: true,
                userId: { $ne: null }
            }
        },
        {
            $group: {
                _id: '$userId',
                events: { $sum: 1 },
                sessions: { $addToSet: '$sessionId' }
            }
        },
        {
            $project: {
                _id: 0,
                userId: '$_id',
                events: 1,
                sessions: { $size: '$sessions' }
            }
        },
        { $sort: { events: -1 } },
        { $limit: limit }
    ]);

    if (!rows.length) return [];

    const userIds = rows.map((row) => row.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('username role');
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    return rows.map((row) => {
        const user = userMap.get(String(row.userId));
        return {
            userId: row.userId,
            username: user?.username || 'unknown',
            role: user?.role || 'unknown',
            events: row.events,
            sessions: row.sessions
        };
    });
}

async function getAcquisition(match, limit = 10) {
    const [sources, referrers, countries, languages, campaigns] = await Promise.all([
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$source', 'unknown'] },
                    events: { $sum: 1 },
                    visitors: { $addToSet: '$visitorId' }
                }
            },
            {
                $project: {
                    _id: 0,
                    source: '$_id',
                    events: 1,
                    uniqueVisitors: { $size: '$visitors' }
                }
            },
            { $sort: { events: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            {
                $match: {
                    ...match,
                    referrerHost: { $nin: [null, ''] }
                }
            },
            {
                $group: {
                    _id: '$referrerHost',
                    events: { $sum: 1 },
                    visitors: { $addToSet: '$visitorId' }
                }
            },
            {
                $project: {
                    _id: 0,
                    referrerHost: '$_id',
                    events: 1,
                    uniqueVisitors: { $size: '$visitors' }
                }
            },
            { $sort: { events: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$country', 'unknown'] },
                    events: { $sum: 1 }
                }
            },
            { $project: { _id: 0, country: '$_id', events: 1 } },
            { $sort: { events: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$language', 'unknown'] },
                    events: { $sum: 1 }
                }
            },
            { $project: { _id: 0, language: '$_id', events: 1 } },
            { $sort: { events: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            {
                $match: {
                    ...match,
                    $or: [
                        { utmSource: { $nin: [null, ''] } },
                        { utmCampaign: { $nin: [null, ''] } },
                        { utmMedium: { $nin: [null, ''] } }
                    ]
                }
            },
            {
                $group: {
                    _id: {
                        source: { $ifNull: ['$utmSource', 'unknown'] },
                        campaign: { $ifNull: ['$utmCampaign', 'unknown'] },
                        medium: { $ifNull: ['$utmMedium', 'unknown'] }
                    },
                    events: { $sum: 1 },
                    visitors: { $addToSet: '$visitorId' }
                }
            },
            {
                $project: {
                    _id: 0,
                    utmSource: '$_id.source',
                    utmCampaign: '$_id.campaign',
                    utmMedium: '$_id.medium',
                    events: 1,
                    uniqueVisitors: { $size: '$visitors' }
                }
            },
            { $sort: { events: -1 } },
            { $limit: limit }
        ])
    ]);

    return {
        sources,
        referrers,
        countries,
        languages,
        campaigns
    };
}

async function getTechnicalHealth(match, limit = 10) {
    const [network, viewport, pwa, apiErrors, jsErrors] = await Promise.all([
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$networkQuality', 'unknown'] },
                    events: { $sum: 1 }
                }
            },
            { $project: { _id: 0, quality: '$_id', events: 1 } },
            { $sort: { events: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $ifNull: ['$viewportBucket', 'unknown'] },
                    events: { $sum: 1 }
                }
            },
            { $project: { _id: 0, bucket: '$_id', events: 1 } },
            { $sort: { events: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: {
                        $cond: [{ $eq: ['$pwaInstalled', true] }, 'installed', 'browser']
                    },
                    events: { $sum: 1 }
                }
            },
            { $project: { _id: 0, mode: '$_id', events: 1 } },
            { $sort: { events: -1 } }
        ]),
        AnalyticsEvent.aggregate([
            {
                $match: buildUnexpectedApiErrorMatch(match)
            },
            {
                $group: {
                    _id: {
                        path: { $ifNull: ['$path', 'unknown'] },
                        statusCode: { $ifNull: ['$statusCode', 'n/a'] }
                    },
                    errors: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    path: '$_id.path',
                    statusCode: '$_id.statusCode',
                    errors: 1
                }
            },
            { $sort: { errors: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            {
                $match: {
                    ...match,
                    eventName: 'js_error'
                }
            },
            {
                $group: {
                    _id: {
                        message: { $ifNull: ['$metadata.message', 'unknown'] },
                        path: { $ifNull: ['$path', 'unknown'] }
                    },
                    errors: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    message: '$_id.message',
                    path: '$_id.path',
                    errors: 1
                }
            },
            { $sort: { errors: -1 } },
            { $limit: limit }
        ])
    ]);

    return {
        network,
        viewport,
        pwa,
        apiErrors,
        jsErrors
    };
}

async function getContentPerformance(match, limit = 10) {
    const cardRows = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                cardId: { $nin: [null, ''] }
            }
        },
        {
            $group: {
                _id: '$cardId',
                interactions: { $sum: 1 },
                uniqueVisitors: { $addToSet: '$visitorId' },
                opens: {
                    $sum: {
                        $cond: [
                            { $in: ['$cardAction', ['card_open', 'open', 'listing_open']] },
                            1,
                            0
                        ]
                    }
                },
                likes: { $sum: { $cond: [{ $eq: ['$cardAction', 'like'] }, 1, 0] } },
                dislikes: { $sum: { $cond: [{ $eq: ['$cardAction', 'dislike'] }, 1, 0] } },
                comments: { $sum: { $cond: [{ $eq: ['$cardAction', 'comment'] }, 1, 0] } },
                shares: { $sum: { $cond: [{ $eq: ['$cardAction', 'share'] }, 1, 0] } },
                edits: { $sum: { $cond: [{ $eq: ['$cardAction', 'edit'] }, 1, 0] } },
                deletes: { $sum: { $cond: [{ $eq: ['$cardAction', 'delete'] }, 1, 0] } },
                noAddressInteractions: {
                    $sum: { $cond: [{ $eq: ['$cardNoAddress', true] }, 1, 0] }
                }
            }
        },
        {
            $project: {
                _id: 0,
                cardId: '$_id',
                interactions: 1,
                uniqueVisitors: { $size: '$uniqueVisitors' },
                opens: 1,
                likes: 1,
                dislikes: 1,
                comments: 1,
                shares: 1,
                edits: 1,
                deletes: 1,
                noAddressInteractions: 1
            }
        },
        { $sort: { interactions: -1 } },
        { $limit: limit }
    ]);

    const interactionByAddressType = await AnalyticsEvent.aggregate([
        {
            $match: {
                ...match,
                cardId: { $nin: [null, ''] }
            }
        },
        {
            $group: {
                _id: {
                    $cond: [{ $eq: ['$cardNoAddress', true] }, 'without_address', 'with_address']
                },
                interactions: { $sum: 1 },
                visitors: { $addToSet: '$visitorId' }
            }
        },
        {
            $project: {
                _id: 0,
                type: '$_id',
                interactions: 1,
                uniqueVisitors: { $size: '$visitors' }
            }
        },
        { $sort: { interactions: -1 } }
    ]);

    if (!cardRows.length) {
        return {
            topCards: [],
            interactionByAddressType,
            topTags: []
        };
    }

    const objectIdCardIds = cardRows
        .map((row) => row.cardId)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

    const people = objectIdCardIds.length > 0
        ? await Person.find({ _id: { $in: objectIdCardIds } })
            .select('name familyName tags addressStatus')
            .lean()
        : [];

    const personMap = new Map(people.map((p) => [String(p._id), p]));
    const topTagsMap = new Map();

    const topCards = cardRows.map((row) => {
        const person = personMap.get(String(row.cardId));
        const personName = person
            ? [person.name || '', person.familyName || ''].join(' ').trim()
            : '';
        const tags = Array.isArray(person?.tags) ? person.tags : [];

        for (const tag of tags) {
            const key = String(tag || '').trim();
            if (!key) continue;
            topTagsMap.set(key, (topTagsMap.get(key) || 0) + row.interactions);
        }

        return {
            ...row,
            personName: personName || row.cardId,
            addressStatus: person?.addressStatus || 'unknown'
        };
    });

    const topTags = Array.from(topTagsMap.entries())
        .map(([tag, interactions]) => ({ tag, interactions }))
        .sort((a, b) => b.interactions - a.interactions)
        .slice(0, limit);

    return {
        topCards,
        interactionByAddressType,
        topTags
    };
}

async function getRetentionCohorts(range, limit = 24) {
    const cohortUsers = await User.find({
        role: { $ne: 'Almighty' },
        createdAt: {
            $gte: range.from,
            $lte: range.to
        }
    }).select('_id createdAt').lean();

    if (!cohortUsers.length) return [];

    const userMap = new Map();
    let minCreated = cohortUsers[0].createdAt;
    let maxCreated = cohortUsers[0].createdAt;

    for (const user of cohortUsers) {
        const userId = String(user._id);
        const createdAt = new Date(user.createdAt);
        const cohortStart = weekStartUtc(createdAt);
        userMap.set(userId, {
            createdAt,
            cohort: dateKey(cohortStart),
            d1: false,
            d7: false,
            d30: false
        });
        if (createdAt < minCreated) minCreated = createdAt;
        if (createdAt > maxCreated) maxCreated = createdAt;
    }

    const userIds = cohortUsers.map((u) => u._id);
    const activityMatch = await buildNonAlmightyMatch({
        userId: { $in: userIds },
        createdAt: {
            $gte: new Date(new Date(minCreated).getTime() + (1 * 24 * 60 * 60 * 1000)),
            $lte: new Date(new Date(maxCreated).getTime() + (31 * 24 * 60 * 60 * 1000))
        }
    });

    const activityRows = await AnalyticsEvent.find(activityMatch)
        .select('userId createdAt')
        .lean();

    const dayMs = 24 * 60 * 60 * 1000;

    for (const row of activityRows) {
        const userId = String(row.userId || '');
        const state = userMap.get(userId);
        if (!state) continue;

        const diff = (new Date(row.createdAt).getTime() - state.createdAt.getTime()) / dayMs;
        if (diff >= 1 && diff < 2) state.d1 = true;
        if (diff >= 7 && diff < 8) state.d7 = true;
        if (diff >= 30 && diff < 31) state.d30 = true;
    }

    const cohortMap = new Map();
    for (const row of userMap.values()) {
        const current = cohortMap.get(row.cohort) || {
            cohort: row.cohort,
            users: 0,
            day1: 0,
            day7: 0,
            day30: 0
        };
        current.users += 1;
        if (row.d1) current.day1 += 1;
        if (row.d7) current.day7 += 1;
        if (row.d30) current.day30 += 1;
        cohortMap.set(row.cohort, current);
    }

    return Array.from(cohortMap.values())
        .sort((a, b) => (a.cohort < b.cohort ? 1 : -1))
        .slice(0, limit)
        .map((cohort) => ({
            ...cohort,
            day1Rate: cohort.users > 0 ? Math.round((cohort.day1 / cohort.users) * 1000) / 10 : 0,
            day7Rate: cohort.users > 0 ? Math.round((cohort.day7 / cohort.users) * 1000) / 10 : 0,
            day30Rate: cohort.users > 0 ? Math.round((cohort.day30 / cohort.users) * 1000) / 10 : 0
        }));
}

async function buildDiagnosticsPayload(query = {}) {
    const range = parseRange(query);
    const limit = getLimit(query.limit, 20, 100);
    const baseMatch = {
        createdAt: {
            $gte: range.from,
            $lte: range.to
        }
    };
    const match = await buildNonAlmightyMatch(baseMatch);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const last24hMatch = await buildNonAlmightyMatch({
        createdAt: { $gte: since24h }
    });

    const [overview, technical, recentApiErrors, recentJsErrors, latestEvent] = await Promise.all([
        getOverview(match),
        getTechnicalHealth(match, limit),
        AnalyticsEvent.aggregate([
            {
                $match: buildUnexpectedApiErrorMatch(match)
            },
            {
                $group: {
                    _id: {
                        method: { $ifNull: ['$metadata.method', 'unknown'] },
                        endpoint: { $ifNull: ['$metadata.endpoint', { $ifNull: ['$path', 'unknown'] }] },
                        path: { $ifNull: ['$path', 'unknown'] },
                        appSection: { $ifNull: ['$appSection', 'unknown'] },
                        statusCode: { $ifNull: ['$statusCode', 'n/a'] },
                        message: { $ifNull: ['$metadata.message', 'unknown'] }
                    },
                    count: { $sum: 1 },
                    lastSeen: { $max: '$createdAt' },
                    firstSeen: { $min: '$createdAt' }
                }
            },
            {
                $project: {
                    _id: 0,
                    method: '$_id.method',
                    endpoint: '$_id.endpoint',
                    path: '$_id.path',
                    appSection: '$_id.appSection',
                    statusCode: '$_id.statusCode',
                    message: '$_id.message',
                    count: 1,
                    firstSeen: 1,
                    lastSeen: 1
                }
            },
            { $sort: { count: -1, lastSeen: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.aggregate([
            {
                $match: {
                    ...match,
                    eventName: 'js_error'
                }
            },
            {
                $group: {
                    _id: {
                        message: { $ifNull: ['$metadata.message', 'unknown'] },
                        type: { $ifNull: ['$metadata.type', 'error'] },
                        source: { $ifNull: ['$metadata.source', 'unknown'] },
                        line: { $ifNull: ['$metadata.line', 'n/a'] },
                        column: { $ifNull: ['$metadata.column', 'n/a'] },
                        path: { $ifNull: ['$path', 'unknown'] },
                        appSection: { $ifNull: ['$appSection', 'unknown'] }
                    },
                    count: { $sum: 1 },
                    lastSeen: { $max: '$createdAt' },
                    firstSeen: { $min: '$createdAt' }
                }
            },
            {
                $project: {
                    _id: 0,
                    message: '$_id.message',
                    type: '$_id.type',
                    source: '$_id.source',
                    line: '$_id.line',
                    column: '$_id.column',
                    path: '$_id.path',
                    appSection: '$_id.appSection',
                    count: 1,
                    firstSeen: 1,
                    lastSeen: 1
                }
            },
            { $sort: { count: -1, lastSeen: -1 } },
            { $limit: limit }
        ]),
        AnalyticsEvent.findOne(match).sort({ createdAt: -1 }).select('createdAt').lean()
    ]);

    const [apiErrors24h, jsErrors24h, totalEvents24h] = await Promise.all([
        AnalyticsEvent.countDocuments(buildUnexpectedApiErrorMatch(last24hMatch)),
        AnalyticsEvent.countDocuments({ ...last24hMatch, eventName: 'js_error' }),
        AnalyticsEvent.countDocuments(last24hMatch)
    ]);

    const memory = process.memoryUsage();
    const mongoState = mongoose.connection.readyState;
    const uptimeSec = Math.max(0, Math.floor(process.uptime()));
    const apiErrorRate = overview.totalEvents > 0 ? (overview.apiErrors / overview.totalEvents) * 100 : 0;
    const jsErrorRate = overview.totalEvents > 0 ? (overview.jsErrors / overview.totalEvents) * 100 : 0;
    const warnings = [];

    if (mongoState !== 1) {
        warnings.push(`Database connection state is ${mongoReadyStateLabel(mongoState)}.`);
    }
    if (apiErrorRate >= 2) {
        warnings.push(`High API error rate detected (${apiErrorRate.toFixed(2)}%).`);
    }
    if (jsErrorRate >= 2) {
        warnings.push(`High JS error rate detected (${jsErrorRate.toFixed(2)}%).`);
    }
    if (totalEvents24h > 0 && apiErrors24h + jsErrors24h > totalEvents24h * 0.05) {
        warnings.push('Error volume in last 24h exceeds 5% of recent events.');
    }
    if (!latestEvent?.createdAt) {
        warnings.push('No analytics events were found in the selected date range.');
    }

    const recentApi = (recentApiErrors || []).map((row) => ({
        createdAt: row.lastSeen,
        firstSeen: row.firstSeen,
        method: safeText(row?.method),
        endpoint: safeText(row?.endpoint || row?.path),
        path: safeText(row?.path),
        appSection: safeText(row?.appSection),
        statusCode: row?.statusCode ?? 'n/a',
        message: safeText(row?.message),
        count: Number(row?.count || 0)
    }));

    const recentJs = (recentJsErrors || []).map((row) => ({
        createdAt: row.lastSeen,
        firstSeen: row.firstSeen,
        message: safeText(row?.message),
        type: safeText(row?.type || 'error'),
        source: safeText(row?.source),
        line: row?.line ?? 'n/a',
        column: row?.column ?? 'n/a',
        path: safeText(row?.path),
        appSection: safeText(row?.appSection),
        count: Number(row?.count || 0)
    }));

    return {
        generatedAt: new Date().toISOString(),
        range: {
            from: range.from.toISOString(),
            to: range.to.toISOString()
        },
        server: {
            nodeVersion: process.version,
            platform: `${os.platform()} ${os.release()}`,
            uptimeSec,
            pid: process.pid,
            cpuCount: os.cpus()?.length || 0,
            loadAverage: os.loadavg().map((v) => Math.round(v * 100) / 100),
            memory: {
                rss: memory.rss,
                heapTotal: memory.heapTotal,
                heapUsed: memory.heapUsed,
                external: memory.external
            },
            memoryHuman: {
                rss: formatBytes(memory.rss),
                heapTotal: formatBytes(memory.heapTotal),
                heapUsed: formatBytes(memory.heapUsed),
                external: formatBytes(memory.external)
            },
            mongo: {
                state: mongoReadyStateLabel(mongoState),
                readyState: mongoState
            }
        },
        summary: {
            totalEvents: overview.totalEvents || 0,
            pageViews: overview.pageViews || 0,
            uniqueVisitors: overview.uniqueVisitors || 0,
            sessions: overview.sessions || 0,
            apiErrors: overview.apiErrors || 0,
            jsErrors: overview.jsErrors || 0,
            apiErrorRatePercent: Math.round(apiErrorRate * 100) / 100,
            jsErrorRatePercent: Math.round(jsErrorRate * 100) / 100,
            last24h: {
                totalEvents: totalEvents24h || 0,
                apiErrors: apiErrors24h || 0,
                jsErrors: jsErrors24h || 0
            }
        },
        warnings,
        technical: technical || {},
        recentApiErrors: recentApi,
        recentJsErrors: recentJs
    };
}

function buildDiagnosticsText(payload) {
    const lines = [];
    const push = (text = '') => lines.push(text);

    push('Radgir Diagnostics Report');
    push(`Generated at: ${payload.generatedAt}`);
    push(`Range: ${payload.range.from} -> ${payload.range.to}`);
    push('');
    push('Server Snapshot');
    push(`- Node: ${payload.server.nodeVersion}`);
    push(`- Platform: ${payload.server.platform}`);
    push(`- PID: ${payload.server.pid}`);
    push(`- Uptime: ${payload.server.uptimeSec}s`);
    push(`- CPU cores: ${payload.server.cpuCount}`);
    push(`- Load average: ${payload.server.loadAverage.join(', ')}`);
    push(`- MongoDB: ${payload.server.mongo.state} (${payload.server.mongo.readyState})`);
    push(`- RSS: ${payload.server.memoryHuman.rss}`);
    push(`- Heap used / total: ${payload.server.memoryHuman.heapUsed} / ${payload.server.memoryHuman.heapTotal}`);
    push(`- External memory: ${payload.server.memoryHuman.external}`);
    push('');
    push('Traffic Summary');
    push(`- Total events: ${payload.summary.totalEvents}`);
    push(`- Page views: ${payload.summary.pageViews}`);
    push(`- Unique visitors: ${payload.summary.uniqueVisitors}`);
    push(`- Sessions: ${payload.summary.sessions}`);
    push(`- API errors: ${payload.summary.apiErrors} (${payload.summary.apiErrorRatePercent}%)`);
    push(`- JS errors: ${payload.summary.jsErrors} (${payload.summary.jsErrorRatePercent}%)`);
    push(`- Last 24h events: ${payload.summary.last24h.totalEvents}`);
    push(`- Last 24h API errors: ${payload.summary.last24h.apiErrors}`);
    push(`- Last 24h JS errors: ${payload.summary.last24h.jsErrors}`);
    push('');
    push('Warnings');
    if (payload.warnings.length === 0) {
        push('- none');
    } else {
        payload.warnings.forEach((warning) => push(`- ${warning}`));
    }
    push('');
    push('Recent API Errors');
    if (!payload.recentApiErrors.length) {
        push('- none');
    } else {
        payload.recentApiErrors.forEach((row) => {
            push(`- [${row.createdAt}] ${row.method} ${row.endpoint} | status=${row.statusCode} | path=${row.path} | section=${row.appSection} | count=${row.count}`);
            push(`  first seen: ${row.firstSeen}`);
            push(`  message: ${row.message}`);
        });
    }
    push('');
    push('Recent JS Errors');
    if (!payload.recentJsErrors.length) {
        push('- none');
    } else {
        payload.recentJsErrors.forEach((row) => {
            push(`- [${row.createdAt}] type=${row.type} | path=${row.path} | section=${row.appSection} | count=${row.count}`);
            push(`  first seen: ${row.firstSeen}`);
            push(`  message: ${row.message}`);
            push(`  source: ${row.source} @ ${row.line}:${row.column}`);
        });
    }

    return `${lines.join('\n')}\n`;
}

router.get('/report', async (req, res) => {
    try {
        const range = parseRange(req.query);
        const baseMatch = {
            createdAt: {
                $gte: range.from,
                $lte: range.to
            }
        };
        const match = await buildNonAlmightyMatch(baseMatch);
        const limit = getLimit(req.query.limit, 10, 50);

        const [
            earliestEvent,
            overview,
            timelineData,
            topPages,
            topClicks,
            devices,
            sections,
            flows,
            funnel,
            signedInUsers,
            acquisition,
            technical,
            content,
            cohorts,
            engagement
        ] = await Promise.all([
            AnalyticsEvent.findOne(match).sort({ createdAt: 1 }).select('createdAt').lean(),
            getOverview(match),
            getTimeline(match, range),
            getTopPages(match, limit),
            getTopClicks(match, limit),
            getDeviceBreakdown(match, limit),
            getTopSections(match, limit),
            getNavigationFlows(match, limit),
            getFunnel(match),
            getSignedInUsers(match, limit),
            getAcquisition(match, limit),
            getTechnicalHealth(match, limit),
            getContentPerformance(match, limit),
            getRetentionCohorts(range, Math.min(limit, 26)),
            getEngagementInsights(match, Math.max(limit, 20))
        ]);

        return res.json({
            success: true,
            data: {
                range: {
                    from: range.from.toISOString(),
                    to: range.to.toISOString(),
                    earliestAvailable: earliestEvent?.createdAt ? new Date(earliestEvent.createdAt).toISOString() : null
                },
                overview: {
                    ...overview,
                    uiClicks: engagement?.totals?.uiClicks || 0,
                    tabChanges: engagement?.totals?.tabChanges || 0
                },
                timeline: timelineData.rows,
                timelineSource: timelineData.source,
                topPages,
                topClicks,
                topSections: sections,
                deviceBreakdown: devices,
                navigationFlows: flows,
                funnel,
                signedInUsers,
                acquisition,
                technical,
                content,
                cohorts,
                engagement
            }
        });
    } catch (error) {
        console.error('Analytics report error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to build analytics report'
        });
    }
});

router.get('/diagnostics', async (req, res) => {
    try {
        const payload = await buildDiagnosticsPayload(req.query);
        return res.json({
            success: true,
            data: payload
        });
    } catch (error) {
        console.error('Analytics diagnostics error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to build diagnostics report'
        });
    }
});

router.get('/diagnostics/export', async (req, res) => {
    try {
        const payload = await buildDiagnosticsPayload(req.query);
        const reportText = buildDiagnosticsText(payload);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `radgir-diagnostics-${stamp}.txt`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(reportText);
    } catch (error) {
        console.error('Analytics diagnostics export error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to export diagnostics report'
        });
    }
});

router.get('/realtime', async (req, res) => {
    try {
        const minutes = getLimit(req.query.minutes, 30, 180);
        const since = new Date(Date.now() - minutes * 60 * 1000);
        const match = await buildNonAlmightyMatch({ createdAt: { $gte: since } });

        const [activeVisitors, activeSessions, pageViews, topPages, recentEvents] = await Promise.all([
            countDistinct('visitorId', match),
            countDistinct('sessionId', match),
            AnalyticsEvent.countDocuments({ ...match, eventName: 'page_view' }),
            AnalyticsEvent.aggregate([
                { $match: { ...match, eventName: 'page_view', path: { $nin: [null, ''] } } },
                { $group: { _id: '$path', views: { $sum: 1 } } },
                { $project: { _id: 0, path: '$_id', views: 1 } },
                { $sort: { views: -1 } },
                { $limit: 8 }
            ]),
            AnalyticsEvent.find(match)
                .sort({ createdAt: -1 })
                .limit(30)
                .select('eventName path appSection elementText deviceType browser os createdAt authenticated source')
                .lean()
        ]);

        return res.json({
            success: true,
            data: {
                windowMinutes: minutes,
                since: since.toISOString(),
                activeVisitors,
                activeSessions,
                pageViews,
                topPages,
                recentEvents
            }
        });
    } catch (error) {
        console.error('Realtime analytics error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to build realtime analytics'
        });
    }
});

module.exports = router;
