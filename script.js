/**
 * Homepage mobile behaviors (list sheet).
 * Hamburger menu is owned by navigation.js only — do not bind it here
 * or both handlers fire and the menu opens then immediately closes.
 */
document.addEventListener('DOMContentLoaded', function() {
    /**
     * Mobile draggable list sheet:
     * - No bottom quick-nav buttons
     * - Snap states: peek / half / full
     * - Drag from handle to resize
     */
    const listSheet = document.querySelector('#app-view-container .list-and-filters-wrapper');
    const sheetHandle = document.getElementById('mobileSheetHandle');

    if (listSheet && sheetHandle) {
        const body = document.body;
        const MOBILE_BREAKPOINT = 900;
        const SHEET_STATES = ['peek', 'half', 'full'];
        const SHEET_CLASS_PREFIX = 'mobile-sheet-';

        let currentState = 'peek';
        let anchors = { peek: 0, half: 0, full: 0 };
        let currentOffset = 0;
        let isDragging = false;
        let dragStartY = 0;
        let dragStartOffset = 0;
        let dragStartTs = 0;
        let didDrag = false;

        // Clean up legacy bottom-nav mode classes only (keep mobile-list-show-* for tabs).
        body.classList.remove('mobile-mode-map', 'mobile-mode-list', 'mobile-mode-filters');

        function isMobileLayout() {
            return window.innerWidth <= MOBILE_BREAKPOINT;
        }

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        function clearSheetStateClasses() {
            SHEET_STATES.forEach((state) => body.classList.remove(`${SHEET_CLASS_PREFIX}${state}`));
        }

        function setSheetOffset(offsetPx, animate = true) {
            currentOffset = clamp(offsetPx, anchors.full, anchors.peek);
            listSheet.classList.toggle('sheet-dragging', !animate);
            // Drive transform via CSS var so drag is not blocked by !important class rules.
            listSheet.style.setProperty('--sheet-offset', `${Math.round(currentOffset)}px`);
        }

        function snapToState(nextState, animate = true) {
            currentState = SHEET_STATES.includes(nextState) ? nextState : 'peek';
            clearSheetStateClasses();
            body.classList.add(`${SHEET_CLASS_PREFIX}${currentState}`);
            setSheetOffset(anchors[currentState], animate);
        }

        function recalcAnchors() {
            if (!isMobileLayout()) {
                clearSheetStateClasses();
                listSheet.classList.remove('sheet-dragging');
                listSheet.style.removeProperty('--sheet-offset');
                return;
            }

            const sheetHeight = Math.max(260, Math.round(listSheet.getBoundingClientRect().height || 0));
            const peekVisible = clamp(Math.round(window.innerHeight * 0.08), 52, 68); // taller peek so handle is easy to grab
            const halfVisible = clamp(Math.round(window.innerHeight * 0.5), 260, sheetHeight - 48);

            anchors = {
                full: 0,
                half: clamp(sheetHeight - halfVisible, 0, sheetHeight),
                peek: clamp(sheetHeight - peekVisible, 0, sheetHeight)
            };

            snapToState(currentState, false);
        }

        function stateFromOffset(offsetPx, velocityPxPerMs) {
            // Fast swipe changes to the next snap point in swipe direction.
            if (Math.abs(velocityPxPerMs) > 0.35) {
                if (velocityPxPerMs < 0) {
                    return offsetPx <= anchors.half ? 'full' : 'half';
                }
                return offsetPx >= anchors.half ? 'peek' : 'half';
            }

            // Otherwise snap to nearest anchor.
            const nearest = Object.entries(anchors).sort((a, b) => {
                return Math.abs(a[1] - offsetPx) - Math.abs(b[1] - offsetPx);
            })[0];
            return nearest ? nearest[0] : 'half';
        }

        function beginDrag(clientY) {
            if (!isMobileLayout()) return;
            isDragging = true;
            didDrag = false;
            dragStartY = clientY;
            dragStartOffset = currentOffset;
            dragStartTs = performance.now();
            listSheet.classList.add('sheet-dragging');
        }

        function moveDrag(clientY) {
            if (!isDragging) return;
            const deltaY = clientY - dragStartY;
            if (Math.abs(deltaY) > 3) didDrag = true;
            setSheetOffset(dragStartOffset + deltaY, false);
        }

        function endDrag(clientY) {
            if (!isDragging) return;
            isDragging = false;

            const elapsedMs = Math.max(1, performance.now() - dragStartTs);
            const velocity = (clientY - dragStartY) / elapsedMs;
            const nextState = stateFromOffset(currentOffset, velocity);
            snapToState(nextState, true);
            listSheet.classList.remove('sheet-dragging');
        }

        sheetHandle.addEventListener('touchstart', (event) => {
            const touch = event.touches && event.touches[0];
            if (!touch) return;
            beginDrag(touch.clientY);
        }, { passive: true });

        sheetHandle.addEventListener('touchmove', (event) => {
            if (!isDragging) return;
            const touch = event.touches && event.touches[0];
            if (!touch) return;
            event.preventDefault();
            moveDrag(touch.clientY);
        }, { passive: false });

        sheetHandle.addEventListener('touchend', (event) => {
            const touch = event.changedTouches && event.changedTouches[0];
            endDrag(touch ? touch.clientY : dragStartY);
        });

        sheetHandle.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            beginDrag(event.clientY);
        });

        window.addEventListener('mousemove', (event) => {
            moveDrag(event.clientY);
        });

        window.addEventListener('mouseup', (event) => {
            if (!isDragging) return;
            endDrag(event.clientY);
        });

        // Tap on the handle toggles between peek and half if there was no drag.
        sheetHandle.addEventListener('click', (event) => {
            if (!isMobileLayout() || didDrag) {
                didDrag = false;
                return;
            }
            event.preventDefault();
            snapToState(currentState === 'peek' ? 'half' : 'peek', true);
        });

        window.addEventListener('resize', recalcAnchors);
        recalcAnchors();
    }
    
    /**
     * Smooth scroll behavior for anchor links
     * This enhances the native smooth scroll with offset for fixed header
     */
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            
            // Get target element from href attribute
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            
            if (targetElement) {
                // Calculate offset for fixed header (60px)
                const headerOffset = 60;
                const elementPosition = targetElement.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - headerOffset;
                
                // Smooth scroll to target with offset
                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
                
                // Log for debugging
                console.log('Smooth scroll to:', targetId);
            }
        });
    });
    
    // Log initialization
    console.log('Website script initialized successfully');
});





