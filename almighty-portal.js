/**
 * ============================================
 * Almighty Portal JavaScript
 * ============================================
 * Handles all functionality for the Almighty user portal
 * Includes user management, statistics, and CRUD operations
 * 
 * Note: API_BASE_URL is defined in auth.js, which is loaded before this script
 * This script uses authAPI.request() which already handles API calls with the correct base URL
 */

// Current editing user ID (null when creating new user)
let editingUserId = null;

// Search timeout for debouncing
let searchTimeout = null;

const DEFAULT_ABOUT_CONTENT = {
    headline: 'درباره من و راه‌های ارتباطی',
    summary: 'این صفحه برای معرفی کوتاه و دریافت نظرها و پیشنهادهای شما ساخته شده است.',
    seeking: 'به دنبال افراد عاقل و کاربلد برای همکاری هستم.',
    email: 'radgir@protonmail.com'
};

let analyticsRealtimeTimer = null;
const ANALYTICS_LIMIT = 20;
let analyticsOverviewSnapshot = null;
let analyticsDiagnosticsSnapshot = null;
let analyticsCustomRange = null;
let personTagsCache = [];

const PORTAL_TAB_HASHES = { users: 'usersSection', about: 'aboutEditorSection', tags: 'personTagsSection', analytics: 'analyticsSection' }; // Keep stable hashes so bookmarks and direct links open the correct tab.

function setPortalTab(tabName, { updateHash = false } = {}) {
    const safeTab = Object.prototype.hasOwnProperty.call(PORTAL_TAB_HASHES, tabName) ? tabName : 'users'; // Unknown hashes safely fall back to user management.
    const previousTab = document.querySelector('[data-portal-tab][aria-selected="true"]')?.dataset?.portalTab || null;

    document.querySelectorAll('[data-portal-tab-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.portalTabPanel !== safeTab; // The hidden attribute guarantees that only the selected section occupies page space.
    });

    document.querySelectorAll('[data-portal-tab]').forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.portalTab === safeTab)); // aria-selected exposes the active tab to assistive technology.
    });

    if (safeTab === 'about' && typeof loadAboutContactEditor === 'function') {
        loadAboutContactEditor(); // Refresh fields + tag chips whenever About tab is opened
    }

    if (updateHash) {
        history.replaceState(null, '', `#${PORTAL_TAB_HASHES[safeTab]}`); // Replace instead of pushing history for every tab click.
        if (window.analyticsTracker && typeof window.analyticsTracker.trackTabChange === 'function') {
            window.analyticsTracker.trackTabChange({
                tabGroup: 'portal',
                tabName: safeTab,
                previousTab,
                appZone: 'portal_tabs',
                label: safeTab,
                source: 'setPortalTab'
            });
        }
    }
}

function setupPortalTabs() {
    const tabList = document.querySelector('.portal-tabs');
    if (!tabList) return;
    const hashToTab = Object.fromEntries(Object.entries(PORTAL_TAB_HASHES).map(([tab, hash]) => [hash, tab])); // Reverse lookup translates a URL fragment into its tab name.
    const selectFromHash = () => setPortalTab(hashToTab[window.location.hash.slice(1)] || 'users');

    if (tabList.dataset.bound !== '1') {
        tabList.dataset.bound = '1'; // Guard against duplicate handlers if the portal is initialized again by the client router.
        document.querySelectorAll('[data-portal-tab]').forEach((button) => {
            button.addEventListener('click', () => setPortalTab(button.dataset.portalTab, { updateHash: true }));
        });
        window.addEventListener('hashchange', selectFromHash);
    }
    selectFromHash();
}

function tp(key, fallback) {
    if (typeof languageManager !== 'undefined' && languageManager) {
        const value = languageManager.getTranslation(key);
        if (value) return value;
    }
    return fallback;
}

function formatAnalyticsNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number)
        ? new Intl.NumberFormat('en-US').format(Math.round(number))
        : '-';
}

function formatAnalyticsPercent(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '-';
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(number)}%`;
}

function formatAnalyticsDuration(seconds) {
    const number = Number(seconds || 0);
    if (!Number.isFinite(number) || number <= 0) return '0s';
    if (number < 60) return `${Math.round(number)}s`;
    const mins = Math.floor(number / 60);
    const rem = Math.round(number % 60);
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

function formatAnalyticsDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function formatAnalyticsDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

/** Format a Date as yyyy-mm-dd in the browser's local timezone (for <input type="date">). */
function toLocalDateInputValue(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Parse <input type="date"> value as local start/end of that calendar day. */
function parseLocalDateInput(value, endOfDay = false) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split('-').map(Number);
    if (endOfDay) return new Date(y, m - 1, d, 23, 59, 59, 999);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function setAnalyticsText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
}

function showAnalyticsAlert(message, type = 'error') {
    const alertDiv = document.getElementById('analyticsAlert');
    if (!alertDiv) return;
    alertDiv.textContent = message;
    alertDiv.className = `alert ${type}`;
    alertDiv.style.display = 'block';
}

function clearAnalyticsAlert() {
    const alertDiv = document.getElementById('analyticsAlert');
    if (!alertDiv) return;
    alertDiv.style.display = 'none';
}

function renderAnalyticsRows(bodyId, rowsHtml, emptyMessage = 'No data available.', colspan = 8) {
    const tbody = document.getElementById(bodyId);
    if (!tbody) return;
    if (!rowsHtml || rowsHtml.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colspan}" class="analytics-empty">${emptyMessage}</td></tr>`;
        return;
    }
    tbody.innerHTML = rowsHtml.join('');
}

function ensureAnalyticsDateRange() {
    const fromEl = document.getElementById('analyticsFrom');
    const toEl = document.getElementById('analyticsTo');
    if (!fromEl || !toEl) return;

    if (toEl.value && fromEl.value) return;
    setAnalyticsQuickRange(24, { triggerReload: false });
}

function setAnalyticsQuickRange(hours, options = {}) {
    const { triggerReload = true } = options;
    const fromEl = document.getElementById('analyticsFrom');
    const toEl = document.getElementById('analyticsTo');
    if (!fromEl || !toEl) return;

    const now = new Date();
    const from = new Date(now.getTime() - (Number(hours) || 24) * 60 * 60 * 1000);

    // Quick ranges use exact rolling windows (not midnight-to-midnight)
    analyticsCustomRange = {
        from,
        to: now
    };

    fromEl.value = toLocalDateInputValue(from);
    toEl.value = toLocalDateInputValue(now);

    if (triggerReload) {
        loadAnalyticsReport();
        loadAnalyticsDiagnostics();
        loadRealtimeAnalytics();
    }
}

function getAnalyticsRangeQuery() {
    ensureAnalyticsDateRange();

    const fromEl = document.getElementById('analyticsFrom');
    const toEl = document.getElementById('analyticsTo');
    if (!fromEl || !toEl) return null;

    let fromDate = null;
    let toDate = null;

    // Prefer the date inputs whenever both are set and the user cleared the quick-range override
    if (analyticsCustomRange?.from && analyticsCustomRange?.to) {
        fromDate = new Date(analyticsCustomRange.from);
        toDate = new Date(analyticsCustomRange.to);
    } else {
        if (!fromEl.value || !toEl.value) return null;
        fromDate = parseLocalDateInput(fromEl.value, false);
        toDate = parseLocalDateInput(toEl.value, true);
    }

    if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return null;
    }

    if (fromDate > toDate) {
        const tmp = fromDate;
        fromDate = toDate;
        toDate = tmp;
    }

    const params = new URLSearchParams({
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        limit: String(ANALYTICS_LIMIT)
    });
    return params.toString();
}

function renderAnalyticsOverview(reportData) {
    const overview = reportData?.overview || {};
    const earliest = reportData?.range?.earliestAvailable || null;

    analyticsOverviewSnapshot = overview;

    setAnalyticsText('anTotalEvents', formatAnalyticsNumber(overview.totalEvents));
    setAnalyticsText('anPageViews', formatAnalyticsNumber(overview.pageViews));
    setAnalyticsText('anUniqueVisitors', formatAnalyticsNumber(overview.uniqueVisitors));
    setAnalyticsText('anSessions', formatAnalyticsNumber(overview.sessions));
    setAnalyticsText('anReturning', formatAnalyticsNumber(overview.returningVisitors));
    setAnalyticsText('anAuthVisitors', formatAnalyticsNumber(overview.authVisitors));
    setAnalyticsText('anBounceRate', formatAnalyticsPercent(overview.bounceRate));
    setAnalyticsText('anAvgDuration', formatAnalyticsDuration(overview.avgSessionDurationSec));
    setAnalyticsText('anApiErrors', formatAnalyticsNumber(overview.apiErrors));
    setAnalyticsText('anEarliest', earliest ? formatAnalyticsDate(earliest) : '-');
    setAnalyticsText('anJsErrors', formatAnalyticsNumber(overview.jsErrors));
    setAnalyticsText('anSearchTraffic', formatAnalyticsNumber(overview.searchTraffic));
    setAnalyticsText('anSocialTraffic', formatAnalyticsNumber(overview.socialTraffic));
    setAnalyticsText('anPwaInstalled', formatAnalyticsNumber(overview.pwaInstalledEvents));
    setAnalyticsText('anUiClicks', formatAnalyticsNumber(overview.uiClicks));
    setAnalyticsText('anTabChanges', formatAnalyticsNumber(overview.tabChanges));
}

