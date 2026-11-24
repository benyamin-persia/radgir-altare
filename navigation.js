/**
 * ============================================
 * Navigation Utility
 * ============================================
 * Provides consistent, role-aware navigation across pages.
 */

function getNavTranslation(key, fallback) {
    try {
        if (typeof languageManager !== 'undefined' && languageManager.getTranslation) {
            const translated = languageManager.getTranslation(key);
            if (translated && translated !== key) {
                return translated;
            }
        }
    } catch (_) {
        // Ignore translation lookup issues and use fallback.
    }
    return fallback;
}

let navUnreadPollTimer = null;
let navUnreadVisibilityHandler = null;
let navUnreadInFlight = false;
const NAV_UNREAD_POLL_INTERVAL_MS = 45000;

function clearNavUnreadPolling() {
    if (navUnreadPollTimer) {
        clearInterval(navUnreadPollTimer);
        navUnreadPollTimer = null;
    }
    if (navUnreadVisibilityHandler) {
        document.removeEventListener('visibilitychange', navUnreadVisibilityHandler);
        window.removeEventListener('focus', navUnreadVisibilityHandler);
        navUnreadVisibilityHandler = null;
    }
}

function renderNavUnreadBadge(navContainer, unreadCount) {
    const toggle = navContainer?.querySelector('.nav-user-menu-toggle');
    const badge = navContainer?.querySelector('.nav-user-unread-badge');
    if (!toggle || !badge) return;

    const count = Number.isFinite(Number(unreadCount)) ? Math.max(0, Number(unreadCount)) : 0;
    if (count > 0) {
        badge.hidden = false;
        badge.textContent = count > 99 ? '99+' : String(count);
        const username = navContainer.querySelector('.nav-user-name')?.textContent?.trim() || '';
        const unreadLabel = getNavTranslation('nav.unreadMessages', 'unread messages');
        toggle.setAttribute('title', `${username ? `${username} - ` : ''}${count} ${unreadLabel}`);
    } else {
        badge.hidden = true;
        badge.textContent = '';
        toggle.removeAttribute('title');
    }
}

async function refreshNavUnreadCountInternal(navContainer, options = {}) {
    const { stopOnMissingRoute = true } = options;
    if (!navContainer) return;
    if (navUnreadInFlight) return;
    if (typeof authAPI === 'undefined' || !authAPI?.isAuthenticated?.()) {
        renderNavUnreadBadge(navContainer, 0);
        return;
    }

    navUnreadInFlight = true;
    try {
        const response = await authAPI.request('/messages/unread-count', {
            trackErrors: false, // Background badge polling must not inflate API-error health alerts
            silent: true
        });
        const unreadCount = Number(response?.data?.unreadCount || 0);
        renderNavUnreadBadge(navContainer, unreadCount);
    } catch (error) {
        if (stopOnMissingRoute && (error?.status === 404 || /Route not found/i.test(error?.message || ''))) {
            clearNavUnreadPolling();
            renderNavUnreadBadge(navContainer, 0);
            console.info('Messaging unread-count endpoint unavailable; nav badge polling disabled.');
            return;
        }
        if (error?.status === 401 || error?.status === 403) {
            clearNavUnreadPolling();
            renderNavUnreadBadge(navContainer, 0);
            return;
        }
        console.warn('Failed to refresh navigation unread count:', error?.message || error);
    } finally {
        navUnreadInFlight = false;
    }
}

function initNavUnreadBadge(navContainer) {
    clearNavUnreadPolling();
    if (!navContainer) return;
    if (typeof authAPI === 'undefined' || !authAPI?.isAuthenticated?.()) {
        renderNavUnreadBadge(navContainer, 0);
        return;
    }

    refreshNavUnreadCountInternal(navContainer);
    navUnreadPollTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        refreshNavUnreadCountInternal(navContainer, { stopOnMissingRoute: false });
    }, NAV_UNREAD_POLL_INTERVAL_MS);

    navUnreadVisibilityHandler = () => {
        if (document.visibilityState === 'visible') {
            refreshNavUnreadCountInternal(navContainer, { stopOnMissingRoute: false });
        }
    };
    document.addEventListener('visibilitychange', navUnreadVisibilityHandler);
    window.addEventListener('focus', navUnreadVisibilityHandler);
}

