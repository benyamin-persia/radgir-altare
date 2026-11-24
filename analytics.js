/**
 * ============================================
 * Radgir First-Party Analytics Tracker
 * ============================================
 * Collects client-side events and sends them in batches to /api/analytics/events.
 */
(function initRadgirAnalytics() {
    if (window.__radgirAnalyticsInitialized) return;
    window.__radgirAnalyticsInitialized = true;

    const API_ENDPOINT = `${window.location.origin}/api/analytics/events`;
    const QUEUE_LIMIT = 40;
    const FLUSH_INTERVAL_MS = 10000;
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    const MAX_TEXT_LEN = 300;

    const KEYS = {
        visitorId: 'radgir.analytics.visitor_id',
        sessionId: 'radgir.analytics.session_id',
        lastActivity: 'radgir.analytics.last_activity',
        firstSeen: 'radgir.analytics.first_seen',
        lastSeen: 'radgir.analytics.last_seen',
        optOut: 'radgir.analytics.opt_out',
        almightyExclude: 'radgir.analytics.almighty_exclude', // permanent: this browser belongs to Almighty
        almightyRegistered: 'radgir.analytics.almighty_registered'
    };

    function nowMs() {
        return Date.now();
    }

    function safeText(value, maxLen = MAX_TEXT_LEN) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
    }

    function makeId(prefix) {
        const rand = Math.random().toString(36).slice(2, 10);
        return `${prefix}_${nowMs().toString(36)}_${rand}`;
    }

    function getStorageItem(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function setStorageItem(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (_) {
            // Ignore storage failures (private mode / blocked storage).
        }
    }

    function getStoredNumber(key) {
        const raw = getStorageItem(key);
        if (!raw) return 0;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function getOrCreateVisitorId() {
        let id = getStorageItem(KEYS.visitorId);
        if (!id) {
            id = makeId('v');
            setStorageItem(KEYS.visitorId, id);
            setStorageItem(KEYS.firstSeen, String(nowMs()));
        }
        setStorageItem(KEYS.lastSeen, String(nowMs()));
        return id;
    }

    function getUserSnapshot() {
        try {
            const raw = getStorageItem('user');
            if (!raw) return null;
            const user = JSON.parse(raw);
            if (!user || typeof user !== 'object') return null;
            return {
                id: user.id || user._id || null,
                role: user.role || null
            };
        } catch (_) {
            return null;
        }
    }

    function isAlmightyUserSnapshot(user) {
        return Boolean(user && String(user.role || '').toLowerCase() === 'almighty');
    }

    /** Mark this browser as Almighty-owned so analytics stay off even after logout/testing. */
    function markAlmightyBrowserExcluded() {
        setStorageItem(KEYS.almightyExclude, '1');
        queue.length = 0; // drop anything already queued
        registerAlmightyVisitorWithServer();
    }

    function registerAlmightyVisitorWithServer() {
        if (getStorageItem(KEYS.almightyRegistered) === '1') return;
        const token = getStorageItem('token');
        if (!token) return;
        const vid = getStorageItem(KEYS.visitorId) || visitorId;
        if (!vid) return;
        fetch(`${window.location.origin}/api/analytics/exclude-visitor`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ visitorId: vid }),
            keepalive: true
        }).then((res) => {
            if (res && res.ok) setStorageItem(KEYS.almightyRegistered, '1');
        }).catch(() => {
            // Retry next page load if this fails.
        });
    }

    function shouldSkipAnalyticsForCurrentUser() {
        if (String(getStorageItem(KEYS.almightyExclude) || '').toLowerCase() === '1') {
            registerAlmightyVisitorWithServer(); // retry server ban-list until token is available
            return true;
        }
        if (typeof window !== 'undefined' && window.authAPI && typeof window.authAPI.isAlmighty === 'function') {
            try {
                if (window.authAPI.isAlmighty()) {
                    markAlmightyBrowserExcluded();
                    return true;
                }
            } catch (_) { /* ignore */ }
        }
        const user = getUserSnapshot();
        if (isAlmightyUserSnapshot(user)) {
            markAlmightyBrowserExcluded();
            return true;
        }
        return false;
    }

    function isDoNotTrackEnabled() {
        const dnt = String(
            navigator.doNotTrack ||
            window.doNotTrack ||
            navigator.msDoNotTrack ||
            ''
        ).toLowerCase();
        return dnt === '1' || dnt === 'yes';
    }

    function isOptOutEnabled() {
        const raw = String(getStorageItem(KEYS.optOut) || '').toLowerCase();
        return raw === '1' || raw === 'true' || raw === 'yes';
    }

    function isAnalyticsAllowed() {
        if (shouldSkipAnalyticsForCurrentUser()) return false;
        if (isDoNotTrackEnabled()) return false;
        if (isOptOutEnabled()) return false;
        return true;
    }

    function resolveAppSection(pathname) {
        const path = String(pathname || '/').toLowerCase();
        if (path === '/' || path.endsWith('/index.html')) return 'home_map';
        if (path.includes('login')) return 'auth_login';
        if (path.includes('register')) return 'auth_register';
        if (path.includes('dashboard')) return 'dashboard';
        if (path.includes('create-person')) return 'create_person';
        if (path.includes('almighty-portal')) return 'almighty_portal';
        if (path.includes('about-contact')) return 'about_contact';
        if (path.includes('reset-password') || path.includes('forgot-password') || path.includes('verify-email')) return 'auth_security';
        return 'other';
    }

    function safeUrl(rawUrl) {
        try {
            return new URL(rawUrl, window.location.origin);
        } catch (_) {
            return null;
        }
    }

    function getReferrerHost(referrer) {
        if (!referrer) return '';
        try {
            return (new URL(referrer)).hostname.toLowerCase();
        } catch (_) {
            return '';
        }
    }

    function classifyTrafficSource(referrerHost) {
        if (!referrerHost) return 'direct';
        const currentHost = String(window.location.hostname || '').toLowerCase();
        if (referrerHost === currentHost) return 'internal';

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

    function getCampaignData() {
        const url = safeUrl(window.location.href);
        if (!url) {
            return {
                utmSource: '',
                utmMedium: '',
                utmCampaign: '',
                utmTerm: '',
                utmContent: ''
            };
        }
        return {
            utmSource: safeText(url.searchParams.get('utm_source'), 120),
            utmMedium: safeText(url.searchParams.get('utm_medium'), 120),
            utmCampaign: safeText(url.searchParams.get('utm_campaign'), 160),
            utmTerm: safeText(url.searchParams.get('utm_term'), 160),
            utmContent: safeText(url.searchParams.get('utm_content'), 160)
        };
    }

    function getViewportBucket(width) {
        const w = Number(width || 0);
        if (!Number.isFinite(w) || w <= 0) return 'unknown';
        if (w < 480) return 'mobile_xs';
        if (w < 768) return 'mobile';
        if (w < 992) return 'tablet';
        if (w < 1280) return 'desktop';
        return 'desktop_wide';
    }

    function classifyNetworkQuality(effectiveType, downlink) {
        const type = String(effectiveType || '').toLowerCase();
        if (type === 'slow-2g' || type === '2g') return 'poor';
        if (type === '3g') return 'moderate';
        if (type === '4g' || type === '5g') return 'good';

        const dl = Number(downlink);
        if (!Number.isFinite(dl)) return 'unknown';
        if (dl < 0.8) return 'poor';
        if (dl < 2) return 'moderate';
        return 'good';
    }

    function getNetworkSnapshot() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const networkType = safeText(connection?.type, 40);
        const effectiveType = safeText(connection?.effectiveType, 40);
        const downlink = Number(connection?.downlink);
        const rtt = Number(connection?.rtt);
        const saveData = Boolean(connection?.saveData);

        return {
            networkType,
            networkEffectiveType: effectiveType,
            networkDownlink: Number.isFinite(downlink) ? Math.round(downlink * 100) / 100 : null,
            networkRtt: Number.isFinite(rtt) ? Math.round(rtt) : null,
            networkSaveData: saveData,
            networkQuality: classifyNetworkQuality(effectiveType, downlink)
        };
    }

    function getPwaState() {
        const standalone =
            Boolean(window.navigator.standalone) ||
            window.matchMedia('(display-mode: standalone)').matches;
        return {
            pwaInstalled: standalone,
            displayMode: standalone ? 'standalone' : 'browser'
        };
    }

    function resolveUiZone(target) {
        if (!target || !target.closest) return 'unknown';
        if (target.closest('.portal-tabs') || target.closest('[data-portal-tab]')) return 'portal_tabs';
        if (target.closest('.dashboard-tabs') || target.closest('[data-dashboard-tab]')) return 'dashboard_tabs';
        if (target.closest('#mobileListTabs') || target.closest('.mobile-list-tab')) return 'mobile_list_tabs';
        if (target.closest('#filtersPeopleTabs') || target.closest('.people-tab-btn')) return 'people_tabs';
        if (target.closest('#filtersSection')) return 'filters_panel';
        if (target.closest('#listingsSection')) return 'listings_panel';
        if (target.closest('.leaflet-container') || target.closest('#map')) return 'map';
        if (target.closest('nav') || target.closest('.nav-links') || target.closest('.portal-nav-links')) return 'navigation';
        if (target.closest('form')) return 'form';
        if (target.closest('.map-filters-bar') || target.closest('#mapFiltersBar')) return 'map_filters';
        return 'content';
    }

    // Resolve which named site tab was clicked (portal / dashboard / people / mobile list).
    function resolveTabTarget(target) {
        if (!target || !target.closest) return null;
        const portalTab = target.closest('[data-portal-tab]');
        if (portalTab) {
            return {
                tabGroup: 'portal',
                tabName: safeText(portalTab.dataset.portalTab, 80).toLowerCase() || 'unknown'
            };
        }
        const dashboardTab = target.closest('[data-dashboard-tab]');
        if (dashboardTab) {
            return {
                tabGroup: 'dashboard',
                tabName: safeText(dashboardTab.dataset.dashboardTab, 80).toLowerCase() || 'unknown'
            };
        }
        const peopleTab = target.closest('.people-tab-btn,[data-people-tab]');
        if (peopleTab) {
            return {
                tabGroup: 'people_address',
                tabName: safeText(peopleTab.dataset.peopleTab || peopleTab.dataset.tab, 80).toLowerCase() || 'unknown'
            };
        }
        const mobileTab = target.closest('.mobile-list-tab,[data-mobile-list-tab]');
        if (mobileTab) {
            const raw = safeText(mobileTab.dataset.mobileListTab, 40).toLowerCase();
            const tabName = raw === 'with' || raw === 'with-address'
                ? 'with-address'
                : (raw === 'without' || raw === 'without-address' || raw === 'no' ? 'without-address' : (raw || 'unknown'));
            return { tabGroup: 'people_address_mobile', tabName };
        }
        return null;
    }

    const lastTabByGroup = {}; // Remember previous tab per group so we can report from→to transitions.
    let lastTabEventKey = '';
    let lastTabEventAt = 0;

    function inferUiClickAction(target) {
        if (!target || !target.closest) return 'click';
        if (target.closest('.listing-vote-btn')) {
            const voteType = safeText(target.closest('.listing-vote-btn')?.dataset?.type, 20).toLowerCase();
            return voteType === 'dislike' ? 'dislike' : 'like';
        }
        if (target.closest('.listing-comment-btn')) return 'comment';
        if (target.closest('.listing-share-btn')) return 'share';
        if (target.closest('.listing-edit-btn')) return 'edit';
        if (target.closest('.listing-delete-btn')) return 'delete';
        if (resolveTabTarget(target)) return 'tab_change';
        if (target.closest('#filtersToggle')) return 'filters_toggle';
        if (target.closest('#listingsToggle')) return 'listings_toggle';
        if (target.closest('.listing-address-clickable')) return 'map_navigation';
        if (target.closest('.listing-card')) return 'card_open';
        if (target.tagName && target.tagName.toLowerCase() === 'a') return 'link_click';
        return 'click';
    }

    let visitorId = getOrCreateVisitorId();
    let sessionId = getStorageItem(KEYS.sessionId);
    let lastActivity = getStoredNumber(KEYS.lastActivity);
    let needsSessionStart = false;
    let pageEnteredAt = nowMs();
    let lastPath = window.location.pathname + window.location.search + window.location.hash;

    function refreshSession() {
        const now = nowMs();
        const expired = !sessionId || (lastActivity && now - lastActivity > SESSION_TIMEOUT_MS);
        if (expired) {
            sessionId = makeId('s');
            setStorageItem(KEYS.sessionId, sessionId);
            needsSessionStart = true;
        }
        lastActivity = now;
        setStorageItem(KEYS.lastActivity, String(now));
    }

    refreshSession();

    const queue = [];
    let flushing = false;
    let flushTimer = null;

    function buildBaseEvent(eventName, payload) {
        const user = getUserSnapshot();
        const referrerHost = getReferrerHost(document.referrer || '');
        const source = classifyTrafficSource(referrerHost);
        const campaign = getCampaignData();
        const network = getNetworkSnapshot();
        const pwa = getPwaState();
        const payloadMetadata = payload && typeof payload.metadata === 'object' && payload.metadata !== null
            ? payload.metadata
            : {};
        const combinedMetadata = {
            ...payloadMetadata,
            ...payload,
            userRole: user?.role || null
        };
        delete combinedMetadata.metadata;

        return {
            eventName: safeText(eventName, 80).toLowerCase() || 'custom_event',
            visitorId,
            sessionId,
            path: window.location.pathname,
            fullUrl: window.location.href,
            referrer: document.referrer || '',
            pageTitle: document.title || '',
            appSection: resolveAppSection(window.location.pathname),
            language: navigator.language || '',
            viewportWidth: window.innerWidth || null,
            viewportHeight: window.innerHeight || null,
            screenWidth: window.screen?.width || null,
            screenHeight: window.screen?.height || null,
            deviceType: payload.deviceType || null,
            os: payload.os || null,
            browser: payload.browser || null,
            source: safeText(payload.source || source, 30).toLowerCase() || 'direct',
            referrerHost: safeText(payload.referrerHost || referrerHost, 255).toLowerCase(),
            utmSource: safeText(payload.utmSource || campaign.utmSource, 120),
            utmMedium: safeText(payload.utmMedium || campaign.utmMedium, 120),
            utmCampaign: safeText(payload.utmCampaign || campaign.utmCampaign, 160),
            utmTerm: safeText(payload.utmTerm || campaign.utmTerm, 160),
            utmContent: safeText(payload.utmContent || campaign.utmContent, 160),
            viewportBucket: safeText(payload.viewportBucket || getViewportBucket(window.innerWidth), 40),
            networkType: safeText(payload.networkType || network.networkType, 40),
            networkEffectiveType: safeText(payload.networkEffectiveType || network.networkEffectiveType, 40),
            networkDownlink: Number.isFinite(Number(payload.networkDownlink))
                ? Number(payload.networkDownlink)
                : network.networkDownlink,
            networkRtt: Number.isFinite(Number(payload.networkRtt))
                ? Number(payload.networkRtt)
                : network.networkRtt,
            networkSaveData: payload.networkSaveData === true || payload.networkSaveData === false
                ? payload.networkSaveData
                : network.networkSaveData,
            networkQuality: safeText(payload.networkQuality || network.networkQuality, 40),
            pwaInstalled: payload.pwaInstalled === true || payload.pwaInstalled === false
                ? payload.pwaInstalled
                : pwa.pwaInstalled,
            displayMode: safeText(payload.displayMode || pwa.displayMode, 40),
            cardId: safeText(payload.cardId, 120),
            cardAction: safeText(payload.cardAction || payload.dataAction, 80).toLowerCase(),
            cardNoAddress: payload.cardNoAddress === true || payload.cardNoAddress === false
                ? payload.cardNoAddress
                : null,
            cardHasCoords: payload.cardHasCoords === true || payload.cardHasCoords === false
                ? payload.cardHasCoords
                : null,
            // Promote timing/status out of metadata so admin aggregates can use top-level fields.
            durationMs: Number.isFinite(Number(payload.durationMs)) ? Math.max(0, Number(payload.durationMs)) : undefined,
            statusCode: Number.isFinite(Number(payload.statusCode)) ? Number(payload.statusCode) : undefined,
            metadata: combinedMetadata,
            clientTimestamp: new Date().toISOString()
        };
    }

    /**
     * Emit a first-class tab_change event with which/when/where context.
     * @param {{ tabGroup: string, tabName: string, previousTab?: string, appZone?: string, label?: string, source?: string }} details
     */
    function trackTabChange(details = {}) {
        const tabGroup = safeText(details.tabGroup, 80).toLowerCase() || 'unknown';
        const tabName = safeText(details.tabName, 80).toLowerCase() || 'unknown';
        if (!tabGroup || !tabName) return;

        // Dedupe click-delegation + explicit setter calls that fire for the same tab within ~1s.
        const dedupeKey = `${tabGroup}:${tabName}`;
        const stamp = nowMs();
        if (dedupeKey === lastTabEventKey && stamp - lastTabEventAt < 1000) return;
        lastTabEventKey = dedupeKey;
        lastTabEventAt = stamp;

        const previousTab = safeText(
            details.previousTab != null ? details.previousTab : lastTabByGroup[tabGroup],
            80
        ).toLowerCase();
        lastTabByGroup[tabGroup] = tabName;

        const now = new Date();
        enqueue('tab_change', {
            dataAction: 'tab_change',
            cardAction: 'tab_change',
            elementText: safeText(details.label || tabName, 300),
            elementId: safeText(details.elementId || `${tabGroup}:${tabName}`, 120),
            metadata: {
                action: 'tab_change',
                tabGroup,
                tabName,
                previousTab: previousTab || null,
                tabTransition: previousTab ? `${previousTab} -> ${tabName}` : tabName,
                appZone: safeText(details.appZone || `${tabGroup}_tabs`, 80),
                source: safeText(details.source || 'explicit', 40),
                pathWithHash: window.location.pathname + window.location.search + window.location.hash,
                localHour: now.getHours(),
                localDayOfWeek: now.getDay(),
                viewportBucket: getViewportBucket(window.innerWidth)
            }
        });
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = window.setTimeout(() => {
            flushTimer = null;
            flushQueue();
        }, FLUSH_INTERVAL_MS);
    }

    async function flushQueue() {
        if (flushing || queue.length === 0) return;
        flushing = true;
        const batch = queue.splice(0, QUEUE_LIMIT);

        try {
            const headers = { 'Content-Type': 'application/json' };
            const token = getStorageItem('token');
            if (token) headers.Authorization = `Bearer ${token}`;
            await fetch(API_ENDPOINT, {
                method: 'POST',
                headers,
                body: JSON.stringify({ events: batch }),
                keepalive: true
            });
        } catch (_) {
            // Re-queue failed batch at front
            queue.unshift(...batch);
        } finally {
            flushing = false;
            if (queue.length > 0) scheduleFlush();
        }
    }

    function flushWithBeacon() {
        if (!navigator.sendBeacon || queue.length === 0) return;
        const batch = queue.splice(0, QUEUE_LIMIT);
        try {
            const blob = new Blob([JSON.stringify({ events: batch })], { type: 'application/json' });
            navigator.sendBeacon(API_ENDPOINT, blob);
        } catch (_) {
            queue.unshift(...batch);
        }
    }

    function enqueue(eventName, payload = {}, immediate = false) {
        if (!isAnalyticsAllowed()) {
            return;
        }
        refreshSession();

        if (needsSessionStart && eventName !== 'session_start') {
            queue.push(
                buildBaseEvent('session_start', {
                    reason: 'new_session',
                    firstSeen: getStoredNumber(KEYS.firstSeen) || null,
                    ...getCampaignData(),
                    ...getNetworkSnapshot(),
                    ...getPwaState()
                })
            );
            needsSessionStart = false;
        }

        queue.push(buildBaseEvent(eventName, payload));
        if (queue.length >= QUEUE_LIMIT || immediate) {
            flushQueue();
        } else {
            scheduleFlush();
        }
    }

    function trackPageView(navigationType) {
        enqueue('page_view', {
            navigationType: safeText(navigationType || 'navigate', 60),
            pathWithQuery: window.location.pathname + window.location.search,
            ...getNetworkSnapshot(),
            ...getPwaState()
        });
    }

    function trackPageExit(reason) {
        const durationMs = Math.max(0, nowMs() - pageEnteredAt);
        enqueue(
            'page_exit',
            {
                reason: safeText(reason || 'unknown', 40),
                durationMs,
                pathWithQuery: window.location.pathname + window.location.search
            },
            true
        );
    }

    function getElementLabel(el) {
        if (!el) return '';
        return (
            safeText(el.getAttribute('aria-label'), 160) ||
            safeText(el.getAttribute('title'), 160) ||
            safeText(el.textContent, 160)
        );
    }

    function trackRouteChange(trigger) {
        const current = window.location.pathname + window.location.search + window.location.hash;
        if (current === lastPath) return;
        trackPageExit('route_change');
        lastPath = current;
        pageEnteredAt = nowMs();
        enqueue('route_change', { trigger: safeText(trigger, 40), pathWithQuery: current });
        trackPageView('route_change');
    }

    const origPushState = history.pushState;
    history.pushState = function wrappedPushState() {
        origPushState.apply(history, arguments);
        trackRouteChange('pushState');
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function wrappedReplaceState() {
        origReplaceState.apply(history, arguments);
        trackRouteChange('replaceState');
    };

    window.addEventListener('popstate', () => trackRouteChange('popstate'));
    window.addEventListener('hashchange', () => trackRouteChange('hashchange'));

    document.addEventListener(
            'click',
        (ev) => {
            const target = ev.target && ev.target.closest
                ? ev.target.closest(
                    'a,button,[role="button"],[role="tab"],input[type="submit"],.btn,.listing-card,.listing-vote-btn,.listing-comment-btn,.listing-manage-btn,.people-tab-btn,.mobile-list-tab,[data-portal-tab],[data-dashboard-tab],[data-people-tab],[data-mobile-list-tab],#filtersToggle,#listingsToggle'
                )
                : null;
            if (!target) return;

            const listingCard = target.closest('.listing-card');
            const cardId = safeText(target.dataset?.id || listingCard?.dataset?.id, 120);
            const cardNoAddressValue = target.dataset?.noAddress || listingCard?.dataset?.noAddress;
            const cardNoAddress = cardNoAddressValue === '1' ? true : (cardNoAddressValue === '0' ? false : null);
            const cardHasCoords = Boolean(
                safeText(listingCard?.dataset?.lat, 40) &&
                safeText(listingCard?.dataset?.lng, 40)
            );
            const inferredAction = inferUiClickAction(target);
            const appZone = resolveUiZone(target);
            const tabInfo = resolveTabTarget(target);

            enqueue('ui_click', {
                elementTag: safeText(target.tagName, 40).toLowerCase(),
                elementId: safeText(target.id, 120),
                elementClasses: safeText(target.className, 300),
                elementText: getElementLabel(target),
                elementHref: safeText(target.getAttribute('href'), 1000),
                dataAction: safeText(target.dataset?.action || target.dataset?.analyticsAction || inferredAction, 120),
                cardAction: inferredAction,
                cardId,
                cardNoAddress,
                cardHasCoords,
                metadata: {
                    appZone,
                    action: inferredAction,
                    cardId,
                    cardNoAddress,
                    cardHasCoords,
                    tabGroup: tabInfo?.tabGroup || null,
                    tabName: tabInfo?.tabName || null,
                    pathWithHash: window.location.pathname + window.location.search + window.location.hash,
                    localHour: new Date().getHours()
                }
            });

            // Also emit a structured tab_change so reports can answer which/when/where for tabs.
            if (tabInfo) {
                trackTabChange({
                    tabGroup: tabInfo.tabGroup,
                    tabName: tabInfo.tabName,
                    appZone,
                    label: getElementLabel(target),
                    elementId: target.id,
                    source: 'delegated_click'
                });
            }
        },
        { passive: true }
    );

    document.addEventListener(
        'submit',
        (ev) => {
            const form = ev.target;
            if (!form || !form.tagName || form.tagName.toLowerCase() !== 'form') return;
            enqueue('form_submit', {
                elementId: safeText(form.id, 120),
                dataAction: safeText(form.getAttribute('action'), 200),
                metadata: {
                    formId: safeText(form.id, 120),
                    method: safeText(form.getAttribute('method') || 'get', 16).toLowerCase()
                }
            });
        },
        true
    );

    document.addEventListener(
        'change',
        (ev) => {
            const el = ev.target;
            if (!el || !el.closest) return;
            if (!el.matches || !el.matches('select,input,textarea')) return;
            const inFilterUi = el.closest('#filtersSection, .filters-content, .combined-list-header, .filters-header, .search-box');
            if (!inFilterUi) return;

            const type = safeText(el.type, 30).toLowerCase();
            const isSensitive = ['password', 'email', 'tel'].includes(type);
            const rawValue = isSensitive ? '' : safeText(el.value, 120);
            const payload = {
                elementTag: safeText(el.tagName, 30).toLowerCase(),
                elementId: safeText(el.id || el.name, 120),
                dataAction: 'filter_change',
                metadata: {
                    inputType: type || 'unknown',
                    appZone: 'filters_panel'
                }
            };

            if (type === 'text' || type === 'search') {
                payload.metadata.valueLength = rawValue.length;
            } else if (!isSensitive) {
                payload.metadata.value = rawValue;
            }

            enqueue('filter_change', payload);
        },
        true
    );

    let highestScrollBucket = 0;
    const scrollBuckets = [25, 50, 75, 100];
    window.addEventListener(
        'scroll',
        () => {
            const body = document.body;
            const doc = document.documentElement;
            const maxScroll = Math.max(
                0,
                (doc.scrollHeight || body.scrollHeight || 0) - (window.innerHeight || 0)
            );
            if (maxScroll <= 0) return;
            const current = window.scrollY || doc.scrollTop || body.scrollTop || 0;
            const percent = Math.round((current / maxScroll) * 100);
            for (const bucket of scrollBuckets) {
                if (percent >= bucket && bucket > highestScrollBucket) {
                    highestScrollBucket = bucket;
                    enqueue('scroll_depth', {
                        depthPercent: bucket,
                        metadata: { depthPercent: bucket }
                    });
                }
            }
        },
        { passive: true }
    );

    window.addEventListener('error', (ev) => {
        enqueue('js_error', {
            metadata: {
                message: safeText(ev.message, 300),
                source: safeText(ev.filename, 400),
                line: ev.lineno || null,
                column: ev.colno || null
            }
        });
    });

    window.addEventListener('unhandledrejection', (ev) => {
        enqueue('js_error', {
            metadata: {
                message: safeText(ev.reason?.message || ev.reason, 300),
                type: 'unhandledrejection'
            }
        });
    });

    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection && typeof connection.addEventListener === 'function') {
        connection.addEventListener('change', () => {
            enqueue('network_change', {
                ...getNetworkSnapshot()
            });
        });
    }

    window.addEventListener('beforeinstallprompt', () => {
        enqueue('pwa_install_prompt_shown', {
            ...getPwaState()
        });
    });

    window.addEventListener('appinstalled', () => {
        enqueue(
            'pwa_installed',
            {
                pwaInstalled: true,
                displayMode: 'standalone'
            },
            true
        );
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            trackPageExit('visibility_hidden');
            flushWithBeacon();
        } else if (document.visibilityState === 'visible') {
            pageEnteredAt = nowMs();
        }
    });

    window.addEventListener('beforeunload', () => {
        trackPageExit('beforeunload');
        flushWithBeacon();
    });

    window.analyticsTracker = {
        track(name, payload = {}, immediate = false) {
            enqueue(name, payload, Boolean(immediate));
        },
        trackTabChange(details = {}) {
            trackTabChange(details);
        },
        flush() {
            return flushQueue();
        },
        setOptOut(enabled) {
            setStorageItem(KEYS.optOut, enabled ? '1' : '0');
        },
        /** Call after Almighty login so this browser never counts in analytics. */
        excludeAlmightyBrowser() {
            markAlmightyBrowserExcluded();
        },
        getState() {
            return {
                visitorId,
                sessionId,
                queuedEvents: queue.length,
                enabled: isAnalyticsAllowed(),
                almightyExcluded: String(getStorageItem(KEYS.almightyExclude) || '') === '1'
            };
        }
    };

    // If Almighty is already logged in on this page load, register visitor + stop tracking.
    if (shouldSkipAnalyticsForCurrentUser()) {
        markAlmightyBrowserExcluded();
    } else {
        trackPageView('initial');
    }
})();
