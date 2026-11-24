/**
 * Live analytics snapshot posted to the owner's private Telegram chat.
 * Updates ONE message in place (editMessageText) whenever overview stats change.
 */

const AnalyticsEvent = require('../models/AnalyticsEvent');
const AppState = require('../models/AppState');
const { buildNonAlmightyMatch } = require('./analyticsFilters');

const STATE_KEY = 'telegram_analytics_message';
const DEFAULT_INTERVAL_MS = 60 * 1000; // every minute

function getTelegramCredentials() {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
    const chatId = String(
        process.env.TELEGRAM_ANALYTICS_CHAT_ID || process.env.TELEGRAM_CONTACT_CHAT_ID || ''
    ).trim().replace(/^['"]|['"]$/g, '');
    return {
        token,
        chatId,
        base: token ? `https://api.telegram.org/bot${token}` : ''
    };
}

function isConfigured() {
    const { token, chatId } = getTelegramCredentials();
    return Boolean(token && chatId) && process.env.SOCIAL_NOTIFY_ENABLED !== 'false';
}

function formatEnNumber(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function formatEnPercent(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0%';
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)}%`;
}

function formatEnDuration(seconds) {
    const number = Number(seconds || 0);
    if (!Number.isFinite(number) || number <= 0) return '0s';
    if (number < 60) return `${Math.round(number)}s`;
    const mins = Math.floor(number / 60);
    const rem = Math.round(number % 60);
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatEnDateTime(date = new Date()) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    }).format(date);
}

async function countDistinct(field, match) {
    const rows = await AnalyticsEvent.aggregate([
        { $match: { ...match, [field]: { $nin: [null, ''] } } },
        { $group: { _id: `$${field}` } },
        { $count: 'count' }
    ]);
    return rows[0]?.count || 0;
}

/** Last-24h overview stats (same metrics as portal overview cards). */
async function getLast24hOverview() {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const match = await buildNonAlmightyMatch({
        createdAt: { $gte: from, $lte: to }
    });

    const [
        pageViews,
        uniqueVisitors,
        sessions,
        authVisitors,
        returningVisitorsRows,
        bounceRows,
        avgDurationRows
    ] = await Promise.all([
        AnalyticsEvent.countDocuments({ ...match, eventName: 'page_view' }),
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
        ])
    ]);

    const bounce = bounceRows[0] || { totalSessions: 0, bounceSessions: 0 };
    const bounceRate = bounce.totalSessions > 0
        ? Math.round((bounce.bounceSessions / bounce.totalSessions) * 1000) / 10
        : 0;
    const avgSessionDurationSec = avgDurationRows[0]?.avgDurationMs
        ? Math.round((avgDurationRows[0].avgDurationMs / 1000) * 10) / 10
        : 0;

    return {
        from,
        to,
        pageViews,
        uniqueVisitors,
        sessions,
        returningVisitors: returningVisitorsRows[0]?.count || 0,
        authVisitors,
        bounceRate,
        avgSessionDurationSec
    };
}

function buildAnalyticsCaption(overview) {
    const lines = [
        '📊 <b>Radgir Analytics</b> (last 24 hours)',
        `Updated: ${formatEnDateTime(new Date())}`,
        '',
        `📄 Page views: <b>${formatEnNumber(overview.pageViews)}</b>`,
        `👤 Unique visitors: <b>${formatEnNumber(overview.uniqueVisitors)}</b>`,
        `🧭 Sessions: <b>${formatEnNumber(overview.sessions)}</b>`,
        `🔁 Returning visitors: <b>${formatEnNumber(overview.returningVisitors)}</b>`,
        `🔐 Signed in visitors: <b>${formatEnNumber(overview.authVisitors)}</b>`,
        `↩️ Bounce rate: <b>${formatEnPercent(overview.bounceRate)}</b>`,
        `⏱️ Avg session time: <b>${formatEnDuration(overview.avgSessionDurationSec)}</b>`
    ];
    return lines.join('\n');
}

async function telegramApi(method, body) {
    const { token, base } = getTelegramCredentials();
    if (!token) throw new Error('telegram_not_configured');
    const response = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
        throw new Error(result.description || `Telegram ${method} HTTP ${response.status}`);
    }
    return result;
}

async function loadStoredMessage() {
    const doc = await AppState.findOne({ key: STATE_KEY }).lean();
    return doc?.value || null;
}

async function saveStoredMessage(value) {
    await AppState.findOneAndUpdate(
        { key: STATE_KEY },
        { $set: { value } },
        { upsert: true, new: true }
    );
}

/**
 * Send or edit the single private analytics message.
 * @returns {{ ok: boolean, changed?: boolean, skipped?: boolean, reason?: string }}
 */
async function syncAnalyticsTelegramMessage() {
    if (!isConfigured()) return { skipped: true, reason: 'not_configured' };

    const { chatId } = getTelegramCredentials();
    const overview = await getLast24hOverview();
    const text = buildAnalyticsCaption(overview);
    const stored = await loadStoredMessage();

    if (stored?.fingerprint === text && stored?.messageId) {
        return { ok: true, changed: false };
    }

    if (stored?.messageId) {
        try {
            await telegramApi('editMessageText', {
                chat_id: stored.chatId || chatId,
                message_id: Number(stored.messageId),
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            await saveStoredMessage({
                messageId: Number(stored.messageId),
                chatId: stored.chatId || chatId,
                fingerprint: text,
                updatedAt: new Date().toISOString()
            });
            return { ok: true, changed: true, edited: true };
        } catch (error) {
            const msg = String(error.message || error);
            if (/message is not modified/i.test(msg)) {
                await saveStoredMessage({
                    messageId: Number(stored.messageId),
                    chatId: stored.chatId || chatId,
                    fingerprint: text,
                    updatedAt: new Date().toISOString()
                });
                return { ok: true, changed: false };
            }
            // Message deleted by user — fall through and send a fresh one
            if (!/message to edit not found|message can't be edited|chat not found/i.test(msg)) {
                throw error;
            }
        }
    }

    const sent = await telegramApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    const messageId = sent.result?.message_id;
    if (messageId) {
        await saveStoredMessage({
            messageId: Number(messageId),
            chatId,
            fingerprint: text,
            updatedAt: new Date().toISOString()
        });
    }
    return { ok: true, changed: true, created: true, messageId };
}

let schedulerTimer = null;
let schedulerRunning = false;

function startAnalyticsTelegramScheduler(options = {}) {
    if (schedulerTimer) return;
    if (!isConfigured()) {
        console.log('[AnalyticsTelegram] Skipped scheduler (TELEGRAM_CONTACT_CHAT_ID / bot token not set)');
        return;
    }

    const intervalMs = Math.max(
        30 * 1000,
        Number(options.intervalMs || process.env.ANALYTICS_TELEGRAM_INTERVAL_MS) || DEFAULT_INTERVAL_MS
    );

    async function runOnce() {
        if (schedulerRunning) return;
        schedulerRunning = true;
        try {
            const result = await syncAnalyticsTelegramMessage();
            if (result.changed) {
                console.log('[AnalyticsTelegram] Private analytics message updated');
            }
        } catch (error) {
            console.error('[AnalyticsTelegram] Sync failed:', error.message || error);
        } finally {
            schedulerRunning = false;
        }
    }

    runOnce().catch(() => {});
    schedulerTimer = setInterval(runOnce, intervalMs);
    if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
    console.log(`[AnalyticsTelegram] Scheduler started (interval=${intervalMs}ms)`);
}

module.exports = {
    syncAnalyticsTelegramMessage,
    startAnalyticsTelegramScheduler,
    getLast24hOverview,
    buildAnalyticsCaption,
    isConfigured
};