/**
 * Resolve the current HTML page name for active-link highlighting.
 */
function getCurrentNavPage() {
    const path = (window.location.pathname || '').replace(/\/+$/, '');
    const file = path.split('/').pop() || '';
    if (!file || file === 'radgir.com') return 'index.html'; // Root URL maps to the home page.
    return file.endsWith('.html') ? file : `${file}.html`;
}

/**
 * Ensure every page has one shared site header with .nav-links.
 */
function ensureSiteHeader() {
    let header = document.querySelector('header');
    if (!header) {
        header = document.createElement('header');
        document.body.insertBefore(header, document.body.firstChild);
    }

    let nav = header.querySelector('nav');
    if (!nav) {
        nav = document.createElement('nav');
        header.prepend(nav);
    }

    if (!nav.querySelector('.logo')) {
        const logo = document.createElement('div');
        logo.className = 'logo';
        logo.textContent = 'Radgir';
        nav.prepend(logo);
    }

    let navContainer = nav.querySelector('.nav-links') ||
        nav.querySelector('.portal-nav-links') ||
        nav.querySelector('.dashboard-nav-links');

    if (!navContainer) {
        navContainer = document.createElement('ul');
        navContainer.className = 'nav-links';
        nav.appendChild(navContainer);
    } else {
        navContainer.classList.add('nav-links'); // Normalize legacy portal/dashboard class names to the shared navbar.
        navContainer.classList.remove('portal-nav-links', 'dashboard-nav-links');
    }

    if (!nav.querySelector('.menu-toggle')) {
        const menuToggle = document.createElement('div');
        menuToggle.className = 'menu-toggle';
        menuToggle.setAttribute('role', 'button');
        menuToggle.setAttribute('aria-label', 'Toggle menu');
        menuToggle.innerHTML = '<span></span><span></span><span></span>';
        nav.appendChild(menuToggle);
    }

    return navContainer;
}

/**
 * Bind the hamburger menu once per page so every navbar works on mobile.
 * Uses document-level delegation so it still works if the toggle node is replaced.
 */
function bindMobilePrimaryMenu() {
    if (window.__navMobileMenuBound) return;

    function getMenuParts() {
        return {
            menuToggle: document.querySelector('header nav .menu-toggle'),
            navLinks: document.querySelector('header nav .nav-links'),
            menuBackdrop: document.getElementById('mobileNavBackdrop')
        };
    }

    let menuBackdrop = document.getElementById('mobileNavBackdrop');
    if (!menuBackdrop) {
        menuBackdrop = document.createElement('div');
        menuBackdrop.id = 'mobileNavBackdrop';
        menuBackdrop.className = 'mobile-nav-backdrop';
        menuBackdrop.setAttribute('aria-hidden', 'true');
        document.body.appendChild(menuBackdrop);
    }

    function openMobileMenu() {
        const { menuToggle, navLinks } = getMenuParts();
        if (!menuToggle || !navLinks) return;
        navLinks.classList.add('active');
        menuToggle.classList.add('active');
        menuBackdrop.classList.add('active');
        menuToggle.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
    }

    function closeMobileMenu() {
        const { menuToggle, navLinks } = getMenuParts();
        if (!menuToggle || !navLinks) return;
        navLinks.classList.remove('active');
        menuToggle.classList.remove('active');
        menuBackdrop.classList.remove('active');
        menuToggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }

    function prepareToggle(menuToggle) {
        if (!menuToggle || menuToggle.dataset.navPrepared === '1') return;
        menuToggle.dataset.navPrepared = '1';
        menuToggle.setAttribute('role', 'button');
        menuToggle.setAttribute('tabindex', '0');
        menuToggle.setAttribute('aria-label', 'Toggle menu');
        menuToggle.setAttribute('aria-expanded', 'false');
        // Clicks on the three bars must hit the toggle, not get trapped by child spans.
        menuToggle.querySelectorAll('span').forEach((span) => {
            span.style.pointerEvents = 'none';
        });
    }

    prepareToggle(getMenuParts().menuToggle);

    // Delegation: one listener for the whole document (survives DOM rewrites).
    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('header nav .menu-toggle');
        if (toggle) {
            e.preventDefault();
            e.stopPropagation();
            prepareToggle(toggle);
            const { navLinks } = getMenuParts();
            if (!navLinks) return;
            if (navLinks.classList.contains('active')) closeMobileMenu();
            else openMobileMenu();
            return;
        }

        if (e.target.closest('#mobileNavBackdrop')) {
            e.preventDefault();
            e.stopPropagation();
            closeMobileMenu();
            return;
        }

        if (e.target.closest('header nav .nav-links a')) {
            closeMobileMenu();
        }
    });

    document.addEventListener('keydown', (e) => {
        const { menuToggle, navLinks } = getMenuParts();
        if (!menuToggle || !navLinks) return;

        if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === menuToggle) {
            e.preventDefault();
            if (navLinks.classList.contains('active')) closeMobileMenu();
            else openMobileMenu();
            return;
        }

        if (e.key === 'Escape' && navLinks.classList.contains('active')) {
            closeMobileMenu();
        }
    });

    window.__navMobileMenuBound = true;
    window.closeMobilePrimaryMenu = closeMobileMenu;
    window.openMobilePrimaryMenu = openMobileMenu;
}

