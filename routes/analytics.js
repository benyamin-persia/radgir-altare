/**
 * ============================================
 * Analytics Collection Routes
 * ============================================
 * Public ingestion endpoint for first-party analytics events.
 */

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const authenticate = require('../middleware/auth');
const {
    isAlmightyRole,
    rememberAlmightyVisitorIds
} = require('../utils/analyticsFilters');

const optionalAuth = authenticate.optionalAuth;
const router = express.Router();

const collectLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many analytics requests. Please slow down.'
    }
});

function safeString(value, maxLen = 200) {
    if (value === undefined || value === null) return '';
    return String(value).trim().slice(0, maxLen);
}

function safeNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function safeBoolean(value) {
    if (value === true || value === false) return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') {
        const norm = value.trim().toLowerCase();
        if (norm === 'true' || norm === 'yes') return true;
        if (norm === 'false' || norm === 'no') return false;
    }
    return null;
}

function safeDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

function sanitizeMetadata(value, depth = 0) {
    if (depth > 2) return null;
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.slice(0, 300);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
    }
    if (typeof value === 'object') {
        const out = {};
        let count = 0;
        for (const [key, item] of Object.entries(value)) {
            if (count >= 40) break;
            const safeKey = safeString(key, 80);
            if (!safeKey) continue;
            out[safeKey] = sanitizeMetadata(item, depth + 1);
            count += 1;
        }
        return out;
    }
    return null;
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',')[0].trim();
        if (first) return first;
    }
    return (
        safeString(req.headers['cf-connecting-ip'], 120) ||
        safeString(req.ip, 120) ||
        safeString(req.connection?.remoteAddress, 120) ||
        'unknown'
    );
}

function hashIp(ip) {
    const salt = process.env.ANALYTICS_SALT || process.env.JWT_SECRET || 'radgir-analytics';
    return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function detectDevice(uaRaw = '') {
    const ua = uaRaw.toLowerCase();

    let deviceType = 'desktop';
    if (/tablet|ipad|playbook|silk/.test(ua)) deviceType = 'tablet';
    else if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/.test(ua)) deviceType = 'mobile';

    let os = 'Other';
    if (/windows nt/.test(ua)) os = 'Windows';
    else if (/android/.test(ua)) os = 'Android';
    else if (/iphone|ipad|ipod|ios/.test(ua)) os = 'iOS';
    else if (/mac os|macintosh/.test(ua)) os = 'macOS';
    else if (/linux/.test(ua)) os = 'Linux';

    let browser = 'Other';
    if (/edg\//.test(ua)) browser = 'Edge';
    else if (/opr\//.test(ua) || /opera/.test(ua)) browser = 'Opera';
    else if (/chrome\//.test(ua) && !/edg\//.test(ua) && !/opr\//.test(ua)) browser = 'Chrome';
    else if (/safari\//.test(ua) && !/chrome\//.test(ua)) browser = 'Safari';
    else if (/firefox\//.test(ua)) browser = 'Firefox';

    return { deviceType, os, browser };
}

function normalizeEventName(rawName) {
    const name = safeString(rawName, 80).toLowerCase();
    if (!name) return 'custom_event';
    if (!/^[a-z0-9_.:-]+$/.test(name)) return 'custom_event';
    return name;
}

function normalizeSource(rawSource) {
    const source = safeString(rawSource, 30).toLowerCase();
    const allowed = new Set(['direct', 'search', 'social', 'external', 'internal', 'unknown']);
    return allowed.has(source) ? source : '';
}

function parseReferrerHost(referrer) {
    const raw = safeString(referrer, 1000);
    if (!raw) return '';
    try {
        return String(new URL(raw).hostname || '').toLowerCase();
    } catch (_) {
        return '';
    }
}

function deriveSource(referrerHost, requestHost) {
    if (!referrerHost) return 'direct';
    if (requestHost && referrerHost === requestHost) return 'internal';

    const searchHosts = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'yandex.', 'baidu.'];
    if (searchHosts.some((token) => referrerHost.includes(token))) return 'search';

    const socialHosts = [
        'facebook.com',
        'instagram.com',
        'x.com',
        'twitter.com',
        't.co',
        't.me',
        'telegram.',
        'youtube.com',
        'youtu.be',
        'reddit.com',
        'linkedin.com'
    ];
    if (socialHosts.some((token) => referrerHost.includes(token))) return 'social';
    return 'external';
}

function parseUtmParamsFromUrl(rawUrl) {
    const urlString = safeString(rawUrl, 1000);
    if (!urlString) {
        return {
            utmSource: '',
            utmMedium: '',
            utmCampaign: '',
            utmTerm: '',
            utmContent: ''
        };
    }

    try {
        const parsed = new URL(urlString);
        return {
            utmSource: safeString(parsed.searchParams.get('utm_source'), 120),
            utmMedium: safeString(parsed.searchParams.get('utm_medium'), 120),
            utmCampaign: safeString(parsed.searchParams.get('utm_campaign'), 160),
            utmTerm: safeString(parsed.searchParams.get('utm_term'), 160),
            utmContent: safeString(parsed.searchParams.get('utm_content'), 160)
        };
    } catch (_) {
        return {
            utmSource: '',
            utmMedium: '',
            utmCampaign: '',
            utmTerm: '',
            utmContent: ''
        };
    }
}

function getViewportBucket(width) {
    const w = Number(width);
    if (!Number.isFinite(w) || w <= 0) return 'unknown';
    if (w < 480) return 'mobile_xs';
    if (w < 768) return 'mobile';
    if (w < 992) return 'tablet';
    if (w < 1280) return 'desktop';
    return 'desktop_wide';
}

function normalizeNetworkQuality(rawQuality, effectiveType, downlink) {
    const direct = safeString(rawQuality, 40).toLowerCase();
    if (['poor', 'moderate', 'good', 'unknown'].includes(direct)) return direct;

    const effective = safeString(effectiveType, 40).toLowerCase();
    if (effective === 'slow-2g' || effective === '2g') return 'poor';
    if (effective === '3g') return 'moderate';
    if (effective === '4g' || effective === '5g') return 'good';

    const dl = Number(downlink);
    if (!Number.isFinite(dl)) return 'unknown';
    if (dl < 0.8) return 'poor';
    if (dl < 2) return 'moderate';
    return 'good';
}

router.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'ok',
        service: 'analytics'
    });
});