function renderAnalyticsTimeline(rows) {
    renderAnalyticsRows(
        'anTimelineBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.date || '-')}</td>
                <td>${formatAnalyticsNumber(row.pageViews)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
                <td>${formatAnalyticsNumber(row.sessions)}</td>
            </tr>
        `)
    );
}

function renderAnalyticsTopPages(rows) {
    renderAnalyticsRows(
        'anTopPagesBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${formatAnalyticsNumber(row.pageViews)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
                <td>${formatAnalyticsNumber(row.exits)}</td>
                <td>${formatAnalyticsDuration(row.avgDurationSec)}</td>
            </tr>
        `)
    );
}

function renderAnalyticsTopClicks(rows) {
    renderAnalyticsRows(
        'anTopClicksBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.label || '-')}</td>
                <td>${escapeHtml(row.action || '-')}</td>
                <td>${escapeHtml(row.zone || '-')}</td>
                <td>${escapeHtml(row.appSection || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
            </tr>
        `),
        'No click data.',
        5
    );
}

function renderAnalyticsEngagement(engagement) {
    const data = engagement || {};

    renderAnalyticsRows(
        'anTabClicksBody',
        (data.tabClicks || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.tabGroup || '-')}</td>
                <td>${escapeHtml(row.tabName || '-')}</td>
                <td>${escapeHtml(row.appSection || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
                <td>${escapeHtml(row.lastClickedAt ? formatAnalyticsDateTime(row.lastClickedAt) : '-')}</td>
            </tr>
        `),
        'No tab click data yet. New tab switches are tracked going forward.',
        6
    );

    renderAnalyticsRows(
        'anTabsByHourBody',
        (data.tabsByHour || []).map((row) => `
            <tr>
                <td>${escapeHtml(String(row.hour ?? '-'))}:00</td>
                <td>${escapeHtml(row.tabGroup || '-')}</td>
                <td>${escapeHtml(row.tabName || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
            </tr>
        `),
        'No hourly tab data.',
        4
    );

    renderAnalyticsRows(
        'anTabsByWhereBody',
        (data.tabsByWhere || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${escapeHtml(row.country || '-')}</td>
                <td>${escapeHtml(row.viewportBucket || '-')}</td>
                <td>${escapeHtml(row.appZone || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
            </tr>
        `),
        'No location/path tab data.',
        5
    );

    renderAnalyticsRows(
        'anTabTransitionsBody',
        (data.tabTransitions || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.transition || '-')}</td>
                <td>${escapeHtml(row.tabGroup || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
            </tr>
        `),
        'No tab transition data yet.',
        3
    );

    renderAnalyticsRows(
        'anRecentTabsBody',
        (data.recentTabClicks || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.createdAt ? formatAnalyticsDateTime(row.createdAt) : '-')}</td>
                <td>${escapeHtml(row.tabGroup || '-')}</td>
                <td>${escapeHtml(row.tabName || '-')}</td>
                <td>${escapeHtml(row.previousTab || '-')}</td>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${escapeHtml(row.country || '-')}</td>
                <td>${escapeHtml(row.viewportBucket || '-')}</td>
            </tr>
        `),
        'No recent tab activity.',
        7
    );

    renderAnalyticsRows(
        'anClickActionsBody',
        (data.clickActions || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.action || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `),
        'No click action data.',
        3
    );

    renderAnalyticsRows(
        'anClickZonesBody',
        (data.clickZones || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.zone || '-')}</td>
                <td>${formatAnalyticsNumber(row.clicks)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `),
        'No click zone data.',
        3
    );
}

function renderAnalyticsTopSections(rows) {
    renderAnalyticsRows(
        'anTopSectionsBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.section || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `)
    );
}

function renderAnalyticsDeviceBreakdown(breakdown) {
    const rows = [];
    (breakdown?.devices || []).forEach((item) => {
        rows.push(`
            <tr>
                <td>Device</td>
                <td>${escapeHtml(item.label || '-')}</td>
                <td>${formatAnalyticsNumber(item.count)}</td>
            </tr>
        `);
    });
    (breakdown?.browsers || []).forEach((item) => {
        rows.push(`
            <tr>
                <td>Browser</td>
                <td>${escapeHtml(item.label || '-')}</td>
                <td>${formatAnalyticsNumber(item.count)}</td>
            </tr>
        `);
    });
    (breakdown?.os || []).forEach((item) => {
        rows.push(`
            <tr>
                <td>OS</td>
                <td>${escapeHtml(item.label || '-')}</td>
                <td>${formatAnalyticsNumber(item.count)}</td>
            </tr>
        `);
    });
    renderAnalyticsRows('anDeviceBreakdownBody', rows);
}

function renderAnalyticsFlows(rows) {
    renderAnalyticsRows(
        'anFlowsBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${formatAnalyticsNumber(row.count)}</td>
            </tr>
        `)
    );
}

function renderAnalyticsFunnel(rows) {
    renderAnalyticsRows(
        'anFunnelBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.label || row.key || '-')}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `)
    );
}

function renderAnalyticsSignedInUsers(rows) {
    renderAnalyticsRows(
        'anSignedInUsersBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.username || '-')}</td>
                <td>${escapeHtml(row.role || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
                <td>${formatAnalyticsNumber(row.sessions)}</td>
            </tr>
        `)
    );
}

function renderAnalyticsAcquisition(acquisition) {
    renderAnalyticsRows(
        'anAcqSourcesBody',
        (acquisition?.sources || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.source || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `),
        'No source data.',
        3
    );

    renderAnalyticsRows(
        'anAcqReferrersBody',
        (acquisition?.referrers || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.referrerHost || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `),
        'No referrer data.',
        3
    );

    renderAnalyticsRows(
        'anAcqCampaignsBody',
        (acquisition?.campaigns || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.utmSource || '-')}</td>
                <td>${escapeHtml(row.utmCampaign || '-')}</td>
                <td>${escapeHtml(row.utmMedium || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
            </tr>
        `),
        'No campaign data.',
        4
    );

    const geoRows = [];
    (acquisition?.countries || []).forEach((row) => {
        geoRows.push(`
            <tr>
                <td>Country</td>
                <td>${escapeHtml(row.country || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
            </tr>
        `);
    });
    (acquisition?.languages || []).forEach((row) => {
        geoRows.push(`
            <tr>
                <td>Language</td>
                <td>${escapeHtml(row.language || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
            </tr>
        `);
    });
    renderAnalyticsRows('anAcqGeoBody', geoRows, 'No country/language data.', 3);
}

function renderAnalyticsTechnical(technical) {
    renderAnalyticsRows(
        'anTechNetworkBody',
        (technical?.network || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.quality || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
            </tr>
        `),
        'No network data.',
        2
    );

    const viewportRows = [];
    (technical?.viewport || []).forEach((row) => {
        viewportRows.push(`
            <tr>
                <td>Viewport</td>
                <td>${escapeHtml(row.bucket || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
            </tr>
        `);
    });
    (technical?.pwa || []).forEach((row) => {
        viewportRows.push(`
            <tr>
                <td>PWA</td>
                <td>${escapeHtml(row.mode || '-')}</td>
                <td>${formatAnalyticsNumber(row.events)}</td>
            </tr>
        `);
    });
    renderAnalyticsRows('anTechViewportBody', viewportRows, 'No viewport/PWA data.', 3);

    renderAnalyticsRows(
        'anTechApiErrorsBody',
        (technical?.apiErrors || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${escapeHtml(String(row.statusCode ?? '-'))}</td>
                <td>${formatAnalyticsNumber(row.errors)}</td>
            </tr>
        `),
        'No API errors.',
        3
    );

    renderAnalyticsRows(
        'anTechJsErrorsBody',
        (technical?.jsErrors || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.message || '-')}</td>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${formatAnalyticsNumber(row.errors)}</td>
            </tr>
        `),
        'No JS errors.',
        3
    );
}

function renderAnalyticsContent(content) {
    renderAnalyticsRows(
        'anContentTopCardsBody',
        (content?.topCards || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.personName || row.cardId || '-')}</td>
                <td>${escapeHtml(row.addressStatus || '-')}</td>
                <td>${formatAnalyticsNumber(row.interactions)}</td>
                <td>${formatAnalyticsNumber(row.likes)}</td>
                <td>${formatAnalyticsNumber(row.dislikes)}</td>
                <td>${formatAnalyticsNumber(row.comments)}</td>
                <td>${formatAnalyticsNumber(row.shares)}</td>
            </tr>
        `),
        'No card interaction data.',
        7
    );

    renderAnalyticsRows(
        'anContentAddressTypeBody',
        (content?.interactionByAddressType || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.type || '-')}</td>
                <td>${formatAnalyticsNumber(row.interactions)}</td>
                <td>${formatAnalyticsNumber(row.uniqueVisitors)}</td>
            </tr>
        `),
        'No with/without address data.',
        3
    );

    renderAnalyticsRows(
        'anContentTagsBody',
        (content?.topTags || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.tag || '-')}</td>
                <td>${formatAnalyticsNumber(row.interactions)}</td>
            </tr>
        `),
        'No tag engagement data.',
        2
    );
}