/**
 * Initialize navigation bar based on auth status and role.
 */
function initNavigation() {
    console.log('Initializing navigation...');

    const navContainer = ensureSiteHeader();
    if (!navContainer) return;

    let isAuthenticated = false;
    let user = null;
    let isAlmighty = false;
    let canCreateListings = false;

    if (typeof authAPI !== 'undefined' && authAPI.isAuthenticated) {
        try {
            isAuthenticated = authAPI.isAuthenticated();
            if (isAuthenticated && authAPI.getCurrentUser) {
                user = authAPI.getCurrentUser();
                isAlmighty = !!(user && user.role === 'Almighty');
                canCreateListings = !!(user && user.role && user.role !== 'Guest'); // Guests browse but cannot create listings.
            }
        } catch (error) {
            console.error('Error checking authentication status:', error);
            isAuthenticated = false;
            user = null;
            isAlmighty = false;
            canCreateListings = false;
        }
    }

    console.log('Navigation state:', {
        isAuthenticated,
        username: user ? user.username : null,
        role: user ? user.role : null,
        isAlmighty
    });

    const currentPage = getCurrentNavPage();
    const labels = {
        about: getNavTranslation('nav.about', 'Contact'),
        account: getNavTranslation('nav.account', 'Account')
    };

    let navHTML = '';

    function addLink(href, key, fallback) {
        const active = currentPage === href ? 'class="active"' : '';
        navHTML += `<li><a href="${href}" ${active} data-i18n="${key}">${fallback}</a></li>`;
    }

    function addUserMenu() {
        if (!user) return;

        const username = escapeHtml(user.username || 'User');

        navHTML += `
            <li class="nav-user-menu">
                <button type="button" class="nav-user-menu-toggle" aria-expanded="false" aria-haspopup="true">
                    <span class="nav-user-name">${username}</span>
                    <span class="nav-user-caret">&#9662;</span>
                    <span class="nav-user-unread-badge" hidden aria-label="Unread messages"></span>
                </button>
                <div class="nav-user-dropdown" role="menu" aria-label="${escapeHtml(labels.account)}">
                    <a href="dashboard.html#profileSection" role="menuitem" data-i18n="nav.profile">Profile</a>
                    <a href="dashboard.html#postsSection" role="menuitem" data-i18n="nav.myPosts">My Posts</a>
                    <a href="dashboard.html#messagesSection" role="menuitem" data-i18n="nav.inbox">Inbox</a>
                    <a href="dashboard.html#bookmarksSection" role="menuitem" data-i18n="dashboard.bookmarkedCards">Bookmarks</a>
                    <button type="button" class="nav-user-logout" onclick="authAPI.logout()" role="menuitem" data-i18n="nav.logout">Logout</button>
                </div>
            </li>
        `;
    }

    // One consistent top-level navbar on every page.
    addLink('index.html', 'nav.home', 'Home');
    addLink('about-contact.html', 'nav.about', labels.about);

    if (isAuthenticated) {
        addLink('dashboard.html', 'nav.dashboard', 'Dashboard');
        if (canCreateListings) addLink('create-person.html', 'nav.createPerson', 'Create Person');
        if (isAlmighty) addLink('almighty-portal.html', 'nav.almightyPortal', 'Almighty Portal');
        addUserMenu();
    } else {
        addLink('login.html', 'nav.login', 'Login');
        addLink('register.html', 'nav.register', 'Register');
    }

    navContainer.innerHTML = navHTML;

    if (typeof languageManager !== 'undefined' && languageManager.translatePage) {
        languageManager.translatePage();
    }

    addNavigationStyles();
    bindUserMenuEvents(navContainer);
    bindMobilePrimaryMenu();
    initNavUnreadBadge(navContainer);

    console.log('Navigation initialized successfully');
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Bind dropdown events for the user menu.
 */
function bindUserMenuEvents(navContainer) {
    const toggle = navContainer.querySelector('.nav-user-menu-toggle');
    const userMenu = navContainer.querySelector('.nav-user-menu');

    if (!toggle || !userMenu) {
        return;
    }

    toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        const isOpen = userMenu.classList.contains('open');
        closeAllUserMenus();
        if (!isOpen) {
            userMenu.classList.add('open');
            toggle.setAttribute('aria-expanded', 'true');
        }
        refreshNavUnreadCountInternal(navContainer, { stopOnMissingRoute: false });
    });

    const dropdownItems = navContainer.querySelectorAll('.nav-user-dropdown a, .nav-user-dropdown .nav-user-logout');
    dropdownItems.forEach((item) => {
        item.addEventListener('click', function () {
            closeAllUserMenus();
            closeMobilePrimaryMenu();
        });
    });

    if (!window.__navUserMenuCloseBound) {
        document.addEventListener('click', closeAllUserMenus);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                closeAllUserMenus();
            }
        });
        window.__navUserMenuCloseBound = true;
    }
}