/**
 * POST /api/analytics/exclude-visitor
 * Almighty-only: remember this browser's visitorId so reports ignore it even after logout.
 */
router.post('/exclude-visitor', collectLimiter, optionalAuth, async (req, res) => {
    try {
        if (!isAlmightyRole(req.user?.role)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const visitorId = safeString(req.body?.visitorId, 120);
        if (!visitorId) {
            return res.status(400).json({ success: false, message: 'visitorId required' });
        }
        await rememberAlmightyVisitorIds([visitorId]);
        return res.json({ success: true, data: { excluded: true } });
    } catch (error) {
        console.error('Analytics exclude-visitor error:', error);
        return res.status(500).json({ success: false, message: 'Failed to exclude visitor' });
    }
});

/**
 * POST /api/analytics/events
 * Accepts either:
 * - { events: [...] }
 * - single event object
 */
router.post('/events', collectLimiter, optionalAuth, async (req, res) => {
    try {
        const incomingEvents = Array.isArray(req.body?.events)
            ? req.body.events
            : [req.body];

        if (!incomingEvents.length) {
            return res.status(400).json({
                success: false,
                message: 'No analytics events provided'
            });
        }

        if (incomingEvents.length > 100) {
            return res.status(400).json({
                success: false,
                message: 'Too many events in one request (max 100)'
            });
        }

        const userAgent = safeString(req.headers['user-agent'], 600);
        const detected = detectDevice(userAgent);
        const ipHash = hashIp(getClientIp(req));
        const country = safeString(req.headers['cf-ipcountry'], 10);
        const requestHost = safeString(req.headers.host, 255).split(':')[0].toLowerCase();
        const requestUserIsAlmighty = isAlmightyRole(req.user?.role);

        /* If Almighty is authenticated, remember their visitorIds so reports exclude this browser forever,
           then accept the request with zero inserts (do not inflate page views / sessions). */
        if (requestUserIsAlmighty) {
            const visitorIds = incomingEvents
                .filter((evt) => evt && typeof evt === 'object')
                .map((evt) => safeString(evt.visitorId, 120))
                .filter(Boolean);
            await rememberAlmightyVisitorIds(visitorIds);
            return res.status(201).json({
                success: true,
                data: { inserted: 0, excluded: 'almighty' }
            });
        }

        const docs = incomingEvents
            .filter((evt) => evt && typeof evt === 'object')
            .map((evt) => {
                const rawUserRole = safeString(evt?.metadata?.userRole, 40);
                const rawRole = safeString(evt?.metadata?.role, 40);
                const path = safeString(evt.path, 300);
                const appSection = safeString(evt.appSection, 120);
                if (
                    rawUserRole.toLowerCase() === 'almighty' ||
                    rawRole.toLowerCase() === 'almighty' ||
                    appSection === 'almighty_portal' ||
                    /almighty-portal/i.test(path)
                ) {
                    return null;
                }

                const fullUrl = safeString(evt.fullUrl || evt.url, 1000);
                const referrer = safeString(evt.referrer, 1000);
                const referrerHost = safeString(evt.referrerHost, 255).toLowerCase() || parseReferrerHost(referrer);
                const parsedUtm = parseUtmParamsFromUrl(fullUrl);
                const source = normalizeSource(evt.source) || deriveSource(referrerHost, requestHost);
                const viewportWidth = safeNumber(evt.viewportWidth);
                const viewportHeight = safeNumber(evt.viewportHeight);
                const networkDownlink = safeNumber(evt.networkDownlink);
                const networkRtt = safeNumber(evt.networkRtt);
                const networkEffectiveType = safeString(evt.networkEffectiveType, 40).toLowerCase();
                const metadata = sanitizeMetadata(evt.metadata) || {};
                if (req.user?.role) {
                    metadata.userRole = safeString(req.user.role, 40); // stamp auth role for read-side filters
                }

                const normalized = {
                    eventName: normalizeEventName(evt.eventName || evt.name),
                    visitorId: safeString(evt.visitorId, 120) || `anon-${ipHash.slice(0, 16)}`,
                    sessionId: safeString(evt.sessionId, 120) || `sess-${Date.now()}`,
                    userId: req.user?._id || null,
                    authenticated: Boolean(req.user),
                    path,
                    fullUrl,
                    referrer,
                    referrerHost,
                    source,
                    pageTitle: safeString(evt.pageTitle, 300),
                    appSection,
                    elementTag: safeString(evt.elementTag, 40),
                    elementId: safeString(evt.elementId, 120),
                    elementClasses: safeString(evt.elementClasses, 300),
                    elementText: safeString(evt.elementText, 300),
                    elementHref: safeString(evt.elementHref, 1000),
                    dataAction: safeString(evt.dataAction, 120),
                    durationMs: safeNumber(evt.durationMs),
                    statusCode: safeNumber(evt.statusCode),
                    deviceType: safeString(evt.deviceType, 40) || detected.deviceType,
                    os: safeString(evt.os, 60) || detected.os,
                    browser: safeString(evt.browser, 60) || detected.browser,
                    viewportWidth,
                    viewportHeight,
                    viewportBucket: safeString(evt.viewportBucket, 40) || getViewportBucket(viewportWidth),
                    screenWidth: safeNumber(evt.screenWidth),
                    screenHeight: safeNumber(evt.screenHeight),
                    networkType: safeString(evt.networkType, 40).toLowerCase(),
                    networkEffectiveType,
                    networkDownlink,
                    networkRtt,
                    networkSaveData: safeBoolean(evt.networkSaveData) || false,
                    networkQuality: normalizeNetworkQuality(
                        evt.networkQuality,
                        networkEffectiveType,
                        networkDownlink
                    ),
                    pwaInstalled: safeBoolean(evt.pwaInstalled) || false,
                    displayMode: safeString(evt.displayMode, 40).toLowerCase(),
                    cardId: safeString(evt.cardId, 120),
                    cardAction: safeString(evt.cardAction || evt.dataAction, 80).toLowerCase(),
                    cardNoAddress: safeBoolean(evt.cardNoAddress),
                    cardHasCoords: safeBoolean(evt.cardHasCoords),
                    utmSource: safeString(evt.utmSource, 120) || parsedUtm.utmSource,
                    utmMedium: safeString(evt.utmMedium, 120) || parsedUtm.utmMedium,
                    utmCampaign: safeString(evt.utmCampaign, 160) || parsedUtm.utmCampaign,
                    utmTerm: safeString(evt.utmTerm, 160) || parsedUtm.utmTerm,
                    utmContent: safeString(evt.utmContent, 160) || parsedUtm.utmContent,
                    language: safeString(evt.language, 20),
                    country,
                    ipHash,
                    userAgent,
                    metadata,
                    clientTimestamp: safeDate(evt.clientTimestamp)
                };

                if (normalized.statusCode !== null) {
                    normalized.statusCode = Math.max(100, Math.min(599, Math.floor(normalized.statusCode)));
                }
                if (normalized.durationMs !== null) {
                    normalized.durationMs = Math.max(0, Math.floor(normalized.durationMs));
                }
                if (normalized.networkRtt !== null) {
                    normalized.networkRtt = Math.max(0, Math.floor(normalized.networkRtt));
                }
                if (normalized.networkDownlink !== null) {
                    normalized.networkDownlink = Math.max(0, Math.round(normalized.networkDownlink * 100) / 100);
                }

                return normalized;
            })
            .filter(Boolean);

        if (!docs.length) {
            return res.status(400).json({
                success: false,
                message: 'No valid analytics events to save'
            });
        }

        const result = await AnalyticsEvent.insertMany(docs, { ordered: false });

        return res.status(201).json({
            success: true,
            data: {
                inserted: result.length
            }
        });
    } catch (error) {
        console.error('Analytics collection error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to record analytics events'
        });
    }
});

module.exports = router;