function renderAnalyticsCohorts(rows) {
    renderAnalyticsRows(
        'anCohortsBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.cohort || '-')}</td>
                <td>${formatAnalyticsNumber(row.users)}</td>
                <td>${formatAnalyticsNumber(row.day1)} (${formatAnalyticsPercent(row.day1Rate)})</td>
                <td>${formatAnalyticsNumber(row.day7)} (${formatAnalyticsPercent(row.day7Rate)})</td>
                <td>${formatAnalyticsNumber(row.day30)} (${formatAnalyticsPercent(row.day30Rate)})</td>
            </tr>
        `),
        'No cohort data.',
        5
    );
}

function renderRealtimeSummary(data) {
    setAnalyticsText('anRealtimeVisitors', formatAnalyticsNumber(data?.activeVisitors));
    setAnalyticsText('anRealtimeSessions', formatAnalyticsNumber(data?.activeSessions));
}

function renderRealtimeTopPages(rows) {
    renderAnalyticsRows(
        'anRealtimeTopPagesBody',
        (rows || []).map((row) => `
            <tr>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${formatAnalyticsNumber(row.views)}</td>
            </tr>
        `)
    );
}

function renderRealtimeEvents(rows) {
    renderAnalyticsRows(
        'anRealtimeEventsBody',
        (rows || []).map((row) => `
            <tr>
                <td>${formatAnalyticsDateTime(row.createdAt)}</td>
                <td>${escapeHtml(row.eventName || '-')}</td>
                <td>${escapeHtml(row.path || '-')}</td>
                <td>${escapeHtml(row.appSection || '-')}</td>
            </tr>
        `)
    );
}

function renderDiagnosticsWarnings(warnings) {
    const listEl = document.getElementById('anDiagWarnings');
    if (!listEl) return;
    const items = Array.isArray(warnings) ? warnings : [];
    if (items.length === 0) {
        listEl.innerHTML = '<li>No warnings detected.</li>';
        return;
    }
    listEl.innerHTML = items.map((warning) => `<li>${escapeHtml(warning || '-')}</li>`).join('');
}

function renderAnalyticsDiagnostics(data) {
    analyticsDiagnosticsSnapshot = data || null;

    const generatedAt = data?.generatedAt ? formatAnalyticsDateTime(data.generatedAt) : '-';
    const node = [
        data?.server?.nodeVersion || '-',
        data?.server?.platform || '-'
    ].join(' | ');
    const mongo = data?.server?.mongo
        ? `${data.server.mongo.state || '-'} (${data.server.mongo.readyState ?? '-'})`
        : '-';
    const uptime = formatUptime(data?.server?.uptimeSec);
    const memory = data?.server?.memoryHuman
        ? `${data.server.memoryHuman.heapUsed || '-'} / ${data.server.memoryHuman.heapTotal || '-'} (RSS ${data.server.memoryHuman.rss || '-'})`
        : '-';

    setAnalyticsText('anDiagGeneratedAt', generatedAt);
    setAnalyticsText('anDiagNode', node);
    setAnalyticsText('anDiagMongo', mongo);
    setAnalyticsText('anDiagUptime', uptime);
    setAnalyticsText('anDiagMemory', memory);
    renderDiagnosticsWarnings(data?.warnings || []);

    const recentRows = [];
    (data?.recentApiErrors || []).forEach((row) => {
        recentRows.push({
            createdAt: row.createdAt,
            count: Number(row.count || 1),
            type: 'API',
            target: `${row.method || '-'} ${row.endpoint || row.path || '-'}`.trim(),
            message: row.message || '-'
        });
    });
    (data?.recentJsErrors || []).forEach((row) => {
        recentRows.push({
            createdAt: row.createdAt,
            count: Number(row.count || 1),
            type: 'JS',
            target: row.path || '-',
            message: row.message || '-'
        });
    });
    recentRows.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    renderAnalyticsRows(
        'anDiagRecentErrorsBody',
        recentRows.slice(0, ANALYTICS_LIMIT).map((row) => `
            <tr>
                <td>${formatAnalyticsNumber(row.count)}</td>
                <td>${formatAnalyticsDateTime(row.createdAt)}</td>
                <td>${escapeHtml(row.type || '-')}</td>
                <td>${escapeHtml(row.target || '-')}</td>
                <td>${escapeHtml(row.message || '-')}</td>
            </tr>
        `),
        'No recent diagnostic errors.',
        5
    );
}

async function loadAnalyticsDiagnostics() {
    const rangeQuery = getAnalyticsRangeQuery();
    if (!rangeQuery) {
        showAnalyticsAlert('Invalid diagnostics date range.');
        return;
    }

    try {
        const response = await authAPI.request(`/almighty/analytics/diagnostics?${rangeQuery}`);
        if (!response.success || !response.data) {
            throw new Error(response.message || 'Failed to load diagnostics');
        }
        clearAnalyticsAlert();
        renderAnalyticsDiagnostics(response.data);
    } catch (error) {
        console.error('Error loading diagnostics report:', error);
        if (error.status === 403) {
            showAnalyticsAlert('Diagnostics access is limited to Almighty.');
            return;
        }
        showAnalyticsAlert(error.message || 'Failed to load diagnostics report.');
    }
}

async function downloadAnalyticsDiagnosticsReport() {
    const rangeQuery = getAnalyticsRangeQuery();
    if (!rangeQuery) {
        showAnalyticsAlert('Invalid diagnostics date range.');
        return;
    }

    const token = authAPI.getToken();
    const apiBaseUrl = (typeof window !== 'undefined' && window.__API_BASE_URL)
        ? window.__API_BASE_URL
        : `${window.location.origin}/api`;
    const exportUrl = `${apiBaseUrl}/almighty/analytics/diagnostics/export?${rangeQuery}`;

    try {
        const response = await fetch(exportUrl, {
            method: 'GET',
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });

        if (!response.ok) {
            let message = 'Failed to download diagnostics export.';
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await response.json();
                message = data?.message || message;
            }
            throw new Error(message);
        }

        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const fileNameMatch = disposition.match(/filename="?([^"]+)"?/i);
        const filename = fileNameMatch?.[1] || `radgir-diagnostics-${Date.now()}.txt`;

        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(href);
    } catch (error) {
        console.error('Error downloading diagnostics export:', error);
        showAnalyticsAlert(error.message || 'Failed to download diagnostics export.');
    }
}

async function loadAnalyticsReport() {
    const rangeQuery = getAnalyticsRangeQuery();
    if (!rangeQuery) {
        showAnalyticsAlert('Invalid analytics date range.');
        return;
    }

    try {
        const response = await authAPI.request(`/almighty/analytics/report?${rangeQuery}`);
        if (!response.success || !response.data) {
            throw new Error(response.message || 'Failed to load analytics report');
        }

        clearAnalyticsAlert();
        renderAnalyticsOverview(response.data);
        renderAnalyticsTimeline(response.data.timeline || []);
        renderAnalyticsTopPages(response.data.topPages || []);
        renderAnalyticsTopClicks(response.data.topClicks || []);
        renderAnalyticsEngagement(response.data.engagement || {});
        renderAnalyticsTopSections(response.data.topSections || []);
        renderAnalyticsDeviceBreakdown(response.data.deviceBreakdown || {});
        renderAnalyticsFlows(response.data.navigationFlows || []);
        renderAnalyticsFunnel(response.data.funnel || []);
        renderAnalyticsSignedInUsers(response.data.signedInUsers || []);
        renderAnalyticsAcquisition(response.data.acquisition || {});
        renderAnalyticsTechnical(response.data.technical || {});
        renderAnalyticsContent(response.data.content || {});
        renderAnalyticsCohorts(response.data.cohorts || []);
    } catch (error) {
        console.error('Error loading analytics report:', error);
        if (error.status === 403) {
            showAnalyticsAlert('Analytics report access is limited to Almighty.');
            return;
        }
        showAnalyticsAlert(error.message || 'Failed to load analytics report.');
    }
}

async function loadRealtimeAnalytics() {
    try {
        const response = await authAPI.request('/almighty/analytics/realtime?minutes=30');
        if (!response.success || !response.data) {
            throw new Error(response.message || 'Failed to load realtime analytics');
        }

        clearAnalyticsAlert();
        renderRealtimeSummary(response.data);
        renderRealtimeTopPages(response.data.topPages || []);
        renderRealtimeEvents(response.data.recentEvents || []);
    } catch (error) {
        console.error('Error loading realtime analytics:', error);
        if (error.status === 403) {
            showAnalyticsAlert('Realtime analytics access is limited to Almighty.');
            return;
        }
        showAnalyticsAlert(error.message || 'Failed to load realtime analytics.');
    }
}

function setupAnalyticsControls() {
    const refreshReportBtn = document.getElementById('refreshAnalyticsBtn');
    const refreshRealtimeBtn = document.getElementById('refreshRealtimeBtn');
    const refreshDiagnosticsBtn = document.getElementById('refreshDiagnosticsBtn');
    const downloadDiagnosticsBtn = document.getElementById('downloadDiagnosticsBtn');
    const quick24hBtn = document.getElementById('analyticsQuick24h');
    const quick7dBtn = document.getElementById('analyticsQuick7d');
    const quick30dBtn = document.getElementById('analyticsQuick30d');
    const fromEl = document.getElementById('analyticsFrom');
    const toEl = document.getElementById('analyticsTo');

    if (!refreshReportBtn || !refreshRealtimeBtn || !fromEl || !toEl) return;

    ensureAnalyticsDateRange();

    if (!refreshReportBtn.dataset.bound) {
        refreshReportBtn.dataset.bound = '1';
        refreshReportBtn.addEventListener('click', () => {
            loadAnalyticsReport();
            loadAnalyticsDiagnostics();
        });
    }
    if (!refreshRealtimeBtn.dataset.bound) {
        refreshRealtimeBtn.dataset.bound = '1';
        refreshRealtimeBtn.addEventListener('click', () => {
            loadRealtimeAnalytics();
        });
    }
    if (refreshDiagnosticsBtn && !refreshDiagnosticsBtn.dataset.bound) {
        refreshDiagnosticsBtn.dataset.bound = '1';
        refreshDiagnosticsBtn.addEventListener('click', () => {
            loadAnalyticsDiagnostics();
        });
    }
    if (downloadDiagnosticsBtn && !downloadDiagnosticsBtn.dataset.bound) {
        downloadDiagnosticsBtn.dataset.bound = '1';
        downloadDiagnosticsBtn.addEventListener('click', () => {
            downloadAnalyticsDiagnosticsReport();
        });
    }
    if (quick24hBtn && !quick24hBtn.dataset.bound) {
        quick24hBtn.dataset.bound = '1';
        quick24hBtn.addEventListener('click', () => setAnalyticsQuickRange(24));
    }
    if (quick7dBtn && !quick7dBtn.dataset.bound) {
        quick7dBtn.dataset.bound = '1';
        quick7dBtn.addEventListener('click', () => setAnalyticsQuickRange(24 * 7));
    }
    if (quick30dBtn && !quick30dBtn.dataset.bound) {
        quick30dBtn.dataset.bound = '1';
        quick30dBtn.addEventListener('click', () => setAnalyticsQuickRange(24 * 30));
    }
    if (!fromEl.dataset.bound) {
        fromEl.dataset.bound = '1';
        fromEl.addEventListener('change', () => {
            analyticsCustomRange = null; // honor custom From/To calendar days instead of quick-range override
            loadAnalyticsReport();
            loadAnalyticsDiagnostics();
        });
    }
    if (!toEl.dataset.bound) {
        toEl.dataset.bound = '1';
        toEl.addEventListener('change', () => {
            analyticsCustomRange = null;
            loadAnalyticsReport();
            loadAnalyticsDiagnostics();
        });
    }
}

function startAnalyticsRealtimeTimer() {
    if (analyticsRealtimeTimer) {
        clearInterval(analyticsRealtimeTimer);
    }
    analyticsRealtimeTimer = setInterval(() => {
        loadRealtimeAnalytics();
    }, 60000);
}

window.addEventListener('beforeunload', () => {
    if (analyticsRealtimeTimer) {
        clearInterval(analyticsRealtimeTimer);
        analyticsRealtimeTimer = null;
    }
});

/**
 * Initialize the portal
 * Checks authentication and loads data
 * Wrapped in try-catch for comprehensive error handling
 */
async function initPortal() {
    try {
        setupPortalTabs();

        // Check if user is authenticated and is Almighty
        if (!authAPI.isAuthenticated()) {
            console.log('User not authenticated, redirecting to login');
            if (typeof router !== 'undefined') {
                router.navigate('/login');
            } else {
                window.location.href = 'login.html';
            }
            return;
        }

        const user = authAPI.getCurrentUser();
        // Match the client guard to the existing Almighty-only API authorization.
        if (!user || user.role !== 'Almighty') {
            console.log('User is not Almighty, redirecting');
            alert('Access denied. Almighty role required.');
            if (typeof router !== 'undefined') {
                router.navigate('/login');
            } else {
                window.location.href = 'login.html';
            }
            return;
        }

        // Display current user info when the legacy label exists
        const currentUserEl = document.getElementById('currentUser');
        if (currentUserEl) currentUserEl.textContent = `${user.username} (${user.role})`;

        // Load statistics, users, and pending role upgrade requests
        // These functions have their own error handling, so errors won't crash the portal
        await loadStatistics();
        await loadUsers();
        await loadRoleUpgradeRequests(); // Load pending role upgrade requests
        await loadAboutContactEditor();
        await loadPersonTagsEditor();
        setupAnalyticsControls();
        await loadAnalyticsReport();
        await loadRealtimeAnalytics();
        await loadAnalyticsDiagnostics();
        startAnalyticsRealtimeTimer();
    } catch (error) {
        // Handle any unexpected errors during initialization
        console.error('Error initializing portal:', error);
        alert('An error occurred while initializing the portal. Please refresh the page.');
    }
}

/**
 * Load system statistics
 * Fetches statistics from the Almighty API endpoint
 */
async function loadStatistics() {
    try {
        console.log('Loading statistics...');
        const response = await authAPI.request('/almighty/stats');

        if (response.success) {
            const stats = response.data;
            
            // Update stat cards
            document.getElementById('statTotal').textContent = stats.totalUsers || 0;
            document.getElementById('statActive').textContent = stats.activeUsers || 0;
            document.getElementById('statAlmighty').textContent = stats.roleCounts?.Almighty || 0;
            document.getElementById('statRecent').textContent = stats.recentUsers || 0;

            console.log('Statistics loaded successfully');
        }
    } catch (error) {
        // Comprehensive error handling for statistics loading
        console.error('Error loading statistics:', error);
        
        // Extract error message based on error type and status
        let errorMessage = 'Failed to load statistics';
        
        if (error.status === 401) {
            // Unauthorized - session expired
            errorMessage = 'Session expired. Please login again.';
            setTimeout(() => authAPI.logout(), 2000);
        } else if (error.status === 403) {
            // Forbidden - not authorized
            errorMessage = 'Access denied. Almighty role required.';
        } else if (error.status === 500) {
            // Server error
            errorMessage = 'Server error. Please try again later.';
        } else if (error.message) {
            // Use specific error message if available
            errorMessage = `Failed to load statistics: ${error.message}`;
        }
        
        showAlert(errorMessage, 'error');
    }
}

/**
 * Load users list
 * Fetches all users from the Almighty API endpoint
 * 
 * @param {string} search - Optional search query
 * @param {string} role - Optional role filter
 */
async function loadUsers(search = '', role = '') {
    try {
        // Show loading indicator
        document.getElementById('loadingIndicator').style.display = 'block';
        document.getElementById('usersTable').style.display = 'none';

        console.log('Loading users...', { search, role });

        // Build query parameters
        const params = new URLSearchParams();
        if (search) params.append('search', search);
        if (role) params.append('role', role);
        params.append('limit', '100'); // Load more users

        // Fetch users
        const response = await authAPI.request(`/almighty/users?${params.toString()}`);

        console.log('Users API response:', response); // Debug log

        if (response.success && response.data) {
            const users = response.data.users || [];
            const tbody = document.getElementById('usersTableBody');
            
            if (!tbody) {
                console.error('usersTableBody element not found!');
                throw new Error('Users table body element not found');
            }
            
            // Clear existing rows
            tbody.innerHTML = '';

            if (users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-light);">No users found. Register new users to see them here.</td></tr>';
            } else {
                // Create table rows for each user
                users.forEach(user => {
                    const row = createUserRow(user);
                    tbody.appendChild(row);
                });
            }

            // Hide loading, show table
            const loadingIndicator = document.getElementById('loadingIndicator');
            const usersTable = document.getElementById('usersTable');
            
            if (loadingIndicator) loadingIndicator.style.display = 'none';
            if (usersTable) usersTable.style.display = 'table';

            console.log(`Successfully loaded ${users.length} users`);
        } else {
            // Response structure is not as expected
            console.error('Unexpected response structure:', response);
            throw new Error(response.message || 'Invalid response from server');
        }
    } catch (error) {
        // Comprehensive error handling for users loading
        console.error('Error loading users:', error);
        document.getElementById('loadingIndicator').style.display = 'none';
        
        // Extract error message based on error type and status
        let errorMessage = 'Failed to load users';
        
        if (error.status === 401) {
            // Unauthorized - session expired
            errorMessage = 'Session expired. Please login again.';
            setTimeout(() => authAPI.logout(), 2000);
        } else if (error.status === 403) {
            // Forbidden - not authorized
            errorMessage = 'Access denied. Almighty role required.';
        } else if (error.status === 500) {
            // Server error
            errorMessage = 'Server error. Please try again later.';
        } else if (error.message) {
            // Use specific error message if available
            errorMessage = `Failed to load users: ${error.message}`;
        }
        
        showAlert(errorMessage, 'error');
    }
}

/**
 * Create a table row for a user
 * 
 * @param {Object} user - User object
 * @returns {HTMLElement} Table row element
 */
function createUserRow(user) {
    const row = document.createElement('tr');

    // Format last login date
    const lastLogin = user.lastLogin 
        ? new Date(user.lastLogin).toLocaleString() 
        : 'Never';

    // Get badge class for role
    const roleBadgeClass = `badge-${user.role.toLowerCase()}`;
    
    // Get translations for status and buttons
    const t = languageManager ? languageManager.getTranslations(languageManager.getCurrentLanguage()) : null;
    const commonT = t ? t.common : null;
    const almightyT = t ? t.almighty : null;
    
    const activeText = commonT ? commonT.active : 'Active';
    const inactiveText = commonT ? commonT.inactive : 'Inactive';
    const editText = almightyT ? almightyT.editButton : 'Edit';
    const deleteText = almightyT ? almightyT.deleteButton : 'Delete';
    const neverText = almightyT ? almightyT.never : 'Never';
    
    // Get status badge
    const statusBadge = user.isActive 
        ? `<span class="badge badge-active">${activeText}</span>`
        : `<span class="badge badge-inactive">${inactiveText}</span>`;

    row.innerHTML = `
        <td class="username-cell" style="cursor: pointer; color: var(--primary-color); text-decoration: underline;" onclick="viewUserPostsFromPortal('${user._id}', '${escapeHtml(user.username)}')" title="Click to view this user's posts">${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td><span class="badge ${roleBadgeClass}">${escapeHtml(user.role)}</span></td>
        <td>${user.level}</td>
        <td>${statusBadge}</td>
        <td>${lastLogin === 'Never' ? neverText : lastLogin}</td>
        <td>
            <button class="btn-action btn-edit" onclick="editUser('${user._id}')">${editText}</button>
            <button class="btn-action btn-delete" onclick="deleteUser('${user._id}', '${escapeHtml(user.username)}')">${deleteText}</button>
        </td>
    `;

    return row;
}

/**
 * Handle search input
 * Debounces search to avoid too many API calls
 */
function handleSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchTerm = searchInput.value.trim();

    // Clear existing timeout
    if (searchTimeout) {
        clearTimeout(searchTimeout);
    }

    // Debounce search (wait 500ms after user stops typing)
    searchTimeout = setTimeout(() => {
        loadUsers(searchTerm);
    }, 500);
}

/**
 * Open create user modal
 * Resets form and shows modal for creating a new user
 */
function openCreateUserModal() {
    editingUserId = null;
    // Get translation for modal title
    const t = languageManager ? languageManager.getTranslations(languageManager.getCurrentLanguage()) : null;
    const almightyT = t ? t.almighty : null;
    const modalTitle = almightyT ? almightyT.modalTitleCreate : 'Create New User';
    document.getElementById('modalTitle').textContent = modalTitle;
    document.getElementById('userForm').reset();
    document.getElementById('userId').value = '';
    document.getElementById('modalPassword').required = true;
    document.getElementById('modalLevel').value = '30';
    document.getElementById('modalRole').value = 'User';
    // Reset permission checkboxes
    document.getElementById('permissionEditPosts').checked = false;
    document.getElementById('permissionDeletePosts').checked = false;
    updateLevel(); // Update level based on role
    document.getElementById('userModal').classList.add('active');
}

/**
 * Edit user
 * Loads user data and opens modal for editing
 * 
 * @param {string} userId - User ID to edit
 */
async function editUser(userId) {
    try {
        console.log('Editing user:', userId);
        
        // Fetch user details
        const response = await authAPI.request(`/almighty/users/${userId}`);

        if (response.success) {
            const user = response.data.user;
            editingUserId = userId;

            // Populate form
            // Get translation for modal title
            const t = languageManager ? languageManager.getTranslations(languageManager.getCurrentLanguage()) : null;
            const almightyT = t ? t.almighty : null;
            const modalTitle = almightyT ? almightyT.modalTitleEdit : 'Edit User';
            document.getElementById('modalTitle').textContent = modalTitle;
            document.getElementById('userId').value = user._id;
            document.getElementById('modalUsername').value = user.username;
            document.getElementById('modalEmail').value = user.email;
            document.getElementById('modalPassword').value = '';
            document.getElementById('modalPassword').required = false; // Password optional when editing
            document.getElementById('modalRole').value = user.role;
            document.getElementById('modalLevel').value = user.level;
            document.getElementById('modalActive').value = user.isActive.toString();

            // Populate permissions checkboxes
            const permissions = user.permissions || [];
            document.getElementById('permissionEditPosts').checked = permissions.includes('edit:posts');
            document.getElementById('permissionDeletePosts').checked = permissions.includes('delete:posts');

            // Show modal
            document.getElementById('userModal').classList.add('active');
        }
    } catch (error) {
        // Comprehensive error handling for user details loading
        console.error('Error loading user:', error);
        
        // Extract error message based on error type and status
        let errorMessage = 'Failed to load user details';
        
        if (error.status === 404) {
            // User not found
            errorMessage = 'User not found';
        } else if (error.status === 401) {
            // Unauthorized - session expired
            errorMessage = 'Session expired. Please login again.';
            setTimeout(() => authAPI.logout(), 2000);
        } else if (error.status === 403) {
            // Forbidden - not authorized
            errorMessage = 'Access denied. Almighty role required.';
        } else if (error.status === 500) {
            // Server error
            errorMessage = 'Server error. Please try again later.';
        } else if (error.message) {
            // Use specific error message if available
            errorMessage = `Failed to load user details: ${error.message}`;
        }
        
        showAlert(errorMessage, 'error');
        closeUserModal();
    }
}

/**
 * Delete user
 * Confirms deletion and removes user
 * 
 * @param {string} userId - User ID to delete
 * @param {string} username - Username for confirmation message
 */
async function deleteUser(userId, username) {
    // Confirm deletion
    if (!confirm(`Are you sure you want to delete user "${username}"?\n\nThis action cannot be undone.`)) {
        return;
    }

    try {
        console.log('Deleting user:', userId);
        
        const response = await authAPI.request(`/almighty/users/${userId}`, {
            method: 'DELETE'
        });

        if (response.success) {
            showAlert('User deleted successfully', 'success');
            // Reload users list
            await loadUsers();
            await loadStatistics();
        }
    } catch (error) {
        // Comprehensive error handling for user deletion
        console.error('Error deleting user:', error);
        
        // Extract error message based on error type and status
        let errorMessage = 'Failed to delete user';
        
        if (error.status === 404) {
            // User not found
            errorMessage = 'User not found. It may have already been deleted.';
            // Reload users list to refresh display
            await loadUsers();
        } else if (error.status === 400) {
            // Bad request (e.g., trying to delete yourself)
            errorMessage = error.message || 'Cannot delete this user';
        } else if (error.status === 401) {
            // Unauthorized - session expired
            errorMessage = 'Session expired. Please login again.';
            setTimeout(() => authAPI.logout(), 2000);
        } else if (error.status === 403) {
            // Forbidden - not authorized
            errorMessage = 'Access denied. Almighty role required.';
        } else if (error.status === 500) {
            // Server error
            errorMessage = 'Server error. Please try again later.';
        } else if (error.message) {
            // Use specific error message if available
            errorMessage = `Failed to delete user: ${error.message}`;
        }
        
        showAlert(errorMessage, 'error');
    }
}

/**
 * Update level based on selected role
 * Sets default level for the selected role
 */
function updateLevel() {
    const role = document.getElementById('modalRole').value;
    const levelInput = document.getElementById('modalLevel');
    
    // Default levels for each role
    const roleLevels = {
        'Almighty': 100,
        'SuperAdmin': 90,
        'Admin': 70,
        'Manager': 50,
        'User': 30,
        'Guest': 10
    };

    // Only update if level hasn't been manually changed or if creating new user
    if (!editingUserId || levelInput.value === '30') {
        levelInput.value = roleLevels[role] || 30;
    }
}

/**
 * Close user modal
 */
function closeUserModal() {
    document.getElementById('userModal').classList.remove('active');
    document.getElementById('modalAlert').style.display = 'none';
    editingUserId = null;
}

/**
 * Handle user form submission
 * Creates or updates user based on editingUserId
 */
document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = {
        username: document.getElementById('modalUsername').value.trim(),
        email: document.getElementById('modalEmail').value.trim(),
        role: document.getElementById('modalRole').value,
        level: parseInt(document.getElementById('modalLevel').value),
        isActive: document.getElementById('modalActive').value === 'true'
    };

    // Collect permissions from checkboxes
    const permissions = [];
    if (document.getElementById('permissionEditPosts').checked) {
        permissions.push('edit:posts');
    }
    if (document.getElementById('permissionDeletePosts').checked) {
        permissions.push('delete:posts');
    }
    formData.permissions = permissions;

    // Add password only if provided or if creating new user
    const password = document.getElementById('modalPassword').value;
    if (password || !editingUserId) {
        if (password.length < 6) {
            showModalAlert('Password must be at least 6 characters', 'error');
            return;
        }
        formData.password = password;
    }

    try {
        let response;
        
        if (editingUserId) {
            // Update existing user
            console.log('Updating user:', editingUserId);
            response = await authAPI.request(`/almighty/users/${editingUserId}`, {
                method: 'PUT',
                body: JSON.stringify(formData)
            });
        } else {
            // Create new user
            console.log('Creating new user');
            response = await authAPI.request('/almighty/users', {
                method: 'POST',
                body: JSON.stringify(formData)
            });
        }

        if (response.success) {
            showModalAlert(editingUserId ? 'User updated successfully' : 'User created successfully', 'success');
            
            // Close modal and reload data after short delay
            setTimeout(() => {
                closeUserModal();
                loadUsers();
                loadStatistics();
            }, 1000);
        }
    } catch (error) {
        // Comprehensive error handling for user save/create/update
        console.error('Error saving user:', error);
        
        // Extract error message based on error type and status
        let errorMessage = 'Failed to save user';
        
        if (error.status === 400) {
            // Bad request - validation errors
            if (error.data && error.data.errors) {
                // Extract validation error messages
                const validationErrors = error.data.errors
                    .map(err => err.msg || err.message)
                    .join(', ');
                errorMessage = validationErrors || error.data.message || 'Invalid input data';
            } else {
                errorMessage = error.data?.message || error.message || 'Invalid input data';
            }
        } else if (error.status === 409) {
            // Conflict - duplicate username/email
            const field = error.data?.field || 'field';
            errorMessage = error.data?.message || `${field} already exists`;
        } else if (error.status === 404) {
            // User not found (when updating)
            errorMessage = 'User not found. It may have been deleted.';
            closeUserModal();
            await loadUsers();
        } else if (error.status === 401) {
            // Unauthorized - session expired
            errorMessage = 'Session expired. Please login again.';
            setTimeout(() => authAPI.logout(), 2000);
        } else if (error.status === 403) {
            // Forbidden - not authorized
            errorMessage = 'Access denied. Almighty role required.';
        } else if (error.status === 500) {
            // Server error
            errorMessage = 'Server error. Please try again later.';
        } else if (error.data?.message) {
            // Use error message from server response
            errorMessage = error.data.message;
        } else if (error.message) {
            // Use error message if available
            errorMessage = error.message;
        }
        
        showModalAlert(errorMessage, 'error');
    }
});

const aboutContentForm = document.getElementById('aboutContentForm');
if (aboutContentForm) {
    aboutContentForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const payload = {
            headline: document.getElementById('aboutContentHeadline').value.trim(),
            seeking: document.getElementById('aboutContentSeeking').value.trim(),
            email: document.getElementById('aboutContentEmail').value.trim()
        };

        if (!payload.email) {
            showAboutContentAlert('ایمیل الزامی است.', 'error');
            return;
        }

        try {
            const response = await authAPI.request('/almighty/about-contact', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });

            if (response.success) {
                showAboutContentAlert('محتوای صفحه درباره/تماس با موفقیت ذخیره شد.', 'success');
            } else {
                showAboutContentAlert(response.message || 'ذخیره محتوا ناموفق بود.', 'error');
            }
        } catch (error) {
            console.error('Error saving about/contact content:', error);
            const message = error?.data?.message || error?.message || 'ذخیره محتوا ناموفق بود.';
            showAboutContentAlert(message, 'error');
        }
    });
}

const personTagCreateForm = document.getElementById('personTagCreateForm');
if (personTagCreateForm && !personTagCreateForm.dataset.bound) {
    personTagCreateForm.dataset.bound = '1';
    personTagCreateForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const nameInput = document.getElementById('newPersonTagName');
        const orderInput = document.getElementById('newPersonTagOrder');
        const name = (nameInput?.value || '').trim();
        const sortOrder = Number.isFinite(Number(orderInput?.value)) ? parseInt(orderInput.value, 10) : 0;

        if (!name) {
            showPersonTagsAlert('نام برچسب الزامی است.', 'error');
            return;
        }

        try {
            const response = await authAPI.request('/almighty/tags', {
                method: 'POST',
                body: JSON.stringify({ name, sortOrder })
            });

            if (!response.success) {
                throw new Error(response.message || 'ایجاد برچسب ناموفق بود.');
            }

            if (nameInput) nameInput.value = '';
            if (orderInput) orderInput.value = '0';
            showPersonTagsAlert('برچسب با موفقیت اضافه شد.', 'success');
            await loadPersonTagsEditor();
            if (typeof loadAboutContactEditor === 'function') {
                await loadAboutContactEditor(); // Keep about lead preview aligned with new tag.
            }
        } catch (error) {
            console.error('Error creating person tag:', error);
            showPersonTagsAlert(error?.data?.message || error?.message || 'ایجاد برچسب ناموفق بود.', 'error');
        }
    });
}

/**
 * Show alert in modal
 * 
 * @param {string} message - Message to display
 * @param {string} type - Alert type: 'error' or 'success'
 */
function showModalAlert(message, type = 'error') {
    const alertDiv = document.getElementById('modalAlert');
    alertDiv.textContent = message;
    alertDiv.className = `alert ${type}`;
    alertDiv.style.display = 'block';
    
    setTimeout(() => {
        alertDiv.style.display = 'none';
    }, 5000);
}

/**
 * Show alert message
 * 
 * @param {string} message - Message to display
 * @param {string} type - Alert type: 'error' or 'success'
 */
function showAlert(message, type = 'error') {
    const alertDiv = document.getElementById('alert');
    alertDiv.textContent = message;
    alertDiv.className = `alert ${type}`;
    alertDiv.style.display = 'block';
    
    setTimeout(() => {
        alertDiv.style.display = 'none';
    }, 5000);
}

function showAboutContentAlert(message, type = 'error') {
    const alertDiv = document.getElementById('aboutContentAlert');
    if (!alertDiv) return;
    alertDiv.textContent = message;
    alertDiv.className = `alert ${type}`;
    alertDiv.style.display = 'block';

    setTimeout(() => {
        alertDiv.style.display = 'none';
    }, 5000);
}

function showPersonTagsAlert(message, type = 'error') {
    const alertDiv = document.getElementById('personTagsAlert');
    if (!alertDiv) return;
    alertDiv.textContent = message;
    alertDiv.className = `alert ${type}`;
    alertDiv.style.display = 'block';

    setTimeout(() => {
        alertDiv.style.display = 'none';
    }, 5000);
}

function renderPersonTagsRows(tags) {
    const tbody = document.getElementById('personTagsTableBody');
    if (!tbody) return;

    if (!Array.isArray(tags) || tags.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="loading">هیچ برچسبی ثبت نشده است.</td></tr>';
        return;
    }

    tbody.innerHTML = tags.map((tag) => {
        const tagId = String(tag._id || '');
        const inputNameId = `person-tag-name-${tagId}`;
        const inputOrderId = `person-tag-order-${tagId}`;
        const inputActiveId = `person-tag-active-${tagId}`;
        const checkedAttr = tag.isActive ? 'checked' : '';
        const activeText = tag.isActive ? 'فعال' : 'غیرفعال';
        const sortOrderValue = Number.isFinite(Number(tag.sortOrder)) ? Number(tag.sortOrder) : 0;

        return `
            <tr>
                <td><input type="text" id="${inputNameId}" value="${escapeHtml(tag.name || '')}" maxlength="100"></td>
                <td><input type="number" id="${inputOrderId}" value="${sortOrderValue}" min="-100000" max="100000"></td>
                <td>
                    <label style="display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" id="${inputActiveId}" ${checkedAttr}>
                        <span>${activeText}</span>
                    </label>
                </td>
                <td>
                    <div class="person-tags-actions">
                        <button type="button" class="person-tags-save" onclick="savePersonTagRow('${tagId}')">ذخیره</button>
                        <button type="button" class="person-tags-delete" onclick="deletePersonTagRow('${tagId}')">حذف</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function loadPersonTagsEditor() {
    const tbody = document.getElementById('personTagsTableBody');
    if (!tbody) return;

    try {
        tbody.innerHTML = '<tr><td colspan="4" class="loading">در حال بارگذاری برچسب‌ها...</td></tr>';
        const response = await authAPI.request('/almighty/tags');
        if (!response.success) {
            throw new Error(response.message || 'بارگذاری برچسب‌ها ناموفق بود.');
        }

        personTagsCache = Array.isArray(response?.data?.tags) ? response.data.tags : [];
        renderPersonTagsRows(personTagsCache);
    } catch (error) {
        console.error('Error loading person tags editor:', error);
        tbody.innerHTML = '<tr><td colspan="4" class="loading">خطا در بارگذاری برچسب‌ها</td></tr>';
        showPersonTagsAlert(error?.data?.message || error?.message || 'بارگذاری برچسب‌ها ناموفق بود.', 'error');
    }
}

async function savePersonTagRow(tagId) {
    const nameInput = document.getElementById(`person-tag-name-${tagId}`);
    const orderInput = document.getElementById(`person-tag-order-${tagId}`);
    const activeInput = document.getElementById(`person-tag-active-${tagId}`);

    if (!nameInput || !orderInput || !activeInput) {
        showPersonTagsAlert('ردیف برچسب پیدا نشد.', 'error');
        return;
    }

    const name = nameInput.value.trim();
    const sortOrder = Number.isFinite(Number(orderInput.value)) ? parseInt(orderInput.value, 10) : 0;
    const isActive = !!activeInput.checked;

    if (!name) {
        showPersonTagsAlert('نام برچسب الزامی است.', 'error');
        return;
    }

    try {
        const response = await authAPI.request(`/almighty/tags/${tagId}`, {
            method: 'PUT',
            body: JSON.stringify({ name, sortOrder, isActive })
        });
        if (!response.success) {
            throw new Error(response.message || 'ویرایش برچسب ناموفق بود.');
        }

        showPersonTagsAlert('برچسب با موفقیت ویرایش شد.', 'success');
        await loadPersonTagsEditor();
        if (typeof loadAboutContactEditor === 'function') {
            await loadAboutContactEditor(); // Refresh readonly about summary from live tags.
        }
    } catch (error) {
        console.error('Error updating person tag:', error);
        showPersonTagsAlert(error?.data?.message || error?.message || 'ویرایش برچسب ناموفق بود.', 'error');
    }
}

async function deletePersonTagRow(tagId) {
    const tag = personTagsCache.find((item) => String(item._id) === String(tagId));
    const tagName = tag?.name || '';
    const shouldDelete = confirm(`حذف برچسب "${tagName}"؟`);
    if (!shouldDelete) return;

    try {
        const response = await authAPI.request(`/almighty/tags/${tagId}`, {
            method: 'DELETE'
        });
        if (!response.success) {
            throw new Error(response.message || 'حذف برچسب ناموفق بود.');
        }

        showPersonTagsAlert('برچسب حذف شد.', 'success');
        await loadPersonTagsEditor();
        if (typeof loadAboutContactEditor === 'function') {
            await loadAboutContactEditor();
        }
    } catch (error) {
        console.error('Error deleting person tag:', error);
        showPersonTagsAlert(error?.data?.message || error?.message || 'حذف برچسب ناموفق بود.', 'error');
    }
}

async function renderAboutTagsPreview(tags) {
    const previewEl = document.getElementById('aboutContentTagsPreview');
    if (!previewEl) return;

    const activeNames = (Array.isArray(tags) ? tags : [])
        .filter((tag) => tag && tag.isActive !== false)
        .map((tag) => (typeof tag === 'string' ? tag : tag.name))
        .filter((name) => typeof name === 'string' && name.trim())
        .map((name) => name.trim());

    if (!activeNames.length) {
        previewEl.className = 'about-tags-preview is-empty';
        previewEl.textContent = 'هنوز برچسب فعالی وجود ندارد. از تب برچسب‌ها اضافه کنید.';
        return;
    }

    previewEl.className = 'about-tags-preview';
    previewEl.innerHTML = activeNames
        .map((name) => `<span class="about-tag-chip" title="${escapeContactHtml(name)}">${escapeContactHtml(name)}</span>`)
        .join('');
}

async function loadAboutContactEditor() {
    const headlineEl = document.getElementById('aboutContentHeadline');
    if (!headlineEl) {
        return;
    }

    try {
        const [aboutResponse, tagsResponse] = await Promise.all([
            authAPI.request('/almighty/about-contact'),
            authAPI.request('/almighty/tags').catch(() => null) // Tags preview is best-effort
        ]);
        const aboutContent = {
            ...DEFAULT_ABOUT_CONTENT,
            ...(aboutResponse?.data?.aboutContact || {})
        };

        document.getElementById('aboutContentHeadline').value = aboutContent.headline || '';
        document.getElementById('aboutContentSeeking').value = aboutContent.seeking || '';
        document.getElementById('aboutContentEmail').value = aboutContent.email || '';

        const tags = Array.isArray(tagsResponse?.data?.tags)
            ? tagsResponse.data.tags
            : (Array.isArray(personTagsCache) ? personTagsCache : []);
        await renderAboutTagsPreview(tags);

        await loadContactInbox(); // Refresh stored contact-form messages whenever the editor opens
    } catch (error) {
        console.error('Error loading about/contact editor:', error);
        showAboutContentAlert('خطا در بارگذاری محتوای صفحه درباره/تماس', 'error');
    }
}

/** Escape text for safe HTML rendering in the contact inbox. */
function escapeContactHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Load public contact-form submissions into the About tab inbox. */
async function loadContactInbox() {
    const listEl = document.getElementById('contactInboxList');
    const unreadEl = document.getElementById('contactInboxUnread');
    if (!listEl) return;

    listEl.innerHTML = '<p style="opacity:0.7;margin:0;">در حال بارگذاری پیام‌ها...</p>';
    try {
        const response = await authAPI.request('/almighty/contact-messages');
        const messages = Array.isArray(response?.data?.messages) ? response.data.messages : [];
        const unreadCount = Number(response?.data?.unreadCount || 0);
        if (unreadEl) {
            unreadEl.textContent = unreadCount > 0 ? `(${unreadCount} خوانده‌نشده)` : '';
        }

        if (!messages.length) {
            listEl.innerHTML = '<p style="opacity:0.7;margin:0;">هنوز پیامی از فرم تماس دریافت نشده است.</p>';
            return;
        }

        listEl.innerHTML = messages.map((msg) => {
            const name = [msg.firstName, msg.lastName].filter(Boolean).join(' ') || 'بدون نام';
            const delivered = msg.emailDelivered ? 'ایمیل ارسال شد' : 'ایمیل ارسال نشد / ذخیره شد';
            const when = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : '';
            const readStyle = msg.isRead ? 'opacity:0.78;' : 'border-color: var(--accent-color);';
            return `
                <article data-contact-id="${escapeContactHtml(msg._id)}" style="border:1px solid var(--border-color); border-radius:10px; padding:0.85rem; background:var(--background-alt); ${readStyle}">
                    <div style="display:flex; justify-content:space-between; gap:0.75rem; flex-wrap:wrap;">
                        <strong>${escapeContactHtml(name)}</strong>
                        <span style="font-size:0.85rem; opacity:0.8;">${escapeContactHtml(when)}</span>
                    </div>
                    <div style="margin-top:0.35rem; font-size:0.92rem;">
                        <a href="mailto:${escapeContactHtml(msg.email)}" dir="ltr">${escapeContactHtml(msg.email)}</a>
                        ${msg.phone ? ` · <span dir="ltr">${escapeContactHtml(msg.phone)}</span>` : ''}
                    </div>
                    <pre style="white-space:pre-wrap; margin:0.55rem 0 0; font:inherit;">${escapeContactHtml(msg.message)}</pre>
                    <div style="margin-top:0.55rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                        <span style="font-size:0.85rem; opacity:0.8;">${escapeContactHtml(delivered)}</span>
                        ${msg.isRead ? '' : `<button type="button" class="btn-primary contact-mark-read-btn" data-id="${escapeContactHtml(msg._id)}">علامت به‌عنوان خوانده‌شده</button>`}
                    </div>
                </article>
            `;
        }).join('');

        listEl.querySelectorAll('.contact-mark-read-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                if (!id) return;
                try {
                    await authAPI.request(`/almighty/contact-messages/${encodeURIComponent(id)}/read`, { method: 'PATCH' });
                    await loadContactInbox();
                } catch (error) {
                    console.error('Mark contact message read failed:', error);
                    showAboutContentAlert('علامت‌گذاری پیام ناموفق بود.', 'error');
                }
            });
        });
    } catch (error) {
        console.error('Error loading contact inbox:', error);
        listEl.innerHTML = '<p style="color:var(--color-orange);margin:0;">خطا در بارگذاری پیام‌های فرم تماس.</p>';
    }
}