/**
 * Close primary mobile navigation overlay if open.
 */
function closeMobilePrimaryMenu() {
    const navLinks = document.querySelector('.nav-links');
    const menuToggle = document.querySelector('.menu-toggle');
    if (!navLinks) return;
    if (navLinks.classList.contains('active')) {
        navLinks.classList.remove('active');
        if (menuToggle) menuToggle.classList.remove('active');
        document.body.style.overflow = '';
    }
}

/**
 * Close all open user dropdowns.
 */
function closeAllUserMenus() {
    const openMenus = document.querySelectorAll('.nav-user-menu.open');
    openMenus.forEach((menu) => {
        menu.classList.remove('open');
        const toggle = menu.querySelector('.nav-user-menu-toggle');
        if (toggle) {
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
}

/**
 * Inject navigation styles once.
 */
function addNavigationStyles() {
    if (document.getElementById('navigation-styles')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'navigation-styles';
    style.textContent = `
        .nav-btn-logout {
            padding: 8px 16px;
            background-color: var(--accent-color);
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 500;
            transition: all 0.3s ease;
        }

        .nav-btn-logout:hover {
            background-color: var(--accent-hover);
        }

        .nav-user-info {
            color: var(--text-light);
            font-size: 0.9rem;
            padding: 0 10px;
        }

        .nav-user-info span {
            color: var(--primary-color);
            font-weight: 500;
        }

        .nav-user-menu {
            position: relative;
        }

        .nav-user-menu-toggle {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            border: none;
            background: transparent;
            color: inherit;
            font: inherit;
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 6px;
            position: relative;
        }

        .nav-user-menu-toggle:hover {
            background: rgba(255, 255, 255, 0.12);
        }

        .nav-user-name {
            font-weight: 600;
            color: var(--accent-color);
        }

        .nav-user-caret {
            font-size: 0.7rem;
            opacity: 0.85;
        }

        .nav-user-unread-badge {
            position: absolute;
            top: -5px;
            inset-inline-end: -6px;
            min-width: 16px;
            height: 16px;
            padding: 0 4px;
            border-radius: 999px;
            background: #e53935;
            color: #fff;
            font-size: 0.66rem;
            font-weight: 700;
            line-height: 16px;
            text-align: center;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
        }

        .nav-user-unread-badge[hidden] {
            display: none !important;
        }

        .nav-user-dropdown {
            position: absolute;
            inset-inline-end: 0;
            top: calc(100% + 8px);
            min-width: 180px;
            background: var(--background-color);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
            padding: 6px;
            display: none;
            z-index: 2000;
        }

        .nav-user-menu.open .nav-user-dropdown {
            display: block;
        }

        .nav-user-dropdown a,
        .nav-user-dropdown .nav-user-logout {
            display: block;
            width: 100%;
            text-align: start;
            text-decoration: none;
            border: none;
            background: transparent;
            color: var(--text-color);
            padding: 8px 10px;
            border-radius: 6px;
            font-size: 0.92rem;
            cursor: pointer;
        }

        .nav-user-dropdown a:hover,
        .nav-user-dropdown .nav-user-logout:hover {
            background: var(--background-alt);
        }

        .nav-user-menu {
            margin-inline-start: 4px;
        }

        @media (max-width: 1024px) {
            .nav-links.active .nav-user-menu {
                width: 100%;
                display: flex;
                flex-direction: column;
                align-items: center;
            }

            .nav-links.active .nav-user-menu-toggle {
                width: 80%;
                justify-content: center;
                background: var(--background-alt);
            }

            .nav-links.active .nav-user-dropdown {
                position: static;
                width: 80%;
                margin-top: 8px;
                box-shadow: none;
                border-color: var(--border-light);
            }
        }

        .nav-links a.active {
            color: var(--text-color); /* Keep label readable on the white pill */
            font-weight: 600;
            background-color: rgba(255, 255, 255, 1); /* White chip so the current page stands out */
            border-style: solid;
            border-width: 1px;
            border-color: rgba(0, 0, 0, 1); /* Solid black outline per design tweak */
            box-shadow: 0px 4px 12px 0px rgba(0, 0, 0, 0.15); /* Soft lift under the active nav item */
            border-radius: 999px; /* Pill shape so the chip reads as a selected control */
            padding: 0.35rem 0.9rem;
        }

        .nav-links li {
            display: flex;
            align-items: center;
        }

        .mobile-nav-backdrop {
            position: fixed;
            inset: 0;
            top: 60px;
            background: rgba(10, 20, 32, 0.35);
            opacity: 0;
            pointer-events: none;
            transition: opacity 140ms ease;
            z-index: 998;
        }

        .mobile-nav-backdrop.active {
            opacity: 1;
            pointer-events: auto;
        }
    `;

    document.head.appendChild(style);
    console.log('Navigation styles added');
}

/**
 * Create base navigation HTML for pages that need it dynamically.
 */
function createNavigationHTML() {
    return `
        <header>
            <nav>
                <div class="logo">Radgir</div>
                <ul class="nav-links">
                    <!-- Navigation links will be dynamically populated by initNavigation() -->
                </ul>
                <div class="menu-toggle">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </nav>
        </header>
    `;
}

/**
 * Wait for authAPI before nav init.
 */
function waitForAuthAPIAndInit(attempts = 0) {
    const maxAttempts = 20;

    if (typeof authAPI !== 'undefined') {
        console.log('authAPI is available, initializing navigation...');
        initNavigation();
    } else if (attempts < maxAttempts) {
        console.log(`Waiting for authAPI to load... (attempt ${attempts + 1}/${maxAttempts})`);
        setTimeout(() => waitForAuthAPIAndInit(attempts + 1), 50);
    } else {
        console.warn('authAPI not found after maximum attempts. Initializing navigation without auth check.');
        initNavigation();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        waitForAuthAPIAndInit();
    });
} else {
    waitForAuthAPIAndInit();
}

if (typeof window !== 'undefined') {
    window.initNavigation = initNavigation;
    window.createNavigationHTML = createNavigationHTML;
    window.refreshNavUnreadCount = function () {
        const navContainer = document.querySelector('header nav .nav-links') || document.querySelector('.nav-links');
        if (navContainer) refreshNavUnreadCountInternal(navContainer, { stopOnMissingRoute: false });
    };
}
