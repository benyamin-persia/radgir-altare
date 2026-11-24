/**
 * ============================================
 * Create Person Listing JavaScript
 * ============================================
 * Handles the form for creating new person listings
 * Includes map for location selection, tag management, and family members
 */

// Global variables
let locationMap = null;
let locationMarker = null;
let familyMemberCount = 0;
let personRelationshipCount = 0;
let isUpdatingFromMap = false; // Flag to prevent circular updates
let isUpdatingFromInput = false; // Flag to prevent circular updates

/**
 * Current step in the progress form (1, 2, or 3).
 * User must fill required fields in each step before Next/Submit.
 */
let currentStep = 1;

/**
 * Whether the location map has been initialized (only when user reaches step 2).
 * Map is created lazily so the container has proper dimensions.
 */
let mapInitialized = false;
let step2SetupInitialized = false;
let mapInitRetryTimer = null;
let mapInitRetryAttempts = 0;
let mapInitAbortedForZeroSize = false;
const MAP_INIT_RETRY_DELAY_MS = 100;
const MAX_MAP_INIT_RETRIES = 30;
const MAX_METADATA_NOTES_LENGTH = 10000;
const CREATE_PERSON_SCRIPT_VERSION = '2026-11-24-card-photo';
const ADDRESS_STATUS = Object.freeze({
    EXACT: 'exact',
    APPROXIMATE: 'approximate',
    UNKNOWN: 'unknown'
});
let approximateProvincesLoaded = false;
let approximateSectionsLoadedForProvince = '';
console.log('create-person.js version:', CREATE_PERSON_SCRIPT_VERSION);

function trackAnalyticsEvent(eventName, payload = {}, immediate = false) {
    if (typeof window === 'undefined') return;
    if (!window.analyticsTracker || typeof window.analyticsTracker.track !== 'function') return;
    try {
        window.analyticsTracker.track(eventName, payload, immediate);
    } catch (_) {
        // Analytics must never interrupt form workflows.
    }
}

/**
 * When editing an existing person, this holds the person's ID.
 * Null when creating a new person; set from URL ?edit=id when in edit mode.
 */
let editPersonId = null;

// API base URL - use window.location to avoid conflicts with auth.js
// Note: auth.js also defines API_BASE_URL, but we use a different variable name here
// to avoid "already declared" errors. Both will work the same way.
// We use window.location.origin to dynamically get the current server URL
const CREATE_PERSON_API_BASE_URL = window.location.origin + '/api';
const PENDING_FOCUS_PERSON_ID_KEY = 'radgir_pending_focus_person_id';

// Nominatim API base URL for geocoding (OpenStreetMap)
const NOMINATIM_API = 'https://nominatim.openstreetmap.org';

/**
 * Geocode.xyz API - free geocoding with Iran (IR) support, no API key required.
 * Unauthenticated use is throttled (e.g. 1 req/sec). Use as fallback when Nominatim fails for Iran.
 * Docs: https://geocode.xyz/api | Iran: https://geocode.xyz/IR
 */
const GEOCODE_XYZ_BASE = 'https://geocode.xyz';

/**
 * Fetch address suggestions from Nominatim for autocomplete dropdown.
 * @param {string} query - Search query (min 2 chars)
 * @returns {Promise<Array<{ display_name: string, lat: number, lng: number }>>}
 */
async function fetchAddressSuggestions(query) {
    const trimmed = (query || '').trim();
    if (trimmed.length < 2) return [];
    let countryBias = '';
    if (typeof languageManager !== 'undefined' && languageManager.getCurrentLanguage() === 'fa') {
        countryBias = '&countrycodes=ir';
    }
    const url = `${NOMINATIM_API}/search?format=json&q=${encodeURIComponent(trimmed)}&limit=5&addressdetails=0${countryBias}`;
    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'PersonListingApp/1.0' } });
        if (!response.ok) return [];
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) return [];
        return data.map(function (item) {
            const lat = parseFloat(item.lat);
            const lng = parseFloat(item.lon);
            return { display_name: item.display_name || '', lat: lat, lng: lng };
        }).filter(function (item) { return !isNaN(item.lat) && !isNaN(item.lng); });
    } catch (e) {
        console.warn('Address suggestions error:', e);
        return [];
    }
}

/**
 * Forward geocode via Geocode.xyz (Iran region, no API key).
 * Returns { lat, lng } or null. Used when Nominatim fails for Iran addresses.
 */
async function forwardGeocodeGeocodeXyz(address) {
    try {
        const encoded = encodeURIComponent(address.trim());
        const url = `${GEOCODE_XYZ_BASE}/${encoded}?region=IR&json=1`;
        const response = await fetch(url, { headers: { 'User-Agent': 'PersonListingApp/1.0' } });
        if (!response.ok) return null;
        const data = await response.json();
        if (data.error && data.error.code === '008') return null; // no results
        const lat = parseFloat(data.latt);
        const lng = parseFloat(data.longt);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        console.log('Geocode.xyz fallback succeeded:', lat, lng);
        return { lat, lng };
    } catch (e) {
        console.warn('Geocode.xyz fallback error:', e);
        return null;
    }
}

/**
 * Escape a string for safe use in an HTML attribute (e.g. data-copy-text).
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
    if (str == null) return '';
    const s = String(str);
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Get a translated string by full i18n key with fallback.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function t(key, fallback) {
    if (typeof languageManager !== 'undefined' && languageManager && typeof languageManager.getTranslation === 'function') {
        const translated = languageManager.getTranslation(key);
        if (typeof translated === 'string' && translated.trim() !== '') {
            return translated;
        }
    }
    return fallback || key;
}

/**
 * Translate and interpolate placeholders like {name}.
 * @param {string} key
 * @param {string} fallback
 * @param {Object<string, string|number>} params
 * @returns {string}
 */
function tf(key, fallback, params) {
    const template = t(key, fallback);
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{(\w+)\}/g, function (_, token) {
        if (Object.prototype.hasOwnProperty.call(params, token)) {
            return String(params[token]);
        }
        return '{' + token + '}';
    });
}

/**
 * Map common backend error texts to localized equivalents.
 * @param {string} message
 * @returns {string}
 */
function localizeApiMessage(message) {
    if (!message || typeof message !== 'string') return message;
    const normalized = message.trim();
    const map = {
        'Validation error': t('createPerson.validationError', 'Validation error'),
        'Unauthorized': t('createPerson.unauthorized', 'Unauthorized'),
        'Forbidden': t('createPerson.forbidden', 'Forbidden'),
        'Person not found': t('createPerson.personNotFound', 'Person not found')
    };
    return map[normalized] || message;
}

/**
 * Build localized relationship option list while preserving backend values.
 * @param {string} selectedValue
 * @returns {string}
 */
function buildRelationshipOptions(selectedValue) {
    const rel = (selectedValue || '').trim();
    const options = [
        { value: '', label: t('createPerson.selectRelationship', 'Select relationship') },
        { value: 'Spouse', label: t('createPerson.relationshipSpouse', 'Spouse') },
        { value: 'Child', label: t('createPerson.relationshipChild', 'Child') },
        { value: 'Parent', label: t('createPerson.relationshipParent', 'Parent') },
        { value: 'Sibling', label: t('createPerson.relationshipSibling', 'Sibling') },
        { value: 'Other', label: t('createPerson.relationshipOther', 'Other') }
    ];
    return options.map(function (option) {
        const selected = option.value === rel ? ' selected' : '';
        return `<option value="${escapeAttr(option.value)}"${selected}>${escapeAttr(option.label)}</option>`;
    }).join('');
}

/**
 * Build localized HTML for a family member form item.
 * @param {number} index
 * @param {Object} member
 * @returns {string}
 */
function buildFamilyMemberMarkup(index, member) {
    const m = member || {};
    return `
        <div class="family-member-header">
            <h3 style="margin: 0; color: var(--primary-color);">${t('createPerson.familyMemberTitle', 'Family Member')} ${index}</h3>
            <button type="button" class="btn-remove" onclick="removeFamilyMember(${index})">${t('createPerson.removeButton', 'Remove')}</button>
        </div>
        <div class="form-grid">
            <div class="form-group">
                <label class="required">${t('createPerson.nameFieldLabel', 'Name')}</label>
                <input type="text" name="familyMembers[${index}][name]" value="${escapeAttr(m.name || '')}" required>
            </div>
            <div class="form-group">
                <label class="required">${t('createPerson.relationshipFieldLabel', 'Relationship')}</label>
                <select name="familyMembers[${index}][relationship]" required>
                    ${buildRelationshipOptions(m.relationship || '')}
                </select>
            </div>
            <div class="form-group">
                <label>${t('createPerson.roleFieldLabel', 'Role')}</label>
                <input type="text" name="familyMembers[${index}][role]" value="${escapeAttr(m.role || '')}">
            </div>
            <div class="form-group">
                <label>${t('createPerson.phoneFieldLabel', 'Phone')}</label>
                <input type="tel" name="familyMembers[${index}][phone]" value="${escapeAttr(m.phone || '')}">
            </div>
            <div class="form-group full-width">
                <label>${t('createPerson.notesFieldLabel', 'Notes')}</label>
                <textarea name="familyMembers[${index}][notes]" rows="2">${escapeAttr(m.notes || '')}</textarea>
            </div>
        </div>
    `;
}

function getRelationshipTargetId(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
        if (value._id) return String(value._id).trim();
        if (value.id) return String(value.id).trim();
    }
    return '';
}

/**
 * Accept plain ObjectId or shared URL with ?person=<ObjectId>.
 * Returns normalized ObjectId string, or empty string if invalid.
 * @param {string} rawValue
 * @returns {string}
 */
function resolveRelationshipTargetPersonId(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return '';

    const objectIdMatch = value.match(/\b[a-fA-F0-9]{24}\b/);
    if (objectIdMatch) return objectIdMatch[0];

    try {
        const url = new URL(value, window.location.origin);
        const personId = (url.searchParams.get('person') || '').trim();
        if (/^[a-fA-F0-9]{24}$/.test(personId)) return personId;
    } catch (_) {
        // Ignore invalid URL parsing and return empty.
    }

    return '';
}

function buildPersonRelationshipMarkup(index, relation) {
    const rel = relation || {};
    const targetPersonId = getRelationshipTargetId(rel.targetPersonId || rel.targetId || rel.personId);

    return `
        <div class="family-member-header">
            <h3 style="margin: 0; color: var(--primary-color);">${t('createPerson.relationshipItemTitle', 'Relationship')} ${index}</h3>
            <button type="button" class="btn-remove" onclick="removePersonRelationship(${index})">${t('createPerson.removeButton', 'Remove')}</button>
        </div>
        <div class="form-grid">
            <div class="form-group full-width">
                <label class="required">${t('createPerson.relationshipTargetIdLabel', 'Related person (ID or shared link)')}</label>
                <input type="text" name="relationships[${index}][targetPersonId]" value="${escapeAttr(targetPersonId)}" placeholder="${escapeAttr(t('createPerson.relationshipTargetIdPlaceholder', 'Paste person ID or shared link (index.html?person=...)'))}" required>
            </div>
        </div>
    `;
}

/**
 * Build popup HTML for the location marker: address + coordinates and a Copy button.
 * @param {string} [address] - Optional address text
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {string} HTML string for L.Marker.bindPopup()
 */
function buildLocationPopupContent(address, lat, lng) {
    const latStr = typeof lat === 'number' ? lat.toFixed(6) : String(lat);
    const lngStr = typeof lng === 'number' ? lng.toFixed(6) : String(lng);
    const coordsText = t('createPerson.coordinatesLabel', 'Coordinates') + ': ' + latStr + ', ' + lngStr;
    const displayAddress = address ? '<strong>' + escapeAttr(address) + '</strong><br>' : '';
    // Copy button copies only the address (not coordinates)
    const copyBtn = address
        ? ' <button type="button" class="popup-copy-btn" title="' + escapeAttr(t('createPerson.copyAddressButtonTitle', 'Copy address')) + '" data-copy-text="' + escapeAttr(address) + '">' + escapeAttr(t('createPerson.copyButton', 'Copy')) + '</button>'
        : '';
    return '<div class="popup-location-content">' +
        '<span class="popup-location-text">' + displayAddress + coordsText + '</span>' + copyBtn +
        '</div>';
}

