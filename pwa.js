/**
 * PWA bootstrap:
 * - Registers service worker
 * - Handles install prompt UX
 */
(function initPWA() {
    if (window.__pwaInitialized) return;
    window.__pwaInitialized = true;

    const isSecureContextLike =
        window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    const supportsSW = 'serviceWorker' in navigator;
    const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        Boolean(window.navigator.standalone);

    function trackPwaEvent(eventName, payload = {}, immediate = false) {
        if (!window.analyticsTracker || typeof window.analyticsTracker.track !== 'function') return;
        try {
            window.analyticsTracker.track(eventName, payload, immediate);
        } catch (_) {
            // Ignore analytics failures in PWA bootstrap.
        }
    }

    if (supportsSW && isSecureContextLike) {
        window.addEventListener('load', () => {
            navigator.serviceWorker
                .register('/sw.js')
                .then((registration) => {
                    // Proactively check for updates on each load.
                    registration.update().catch(() => {});
                    trackPwaEvent('pwa_sw_registered', {
                        pwaInstalled: isStandalone,
                        displayMode: isStandalone ? 'standalone' : 'browser'
                    });
                })
                .catch((error) => {
                    console.error('Service worker registration failed:', error);
                    trackPwaEvent('pwa_sw_register_failed', {
                        metadata: {
                            message: String(error && error.message ? error.message : error)
                        }
                    });
                });
        });
    }

    let deferredPrompt = null;
    let installButton = null;

    function createInstallButton() {
        if (installButton || isStandalone) return null;

        installButton = document.createElement('button');
        installButton.type = 'button';
        installButton.id = 'pwaInstallButton';
        installButton.textContent = 'نصب اپ';
        installButton.style.position = 'fixed';
        // Sit above the mobile list-sheet peek so it does not cover the drag handle.
        installButton.style.bottom = 'max(72px, calc(56px + env(safe-area-inset-bottom, 0px)))';
        installButton.style.right = '16px';
        installButton.style.zIndex = '1150';
        installButton.style.border = 'none';
        installButton.style.borderRadius = '999px';
        installButton.style.padding = '10px 16px';
        installButton.style.background = '#00ACAC';
        installButton.style.color = '#ffffff';
        installButton.style.fontSize = '14px';
        installButton.style.fontWeight = '600';
        installButton.style.cursor = 'pointer';
        installButton.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.2)';
        installButton.style.display = 'none';

        installButton.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            trackPwaEvent('pwa_install_prompt_clicked', {
                pwaInstalled: false,
                displayMode: 'browser'
            });
            deferredPrompt.prompt();
            try {
                const choice = await deferredPrompt.userChoice;
                trackPwaEvent(
                    choice && choice.outcome === 'accepted' ? 'pwa_install_prompt_accepted' : 'pwa_install_prompt_dismissed',
                    {
                        metadata: {
                            outcome: choice && choice.outcome ? choice.outcome : 'unknown'
                        }
                    },
                    true
                );
            } catch (err) {
                console.warn('Install prompt result unavailable:', err);
            } finally {
                deferredPrompt = null;
                installButton.style.display = 'none';
            }
        });

        document.body.appendChild(installButton);
        return installButton;
    }

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event;
        const btn = createInstallButton();
        if (btn) btn.style.display = 'inline-flex';
        trackPwaEvent('pwa_install_available', {
            pwaInstalled: false,
            displayMode: 'browser'
        });
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        if (installButton) {
            installButton.style.display = 'none';
        }
        trackPwaEvent(
            'pwa_installed',
            {
                pwaInstalled: true,
                displayMode: 'standalone'
            },
            true
        );
    });
})();