function bindContactInboxControls() {
    const refreshBtn = document.getElementById('contactInboxRefreshBtn');
    const testBtn = document.getElementById('contactTestEmailBtn');
    const telegramBtn = document.getElementById('telegramBackfillBtn');
    if (refreshBtn && !refreshBtn.dataset.bound) {
        refreshBtn.dataset.bound = '1';
        refreshBtn.addEventListener('click', () => loadContactInbox());
    }
    if (testBtn && !testBtn.dataset.bound) {
        testBtn.dataset.bound = '1';
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            try {
                const response = await authAPI.request('/almighty/contact-messages/test-email', { method: 'POST' });
                showAboutContentAlert(response.message || 'ایمیل آزمایشی ارسال شد. Inbox و Spam را در Proton چک کنید.', 'success');
            } catch (error) {
                console.error('Test contact email failed:', error);
                showAboutContentAlert(error?.data?.message || error?.message || 'ارسال ایمیل آزمایشی ناموفق بود.', 'error');
            } finally {
                testBtn.disabled = false;
            }
        });
    }
    if (telegramBtn && !telegramBtn.dataset.bound) {
        telegramBtn.dataset.bound = '1';
        telegramBtn.addEventListener('click', async () => {
            const ok = window.confirm('آگهی‌های فعالی که هنوز در تلگرام لینک نشده‌اند منتشر شوند؟\n(ممکن است برای بعضی آگهی‌های اخیر پست تکراری ساخته شود.)');
            if (!ok) return;
            telegramBtn.disabled = true;
            try {
                const response = await authAPI.request('/almighty/telegram/backfill', {
                    method: 'POST',
                    body: JSON.stringify({ all: true })
                });
                showAboutContentAlert(response.message || 'انتشار در تلگرام انجام شد.', 'success');
            } catch (error) {
                console.error('Telegram backfill failed:', error);
                showAboutContentAlert(error?.data?.message || error?.message || 'انتشار در تلگرام ناموفق بود.', 'error');
            } finally {
                telegramBtn.disabled = false;
            }
        });
    }
}

