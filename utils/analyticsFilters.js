/**
 * Shared analytics filters.
 * Keeps Almighty traffic excluded from analytics reads (and supports write-side checks).
 */

const User = require('../models/User');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const AppState = require('../models/AppState');

const EXCLUDED_VISITORS_KEY = 'analytics_almighty_visitor_ids';

let cachedAlmighty = {
    ids: [],
    visitorIds: [],
    expiresAt: 0
};

function isAlmightyRole(role) {
    return String(role || '').trim().toLowerCase() === 'almighty';
}

async function getAlmightyUserIds() {
    const almightyUsers = await User.find({ role: 'Almighty' }).select('_id').lean();
    return almightyUsers.map((user) => user._id);
}

async function getStoredExcludedVisitorIds() {
    try {
        const row = await AppState.findOne({ key: EXCLUDED_VISITORS_KEY }).lean();
        const list = row?.value?.visitorIds;
        return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
    } catch (_) {
        return [];
    }
}

/** Persist visitorIds used by Almighty so reports exclude that browser even after logout. */
async function rememberAlmightyVisitorIds(visitorIds = []) {
    const incoming = [...new Set((visitorIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!incoming.length) return;

    const existing = await getStoredExcludedVisitorIds();
    const merged = [...new Set([...existing, ...incoming])].slice(-500); // cap growth
    await AppState.findOneAndUpdate(
        { key: EXCLUDED_VISITORS_KEY },
        { $set: { value: { visitorIds: merged, updatedAt: new Date().toISOString() } } },
        { upsert: true, new: true }
    );
    invalidateAlmightyAnalyticsCache();
}

/** Visitor IDs tied to Almighty auth/portal traffic — exclude forever from reports. */
async function getAlmightyLinkedVisitorIds(almightyIds) {
    const orConditions = [
        { 'metadata.userRole': { $regex: /^almighty$/i } },
        { 'metadata.role': { $regex: /^almighty$/i } },
        { appSection: 'almighty_portal' },
        { path: { $regex: /almighty-portal/i } }
    ];
    if (almightyIds.length > 0) {
        orConditions.push({ userId: { $in: almightyIds } });
    }

    const [fromEvents, fromState] = await Promise.all([
        AnalyticsEvent.distinct('visitorId', {
            visitorId: { $nin: [null, ''] },
            $or: orConditions
        }).catch(() => []),
        getStoredExcludedVisitorIds()
    ]);

    return [...new Set([...(fromEvents || []), ...fromState].filter(Boolean).map(String))];
}

async function refreshAlmightyCache() {
    const now = Date.now();
    if (cachedAlmighty.expiresAt > now) {
        return cachedAlmighty;
    }

    const ids = await getAlmightyUserIds();
    let visitorIds = [];
    try {
        visitorIds = await getAlmightyLinkedVisitorIds(ids);
    } catch (err) {
        console.warn('[analyticsFilters] Failed to load Almighty visitorIds:', err.message || err);
    }

    cachedAlmighty = {
        ids,
        visitorIds,
        expiresAt: now + 5 * 60 * 1000 // refresh every 5 minutes
    };
    return cachedAlmighty;
}

/**
 * Build a Mongo match that excludes Almighty-owned / Almighty-browser traffic.
 * Merges safely when baseMatch already has $and.
 */
async function buildNonAlmightyMatch(baseMatch = {}) {
    const { ids: almightyIds, visitorIds } = await refreshAlmightyCache();

    const andConditions = [
        { appSection: { $ne: 'almighty_portal' } },
        { path: { $not: /almighty-portal/i } },
        {
            $and: [
                {
                    $or: [
                        { 'metadata.userRole': { $exists: false } },
                        { 'metadata.userRole': null },
                        { 'metadata.userRole': '' },
                        { 'metadata.userRole': { $not: /^almighty$/i } }
                    ]
                },
                {
                    $or: [
                        { 'metadata.role': { $exists: false } },
                        { 'metadata.role': null },
                        { 'metadata.role': '' },
                        { 'metadata.role': { $not: /^almighty$/i } }
                    ]
                }
            ]
        }
    ];

    if (almightyIds.length > 0) {
        andConditions.push({
            $or: [
                { userId: null },
                { userId: { $exists: false } },
                { userId: { $nin: almightyIds } }
            ]
        });
    }

    if (visitorIds.length > 0) {
        andConditions.push({ visitorId: { $nin: visitorIds } });
    }

    const baseAnd = Array.isArray(baseMatch.$and) ? baseMatch.$and : [];
    const { $and: _ignored, ...rest } = baseMatch;

    return {
        ...rest,
        $and: [...baseAnd, ...andConditions]
    };
}

/** Invalidate cache after Almighty login linkage so new visitorIds drop out quickly. */
function invalidateAlmightyAnalyticsCache() {
    cachedAlmighty.expiresAt = 0;
}

module.exports = {
    buildNonAlmightyMatch,
    getAlmightyUserIds,
    isAlmightyRole,
    rememberAlmightyVisitorIds,
    invalidateAlmightyAnalyticsCache,
    refreshAlmightyCache
};