/**
 * Location rule (مختصات = source of truth):
 * - The person's position on the HOME PAGE MAP (#map) is taken ONLY from the saved coordinates.
 * - The saved coordinates are exactly what you set here: either by clicking on #locationMap (this form's map)
 *   or by entering values in the "مختصات" (coordinates) field. The address is for display only and does NOT
 *   determine the pin position when saving.
 * - So: whatever pin/coordinates you set in this form = exact position of that person's pin on the home page map.
 */

/**
 * Set latitude, longitude, and combined coordinates input (e.g. "35.6892, 51.3890").
 * Use whenever we set location from map, suggestion, or geocode.
 * These values are what get saved and what the home page map uses for the person's marker.
 * @param {number} lat
 * @param {number} lng
 */
function setLocationCoordinates(lat, lng) {
    const latEl = document.getElementById('latitude');
    const lngEl = document.getElementById('longitude');
    const coordsEl = document.getElementById('coordinates');
    if (latEl) latEl.value = typeof lat === 'number' ? lat.toFixed(6) : String(lat);
    if (lngEl) lngEl.value = typeof lng === 'number' ? lng.toFixed(6) : String(lng);
    if (coordsEl) coordsEl.value = (typeof lat === 'number' ? lat.toFixed(6) : lat) + ', ' + (typeof lng === 'number' ? lng.toFixed(6) : lng);
}

var popupCopyButtonSetup = false;

/**
 * Set up delegated click handler for popup Copy buttons (copy location text to clipboard).
 * Safe to call multiple times; listener is only added once.
 */
function setupPopupCopyButton() {
    if (popupCopyButtonSetup) return;
    popupCopyButtonSetup = true;
    document.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest && e.target.closest('.popup-copy-btn');
        if (!btn || !btn.dataset.copyText) return;
        e.preventDefault();
        const text = btn.dataset.copyText;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                if (typeof showAlert !== 'undefined') {
                    showAlert(t('createPerson.copiedToClipboard', 'Copied to clipboard'), 'success');
                } else {
                    btn.textContent = t('createPerson.copiedShort', 'Copied!');
                    setTimeout(function () { btn.textContent = t('createPerson.copyButton', 'Copy'); }, 1500);
                }
            }).catch(function () {
                fallbackCopyToClipboard(text, btn);
            });
        } else {
            fallbackCopyToClipboard(text, btn);
        }
    });
}

function fallbackCopyToClipboard(text, btn) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (typeof showAlert !== 'undefined') showAlert(t('createPerson.copiedToClipboard', 'Copied to clipboard'), 'success');
        else { btn.textContent = t('createPerson.copiedShort', 'Copied!'); setTimeout(function () { btn.textContent = t('createPerson.copyButton', 'Copy'); }, 1500); }
    } catch (err) {
        if (typeof showAlert !== 'undefined') showAlert(t('createPerson.copyToClipboardFailed', 'Could not copy to clipboard'), 'error');
    }
}

/**
 * ============================================
 * Get Edit ID from URL (Edit Mode)
 * ============================================
 * When user clicks "Edit" on dashboard, we open create-person.html?edit=<personId>.
 * This helper reads the edit parameter and returns the ID or null.
 * @returns {string|null} Person ID to edit, or null if not in edit mode
 */
function getEditIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('edit');
    if (!id || id.trim() === '') return null;
    return id.trim();
}

/**
 * ============================================
 * Load Person Data for Edit
 * ============================================
 * Fetches a single person by ID from the API (GET /api/people/:id).
 * Used when the page is opened in edit mode (?edit=id).
 * @param {string} personId - MongoDB ObjectId of the person
 * @returns {Promise<Object|null>} The person object or null on failure
 */