bindContactInboxControls();

/**
 * Escape HTML to prevent XSS
 * 
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * ============================================
 * View User Posts from Portal
 * ============================================
 * Navigates to dashboard to view a specific user's posts
 * This function is called when clicking on a username in the portal
 * 
 * @param {string} userId - User ID to view posts for
 * @param {string} username - Username for display
 */
function viewUserPostsFromPortal(userId, username) {
    if (!userId) {
        console.error('User ID is required');
        return;
    }

    const user = authAPI.getCurrentUser();
    if (!user || user.role !== 'Almighty') {
        console.warn('Only Almighty users can view other users\' posts');
        return;
    }

    console.log(`Navigating to view posts for user: ${username} (${userId})`);
    
    // Navigate to dashboard with userId parameter
    // Check if viewUserPosts function exists (from dashboard.js)
    if (typeof viewUserPosts === 'function') {
        viewUserPosts(userId);
    } else {
        // Fallback: navigate directly
        window.location.href = `dashboard.html?userId=${encodeURIComponent(userId)}`;
    }
}

/**
 * ============================================
 * Load Role Upgrade Requests
 * ============================================
 * Loads and displays pending role upgrade requests
 * Only Almighty and SuperAdmin users can see these
 */
async function loadRoleUpgradeRequests() {
    try {
        console.log('Loading pending role upgrade requests...');
        const response = await authAPI.request('/role-upgrade/pending');

        if (response.success && response.data && response.data.requests) {
            const requests = response.data.requests;
            const requestsList = document.getElementById('upgradeRequestsList');
            const requestsSection = document.getElementById('upgradeRequestsSection');
            const requestsCount = document.getElementById('upgradeRequestsCount');

            // Update count
            requestsCount.textContent = requests.length;

            if (requests.length === 0) {
                // No pending requests
                requestsList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-light);">${tp('almighty.noPendingUpgradeRequests', 'No pending role upgrade requests.')}</div>`;
                requestsSection.style.display = 'none';
            } else {
                // Display requests
                requestsSection.style.display = 'block';
                requestsList.innerHTML = requests.map(request => {
                    const createdAt = new Date(request.createdAt).toLocaleString();
                    return `
                        <div style="background: var(--background-alt); padding: 15px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid var(--primary-color);">
                            <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 10px;">
                                <div style="flex: 1; min-width: 200px;">
                                    <div style="font-weight: bold; color: var(--text-color); margin-bottom: 5px;">
                                        <span>👤 ${request.username}</span>
                                    </div>
                                    <div style="color: var(--text-light); font-size: 0.9rem; margin-bottom: 5px;">
                                        <strong>${tp('almighty.requestLabel', 'Request')}:</strong> ${request.currentRole} → ${request.requestedRole}
                                    </div>
                                    ${request.message ? `
                                        <div style="color: var(--text-color); font-size: 0.9rem; margin-top: 8px; padding: 8px; background: var(--background-color); border-radius: 4px;">
                                            <strong>${tp('almighty.messageLabel', 'Message')}:</strong> ${escapeHtml(request.message)}
                                        </div>
                                    ` : ''}
                                    <div style="color: var(--text-light); font-size: 0.85rem; margin-top: 8px;">
                                        <strong>${tp('almighty.submittedLabel', 'Submitted')}:</strong> ${createdAt}
                                    </div>
                                </div>
                                <div style="display: flex; gap: 10px; align-items: center;">
                                    <button 
                                        onclick="approveUpgradeRequest('${request._id}', '${escapeHtml(request.username)}')" 
                                        class="btn-primary"
                                        style="padding: 8px 16px; font-size: 0.9rem;"
                                    >
                                        &#10003; ${tp('almighty.approveButton', 'Approve')}
                                    </button>
                                    <button 
                                        onclick="denyUpgradeRequest('${request._id}', '${escapeHtml(request.username)}')" 
                                        class="btn-secondary"
                                        style="padding: 8px 16px; font-size: 0.9rem; background: #dc3545; color: white; border: none;"
                                    >
                                        &#10007; ${tp('almighty.denyButton', 'Deny')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }

            console.log(`Loaded ${requests.length} pending role upgrade requests`);
        }
    } catch (error) {
        console.error('Error loading role upgrade requests:', error);
        const requestsSection = document.getElementById('upgradeRequestsSection');
        if (requestsSection) {
            requestsSection.style.display = 'none';
        }
    }
}

/**
 * ============================================
 * Approve Role Upgrade Request
 * ============================================
 * Approves a pending role upgrade request
 */
async function approveUpgradeRequest(requestId, username) {
    if (!confirm(`${tp('almighty.approveConfirm', 'Are you sure you want to approve this role upgrade request for')} ${username}?`)) {
        return;
    }

    try {
        console.log(`Approving role upgrade request: ${requestId}`);
        const token = authAPI.getToken();
        const response = await fetch(`${window.location.origin}/api/role-upgrade/${requestId}/approve`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();

        if (result.success) {
            showAlert(`${tp('almighty.approveSuccess', 'Role upgrade request approved.')} (${username})`, 'success');
            // Reload requests and users list
            await loadRoleUpgradeRequests();
            await loadUsers();
        } else {
            showAlert(`${result.message || tp('almighty.approveFailed', 'Failed to approve request')}`, 'error');
        }
    } catch (error) {
        console.error('Error approving request:', error);
        showAlert(`${tp('almighty.approveError', 'Error approving request')}: ${error.message || 'Unknown error'}`, 'error');
    }
}

/**
 * ============================================
 * Deny Role Upgrade Request
 * ============================================
 * Denies a pending role upgrade request
 */
async function denyUpgradeRequest(requestId, username) {
    const reason = prompt(`${tp('almighty.denyPrompt', 'Enter a reason for denying this role upgrade request (optional):')} ${username}`);
    
    if (reason === null) {
        // User cancelled
        return;
    }

    try {
        console.log(`Denying role upgrade request: ${requestId}`);
        const token = authAPI.getToken();
        const response = await fetch(`${window.location.origin}/api/role-upgrade/${requestId}/deny`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ reason: reason || '' })
        });
        
        const result = await response.json();

        if (result.success) {
            showAlert(`${tp('almighty.denySuccess', 'Role upgrade request denied.')} (${username})`, 'success');
            // Reload requests
            await loadRoleUpgradeRequests();
        } else {
            showAlert(`${result.message || tp('almighty.denyFailed', 'Failed to deny request')}`, 'error');
        }
    } catch (error) {
        console.error('Error denying request:', error);
        showAlert(`${tp('almighty.denyError', 'Error denying request')}: ${error.message || 'Unknown error'}`, 'error');
    }
}

// Note: This is now called by the router when the almighty-portal view is loaded
// The router calls initAlmightyPortalView() which then calls initPortal()
// We keep this for backward compatibility
window.addEventListener('DOMContentLoaded', () => {
    // Only initialize if we're on the almighty-portal view
    // Check if the portal container exists in the DOM
    const portalContainer = document.getElementById('statsGrid');
    if (!portalContainer) {
        // Not on almighty-portal view, skip initialization
        return;
    }
    
    initPortal();
});