async function loadPersonForEdit(personId) {
    try {
        console.log('Loading person for edit:', personId);
        const url = `${CREATE_PERSON_API_BASE_URL}/people/${personId}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ message: t('createPerson.unknownError', 'Unknown error') }));
            console.error('Failed to load person:', err);
            showAlert(localizeApiMessage(err.message) || tf('createPerson.loadPersonFailed', 'Failed to load person ({status})', { status: response.status }), 'error');
            return null;
        }
        const result = await response.json();
        if (!result.success || !result.data || !result.data.person) {
            console.error('Invalid API response:', result);
            showAlert(t('createPerson.invalidResponseFromServer', 'Invalid response from server'), 'error');
            return null;
        }
        console.log('Person loaded for edit:', result.data.person.name);
        return result.data.person;
    } catch (error) {
        console.error('Error loading person for edit:', error);
        showAlert(tf('createPerson.errorLoadingPerson', 'Error loading person: {message}', {
            message: error.message || t('createPerson.networkError', 'Network error')
        }), 'error');
        return null;
    }
}

/**
 * ============================================
 * Populate Form with Person Data (Edit Mode)
 * ============================================
 * Fills all form fields, tags, family members, notes, and shows existing images
 * so the user sees the current data when editing.
 * @param {Object} person - Person object from GET /api/people/:id
 */
async function populateFormWithPerson(person) {
    if (!person) return;

    // Step 1: Basic and contact fields (by element id)
    const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value != null ? String(value) : '';
    };
    setVal('name', person.name);
    setVal('familyName', person.familyName);
    setVal('nationalId', person.nationalId);
    setVal('job', person.job);
    setVal('phone', person.phone);
    setVal('email', person.email || person.metadata?.email);
    setVal('xAccount', person.xAccount);
    setVal('instagramAccount', person.instagramAccount);
    setVal('facebookAccount', person.facebookAccount);

    // Step 2: Location
    const hasCoords = person.location && person.location.coordinates && person.location.coordinates.length >= 2;
    const hasAddr = person.address && String(person.address).trim().length > 0;
    if (hasCoords) {
        const lat = person.latitude != null ? person.latitude : person.location.coordinates[1];
        const lng = person.longitude != null ? person.longitude : person.location.coordinates[0];
        setLocationCoordinates(Number(lat), Number(lng));
    }
    setVal('address', person.address || '');
    const statusExactEl = document.getElementById('addressStatusExact');
    const statusApproximateEl = document.getElementById('addressStatusApproximate');
    const statusUnknownEl = document.getElementById('addressStatusUnknown');

    let resolvedAddressStatus = ADDRESS_STATUS.UNKNOWN;
    const explicitStatus = person.addressStatus ? String(person.addressStatus).trim().toLowerCase() : '';
    if (explicitStatus === ADDRESS_STATUS.EXACT || explicitStatus === ADDRESS_STATUS.APPROXIMATE || explicitStatus === ADDRESS_STATUS.UNKNOWN) {
        resolvedAddressStatus = explicitStatus;
    } else if (hasAddr && hasCoords) {
        resolvedAddressStatus = ADDRESS_STATUS.EXACT;
    } else if (person.approximateRegion && (person.approximateRegion.province || person.approximateRegion.section)) {
        resolvedAddressStatus = ADDRESS_STATUS.APPROXIMATE;
    }

    if (statusExactEl && statusApproximateEl && statusUnknownEl) {
        statusExactEl.checked = resolvedAddressStatus === ADDRESS_STATUS.EXACT;
        statusApproximateEl.checked = resolvedAddressStatus === ADDRESS_STATUS.APPROXIMATE;
        statusUnknownEl.checked = resolvedAddressStatus === ADDRESS_STATUS.UNKNOWN;
    }

    if (resolvedAddressStatus === ADDRESS_STATUS.APPROXIMATE) {
        const approximateProvince = (person.approximateRegion && person.approximateRegion.province) || (person.administrativeRegion && person.administrativeRegion.province) || '';
        const approximateSection = (person.approximateRegion && person.approximateRegion.section) ||
            (person.administrativeRegion && (person.administrativeRegion.bakhsh || person.administrativeRegion.county)) || '';
        await loadApproximateProvinces(approximateProvince);
        await loadApproximateSections(approximateProvince, approximateSection);
    }
    toggleAddressFieldsVisibility();

    // Step 3: Tags - check the checkboxes that match person.tags (tags must already be loaded in #tagsContainer)
    const tags = Array.isArray(person.tags) ? person.tags : [];
    document.querySelectorAll('input[name="tags"]').forEach(checkbox => {
        checkbox.checked = tags.includes(checkbox.value);
    });

    // Step 4: Family members - clear container and add one row per member
    const container = document.getElementById('familyMembersContainer');
    if (container) {
        container.innerHTML = '';
        familyMemberCount = 0;
        const members = Array.isArray(person.familyMembers) ? person.familyMembers : [];
        members.forEach(member => {
            familyMemberCount++;
            const memberDiv = document.createElement('div');
            memberDiv.className = 'family-member-item';
            memberDiv.id = `familyMember-${familyMemberCount}`;
            memberDiv.innerHTML = buildFamilyMemberMarkup(familyMemberCount, member);
            container.appendChild(memberDiv);
        });
    }

    // Step 4.5: Relationships - clear container and add one row per relationship
    const relationshipsContainer = document.getElementById('personRelationshipsContainer');
    if (relationshipsContainer) {
        relationshipsContainer.innerHTML = '';
        personRelationshipCount = 0;
        const relationships = Array.isArray(person.relationships) ? person.relationships : [];
        relationships.forEach((relationship) => {
            personRelationshipCount++;
            const relationDiv = document.createElement('div');
            relationDiv.className = 'family-member-item';
            relationDiv.id = `personRelationship-${personRelationshipCount}`;
            relationDiv.innerHTML = buildPersonRelationshipMarkup(personRelationshipCount, relationship);
            relationshipsContainer.appendChild(relationDiv);
        });
    }

    // Step 5: Notes (metadata.notes)
    const notes = (person.metadata && person.metadata.notes) || person.notes || '';
    setVal('notes', notes);

    // Step 6: Existing images - show as selectable thumbnails in #imagePreview (click = card photo; new uploads add alongside)
    const previewContainer = document.getElementById('imagePreview');
    if (previewContainer && Array.isArray(person.images) && person.images.length > 0) {
        person.images.forEach((imgSrc, idx) => {
            const url = typeof imgSrc === 'string' ? imgSrc : (imgSrc && imgSrc.url) || '';
            if (!url) return;
            const div = document.createElement('div');
            div.className = 'image-preview-item existing-image';
            div.setAttribute('data-existing', 'true'); // marks this as already-saved (not a new File upload)
            div.setAttribute('data-existing-url', url); // stable URL key sent as cardPhoto on submit
            div.setAttribute('role', 'button');
            div.setAttribute('tabindex', '0');
            div.setAttribute('title', t('createPerson.cardPhotoHelp', 'Click an image to use it as the photo on the listing card.'));
            div.innerHTML = `
                <span class="card-photo-badge">${escapeAttr(t('createPerson.cardPhotoBadge', 'Card photo'))}</span>
                <img src="${escapeAttr(url)}" alt="Existing ${idx + 1}">
                <span class="image-name">Existing image ${idx + 1}</span>
            `;
            div.addEventListener('click', () => setCardPhotoPreview(div)); // pick this existing image as the listing card photo
            div.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setCardPhotoPreview(div);
                }
            });
            previewContainer.appendChild(div);
            if (idx === 0) setCardPhotoPreview(div); // images[0] is already the live card photo — preselect it
        });
    }

    console.log('Form populated with person data for edit');
}

/**
 * ============================================
 * Set Edit Mode UI (Heading and Submit Button)
 * ============================================
 * Updates the page heading and submit button text when in edit mode.
 */
function setEditModeUI() {
    const heading = document.querySelector('.form-header h1');
    if (heading) {
        heading.textContent = typeof languageManager !== 'undefined' && languageManager.getTranslation('createPerson.editHeading')
            ? languageManager.getTranslation('createPerson.editHeading')
            : 'Edit Person Listing';
    }
    const submitBtn = document.getElementById('btnSubmitStep');
    if (submitBtn) {
        submitBtn.textContent = typeof languageManager !== 'undefined' && languageManager.getTranslation('createPerson.updateButton')
            ? languageManager.getTranslation('createPerson.updateButton')
            : 'Update Person Listing';
    }
}

/**
 * ============================================
 * Initialize Create Person View (SPA Compatible)
 * ============================================
 * Main initialization function for SPA context
 * Can be called directly when view is loaded dynamically
 */
async function initCreatePersonView() {
    console.log('Initializing create person form (SPA mode)...');
    
    // Check authentication
    if (typeof authAPI !== 'undefined' && !authAPI.isAuthenticated()) {
        console.log('User not authenticated, redirecting to login');
        if (typeof router !== 'undefined') {
            router.navigate('/login');
        } else {
            window.location.href = 'login.html';
        }
        return;
    }
    
    // Wait a bit for DOM to be fully updated (SPA context)
    setTimeout(async () => {
        try {
            // Step navigation first (map is initialized when user reaches step 2)
            setupStepNavigation();
            setupPopupCopyButton();
            showStep(1);

            // Load tags (needed for step 3 and for pre-filling in edit mode)
            await loadTags();

            // Edit mode: URL has ?edit=<personId> — fetch person and pre-fill form
            const editId = getEditIdFromUrl();
            if (editId) {
                editPersonId = editId;
                const person = await loadPersonForEdit(editId);
                if (person) {
                    await populateFormWithPerson(person);
                    setEditModeUI();
                } else {
                    editPersonId = null;
                    console.warn('Edit mode aborted: could not load person');
                }
            }

            // Setup image upload preview (existing images already shown by populateFormWithPerson in edit mode)
            setupImageUpload();

            // Setup form submission (checks currentStep and validates step 3; uses PUT when editPersonId is set)
            setupFormSubmission();

            console.log('Create person form initialized successfully (step 1 active; map loads on step 2)' + (editPersonId ? ' [EDIT MODE]' : ''));
        } catch (error) {
            console.error('Error initializing create person form:', error);
        }
    }, 100);
}

/**
 * ============================================
 * Initialize Application (Legacy DOMContentLoaded)
 * ============================================
 * Main initialization function for non-SPA pages
 * Only runs if DOMContentLoaded hasn't fired yet
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Only initialize if we're on a standalone create-person page
    // In SPA context, initCreatePersonView() will be called directly
    if (document.getElementById('personForm') && !window.location.hash) {
        console.log('Initializing create person form (standalone page)...');

        // Check authentication
        if (typeof authAPI !== 'undefined' && !authAPI.isAuthenticated()) {
            console.log('User not authenticated, redirecting to login');
            window.location.href = 'login.html';
            return;
        }

        // Step navigation (map initializes when user reaches step 2)
        setupStepNavigation();
        setupPopupCopyButton();
        setupHasAddressRadio();
        showStep(1);

        // Load tags (needed for step 3 and for pre-filling in edit mode)
        await loadTags();

        // Edit mode: URL has ?edit=<personId> — fetch person and pre-fill form
        const editId = getEditIdFromUrl();
        if (editId) {
            editPersonId = editId;
            const person = await loadPersonForEdit(editId);
            if (person) {
                await populateFormWithPerson(person);
                setEditModeUI();
            } else {
                editPersonId = null;
                console.warn('Edit mode aborted: could not load person');
            }
        }

        // Setup image upload preview (existing images already shown by populateFormWithPerson in edit mode)
        setupImageUpload();

        // Setup form submission (uses PUT when editPersonId is set; redirect to dashboard after update)
        setupFormSubmission();

        console.log('Create person form initialized successfully (step 1 active; map loads on step 2)' + (editPersonId ? ' [EDIT MODE]' : ''));
    }
});

// Export functions for SPA use
if (typeof window !== 'undefined') {
    window.initCreatePersonView = initCreatePersonView;
    window.initLocationMap = initLocationMap;
    window.setupLocationSync = setupLocationSync;
    window.loadTags = loadTags;
    window.setupImageUpload = setupImageUpload;
    window.setupFormSubmission = setupFormSubmission;
    window.showStep = showStep;
    window.validateStep = validateStep;
    window.setupStepNavigation = setupStepNavigation;
}

function clearMapInitRetry(resetAbortState) {
    if (mapInitRetryTimer) {
        clearTimeout(mapInitRetryTimer);
        mapInitRetryTimer = null;
    }
    mapInitRetryAttempts = 0;
    if (resetAbortState) {
        mapInitAbortedForZeroSize = false;
    }
}

function getSelectedAddressStatus() {
    const selected = document.querySelector('input[name="addressStatus"]:checked');
    const value = selected ? String(selected.value).trim().toLowerCase() : '';
    if (value === ADDRESS_STATUS.EXACT || value === ADDRESS_STATUS.APPROXIMATE || value === ADDRESS_STATUS.UNKNOWN) {
        return value;
    }
    return ADDRESS_STATUS.EXACT;
}

function shouldInitializeMap() {
    if (currentStep !== 2) return false;
    if (getSelectedAddressStatus() !== ADDRESS_STATUS.EXACT) return false;
    const mapFieldsGroup = document.getElementById('mapFieldsGroup');
    if (mapFieldsGroup && mapFieldsGroup.style.display === 'none') return false;
    return true;
}

function centerMapFromCurrentInputs() {
    if (!locationMap) return;
    const latEl = document.getElementById('latitude');
    const lngEl = document.getElementById('longitude');
    if (!latEl || !lngEl) return;
    const lat = parseFloat(latEl.value);
    const lng = parseFloat(lngEl.value);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    locationMap.setView([lat, lng], 15);
    if (locationMarker) {
        locationMarker.setLatLng([lat, lng]);
    } else {
        locationMarker = L.marker([lat, lng]).addTo(locationMap);
    }
    const addressEl = document.getElementById('address');
    if (addressEl && addressEl.value.trim()) {
        locationMarker.bindPopup(buildLocationPopupContent(addressEl.value.trim(), lat, lng));
    } else {
        locationMarker.bindPopup(buildLocationPopupContent(null, lat, lng));
    }
}

/**
 * ============================================
 * Show Step (Progress Tab)
 * ============================================
 * Displays the given step panel and updates the step indicator.
 * Map is initialized only when user first reaches step 2.
 *
 * @param {number} step - Step number (1, 2, or 3)
 */
function showStep(step) {
    if (step < 1 || step > 3) {
        console.warn('showStep: invalid step', step);
        return;
    }
    currentStep = step;
    console.log('Showing step', currentStep);
    trackAnalyticsEvent('create_person_step_view', {
        metadata: { step: currentStep, mode: editPersonId ? 'edit' : 'create' }
    });

    // Show only the active step panel; hide others
    [1, 2, 3].forEach(function (s) {
        const panel = document.getElementById('formStep' + s);
        if (panel) {
            panel.classList.toggle('active', s === step);
        }
    });

    // Update step indicator dots and connectors
    [1, 2, 3].forEach(function (s) {
        const dot = document.getElementById('stepDot' + s);
        if (dot) {
            dot.classList.remove('active', 'completed');
            dot.setAttribute('aria-current', s === step ? 'step' : 'false');
            if (s === step) {
                dot.classList.add('active');
            } else if (s < step) {
                dot.classList.add('completed');
            }
        }
    });
    const conn1 = document.getElementById('connector1');
    const conn2 = document.getElementById('connector2');
    if (conn1) conn1.classList.toggle('completed', step > 1);
    if (conn2) conn2.classList.toggle('completed', step > 2);

    // Show/hide Previous button (hidden on step 1)
    const btnPrev = document.getElementById('btnPrevStep');
    if (btnPrev) {
        btnPrev.style.visibility = step === 1 ? 'hidden' : 'visible';
    }

    // Show Next on steps 1–2, Show Submit on step 3
    const btnNext = document.getElementById('btnNextStep');
    const btnSubmit = document.getElementById('btnSubmitStep');
    if (btnNext) btnNext.style.display = step < 3 ? 'inline-block' : 'none';
    if (btnSubmit) btnSubmit.style.display = step === 3 ? 'inline-block' : 'none';

    // Stop pending map retries when user leaves step 2.
    if (step !== 2) {
        clearMapInitRetry(true);
    }

    // Show/hide exact/approximate location fields (Step 2)
    if (step === 2) {
        toggleAddressFieldsVisibility();

        if (!step2SetupInitialized) {
            console.log('First time on step 2: initializing location sync and address toggles');
            setupLocationSync();
            setupHasAddressRadio();
            step2SetupInitialized = true;
        }

        if (!mapInitialized) {
            if (shouldInitializeMap()) {
                console.log('First time on step 2 with address enabled: initializing location map');
                initLocationMap();
            } else {
                console.log('Skipping location map init on step 2 (address disabled)');
            }
        } else if (locationMap) {
            locationMap.invalidateSize();
            centerMapFromCurrentInputs();
        }
    }

    // Scroll to top of form card so user sees the step content
    const formCard = document.querySelector('.form-card');
    if (formCard) formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * ============================================
 * Load Approximate Province Options
 * ============================================
 * Loads province list for approximate address mode.
 */
async function loadApproximateProvinces(preferredProvince) {
    const provinceSelect = document.getElementById('approximateProvince');
    if (!provinceSelect) return;

    const placeholder = (typeof languageManager !== 'undefined' && languageManager.getTranslation)
        ? (languageManager.getTranslation('createPerson.selectProvince') || t('createPerson.selectProvince', 'Select province'))
        : t('createPerson.selectProvince', 'Select province');

    const currentValue = preferredProvince || provinceSelect.value || '';
    if (approximateProvincesLoaded && provinceSelect.options.length > 1) {
        if (currentValue) provinceSelect.value = currentValue;
        return;
    }

    provinceSelect.innerHTML = `<option value="">${escapeAttr(placeholder)}</option>`;
    const countryCode = (typeof languageManager !== 'undefined' && languageManager.getCurrentLanguage && languageManager.getCurrentLanguage() === 'en') ? 'us' : 'ir';

    try {
        const res = await fetch(`${CREATE_PERSON_API_BASE_URL}/people/provinces?country=${countryCode}`);
        const data = await res.json();
        if (!res.ok || !data.success) {
            console.warn('Failed to load approximate provinces:', data);
            return;
        }
        const provinces = Array.isArray(data.data) ? data.data : [];
        provinces.forEach((p) => {
            const option = document.createElement('option');
            option.value = (p.nameFa || p.name || '').trim();
            option.textContent = option.value;
            if (option.value) provinceSelect.appendChild(option);
        });
        approximateProvincesLoaded = true;

        if (currentValue) {
            const hasOption = Array.from(provinceSelect.options).some(o => o.value === currentValue);
            if (!hasOption) {
                const option = document.createElement('option');
                option.value = currentValue;
                option.textContent = currentValue;
                provinceSelect.appendChild(option);
            }
            provinceSelect.value = currentValue;
        }
    } catch (error) {
        console.error('Error loading approximate provinces:', error);
    }
}

/**
 * ============================================
 * Load Approximate Section Options
 * ============================================
 * Loads sections/counties for a selected province in approximate mode.
 */
async function loadApproximateSections(province, preferredSection) {
    const sectionSelect = document.getElementById('approximateSection');
    if (!sectionSelect) return;

    const placeholder = (typeof languageManager !== 'undefined' && languageManager.getTranslation)
        ? (languageManager.getTranslation('createPerson.selectSectionOptional') || t('createPerson.selectSectionOptional', 'Select section (optional)'))
        : t('createPerson.selectSectionOptional', 'Select section (optional)');

    if (!province) {
        sectionSelect.innerHTML = `<option value="">${escapeAttr(placeholder)}</option>`;
        sectionSelect.disabled = true;
        approximateSectionsLoadedForProvince = '';
        return;
    }

    if (approximateSectionsLoadedForProvince === province && sectionSelect.options.length > 1) {
        sectionSelect.disabled = false;
        if (preferredSection) sectionSelect.value = preferredSection;
        return;
    }

    sectionSelect.disabled = true;
    sectionSelect.innerHTML = `<option value="">${escapeAttr(placeholder)}</option>`;

    const countryCode = (typeof languageManager !== 'undefined' && languageManager.getCurrentLanguage && languageManager.getCurrentLanguage() === 'en') ? 'us' : 'ir';
    try {
        const res = await fetch(`${CREATE_PERSON_API_BASE_URL}/people/sections?province=${encodeURIComponent(province)}&country=${countryCode}`);
        const data = await res.json();
        if (!res.ok || !data.success) {
            console.warn('Failed to load approximate sections:', data);
            sectionSelect.disabled = false;
            return;
        }
        const sections = Array.isArray(data.data) ? data.data : [];
        sections.forEach((s) => {
            const value = (s.nameFa || s.name || '').trim();
            if (!value) return;
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            sectionSelect.appendChild(option);
        });
        sectionSelect.disabled = false;
        approximateSectionsLoadedForProvince = province;

        if (preferredSection) {
            const hasOption = Array.from(sectionSelect.options).some(o => o.value === preferredSection);
            if (!hasOption) {
                const option = document.createElement('option');
                option.value = preferredSection;
                option.textContent = preferredSection;
                sectionSelect.appendChild(option);
            }
            sectionSelect.value = preferredSection;
        }
    } catch (error) {
        console.error('Error loading approximate sections:', error);
        sectionSelect.disabled = false;
    }
}

/**
 * ============================================
 * Toggle Address Fields Visibility (Step 2)
 * ============================================
 * Controls exact-address map fields vs approximate region fields.
 */
function toggleAddressFieldsVisibility() {
    const status = getSelectedAddressStatus();
    const addressFieldsGroup = document.getElementById('addressFieldsGroup');
    const coordinatesFieldsGroup = document.getElementById('coordinatesFieldsGroup');
    const mapFieldsGroup = document.getElementById('mapFieldsGroup');
    const approximateFieldsGroup = document.getElementById('approximateFieldsGroup');
    const provinceSelect = document.getElementById('approximateProvince');
    const sectionSelect = document.getElementById('approximateSection');

    const isExact = status === ADDRESS_STATUS.EXACT;
    const isApproximate = status === ADDRESS_STATUS.APPROXIMATE;

    if (addressFieldsGroup) addressFieldsGroup.style.display = isExact ? '' : 'none';
    if (coordinatesFieldsGroup) coordinatesFieldsGroup.style.display = isExact ? '' : 'none';
    if (mapFieldsGroup) mapFieldsGroup.style.display = isExact ? '' : 'none';
    if (approximateFieldsGroup) approximateFieldsGroup.style.display = isApproximate ? '' : 'none';

    if (isApproximate) {
        const selectedProvince = provinceSelect ? provinceSelect.value : '';
        const selectedSection = sectionSelect ? sectionSelect.value : '';
        loadApproximateProvinces(selectedProvince).then(() => {
            const province = provinceSelect ? provinceSelect.value : '';
            loadApproximateSections(province, selectedSection);
        });
    } else if (sectionSelect) {
        approximateSectionsLoadedForProvince = '';
        sectionSelect.disabled = true;
    }

    console.log('Address status UI:', status, '| exact fields:', isExact ? 'visible' : 'hidden', '| approximate fields:', isApproximate ? 'visible' : 'hidden');
}

/**
 * ============================================
 * Setup Address Status Controls (Step 2)
 * ============================================
 * Binds change listeners for exact/approximate/unknown and approximate selects.
 */
function setupHasAddressRadio() {
    const statusRadios = Array.from(document.querySelectorAll('input[name="addressStatus"]'));
    if (statusRadios.length === 0) return;

    const provinceSelect = document.getElementById('approximateProvince');
    const sectionSelect = document.getElementById('approximateSection');

    if (provinceSelect && provinceSelect.dataset.boundApproximateProvinceChange !== 'true') {
        provinceSelect.addEventListener('change', function () {
            approximateSectionsLoadedForProvince = '';
            loadApproximateSections(provinceSelect.value, sectionSelect ? sectionSelect.value : '');
        });
        provinceSelect.dataset.boundApproximateProvinceChange = 'true';
    }

    const allBound = statusRadios.every(r => r.dataset.boundAddressStatusToggle === 'true');
    if (allBound) {
        return;
    }

    function onChange() {
        toggleAddressFieldsVisibility();
        if (shouldInitializeMap()) {
            mapInitAbortedForZeroSize = false;
            setTimeout(() => {
                initLocationMap();
            }, MAP_INIT_RETRY_DELAY_MS);
            return;
        }
        clearMapInitRetry(true);
    }

    statusRadios.forEach((radio) => {
        if (radio.dataset.boundAddressStatusToggle === 'true') return;
        radio.addEventListener('change', onChange);
        radio.dataset.boundAddressStatusToggle = 'true';
    });
}

/**
 * ============================================
 * Validate Step (Required Fields)
 * ============================================
 * Validates only the required fields for the current step.
 * User cannot proceed to Next/Submit until this passes.
 *
 * @param {number} step - Step number (1, 2, or 3)
 * @returns {{ valid: boolean, message?: string }}
 */
function validateStep(step) {
    if (step === 1) {
        const nameEl = document.getElementById('name');
        const name = nameEl && nameEl.value ? nameEl.value.trim() : '';
        if (!name) {
            if (nameEl) nameEl.focus();
            return { valid: false, message: t('createPerson.nameRequiredStep1', 'Name is required (Step 1).') };
        }
        return { valid: true };
    }

    if (step === 2) {
        const status = getSelectedAddressStatus();
        if (status === ADDRESS_STATUS.UNKNOWN) {
            return { valid: true };
        }
        if (status === ADDRESS_STATUS.APPROXIMATE) {
            const provinceEl = document.getElementById('approximateProvince');
            const province = provinceEl && provinceEl.value ? provinceEl.value.trim() : '';
            if (!province) {
                if (provinceEl) provinceEl.focus();
                return { valid: false, message: t('createPerson.selectProvinceStep2', 'Please select a province for approximate location (Step 2).') };
            }
            return { valid: true };
        }

        const addressEl = document.getElementById('address');
        const latEl = document.getElementById('latitude');
        const lngEl = document.getElementById('longitude');
        const address = addressEl && addressEl.value ? addressEl.value.trim() : '';
        const latStr = latEl && latEl.value ? latEl.value.trim() : '';
        const lngStr = lngEl && lngEl.value ? lngEl.value.trim() : '';
        if (!address) {
            if (addressEl) addressEl.focus();
            return { valid: false, message: t('createPerson.addressRequiredStep2', 'Address is required (Step 2).') };
        }
        if (!latStr || !lngStr) {
            const coordsEl = document.getElementById('coordinates');
            if (coordsEl) coordsEl.focus();
            return { valid: false, message: t('createPerson.latLngRequiredStep2', 'Latitude and longitude are required. Enter them or click on the map (Step 2).') };
        }
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        if (isNaN(lat) || lat < -90 || lat > 90) {
            const coordsEl = document.getElementById('coordinates');
            if (coordsEl) coordsEl.focus();
            return { valid: false, message: t('createPerson.latitudeRangeStep2', 'Latitude must be a number between -90 and 90 (Step 2).') };
        }
        if (isNaN(lng) || lng < -180 || lng > 180) {
            const coordsEl = document.getElementById('coordinates');
            if (coordsEl) coordsEl.focus();
            return { valid: false, message: t('createPerson.longitudeRangeStep2', 'Longitude must be a number between -180 and 180 (Step 2).') };
        }
        return { valid: true };
    }

    if (step === 3) {
        const tagCheckboxes = document.querySelectorAll('input[name="tags"]:checked');
        const selectedTags = Array.from(tagCheckboxes).map(function (c) { return c.value; });
        if (selectedTags.length === 0) {
            const tagsSection = document.querySelector('.form-section:has(#tagsContainer)');
            if (tagsSection) tagsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return { valid: false, message: t('createPerson.selectTagStep3', 'Please select at least one classification tag (Step 3).') };
        }
        // Create mode requires at least one uploaded image.
        if (!editPersonId) {
            const imageInput = document.getElementById('images');
            const imageCount = imageInput && imageInput.files ? imageInput.files.length : 0;
            if (imageCount === 0) {
                if (imageInput) imageInput.focus();
                return { valid: false, message: t('createPerson.imageRequiredStep3', 'Please upload at least one image (Step 3).') };
            }
        }
        return { valid: true };
    }

    return { valid: false, message: t('createPerson.invalidStep', 'Invalid step.') };
}

/**
 * ============================================
 * Setup Step Navigation
 * ============================================
 * Binds Previous/Next/Submit so user must fill required fields to proceed.
 */
function setupStepNavigation() {
    const btnPrev = document.getElementById('btnPrevStep');
    const btnNext = document.getElementById('btnNextStep');
    const btnSubmit = document.getElementById('btnSubmitStep');

    if (!btnPrev || !btnNext || !btnSubmit) {
        console.warn('Step navigation buttons not found');
        return;
    }

    // Next: validate current step, then go to next step
    btnNext.addEventListener('click', function () {
        const result = validateStep(currentStep);
        if (!result.valid) {
            showAlert(result.message || t('createPerson.fillRequiredFieldsToContinue', 'Please fill required fields to continue.'), 'error');
            return;
        }
        hideAlert();
        showStep(currentStep + 1);
    });

    // Previous: no validation needed, go back
    btnPrev.addEventListener('click', function () {
        hideAlert();
        showStep(currentStep - 1);
    });

    // Submit button triggers form submit; validation runs in setupFormSubmission
    // Ensure we only allow submit when on step 3 (button is only visible then)
    console.log('Step navigation ready: user must fill required fields to proceed to next step');
}

/**
 * ============================================
 * Initialize Location Map
 * ============================================
 * Creates a map for selecting person location
 */
function initLocationMap() {
    console.log('Initializing location map...');

    if (!shouldInitializeMap()) {
        clearMapInitRetry(true);
        console.log('Skipping location map initialization (address disabled or step is not active)');
        return;
    }

    if (mapInitAbortedForZeroSize) {
        console.warn('Map init paused after repeated zero-size container. Toggle location mode or revisit Step 2 to retry.');
        return;
    }

    // Map already exists; just refresh layout/marker state.
    if (locationMap) {
        clearMapInitRetry(true);
        mapInitialized = true;
        locationMap.invalidateSize();
        centerMapFromCurrentInputs();
        return;
    }

    // Check if map container exists and is visible
    const mapContainer = document.getElementById('locationMap');
    if (!mapContainer) {
        console.error('Map container #locationMap not found!');
        return;
    }
    
    // Check if container has proper dimensions
    const containerRect = mapContainer.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) {
        if (mapInitRetryAttempts >= MAX_MAP_INIT_RETRIES) {
            console.warn(`Map container stayed at zero size after ${MAX_MAP_INIT_RETRIES} retries; aborting map init.`);
            mapInitAbortedForZeroSize = true;
            clearMapInitRetry();
            return;
        }
        if (!mapInitRetryTimer) {
            mapInitRetryAttempts += 1;
            console.warn(`Map container has zero dimensions. Waiting for layout... (${mapInitRetryAttempts}/${MAX_MAP_INIT_RETRIES})`);
            mapInitRetryTimer = setTimeout(() => {
                mapInitRetryTimer = null;
                initLocationMap();
            }, MAP_INIT_RETRY_DELAY_MS);
        }
        return;
    }

    mapInitAbortedForZeroSize = false;
    clearMapInitRetry();
    console.log('Map container dimensions:', containerRect.width, 'x', containerRect.height);
    
    // Default center (Tehran, Iran)
    let defaultCenter = [35.6892, 51.3890];
    let defaultZoom = 10;
    
    // Try to get coordinates from language manager
    if (typeof languageManager !== 'undefined') {
        const countryCoords = languageManager.getCountryMapCoordinates();
        if (countryCoords) {
            defaultCenter = countryCoords.center;
            defaultZoom = countryCoords.zoom;
            console.log('Using country coordinates from language manager:', defaultCenter);
        }
    }
    
    // Ensure default coordinates are valid
    if (defaultCenter[0] < -90 || defaultCenter[0] > 90 || defaultCenter[1] < -180 || defaultCenter[1] > 180) {
        console.error('Invalid default center coordinates:', defaultCenter);
        defaultCenter = [35.6892, 51.3890]; // Fallback to Tehran
    }
    
    // Create map with explicit CRS (Coordinate Reference System) to ensure WGS84
    // Disable zoom control buttons and set custom attribution text per UI request
    locationMap = L.map('locationMap', {
        crs: L.CRS.EPSG3857, // Web Mercator (standard for web maps)
        center: defaultCenter,
        zoom: defaultZoom,
        zoomControl: false,
        attributionControl: true
    });
    console.log('Location map controls configured: zoomControl=false, attributionControl=true');
    
    // Remove the default Leaflet prefix so only our custom attribution is shown
    if (locationMap.attributionControl) {
        locationMap.attributionControl.setPrefix('');
    }
    
    // Add tile layer
    const customAttribution = '<span class="map-attribution">' +
        'Long live KING , Long live IRAN #javid_shah' +
    '</span>';
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: customAttribution,
        maxZoom: 19,
        noWrap: false // Allow map to wrap around
    }).addTo(locationMap);
    console.log('Location map attribution set to custom text');
    
    // Ensure map is properly sized after initialization
    setTimeout(() => {
        if (locationMap) {
            locationMap.invalidateSize();
            centerMapFromCurrentInputs();
            console.log('Map size invalidated, current center:', locationMap.getCenter());
        }
    }, 100);
    
    // Add click handler to set location
    locationMap.on('click', async function(e) {
        // Get raw coordinates from event
        const rawLat = e.latlng.lat;
        const rawLng = e.latlng.lng;
        
        console.log('Raw coordinates from map click:', { lat: rawLat, lng: rawLng });
        console.log('Map center:', locationMap.getCenter());
        console.log('Map bounds:', locationMap.getBounds());
        
        // Normalize longitude to -180 to 180 range (handle wrapping)
        let lat = rawLat;
        let lng = rawLng;
        
        // Normalize longitude if it's outside valid range (could be a wrapping issue)
        while (lng > 180) {
            lng -= 360;
        }
        while (lng < -180) {
            lng += 360;
        }
        
        console.log('Normalized coordinates:', { lat, lng });
        
        // Validate coordinates before using them
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.error('Invalid coordinates after normalization:', { lat, lng, rawLat, rawLng });
            console.error('Map state:', {
                center: locationMap.getCenter(),
                zoom: locationMap.getZoom(),
                bounds: locationMap.getBounds(),
                size: locationMap.getSize()
            });
            showAlert(t('createPerson.invalidCoordinatesDetected', 'Invalid coordinates detected. Please refresh the page and try again. If the problem persists, try manually entering coordinates.'), 'error');
            return;
        }
        
        // Set flag to prevent circular updates
        isUpdatingFromMap = true;
        
        setLocationCoordinates(lat, lng);
        
        // Update or create marker
        if (locationMarker) {
            locationMarker.setLatLng([lat, lng]);
        } else {
            locationMarker = L.marker([lat, lng]).addTo(locationMap);
        }
        
        // Get address from coordinates (reverse geocoding)
        // Only update the address input if it is empty — if user already entered an address, do not overwrite it
        const addressEl = document.getElementById('address');
        const hasExistingAddress = addressEl && addressEl.value.trim().length > 0;
        try {
            const address = await reverseGeocode(lat, lng);
            if (address) {
                if (!hasExistingAddress) {
                    addressEl.value = address;
                }
                locationMarker.bindPopup(buildLocationPopupContent(address, lat, lng)).openPopup();
            } else {
                locationMarker.bindPopup(buildLocationPopupContent(null, lat, lng)).openPopup();
            }
        } catch (error) {
            console.error('Error getting address:', error);
            locationMarker.bindPopup(buildLocationPopupContent(null, lat, lng)).openPopup();
        }
        
        // Reset flag
        isUpdatingFromMap = false;
    });
    
    // Leave address, latitude, and longitude fields empty by default.
    // Map is already centered on defaultCenter (or country from language manager); user can click map or enter address to set location.
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function(position) {
                const userLat = position.coords.latitude;
                const userLng = position.coords.longitude;
                // Optionally center map on user location (no form fill, no marker)
                locationMap.setView([userLat, userLng], 15);
            },
            function(error) {
                console.warn('Could not get user location:', error.message);
                // Map stays at defaultCenter; fields remain empty
            }
        );
    }

    mapInitialized = true;
    centerMapFromCurrentInputs();
    console.log('Location map initialized');
}

/**
 * ============================================
 * Reverse Geocoding
 * ============================================
 * Converts coordinates (lat, lng) to address
 * Uses Nominatim API from OpenStreetMap
 * 
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<string>} Address string
 */
async function reverseGeocode(lat, lng) {
    try {
        console.log(`Reverse geocoding: ${lat}, ${lng}`);
        
        // Use Nominatim reverse geocoding API
        const url = `${NOMINATIM_API}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'PersonListingApp/1.0' // Required by Nominatim
            }
        });
        
        if (!response.ok) {
            throw new Error(`Geocoding failed: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data && data.display_name) {
            console.log('Address found:', data.display_name);
            return data.display_name;
        }
        
        return null;
    } catch (error) {
        console.error('Reverse geocoding error:', error);
        return null;
    }
}

/**
 * ============================================
 * Forward Geocoding
 * ============================================
 * Converts address to coordinates (lat, lng)
 * Uses Nominatim API from OpenStreetMap
 * 
 * @param {string} address - Address string
 * @returns {Promise<{lat: number, lng: number}>} Coordinates object
 */
/**
 * ============================================
 * Forward Geocoding (Improved for Persian addresses)
 * ============================================
 * Converts address to coordinates (lat, lng)
 * Uses Nominatim API from OpenStreetMap
 * Tries multiple search strategies for better results
 * 
 * @param {string} address - Address string
 * @returns {Promise<{lat: number, lng: number}>} Coordinates object
 */
async function forwardGeocode(address) {
    try {
        console.log(`Forward geocoding: ${address}`);
        
        if (!address || address.trim() === '') {
            console.warn('Empty address provided for geocoding');
            return null;
        }
        
        const trimmedAddress = address.trim();
        
        // Determine language and country settings
        let countryBias = '';
        let acceptLanguage = 'en';
        let isPersianAddress = false;
        
        if (typeof languageManager !== 'undefined') {
            const currentLang = languageManager.getCurrentLanguage();
            if (currentLang === 'fa') {
                countryBias = '&countrycodes=ir'; // Iran
                acceptLanguage = 'fa,en'; // Prefer Persian, fallback to English
                // Check if address contains Persian characters
                isPersianAddress = /[\u0600-\u06FF]/.test(trimmedAddress);
            } else if (currentLang === 'en') {
                countryBias = '&countrycodes=us'; // USA
                acceptLanguage = 'en';
            }
        }
        
        // Strategy 1: Try full address with country bias
        let searchStrategies = [
            trimmedAddress, // Full address
        ];
        
        // Strategy 2: For Persian addresses, try extracting key parts
        // Persian addresses often have format: "شهر، خیابان، محله، پلاک"
        if (trimmedAddress.includes('،') || trimmedAddress.includes(',')) {
            const parts = trimmedAddress.split(/[،,]/).map(p => p.trim()).filter(p => p.length > 0);
            
            // Try combinations of address parts
            if (parts.length >= 2) {
                // Try city + street
                searchStrategies.push(parts.slice(0, 2).join(', '));
            }
            if (parts.length >= 1) {
                // Try just the first part (usually city or major area)
                searchStrategies.push(parts[0]);
            }
            // Try last two parts (often street + neighborhood)
            if (parts.length >= 2) {
                searchStrategies.push(parts.slice(-2).join(', '));
            }
        }
        
        // Strategy 3: For Persian multi-word addresses without comma, try first word (city name) so map at least shows the city
        if (isPersianAddress && trimmedAddress.includes(' ')) {
            const firstWord = trimmedAddress.split(/\s+/)[0];
            if (firstWord && firstWord.length >= 2) {
                searchStrategies.push(firstWord);
            }
        }
        
        // Remove duplicates
        searchStrategies = [...new Set(searchStrategies)];
        
        console.log('Trying search strategies:', searchStrategies);
        
        // Try each search strategy
        for (let i = 0; i < searchStrategies.length; i++) {
            const searchQuery = searchStrategies[i];
            const encodedAddress = encodeURIComponent(searchQuery);
            
            // Build URL with multiple parameters for better results
            const url = `${NOMINATIM_API}/search?format=json&q=${encodedAddress}&limit=5&addressdetails=1&extratags=1${countryBias}`;
            
            console.log(`Geocoding attempt ${i + 1}/${searchStrategies.length}:`, url);
            
            try {
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'PersonListingApp/1.0', // Required by Nominatim
                        'Accept-Language': acceptLanguage // Request Persian language results if available
                    }
                });
                
                if (!response.ok) {
                    console.warn(`Geocoding attempt ${i + 1} failed: ${response.status} ${response.statusText}`);
                    continue; // Try next strategy
                }
                
                const data = await response.json();
                
                console.log(`Geocoding attempt ${i + 1} response:`, data);
                
                // Check if we got results
                if (data && Array.isArray(data) && data.length > 0) {
                    // Find the best match (prefer results with more address details)
                    let bestMatch = data[0];
                    
                    // If multiple results, prefer ones with more complete address information
                    for (const result of data) {
                        if (result.address && Object.keys(result.address).length > Object.keys(bestMatch.address || {}).length) {
                            bestMatch = result;
                        }
                    }
                    
                    if (bestMatch.lat && bestMatch.lon) {
                        const lat = parseFloat(bestMatch.lat);
                        const lng = parseFloat(bestMatch.lon);
                        
                        // Validate coordinates before returning
                        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                            console.warn(`Invalid coordinates from geocoding API (strategy ${i + 1}):`, lat, lng);
                            console.warn('Skipping this result and trying next strategy...');
                            continue; // Try next strategy
                        }
                        
                        console.log(`✅ Coordinates found (strategy ${i + 1}):`, lat, lng);
                        console.log('Matched address:', bestMatch.display_name);
                        console.log('Address details:', bestMatch.address);
                        return { lat, lng };
                    }
                } else {
                    console.log(`Geocoding attempt ${i + 1}: No results found`);
                }
            } catch (fetchError) {
                console.warn(`Geocoding attempt ${i + 1} error:`, fetchError);
                // Continue to next strategy
            }
            
            // Add small delay between requests to respect rate limits
            if (i < searchStrategies.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        
        // If all strategies failed and it's a Persian address, try one more time with English-only
        if (isPersianAddress) {
            console.log('Trying English-only search as fallback for Persian address...');
            const encodedAddress = encodeURIComponent(trimmedAddress);
            const url = `${NOMINATIM_API}/search?format=json&q=${encodedAddress}&limit=5&addressdetails=1&extratags=1${countryBias}`;
            
            try {
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'PersonListingApp/1.0',
                        'Accept-Language': 'en'
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data && Array.isArray(data) && data.length > 0) {
                        const bestMatch = data[0];
                        if (bestMatch.lat && bestMatch.lon) {
                            const lat = parseFloat(bestMatch.lat);
                            const lng = parseFloat(bestMatch.lon);
                            
                            // Validate coordinates before returning
                            if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                                console.warn('Invalid coordinates from geocoding API (English fallback):', lat, lng);
                                return null;
                            }
                            
                            console.log('✅ Coordinates found (English fallback):', lat, lng);
                            console.log('Matched address:', bestMatch.display_name);
                            return { lat, lng };
                        }
                    }
                }
            } catch (error) {
                console.warn('English fallback also failed:', error);
            }
        }
        
        // Fallback: Geocode.xyz for Iran when Nominatim failed (no API key required, throttled)
        const useIranFallback = (countryBias && countryBias.indexOf('ir') !== -1) || isPersianAddress;
        if (useIranFallback && trimmedAddress.length >= 2) {
            const xyzResult = await forwardGeocodeGeocodeXyz(trimmedAddress);
            if (xyzResult) {
                return xyzResult;
            }
        }

        // If all strategies failed, log detailed error
        console.warn('❌ All geocoding strategies failed for address:', address);
        console.warn('Tried strategies:', searchStrategies);

        return null;
    } catch (error) {
        console.error('Forward geocoding error:', error);
        console.error('Error details:', error.message, error.stack);
        // Show user-friendly error message
        if (typeof showAlert === 'function') {
            showAlert(t('createPerson.errorGeocodingAddress', 'Error geocoding address. Please check your internet connection or try a different address format.'), 'error');
        }
        return null;
    }
}

/**
 * ============================================
 * Setup Location Sync
 * ============================================
 * Sets up bidirectional synchronization between:
 * - Map clicks
 * - Address input
 * - Latitude/Longitude inputs
 */
function setupLocationSync() {
    console.log('Setting up location synchronization...');
    
    const addressInput = document.getElementById('address');
    const latitudeInput = document.getElementById('latitude');
    const longitudeInput = document.getElementById('longitude');
    
    // Check if all required elements exist
    if (!addressInput || !latitudeInput || !longitudeInput) {
        console.error('Location sync setup failed: Required input elements not found');
        console.log('Address input:', addressInput);
        console.log('Latitude input:', latitudeInput);
        console.log('Longitude input:', longitudeInput);
        return;
    }
    
    // Address placeholder (from i18n so user sees a hint)
    const addressPlaceholder = (typeof languageManager !== 'undefined' && languageManager.getTranslation && languageManager.getTranslation('createPerson.addressPlaceholder'))
        ? languageManager.getTranslation('createPerson.addressPlaceholder')
        : ((typeof languageManager !== 'undefined' && languageManager.getTranslation && languageManager.getTranslation('createPerson.addressHint'))
            ? languageManager.getTranslation('createPerson.addressHint').replace(/^\s*💡\s*/, '')
            : 'Type address or city...');
    addressInput.placeholder = addressPlaceholder;
    
    // Address suggestions dropdown (autocomplete)
    let addressSuggestionsEl = document.getElementById('addressSuggestions');
    if (!addressSuggestionsEl) {
        addressSuggestionsEl = document.createElement('div');
        addressSuggestionsEl.id = 'addressSuggestions';
        addressSuggestionsEl.className = 'address-suggestions';
        addressSuggestionsEl.setAttribute('role', 'listbox');
        addressSuggestionsEl.setAttribute('aria-label', t('createPerson.addressSuggestionsLabel', 'Address suggestions'));
        addressInput.parentNode.appendChild(addressSuggestionsEl);
    }
    let suggestionsDebounceTimer = null;
    
    function hideAddressSuggestions() {
        if (addressSuggestionsEl) {
            addressSuggestionsEl.innerHTML = '';
            addressSuggestionsEl.classList.remove('address-suggestions-visible');
        }
    }
    
    function showAddressSuggestions(items) {
        if (!addressSuggestionsEl || !items.length) { hideAddressSuggestions(); return; }
        addressSuggestionsEl.innerHTML = '';
        items.forEach(function (item) {
            const div = document.createElement('div');
            div.className = 'address-suggestion-item';
            div.setAttribute('role', 'option');
            div.textContent = item.display_name;
            div.addEventListener('click', function () {
                addressInput.value = item.display_name;
                setLocationCoordinates(item.lat, item.lng);
                // User selected a suggested address — move the pin to that location.
                if (locationMap) {
                    locationMap.setView([item.lat, item.lng], 15, { animate: true, duration: 0.5 });
                    if (locationMarker) {
                        locationMarker.setLatLng([item.lat, item.lng]);
                    } else {
                        locationMarker = L.marker([item.lat, item.lng]).addTo(locationMap);
                    }
                    locationMarker.bindPopup(buildLocationPopupContent(item.display_name, item.lat, item.lng)).openPopup();
                }
                hideAddressSuggestions();
            });
            addressSuggestionsEl.appendChild(div);
        });
        addressSuggestionsEl.classList.add('address-suggestions-visible');
    }
    
    addressInput.addEventListener('input', function () {
        if (isUpdatingFromMap || isUpdatingFromInput) return;
        const query = addressInput.value.trim();
        if (suggestionsDebounceTimer) clearTimeout(suggestionsDebounceTimer);
        if (query.length < 2) {
            hideAddressSuggestions();
            return;
        }
        suggestionsDebounceTimer = setTimeout(function () {
            fetchAddressSuggestions(query).then(function (items) {
                showAddressSuggestions(items);
            });
        }, 300);
    });
    
    addressInput.addEventListener('blur', function () {
        setTimeout(hideAddressSuggestions, 200);
    });
    
    addressInput.addEventListener('focus', function () {
        const query = addressInput.value.trim();
        if (query.length >= 2) {
            fetchAddressSuggestions(query).then(function (items) {
                showAddressSuggestions(items);
            });
        }
    });
    
    // Debounce timers to avoid too many API calls (shared scope)
    let addressDebounceTimer = null;
    let coordinatesDebounceTimer = null;
    
    // Function to update from coordinates (needs access to timers)
    const updateFromCoordinates = async function() {
        if (isUpdatingFromMap || isUpdatingFromInput) return;
        
        // Clear previous timer
        if (coordinatesDebounceTimer) {
            clearTimeout(coordinatesDebounceTimer);
        }
        
        // Wait a bit to see if user is still typing
        coordinatesDebounceTimer = setTimeout(async () => {
            const lat = parseFloat(latitudeInput.value);
            const lng = parseFloat(longitudeInput.value);
            
            // Validate coordinates - ensure they are within valid ranges
            if (isNaN(lat) || isNaN(lng)) {
                console.error('Invalid coordinates: Not a number', { lat, lng });
                showAlert(t('createPerson.invalidCoordinatesEnterNumbers', 'Invalid coordinates: Please enter valid numbers'), 'error');
                return;
            }
            
            if (lat < -90 || lat > 90) {
                console.error('Invalid latitude:', lat);
                showAlert(tf('createPerson.invalidLatitudeRange', 'Invalid latitude: {lat}. Must be between -90 and 90 degrees.', { lat: lat }), 'error');
                latitudeInput.focus();
                return;
            }
            
            if (lng < -180 || lng > 180) {
                console.error('Invalid longitude:', lng);
                showAlert(tf('createPerson.invalidLongitudeRange', 'Invalid longitude: {lng}. Must be between -180 and 180 degrees.', { lng: lng }), 'error');
                longitudeInput.focus();
                return;
            }
            
            console.log('Coordinates changed, updating map and getting address...');
            isUpdatingFromInput = true;
            
            try {
                // Update map
                if (locationMap) {
                    locationMap.setView([lat, lng], 15);
                    
                    // Update or create marker
                    if (locationMarker) {
                        locationMarker.setLatLng([lat, lng]);
                    } else {
                        locationMarker = L.marker([lat, lng]).addTo(locationMap);
                    }
                }
                
                // Get address from coordinates
                const address = await reverseGeocode(lat, lng);
                if (address) {
                    addressInput.value = address;
                    if (locationMarker) {
                        locationMarker.bindPopup(buildLocationPopupContent(address, lat, lng)).openPopup();
                    }
                } else {
                    if (locationMarker) {
                        locationMarker.bindPopup(buildLocationPopupContent(null, lat, lng)).openPopup();
                    }
                }
            } catch (error) {
                console.error('Error updating from coordinates:', error);
            }
            
            isUpdatingFromInput = false;
        }, 800); // Wait 800ms after user stops typing
    };
    
    // Address field is user text only: typing or Enter must NOT change coordinates or pin.
    // (Suggestions and map click still update coordinates.)
    addressInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent form submission; do not geocode or change coordinates
        }
    });
    
    // Combined coordinates input (مختصات): parse and sync to hidden lat/lng. On blur, move map pin to match so form map = saved position = home page pin.
    const coordinatesInput = document.getElementById('coordinates');
    if (coordinatesInput) {
        function parseCoordinatesInput() {
            if (isUpdatingFromMap || isUpdatingFromInput) return;
            const raw = coordinatesInput.value.trim();
            if (!raw) return;
            const parts = raw.split(/[,،\s]+/).map(function (p) { return p.trim(); }).filter(Boolean);
            if (parts.length < 2) return;
            const lat = parseFloat(parts[0]);
            const lng = parseFloat(parts[1]);
            if (isNaN(lat) || isNaN(lng)) return;
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
            latitudeInput.value = lat.toFixed(6);
            longitudeInput.value = lng.toFixed(6);
        }
        coordinatesInput.addEventListener('input', parseCoordinatesInput);
        coordinatesInput.addEventListener('blur', function () {
            parseCoordinatesInput();
            const lat = parseFloat(latitudeInput.value);
            const lng = parseFloat(longitudeInput.value);
            if (coordinatesInput.value.trim() && (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)) {
                showAlert(t('createPerson.invalidCoordinatesFormat', 'Invalid coordinates. Use format: latitude, longitude (e.g. 35.6892, 51.3890)'), 'error');
                coordinatesInput.focus();
                return;
            }
            // Sync map pin to coordinates so form map shows the exact location that will be saved (and shown on home page)
            if (!isNaN(lat) && !isNaN(lng) && locationMap && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                locationMap.setView([lat, lng], locationMap.getZoom());
                if (locationMarker) {
                    locationMarker.setLatLng([lat, lng]);
                    locationMarker.bindPopup(buildLocationPopupContent(null, lat, lng));
                } else {
                    locationMarker = L.marker([lat, lng]).addTo(locationMap);
                    locationMarker.bindPopup(buildLocationPopupContent(null, lat, lng));
                }
            }
        });
    }
    
    console.log('Location synchronization setup complete');
}

/**
 * ============================================
 * Load Tags
 * ============================================
 * Loads available tags from the server or utility
 */
async function loadTags() {
    try {
        console.log('Loading tags...');
        
        // Fallback list (used only when tags API is unavailable)
        let tags = [
            'چپ کمونیست', 'اصلاح طلب',
            'آخوند', 'سپاهی', 'بسیجی',
            'آقازاده', 'دانشجوی سهمیه‌ای',
            'پان ترک', 'پانکورد', 'پان عرب', 'پان بلوچ',
            'افغانی', 'افغان مال',
            'اختلاسگر', 'قاچاقچی مواد', 'قاچاقچی انسان',
            'بچه باز', 'زورگیر', 'متجاوز', 'قاتل'
        ];
        
        try {
            const response = await fetch(`${CREATE_PERSON_API_BASE_URL}/people/tags`);
            if (response.ok) {
                const payload = await response.json();
                const apiTags = Array.isArray(payload?.data?.tags) ? payload.data.tags : [];
                const normalizedApiTags = apiTags
                    .map((item) => typeof item === 'string' ? item : (item && item.name))
                    .filter((item) => typeof item === 'string' && item.trim().length > 0)
                    .map((item) => item.trim());
                if (normalizedApiTags.length > 0) {
                    tags = normalizedApiTags;
                }
            } else {
                console.warn('Tags API returned non-200 status:', response.status);
            }
        } catch (apiError) {
            console.warn('Could not load tags from API, using fallback tags:', apiError);
        }

        tags = [...new Set(tags)];

        const tagsContainer = document.getElementById('tagsContainer');
        tagsContainer.innerHTML = '';
        
        tags.forEach(tag => {
            const checkboxId = `tag-${tag.replace(/\s+/g, '-')}`;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = checkboxId;
            checkbox.name = 'tags';
            checkbox.value = tag;
            checkbox.className = 'tag-checkbox';
            
            const label = document.createElement('label');
            label.htmlFor = checkboxId;
            label.className = 'tag-label';
            label.textContent = tag;
            
            tagsContainer.appendChild(checkbox);
            tagsContainer.appendChild(label);
        });
        
        console.log(`Loaded ${tags.length} tags`);
    } catch (error) {
        console.error('Error loading tags:', error);
        showAlert(t('createPerson.errorLoadingTags', 'Error loading tags. Please refresh the page.'), 'error');
    }
}

/**
 * ============================================
 * Add Family Member
 * ============================================
 * Adds a new family member input section
 */
function addFamilyMember() {
    familyMemberCount++;
    const container = document.getElementById('familyMembersContainer');
    
    const memberDiv = document.createElement('div');
    memberDiv.className = 'family-member-item';
    memberDiv.id = `familyMember-${familyMemberCount}`;
    memberDiv.innerHTML = buildFamilyMemberMarkup(familyMemberCount, {});
    
    container.appendChild(memberDiv);
}

/**
 * ============================================
 * Remove Family Member
 * ============================================
 * Removes a family member input section
 * 
 * @param {number} id - Family member ID
 */
function removeFamilyMember(id) {
    const memberDiv = document.getElementById(`familyMember-${id}`);
    if (memberDiv) {
        memberDiv.remove();
    }
}

/**
 * ============================================
 * Add Person Relationship
 * ============================================
 * Adds a relationship row linking this person to another listed person.
 */
function addPersonRelationship() {
    personRelationshipCount++;
    const container = document.getElementById('personRelationshipsContainer');
    if (!container) return;

    const relationDiv = document.createElement('div');
    relationDiv.className = 'family-member-item';
    relationDiv.id = `personRelationship-${personRelationshipCount}`;
    relationDiv.innerHTML = buildPersonRelationshipMarkup(personRelationshipCount, {});
    container.appendChild(relationDiv);
}

/**
 * ============================================
 * Remove Person Relationship
 * ============================================
 */
function removePersonRelationship(id) {
    const relationDiv = document.getElementById(`personRelationship-${id}`);
    if (relationDiv) {
        relationDiv.remove();
    }
}

/**
 * ============================================
 * Setup Form Submission
 * ============================================
 * Handles form submission and API call
 */
/**
 * Compress an image file on the client to reduce upload time
 * Keeps aspect ratio and limits max dimensions to avoid Heroku timeouts
 *
 * @param {File} file - Original image file
 * @returns {Promise<File>} Compressed image file (or original on failure)
 */
function compressImageFile(file) {
    return new Promise((resolve) => {
        // Only process image files
        if (!file || !file.type || !file.type.startsWith('image/')) {
            return resolve(file);
        }

        const reader = new FileReader();
        reader.onerror = () => {
            console.warn('Image read failed, using original file:', file.name);
            resolve(file);
        };
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => {
                console.warn('Image load failed, using original file:', file.name);
                resolve(file);
            };
            img.onload = () => {
                const maxSize = 1600; // Max width/height in pixels
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                const targetWidth = Math.round(img.width * scale);
                const targetHeight = Math.round(img.height * scale);

                // If no scaling is needed, keep original
                if (scale === 1) {
                    return resolve(file);
                }

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;

                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    console.warn('Canvas context unavailable, using original file:', file.name);
                    return resolve(file);
                }

                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                // Preserve PNG if the original is PNG; otherwise compress as JPEG
                const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                const quality = outputType === 'image/jpeg' ? 0.82 : 0.92;

                canvas.toBlob((blob) => {
                    if (!blob) {
                        console.warn('Compression failed, using original file:', file.name);
                        return resolve(file);
                    }

                    const newName = outputType === 'image/jpeg'
                        ? file.name.replace(/\.(png|jpe?g|webp)$/i, '.jpg')
                        : file.name;

                    const compressedFile = new File([blob], newName, {
                        type: outputType,
                        lastModified: Date.now()
                    });

                    console.log('Compressed image:', {
                        name: file.name,
                        originalSize: file.size,
                        compressedSize: compressedFile.size,
                        outputType
                    });

                    resolve(compressedFile);
                }, outputType, quality);
            };
            img.src = reader.result;
        };

        reader.readAsDataURL(file);
    });
}

function setupFormSubmission() {
    const form = document.getElementById('personForm');
    if (!form) {
        console.warn('Person form not found, skipping submission setup');
        return;
    }

    // Prevent duplicate event binding (SPA + DOMContentLoaded can both call this)
    // We store a flag on the form element so it survives across init paths.
    if (form.dataset.submitBound === 'true') {
        console.log('Form submit handler already bound, skipping duplicate setup');
        return;
    }
    form.dataset.submitBound = 'true';

    // Guard against double-submit while a request is in-flight
    let isSubmitting = false;
    const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('Form submitted (current step:', currentStep, ')');

        // Only allow submit when user is on step 3 (they must complete step 1 and 2 first)
        if (currentStep !== 3) {
            showAlert(tf('createPerson.completeCurrentStepBeforeSubmit', 'Please complete Step {step} and go to Step 3 to submit. Use Next to advance after filling required fields.', {
                step: currentStep
            }), 'error');
            showStep(currentStep);
            return;
        }

        // Validate step 3 required fields (at least one tag) before full submit
        const step3Result = validateStep(3);
        if (!step3Result.valid) {
            showAlert(step3Result.message || t('createPerson.selectAtLeastOneTag', 'Please select at least one classification tag.'), 'error');
            return;
        }

        // Stop duplicate submissions (accidental double-click or multiple handlers)
        if (isSubmitting) {
            console.warn('Submission ignored: request already in progress');
            return;
        }
        isSubmitting = true;
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.setAttribute('aria-busy', 'true');
        }

        // Hide previous alerts
        hideAlert();

        // Validate form (HTML5 validity)
        if (!form.checkValidity()) {
            form.reportValidity();
            isSubmitting = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
            return;
        }

        // Validate tags - at least one tag must be selected
        // We'll reuse these variables later when collecting tags for FormData
        const tagCheckboxes = document.querySelectorAll('input[name="tags"]:checked');
        const selectedTags = Array.from(tagCheckboxes).map(checkbox => checkbox.value);
        
        if (selectedTags.length === 0) {
            showAlert(t('createPerson.selectAtLeastOneTag', 'Please select at least one classification tag.'), 'error');
            // Scroll to tags section
            const tagsSection = document.querySelector('.form-section:has(#tagsContainer)');
            if (tagsSection) {
                tagsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            isSubmitting = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
            return;
        }
        
        const isEditMode = !!editPersonId;
        const addressStatus = getSelectedAddressStatus();
        const isExactAddress = addressStatus === ADDRESS_STATUS.EXACT;
        const isApproximateAddress = addressStatus === ADDRESS_STATUS.APPROXIMATE;

        let lat;
        let lng;
        if (isExactAddress) {
            const latStr = document.getElementById('latitude').value.trim();
            const lngStr = document.getElementById('longitude').value.trim();
            if (!latStr || !lngStr) {
                showAlert(t('createPerson.selectLocationOrCoordinates', 'Please select a location on the map or enter valid coordinates.'), 'error');
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
            lat = parseFloat(latStr);
            lng = parseFloat(lngStr);
            if (isNaN(lat) || isNaN(lng)) {
                showAlert(t('createPerson.invalidCoordinatesLatLngNumbers', 'Invalid coordinates: Please enter valid numbers for latitude and longitude'), 'error');
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
            if (lat < -90 || lat > 90) {
                showAlert(tf('createPerson.invalidLatitudeSubmit', 'Invalid latitude: {lat}. Latitude must be between -90 and 90 degrees.', { lat: lat }), 'error');
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
            if (lng < -180 || lng > 180) {
                showAlert(tf('createPerson.invalidLongitudeSubmit', 'Invalid longitude: {lng}. Longitude must be between -180 and 180 degrees.', { lng: lng }), 'error');
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
            setLocationCoordinates(lat, lng);
        } else if (isApproximateAddress) {
            const approximateProvinceEl = document.getElementById('approximateProvince');
            const approximateProvince = approximateProvinceEl && approximateProvinceEl.value ? approximateProvinceEl.value.trim() : '';
            if (!approximateProvince) {
                showAlert(t('createPerson.selectProvinceForApproximate', 'Please select at least a province for approximate location.'), 'error');
                if (approximateProvinceEl) approximateProvinceEl.focus();
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
        }

        // Create FormData for file upload
        const formData = new FormData(form);
        formData.set('addressStatus', addressStatus);
        if (isExactAddress) {
            formData.set('hasAddress', 'true');
            formData.set('latitude', String(lat));
            formData.set('longitude', String(lng));
            formData.delete('approximateProvince');
            formData.delete('approximateSection');
        } else if (isApproximateAddress) {
            formData.set('hasAddress', 'false');
            formData.delete('address');
            formData.delete('latitude');
            formData.delete('longitude');
            const approximateSectionValue = formData.get('approximateSection');
            if (!approximateSectionValue || (typeof approximateSectionValue === 'string' && approximateSectionValue.trim() === '')) {
                formData.delete('approximateSection');
            }
        } else {
            formData.set('hasAddress', 'false');
            formData.delete('address');
            formData.delete('latitude');
            formData.delete('longitude');
            formData.delete('approximateProvince');
            formData.delete('approximateSection');
        }
        
        // Remove empty optional fields so backend validators don't see empty strings
        const emailValue = formData.get('email');
        if (!emailValue || (typeof emailValue === 'string' && emailValue.trim() === '')) {
            formData.delete('email');
        }
        
        // Validate image files
        const imageInput = document.getElementById('images');
        const files = imageInput.files;
        if (!isEditMode && files.length === 0) {
            showAlert(t('createPerson.imageRequired', 'Please upload at least one image.'), 'error');
            isSubmitting = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
            return;
        }
        if (files.length > 10) {
            showAlert(t('createPerson.maxImagesAllowed', 'Maximum 10 images allowed'), 'error');
            isSubmitting = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
            return;
        }
        
        // Check file sizes (5MB max each)
        for (let i = 0; i < files.length; i++) {
            if (files[i].size > 5 * 1024 * 1024) {
                showAlert(tf('createPerson.imageTooLarge', 'Image {fileName} is too large. Maximum size is 5MB.', { fileName: files[i].name }), 'error');
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
        }

        // Compress images before upload to reduce Cloudinary timeouts on Heroku
        // This keeps uploads under the 30s request limit (H12) and improves UX
        let uploadFiles = Array.from(files);
        if (uploadFiles.length > 0) {
            try {
                console.log(`Compressing ${uploadFiles.length} image(s) before upload...`);
                uploadFiles = await Promise.all(uploadFiles.map((file) => compressImageFile(file)));
                console.log('Image compression complete');
            } catch (compressionError) {
                console.warn('Image compression failed, uploading originals:', compressionError);
            }
        }
        
        // Collect family members and add to FormData as JSON string
        const familyMembers = [];
        const familyMemberItems = document.querySelectorAll('#familyMembersContainer .family-member-item');
        familyMemberItems.forEach(item => {
            const nameInput = item.querySelector('input[name*="[name]"]');
            const relationshipInput = item.querySelector('select[name*="[relationship]"]');
            const roleInput = item.querySelector('input[name*="[role]"]');
            const phoneInput = item.querySelector('input[name*="[phone]"]');
            const notesInput = item.querySelector('textarea[name*="[notes]"]');
            
            const name = nameInput ? nameInput.value : '';
            const relationship = relationshipInput ? relationshipInput.value : '';
            const role = roleInput ? roleInput.value : '';
            const phone = phoneInput ? phoneInput.value : '';
            const notes = notesInput ? notesInput.value : '';
            
            if (name && relationship) {
                familyMembers.push({
                    name: name.trim(),
                    relationship: relationship.trim(),
                    role: role ? role.trim() : '',
                    phone: phone ? phone.trim() : '',
                    notes: notes ? notes.trim() : ''
                });
            }
        });

        // Collect person-to-person relationships and send as JSON string.
        const relationships = [];
        const invalidRelationshipTargets = [];
        const relationshipItems = document.querySelectorAll('#personRelationshipsContainer .family-member-item');
        relationshipItems.forEach((item) => {
            const targetPersonIdInput = item.querySelector('input[name*="[targetPersonId]"]');
            const rawTargetValue = targetPersonIdInput ? targetPersonIdInput.value.trim() : '';
            if (!rawTargetValue) return;

            const targetPersonId = resolveRelationshipTargetPersonId(rawTargetValue);
            if (!targetPersonId) {
                invalidRelationshipTargets.push(rawTargetValue);
                return;
            }

            relationships.push({
                targetPersonId
            });
        });

        if (invalidRelationshipTargets.length > 0) {
            showAlert(
                t(
                    'createPerson.relationshipTargetInvalid',
                    'One or more related-person values are invalid. Use a person ID or shared link.'
                ),
                'error'
            );
            isSubmitting = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
            return;
        }

        // Remove bracket-notation family member fields from FormData to avoid
        // sending duplicate shapes (familyMembers[1][name] + familyMembers JSON),
        // which can cause backend cast errors for familyMembers.
        const familyMemberBracketKeys = new Set();
        const relationshipBracketKeys = new Set();
        for (const key of formData.keys()) {
            if (/^familyMembers\[\d+\]\[(name|relationship|role|phone|notes)\]$/.test(key)) {
                familyMemberBracketKeys.add(key);
            }
            if (/^relationships\[\d+\]\[(targetPersonId|targetId|personId|type|strength|note|source|confidence|status)\]$/.test(key)) {
                relationshipBracketKeys.add(key);
            }
        }
        familyMemberBracketKeys.forEach((key) => formData.delete(key));
        relationshipBracketKeys.forEach((key) => formData.delete(key));
        
        // Remove any existing familyMembers from FormData and add as JSON
        formData.delete('familyMembers');
        if (familyMembers.length > 0) {
            formData.append('familyMembers', JSON.stringify(familyMembers));
        }

        // Always send relationships (including empty array) so edit mode can clear removed relations.
        formData.delete('relationships');
        formData.append('relationships', JSON.stringify(relationships));
        
        // Collect tags and send as JSON array string (like familyMembers and metadata)
        // Reuse selectedTags from validation above (already validated that at least one is selected)
        // Remove any existing tags from FormData
        formData.delete('tags');
        
        // Add tags as JSON string (we already validated that at least one is selected)
        formData.append('tags', JSON.stringify(selectedTags));
        
        // Handle metadata notes
        const notes = formData.get('notes');
        formData.delete('metadata'); // Remove if exists
        if (typeof notes === 'string' && notes.trim()) {
            const trimmedNotes = notes.trim();
            if (trimmedNotes.length > MAX_METADATA_NOTES_LENGTH) {
                showAlert(tf('createPerson.notesTooLong', 'Notes are too long (max {max} characters).', { max: MAX_METADATA_NOTES_LENGTH }), 'error');
                isSubmitting = false;
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.removeAttribute('aria-busy');
                }
                return;
            }
            formData.append('metadata', JSON.stringify({ notes: trimmedNotes }));
        }

        // Replace images in FormData with compressed versions (if any)
        if (uploadFiles.length > 0) {
            formData.delete('images');
            uploadFiles.forEach((file) => {
                formData.append('images', file, file.name);
            });
        }

        // Tell API which preview is the listing card photo (moved to images[0] server-side)
        const cardPhotoPayload = getSelectedCardPhotoPayload();
        formData.delete('cardPhoto');
        if (cardPhotoPayload) {
            formData.append('cardPhoto', JSON.stringify(cardPhotoPayload));
        }
        
        // Debug: Log what we're sending (without files)
        console.log('FormData contents:');
        for (let [key, value] of formData.entries()) {
            if (key !== 'images') {
                console.log(`${key}:`, value);
            }
        }
        
        // Submit to API with FormData (includes files)
        // In edit mode we send PUT to /api/people/:id and redirect to dashboard on success
        const submitUrl = isEditMode
            ? `${CREATE_PERSON_API_BASE_URL}/people/${editPersonId}`
            : `${CREATE_PERSON_API_BASE_URL}/people`;
        const submitMethod = isEditMode ? 'PUT' : 'POST';

        try {
            console.log(isEditMode ? 'Updating person with' : 'Submitting person data with', files.length, 'images');
            
            const token = localStorage.getItem('token');
            const response = await fetch(submitUrl, {
                method: submitMethod,
                headers: {
                    // Don't set Content-Type header - browser will set it with boundary for multipart/form-data
                    'Authorization': `Bearer ${token}`
                },
                body: formData // Send FormData directly (includes files)
            });
            
            // Try to parse JSON response
            let result;
            try {
                const text = await response.text();
                result = text ? JSON.parse(text) : {};
            } catch (parseError) {
                console.error('Failed to parse response:', parseError);
                showAlert(t('createPerson.serverInvalidResponse', 'Server returned an invalid response. Please try again.'), 'error');
                return;
            }
            
            if (response.ok && result.success) {
                if (isEditMode) {
                    console.log('Person updated successfully:', result.data);
                    trackAnalyticsEvent('create_person_submit_success', {
                        metadata: { mode: 'edit', personId: editPersonId || null }
                    }, true);
                    showAlert(t('createPerson.personUpdatedSuccess', 'Person listing updated successfully!'), 'success');
                    // Redirect to main page focused on the edited card.
                    const editedPersonId = result?.data?.person?._id || result?.data?._id || editPersonId;
                    setTimeout(() => {
                        try {
                            if (editedPersonId && typeof sessionStorage !== 'undefined') {
                                sessionStorage.setItem(PENDING_FOCUS_PERSON_ID_KEY, String(editedPersonId));
                            }
                        } catch (_) {}
                        // Redirect to root homepage URL (without query params).
                        window.location.href = '/';
                    }, 1500);
                } else {
                    console.log('Person created successfully:', result.data);
                    trackAnalyticsEvent('create_person_submit_success', {
                        metadata: { mode: 'create', personId: result?.data?.person?._id || null }
                    }, true);
                    showAlert(t('createPerson.personCreatedSuccess', 'Person listing created successfully!'), 'success');
                    // Redirect to index page after 2 seconds
                    setTimeout(() => {
                        window.location.href = 'index.html';
                    }, 2000);
                }
            } else {
                console.error(isEditMode ? 'Error updating person:' : 'Error creating person:', result);
                console.error('Response status:', response.status);
                console.error('Response headers:', response.headers);
                
                const errorMessage = localizeApiMessage(result.message) || (isEditMode
                    ? t('createPerson.updatePersonFailed', 'Failed to update person listing')
                    : t('createPerson.createPersonFailed', 'Failed to create person listing'));
                const errors = result.errors || [];
                const errorDetails = errors.map(e => {
                    if (typeof e === 'string') return e;
                    const path = e.path || e.param;
                    const msg = e.msg || e.message;
                    return path ? `${path}: ${msg}` : msg;
                }).filter(e => e).join('; ');
                
                const fullErrorMessage = errorDetails 
                    ? `${errorMessage}: ${errorDetails}` 
                    : errorMessage;
                
                console.error('Full error details:', fullErrorMessage);
                console.error('Validation errors:', errors);
                trackAnalyticsEvent('create_person_submit_failed', {
                    statusCode: response.status || 0,
                    metadata: {
                        mode: isEditMode ? 'edit' : 'create',
                        message: fullErrorMessage
                    }
                }, true);
                showAlert(fullErrorMessage, 'error');
            }
        } catch (error) {
            console.error('Error submitting form:', error);
            console.error('Error stack:', error.stack);
            trackAnalyticsEvent('create_person_submit_failed', {
                statusCode: 0,
                metadata: {
                    mode: editPersonId ? 'edit' : 'create',
                    message: error.message || 'request_error'
                }
            }, true);
            showAlert(tf('createPerson.errorCreatingPerson', 'Error creating person listing: {message}. Please check the console for details.', {
                message: error.message
            }), 'error');
        } finally {
            // Always release the submit lock so the user can try again
            isSubmitting = false;
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
        }
    });
}

/**
 * ============================================
 * Show Alert
 * ============================================
 * Displays an alert message
 * 
 * @param {string} message - Alert message
 * @param {string} type - Alert type ('error' or 'success')
 */
function showAlert(message, type) {
    const alert = document.getElementById('alert');
    alert.textContent = message;
    alert.className = `alert ${type}`;
    alert.style.display = 'block';
    
    // Scroll to top to show alert
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * ============================================
 * Hide Alert
 * ============================================
 * Hides the alert message
 */
function hideAlert() {
    const alert = document.getElementById('alert');
    alert.style.display = 'none';
    alert.className = 'alert';
}

/**
 * Mark one preview as the listing card photo (only one at a time).
 * Cards/map always use images[0]; this selection is sent as cardPhoto on submit.
 */
function setCardPhotoPreview(item) {
    const previewContainer = document.getElementById('imagePreview');
    if (!previewContainer || !item) return;
    previewContainer.querySelectorAll('.image-preview-item.is-card-photo').forEach((el) => {
        el.classList.remove('is-card-photo');
        el.removeAttribute('aria-pressed');
    });
    item.classList.add('is-card-photo');
    item.setAttribute('aria-pressed', 'true');
}

/**
 * Build cardPhoto payload for the API from the selected preview item.
 * existing → { type:'existing', url }; new upload → { type:'new', index }.
 */
function getSelectedCardPhotoPayload() {
    const previewContainer = document.getElementById('imagePreview');
    if (!previewContainer) return null;
    const selected = previewContainer.querySelector('.image-preview-item.is-card-photo');
    if (!selected) return null;
    if (selected.getAttribute('data-existing') === 'true') {
        const url = selected.getAttribute('data-existing-url') || (selected.querySelector('img') && selected.querySelector('img').getAttribute('src')) || '';
        if (!url) return null;
        return { type: 'existing', url };
    }
    const index = Number(selected.dataset.index);
    if (!Number.isFinite(index) || index < 0) return null;
    return { type: 'new', index };
}

window.setCardPhotoPreview = setCardPhotoPreview;

/**
 * ============================================
 * Setup Image Upload
 * ============================================
 * Handles image file selection and preview
 */
function setupImageUpload() {
    const imageInput = document.getElementById('images');
    const previewContainer = document.getElementById('imagePreview');
    let selectedFiles = [];
    
    // Listen for file selection
    imageInput.addEventListener('change', function(e) {
        const files = Array.from(e.target.files);
        
        // Validate file count
        if (selectedFiles.length + files.length > 10) {
            showAlert(t('createPerson.maxImagesAllowedRemoveSome', 'Maximum 10 images allowed. Please remove some images first.'), 'error');
            return;
        }
        
        // Validate and add files
        files.forEach(file => {
            // Validate file type
            if (!file.type.match('image.*')) {
                showAlert(tf('createPerson.fileIsNotImage', 'File {fileName} is not an image.', { fileName: file.name }), 'error');
                return;
            }
            
            // Validate file size (5MB)
            if (file.size > 5 * 1024 * 1024) {
                showAlert(tf('createPerson.imageTooLarge', 'Image {fileName} is too large. Maximum size is 5MB.', { fileName: file.name }), 'error');
                return;
            }
            
            selectedFiles.push(file);
            addImagePreview(file, selectedFiles.length - 1);
        });
        
        // Update file input to include all selected files
        updateFileInput();
    });
    
    /**
     * Add image preview
     * 
     * @param {File} file - Image file
     * @param {number} index - File index
     */
    function addImagePreview(file, index) {
        const reader = new FileReader();
        
        reader.onload = function(e) {
            const previewItem = document.createElement('div');
            previewItem.className = 'image-preview-item';
            previewItem.dataset.index = index; // index among newly selected files (cardPhoto type:'new')
            previewItem.setAttribute('role', 'button');
            previewItem.setAttribute('tabindex', '0');
            previewItem.setAttribute('title', t('createPerson.cardPhotoHelp', 'Click an image to use it as the photo on the listing card.'));
            
            previewItem.innerHTML = `
                <span class="card-photo-badge">${escapeAttr(t('createPerson.cardPhotoBadge', 'Card photo'))}</span>
                <img src="${e.target.result}" alt="${escapeAttr(file.name)}">
                <button type="button" class="remove-image" onclick="event.stopPropagation(); removeImagePreview(${index})" title="${escapeAttr(t('createPerson.removeImageTitle', 'Remove image'))}">×</button>
                <div class="image-name">${escapeAttr(file.name)}</div>
            `;

            previewItem.addEventListener('click', () => setCardPhotoPreview(previewItem)); // new upload can also be the card photo
            previewItem.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    setCardPhotoPreview(previewItem);
                }
            });
            
            previewContainer.appendChild(previewItem);

            // If nothing is card photo yet (create mode / no existing), make first new image the default
            if (!previewContainer.querySelector('.image-preview-item.is-card-photo')) {
                setCardPhotoPreview(previewItem);
            }
        };
        
        reader.readAsDataURL(file);
    }
    
    /**
     * Remove image preview
     * 
     * @param {number} index - File index to remove
     */
    window.removeImagePreview = function(index) {
        // Remove from array
        selectedFiles.splice(index, 1);
        
        // Remove preview element
        const previewItem = previewContainer.querySelector(`.image-preview-item[data-index="${index}"]`);
        const wasCardPhoto = previewItem && previewItem.classList.contains('is-card-photo');
        if (previewItem) {
            previewItem.remove();
        }
        
        // Re-index remaining *new* previews only (existing images have no data-index for uploads)
        const remainingNewPreviews = previewContainer.querySelectorAll('.image-preview-item:not(.existing-image)');
        remainingNewPreviews.forEach((item, newIndex) => {
            item.dataset.index = newIndex;
            const removeBtn = item.querySelector('.remove-image');
            if (removeBtn) {
                removeBtn.setAttribute('onclick', `event.stopPropagation(); removeImagePreview(${newIndex})`);
            }
        });

        // If we removed the card photo, fall back to first remaining preview
        if (wasCardPhoto) {
            const fallback = previewContainer.querySelector('.image-preview-item');
            if (fallback) setCardPhotoPreview(fallback);
        }
        
        // Update file input
        updateFileInput();
    };
    
    /**
     * Update file input with selected files
     */
    function updateFileInput() {
        // Create new DataTransfer object
        const dataTransfer = new DataTransfer();
        
        // Add all selected files
        selectedFiles.forEach(file => {
            dataTransfer.items.add(file);
        });
        
        // Update file input
        imageInput.files = dataTransfer.files;
    }
}

/**
 * ============================================
 * Cancel Form
 * ============================================
 * Cancels form and redirects to index
 */
function cancelForm() {
    if (confirm(t('createPerson.cancelConfirm', 'Are you sure you want to cancel? All unsaved data will be lost.'))) {
        goBack();
    }
}

/**
 * ============================================
 * Go Back Function
 * ============================================
 * Navigates back to previous page or home
 */
function goBack() {
    // Check if we're in SPA mode (router available)
    if (typeof router !== 'undefined' && router) {
        // Use browser history if available
        if (window.history.length > 1) {
            window.history.back();
        } else {
            // Fallback to home route
            router.navigate('/');
        }
    } else {
        // Standalone page mode - go to home
        window.location.href = 'index.html';
    }
}

// Make goBack globally available
window.goBack = goBack;
