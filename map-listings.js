/**
 * ============================================
 * Map Listings - Radgir Map and Listings Module
 * ============================================
 * Handles viewport-based loading, filters, map markers, and listings display.
 * FIX: Does NOT auto-select default province/section on load - keeps "All" selected
 * so users see all listings initially (avoids hiding listings when person is in a
 * different county than Tehran).
 */

const MAP_API_BASE_URL = (typeof window !== 'undefined' && window.__API_BASE_URL)
    ? window.__API_BASE_URL.replace(/\/api$/, '') + '/api'
    : `${window.location.origin}/api`;
const PENDING_FOCUS_PERSON_ID_KEY = 'radgir_pending_focus_person_id';
const FIRST_VISIT_RANDOM_POPUP_KEY = 'radgir_first_visit_person_popup_shown'; // localStorage flag so first-time visitors see one random person popup once

// Shared context for map state (used by country switcher, etc.)
const mapListingsContext = {
    isProgrammaticMovement: false,
    map: null,
    markers: [],
    /** Map of person _id to Leaflet marker for opening popup when listing card is clicked */
    markersByPersonId: {},
    peopleById: {},
    currentListings: [],
    currentNoAddressListings: [],
    loadedPersonIds: new Set(),
    bookmarkIds: new Set(),
    viewportPage: 1,
    hasMorePages: false,
    viewportNextCursor: '',
    viewportLoading: false,
    viewportLoadGen: 0, // bumps on each fresh list fetch so stale in-flight responses are ignored
    noAddressHasMore: false,
    noAddressNextCursor: '',
    noAddressLoading: false,
    noAddressLoadGen: 0, // same generation guard for the no-address list
    noAddressTotal: 0,
    initialBoundsSet: false,
    peopleTab: (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches)
        ? 'with-address'
        : 'without-address',
    withAddressTotal: 0,
    sharedFocusMode: false,
    sharedPersonId: null,
    sharedPerson: null,
    relationshipsEnabled: false,
    relationshipTypeFilter: '',
    relationshipMinStrength: 1,
    relationshipSelectedPersonId: null,
    relationshipLayer: null,
    relationshipTraversalLayer: null,
    relationshipAnchorCache: {},
    relationshipRenderToken: 0,
    relationshipTraversalToken: 0,
    cardStackDelegationBound: false
};
if (typeof window !== 'undefined') {
    window.mapListingsContext = mapListingsContext;
    console.log('mapListingsContext initialized and available');
}

let map = null;
let debounceTimer = null;
const DEBOUNCE_MS = 300;
let regionClickTimer = null;
let regionClickToken = 0;
let lastSelectedRegion = null;
let filterCounts = null;
let boundaryLayer = null;

/**
 * Get i18n translation for a key
 */
function t(key) {
    if (typeof window !== 'undefined' && window.languageManager) {
        const val = window.languageManager.getTranslation?.(key) || key;
        return typeof val === 'string' ? val : key;
    }
    return key;
}

function getCurrentLanguageCode() {
    if (typeof window !== 'undefined' && window.languageManager && typeof window.languageManager.getCurrentLanguage === 'function') {
        const lang = String(window.languageManager.getCurrentLanguage() || '').trim().toLowerCase();
        if (lang) return lang;
    }
    if (typeof document !== 'undefined' && document.documentElement?.lang) {
        return String(document.documentElement.lang).trim().toLowerCase();
    }
    return 'fa';
}

function isPersianLanguage() {
    return getCurrentLanguageCode().startsWith('fa');
}

function tf(key, fallbackFa, fallbackEn) {
    if (typeof window !== 'undefined' && window.languageManager) {
        const lm = window.languageManager;
        const lang = (typeof lm.getCurrentLanguage === 'function' && lm.getCurrentLanguage()) || getCurrentLanguageCode();
        const dictionary = (typeof lm.getTranslations === 'function') ? lm.getTranslations(lang) : null;
        if (dictionary && key) {
            const parts = String(key).split('.');
            let value = dictionary;
            for (const part of parts) {
                if (value && typeof value === 'object' && part in value) value = value[part];
                else {
                    value = null;
                    break;
                }
            }
            if (typeof value === 'string' && value) return value;
        }
    }
    return isPersianLanguage() ? fallbackFa : fallbackEn;
}

function normalizeText(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    return text;
}

function mergePeopleUnique(existing, incoming) {
    const byId = new Map();
    (Array.isArray(existing) ? existing : []).forEach((person) => {
        const id = normalizePersonId(person?._id || person?.id);
        if (!id) return;
        byId.set(id, person);
    });
    (Array.isArray(incoming) ? incoming : []).forEach((person) => {
        const id = normalizePersonId(person?._id || person?.id);
        if (!id) return;
        byId.set(id, person);
    });
    return Array.from(byId.values());
}

function consumePendingFocusPersonId() {
    if (typeof sessionStorage === 'undefined') return '';
    try {
        const value = normalizePersonId(sessionStorage.getItem(PENDING_FOCUS_PERSON_ID_KEY));
        if (value) {
            sessionStorage.removeItem(PENDING_FOCUS_PERSON_ID_KEY);
            return value;
        }
    } catch (_) {}
    return '';
}

const RELATIONSHIP_TYPE_OPTIONS = ['family', 'work', 'command', 'financial', 'social', 'other'];
const RELATIONSHIP_STATUS_OPTIONS = ['confirmed', 'unverified'];
const RELATIONSHIP_MAX_EDGES = 80;
const RELATIONSHIP_COLORS = {
    family: '#ff7f7f',
    work: '#4dd0e1',
    command: '#ffb74d',
    financial: '#81c784',
    social: '#ba68c8',
    other: '#90a4ae'
};

function normalizePersonId(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
        if (value._id) return String(value._id).trim();
        if (value.id) return String(value.id).trim();
    }
    return '';
}

function normalizeRelationshipType(value) {
    const normalized = normalizeText(value).toLowerCase();
    return RELATIONSHIP_TYPE_OPTIONS.includes(normalized) ? normalized : 'other';
}

function normalizeRelationshipStatus(value) {
    const normalized = normalizeText(value).toLowerCase();
    return RELATIONSHIP_STATUS_OPTIONS.includes(normalized) ? normalized : 'unverified';
}

function normalizeRelationshipStrength(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 3;
    return Math.max(1, Math.min(5, parsed));
}

function normalizeRelationshipConfidence(value) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return 0.5;
    return Math.max(0, Math.min(1, parsed));
}

function normalizeIdentityText(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[\u200c\u200f]/g, '')
        .trim();
}

function getPersonIdentityFullName(person) {
    const name = normalizeIdentityText(person?.name);
    const family = normalizeIdentityText(person?.familyName || person?.family_name);
    return [name, family].filter(Boolean).join(' ');
}

function getPersonPrimaryImage(person) {
    const images = getPersonImages(person);
    if (!Array.isArray(images) || images.length === 0) return '';
    return normalizeIdentityText(images[0]);
}

function isLikelySamePerson(a, b) {
    if (!a || !b) return false;

    const idA = normalizeText(a?._id);
    const idB = normalizeText(b?._id);
    if (idA && idB && idA === idB) return true;

    const fullA = getPersonIdentityFullName(a);
    const fullB = getPersonIdentityFullName(b);
    if (!fullA || !fullB || fullA !== fullB) return false;

    const phoneA = normalizeIdentityText(a?.phone);
    const phoneB = normalizeIdentityText(b?.phone);
    if (phoneA && phoneB && phoneA === phoneB) return true;

    const nationalA = normalizeIdentityText(a?.nationalId);
    const nationalB = normalizeIdentityText(b?.nationalId);
    if (nationalA && nationalB && nationalA === nationalB) return true;

    const imgA = getPersonPrimaryImage(a);
    const imgB = getPersonPrimaryImage(b);
    if (imgA && imgB && imgA === imgB) return true;

    return false;
}

function isSharedFocusMode() {
    return Boolean(mapListingsContext.sharedFocusMode && mapListingsContext.sharedPersonId);
}

function isSharedFocusExactMode() {
    if (!isSharedFocusMode()) return false;
    const person = mapListingsContext.sharedPerson;
    if (!person) return false;
    return isExactLikePerson(person);
}

function exitSharedFocusMode(reason) {
    if (!isSharedFocusMode()) return false;
    mapListingsContext.sharedFocusMode = false;
    mapListingsContext.sharedPersonId = null;
    mapListingsContext.sharedPerson = null;
    if (reason) {
        console.log('Shared focus mode disabled:', reason);
    }
    return true;
}

function normalizePersonForRendering(person) {
    if (!person || typeof person !== 'object') return null;
    const normalized = { ...person };
    if (!normalized.voteSummary || typeof normalized.voteSummary !== 'object') {
        const votes = normalized.votes || {};
        normalized.voteSummary = {
            likes: Number(votes.likes || 0),
            dislikes: Number(votes.dislikes || 0)
        };
    }
    if (normalized.userVote == null) normalized.userVote = '';
    if (normalized.commentCount == null) {
        normalized.commentCount = Array.isArray(normalized.comments) ? normalized.comments.length : 0;
    }
    return normalized;
}

function renderNoAddressEmptyState() {
    const container = document.getElementById('noAddressListContainer') || document.querySelector('#filtersSection .filters-content');
    if (!container) return;
    const emptyKey = 'index.peopleWithoutAddressEmpty';
    updateNoAddressCount(0);
    container.innerHTML = `<div class="no-address-list"><p class="filters-hint" data-i18n="${emptyKey}">${getNoAddressTranslation(emptyKey)}</p></div>`;
    if (typeof window !== 'undefined' && window.languageManager) {
        window.languageManager.translatePage?.();
    }
}

function inferPersonAddressStatus(person) {
    const explicit = normalizeText(person?.addressStatus).toLowerCase();
    if (explicit === 'exact' || explicit === 'approximate' || explicit === 'unknown') {
        return explicit;
    }

    const hasAddress = Boolean(normalizeText(person?.address));
    const hasCoords = Boolean(
        person?.location &&
        Array.isArray(person.location.coordinates) &&
        person.location.coordinates.length === 2 &&
        Number.isFinite(person.location.coordinates[0]) &&
        Number.isFinite(person.location.coordinates[1])
    );
    if (hasAddress && hasCoords) return 'exact';

    const hasApproximateRegion = Boolean(normalizeText(person?.approximateRegion?.province) || normalizeText(person?.approximateRegion?.section));
    return hasApproximateRegion ? 'approximate' : 'unknown';
}

function getPersonImages(person) {
    return (person?.images || [])
        .map((item) => (typeof item === 'string' ? item : (item && item.url) || ''))
        .filter(Boolean);
}

function normalizePersonTags(person) {
    const raw = person?.tags ?? person?.metadata?.tags ?? [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    return list
        .map((tag) => normalizeText(tag))
        .filter(Boolean);
}

function formatPersonTagsForCard(person, maxVisible = 3) {
    const tags = normalizePersonTags(person);
    if (!tags.length) return { shortText: '', fullText: '' };
    const fullText = tags.join(', ');
    if (tags.length <= maxVisible) return { shortText: fullText, fullText };
    const shortText = `${tags.slice(0, maxVisible).join(', ')} +${tags.length - maxVisible}`;
    return { shortText, fullText };
}

function getPersonFullName(person) {
    const first = normalizeText(person?.name);
    const family = normalizeText(person?.familyName || person?.family_name);
    return [first, family].filter(Boolean).join(' ').trim();
}

function getPersonApproximateRegion(person) {
    const province = normalizeText(person?.approximateRegion?.province);
    const section = normalizeText(person?.approximateRegion?.section);
    return [section, province].filter(Boolean).join(', ');
}

function getPersonAdministrativeRegion(person) {
    const province = normalizeText(person?.administrativeRegion?.province);
    const county = normalizeText(person?.administrativeRegion?.county);
    const bakhsh = normalizeText(person?.administrativeRegion?.bakhsh);
    const city = normalizeText(person?.administrativeRegion?.city);
    return [province, county, bakhsh, city].filter(Boolean).join(' / ');
}

function getPersonFamilyMembersSummary(person) {
    if (!Array.isArray(person?.familyMembers) || person.familyMembers.length === 0) return '';
    return person.familyMembers
        .map((member) => {
            const name = normalizeText(member?.name);
            const relationship = normalizeText(member?.relationship);
            const role = normalizeText(member?.role);
            const phone = normalizeText(member?.phone);
            const segment = [
                name,
                relationship ? `(${relationship})` : '',
                role ? `- ${role}` : '',
                phone ? `- ${phone}` : ''
            ].filter(Boolean).join(' ');
            return segment;
        })
        .filter(Boolean)
        .join(' | ');
}

function getPersonRelationshipsSummary(person) {
    const relations = normalizePersonRelationships(person);
    if (!relations.length) return '';
    return relations.map((relation) => {
        const targetName = getPersonDisplayNameById(relation.targetPersonId);
        const relationType = getRelationshipTypeLabel(relation.type);
        const strength = normalizeRelationshipStrength(relation.strength);
        return `${targetName} (${relationType}, ${strength})`;
    }).join(' | ');
}

function normalizePersonRelationships(person) {
    const raw = Array.isArray(person?.relationships) ? person.relationships : [];
    return raw
        .map((item) => {
            const targetPersonId = normalizePersonId(item?.targetPersonId || item?.targetId || item?.personId);
            if (!targetPersonId) return null;
            return {
                targetPersonId,
                type: normalizeRelationshipType(item?.type),
                strength: normalizeRelationshipStrength(item?.strength),
                note: normalizeText(item?.note),
                source: normalizeText(item?.source),
                confidence: normalizeRelationshipConfidence(item?.confidence),
                status: normalizeRelationshipStatus(item?.status)
            };
        })
        .filter(Boolean);
}

function refreshLoadedPersonIds() {
    const ids = new Set();
    const withAddress = Array.isArray(mapListingsContext.currentListings) ? mapListingsContext.currentListings : [];
    const noAddress = Array.isArray(mapListingsContext.currentNoAddressListings) ? mapListingsContext.currentNoAddressListings : [];
    withAddress.forEach((person) => {
        const id = normalizePersonId(person?._id);
        if (id) ids.add(id);
    });
    noAddress.forEach((person) => {
        const id = normalizePersonId(person?._id);
        if (id) ids.add(id);
    });
    if (mapListingsContext.sharedPerson?._id) {
        ids.add(String(mapListingsContext.sharedPerson._id));
    }
    mapListingsContext.loadedPersonIds = ids;
}

function isPersonLoadedInCurrentView(personId) {
    const id = normalizePersonId(personId);
    if (!id) return false;
    return mapListingsContext.loadedPersonIds instanceof Set && mapListingsContext.loadedPersonIds.has(id);
}

function getRelationshipTypeLabel(type) {
    const normalized = normalizeRelationshipType(type);
    const keyByType = {
        family: 'index.relationshipTypeFamily',
        work: 'index.relationshipTypeWork',
        command: 'index.relationshipTypeCommand',
        financial: 'index.relationshipTypeFinancial',
        social: 'index.relationshipTypeSocial',
        other: 'index.relationshipTypeOther'
    };
    return tf(keyByType[normalized], normalized, normalized);
}

function getRelationshipStatusLabel(status) {
    const normalized = normalizeRelationshipStatus(status);
    return normalized === 'confirmed'
        ? tf('index.relationshipStatusConfirmed', 'تایید شده', 'Confirmed')
        : tf('index.relationshipStatusUnverified', 'تایید نشده', 'Unverified');
}

function getPersonDisplayNameById(personId) {
    const person = mapListingsContext.peopleById?.[normalizePersonId(personId)];
    if (!person) return normalizePersonId(personId);
    const name = getPersonFullName(person);
    return name || normalizePersonId(personId);
}

function getRelationshipStyle(relationship) {
    const type = normalizeRelationshipType(relationship?.type);
    const color = RELATIONSHIP_COLORS[type] || RELATIONSHIP_COLORS.other;
    const strength = normalizeRelationshipStrength(relationship?.strength);
    return {
        color,
        weight: 2 + strength * 0.8,
        opacity: 0.96,
        dashArray: null
    };
}

function ensureRelationshipLayer() {
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance) return null;
    if (!mapListingsContext.relationshipLayer) {
        mapListingsContext.relationshipLayer = L.layerGroup().addTo(mapInstance);
    }
    return mapListingsContext.relationshipLayer;
}

function clearRelationshipOverlay() {
    if (mapListingsContext.relationshipLayer) {
        mapListingsContext.relationshipLayer.clearLayers();
    }
    clearRelationshipTraversal();
}

function ensureRelationshipTraversalLayer() {
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance) return null;
    if (!mapListingsContext.relationshipTraversalLayer) {
        mapListingsContext.relationshipTraversalLayer = L.layerGroup().addTo(mapInstance);
    }
    return mapListingsContext.relationshipTraversalLayer;
}

function clearRelationshipTraversal() {
    if (mapListingsContext.relationshipTraversalLayer) {
        mapListingsContext.relationshipTraversalLayer.clearLayers();
    }
}

async function getApproximateBoundaryAnchor(name, level) {
    const boundaryName = normalizeText(name);
    const boundaryLevel = normalizeText(level) || 'province';
    if (!boundaryName) return null;
    const key = `${boundaryLevel}:${boundaryName}`;
    const cache = mapListingsContext.relationshipAnchorCache || {};
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
        const cached = cache[key];
        if (!cached) return null;
        return L.latLng(cached[0], cached[1]);
    }

    try {
        const url = `${MAP_API_BASE_URL}/people/boundary?name=${encodeURIComponent(boundaryName)}&level=${encodeURIComponent(boundaryLevel)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || !data?.success || !data?.data) {
            cache[key] = null;
            mapListingsContext.relationshipAnchorCache = cache;
            return null;
        }

        const geo = data.data;
        let center = null;
        if (Array.isArray(geo?.bbox) && geo.bbox.length >= 4) {
            const [minLng, minLat, maxLng, maxLat] = geo.bbox;
            center = [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
        } else {
            const tmpLayer = L.geoJSON(geo);
            const bounds = tmpLayer.getBounds();
            if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
                const c = bounds.getCenter();
                center = [c.lat, c.lng];
            }
        }

        cache[key] = center;
        mapListingsContext.relationshipAnchorCache = cache;
        if (!center) return null;
        return L.latLng(center[0], center[1]);
    } catch (err) {
        console.warn('Failed to resolve approximate anchor:', boundaryName, boundaryLevel, err?.message || err);
        cache[key] = null;
        mapListingsContext.relationshipAnchorCache = cache;
        return null;
    }
}

async function resolvePersonRelationshipAnchor(person) {
    if (!person) return null;
    const coords = person?.location?.coordinates;
    if (Array.isArray(coords) && coords.length === 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
        return L.latLng(coords[1], coords[0]);
    }

    const status = inferPersonAddressStatus(person);
    if (status !== 'approximate') return null;

    const section = normalizeText(person?.approximateRegion?.section);
    const province = normalizeText(person?.approximateRegion?.province);
    if (section) {
        const sectionAnchor = await getApproximateBoundaryAnchor(section, 'county');
        if (sectionAnchor) return sectionAnchor;
        const bakhshAnchor = await getApproximateBoundaryAnchor(section, 'bakhsh');
        if (bakhshAnchor) return bakhshAnchor;
    }
    if (province) {
        return getApproximateBoundaryAnchor(province, 'province');
    }
    return null;
}

function buildRelationshipLinePopupHtml(edge) {
    const sourceName = getPersonDisplayNameById(edge?.sourceId);
    const targetName = getPersonDisplayNameById(edge?.targetId);
    const parts = [];
    parts.push(`<strong>${escapeHtml(sourceName)} \u2192 ${escapeHtml(targetName)}</strong>`);
    parts.push(`<div>${escapeHtml(tf('index.relationshipTypeFilterLabel', 'نوع ارتباط', 'Relationship type'))}: ${escapeHtml(getRelationshipTypeLabel(edge?.type))}</div>`);
    parts.push(`<div>${escapeHtml(tf('index.relationshipStrengthFilterLabel', 'حداقل شدت', 'Min strength'))}: ${escapeHtml(String(normalizeRelationshipStrength(edge?.strength)))}</div>`);
    parts.push(`<div>${escapeHtml(tf('index.relationshipStatusLabel', 'وضعیت', 'Status'))}: ${escapeHtml(getRelationshipStatusLabel(edge?.status))}</div>`);
    if (edge?.source) {
        parts.push(`<div>${escapeHtml(tf('index.relationshipSourceLabel', 'منبع', 'Source'))}: ${escapeHtml(edge.source)}</div>`);
    }
    if (edge?.note) {
        parts.push(`<div>${escapeHtml(tf('index.relationshipNoteLabel', 'یادداشت', 'Note'))}: ${escapeHtml(edge.note)}</div>`);
    }
    const confidence = normalizeRelationshipConfidence(edge?.confidence);
    parts.push(`<div>${escapeHtml(tf('index.relationshipConfidenceLabel', 'اعتماد', 'Confidence'))}: ${escapeHtml(Math.round(confidence * 100) + '%')}</div>`);
    return `<div class="relationship-popup">${parts.join('')}</div>`;
}

function buildCurvedRelationshipPath(sourceAnchor, targetAnchor, seedKey) {
    if (!sourceAnchor || !targetAnchor) return [sourceAnchor, targetAnchor].filter(Boolean);

    const sourceLat = Number(sourceAnchor.lat);
    const sourceLng = Number(sourceAnchor.lng);
    const targetLat = Number(targetAnchor.lat);
    const targetLng = Number(targetAnchor.lng);
    const deltaLat = targetLat - sourceLat;
    const deltaLng = targetLng - sourceLng;
    const distance = Math.hypot(deltaLat, deltaLng);

    // Keep very short edges straight to avoid visual jitter.
    if (!Number.isFinite(distance) || distance < 0.00015) {
        return [sourceAnchor, targetAnchor];
    }

    const midLat = (sourceLat + targetLat) / 2;
    const midLng = (sourceLng + targetLng) / 2;
    const perpLat = -deltaLng / distance;
    const perpLng = deltaLat / distance;

    let hash = 0;
    const key = String(seedKey || '');
    for (let i = 0; i < key.length; i += 1) {
        hash = ((hash << 5) - hash) + key.charCodeAt(i);
        hash |= 0;
    }
    const direction = hash % 2 === 0 ? 1 : -1;
    const curveOffset = Math.min(0.22, Math.max(0.01, distance * 0.2));
    const control = L.latLng(
        midLat + (perpLat * curveOffset * direction),
        midLng + (perpLng * curveOffset * direction)
    );

    return [sourceAnchor, control, targetAnchor];
}

function buildPersonDetailsHtml(person) {
    if (!person || typeof person !== 'object') return '';

    const notProvidedLabel = tf('index.notProvided', '\u062b\u0628\u062a \u0646\u0634\u062f\u0647', 'Not provided');
    const rows = [];
    const add = (label, value, always) => {
        const text = normalizeText(value);
        const finalText = text || (always ? notProvidedLabel : '');
        if (!finalText) return;
        rows.push(`<p class="listing-detail-item"><span class="listing-detail-label">${escapeHtml(label)}:</span> <span class="listing-detail-value">${escapeHtml(finalText)}</span></p>`);
    };

    const status = inferPersonAddressStatus(person);
    const statusLabelMap = {
        exact: tf('index.addressStatusExact', '\u0622\u062f\u0631\u0633 \u062f\u0642\u06cc\u0642', 'Exact address'),
        approximate: tf('index.addressStatusApproximate', '\u0622\u062f\u0631\u0633 \u062a\u0642\u0631\u06cc\u0628\u06cc', 'Approximate address'),
        unknown: tf('index.addressStatusUnknown', '\u0628\u062f\u0648\u0646 \u0622\u062f\u0631\u0633', 'Unknown address')
    };
    add(tf('index.addressStatusLabel', '\u0648\u0636\u0639\u06cc\u062a \u0622\u062f\u0631\u0633', 'Address status'), statusLabelMap[status] || statusLabelMap.unknown, true);
    add(tf('index.addressLabel', '\u0622\u062f\u0631\u0633', 'Address'), person?.address, true);

    add(tf('index.nationalIdLabel', '\u06a9\u062f \u0645\u0644\u06cc', 'National ID'), person?.nationalId, true);
    add(tf('index.jobLabel', '\u0634\u063a\u0644', 'Job'), person?.job || person?.metadata?.occupation, true);
    add(tf('index.phoneLabel', '\u062a\u0644\u0641\u0646', 'Phone'), person?.phone, true);
    add(tf('index.emailLabel', '\u0627\u06cc\u0645\u06cc\u0644', 'Email'), person?.email || person?.metadata?.email, true);
    add(tf('index.xAccountLabel', '\u0627\u06a9\u0633', 'X account'), person?.xAccount, true);
    add(tf('index.instagramAccountLabel', '\u0627\u06cc\u0646\u0633\u062a\u0627\u06af\u0631\u0627\u0645', 'Instagram'), person?.instagramAccount, true);
    add(tf('index.facebookAccountLabel', '\u0641\u06cc\u0633\u200c\u0628\u0648\u06a9', 'Facebook'), person?.facebookAccount, true);

    const approximateRegion = getPersonApproximateRegion(person);
    add(tf('index.approximateRegionLabel', '\u0645\u0646\u0637\u0642\u0647 \u062a\u0642\u0631\u06cc\u0628\u06cc', 'Approximate region'), approximateRegion, true);

    const administrativeRegion = getPersonAdministrativeRegion(person);
    add(tf('index.administrativeRegionLabel', '\u0645\u0646\u0637\u0642\u0647 \u0627\u062f\u0627\u0631\u06cc', 'Administrative region'), administrativeRegion, true);

    const familySummary = getPersonFamilyMembersSummary(person);
    add(tf('index.familyMembersLabel', '\u0627\u0639\u0636\u0627\u06cc \u062e\u0627\u0646\u0648\u0627\u062f\u0647', 'Family members'), familySummary, true);

    const relationshipSummary = getPersonRelationshipsSummary(person);
    add(tf('index.relationshipsLabel', '\u0631\u0648\u0627\u0628\u0637', 'Relationships'), relationshipSummary, true);

    add(tf('index.notesLabel', '\u06cc\u0627\u062f\u062f\u0627\u0634\u062a', 'Notes'), person?.metadata?.notes || person?.notes, true);

    const creatorName = normalizeText(person?.createdBy?.username || person?.createdBy?.name);
    add(tf('index.postedByLabel', '\u062b\u0628\u062a\u200c\u06a9\u0646\u0646\u062f\u0647', 'Posted by'), creatorName, true);

    const coords = person?.location?.coordinates;
    const coordsText = (Array.isArray(coords) && coords.length === 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1]))
        ? `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`
        : '';
    add(tf('index.coordinatesLabel', '\u0645\u062e\u062a\u0635\u0627\u062a', 'Coordinates'), coordsText, true);

    if (rows.length === 0) return '';
    return `<div class="listing-details">${rows.join('')}</div>`;
}

function indexPeopleById(people) {
    if (!Array.isArray(people) || people.length === 0) return;
    if (!mapListingsContext.peopleById || typeof mapListingsContext.peopleById !== 'object') {
        mapListingsContext.peopleById = {};
    }
    people.forEach((person) => {
        if (!person || !person._id) return;
        mapListingsContext.peopleById[String(person._id)] = person;
    });
}

function getPersonFromCard(cardEl) {
    const personId = cardEl?.dataset?.id;
    if (!personId) return null;
    return mapListingsContext.peopleById?.[String(personId)] || null;
}

function collectRelationshipEdgesForSelectedPerson(selectedPersonId) {
    const selectedId = normalizePersonId(selectedPersonId);
    if (!selectedId) return [];
    if (!isPersonLoadedInCurrentView(selectedId)) return [];

    const selectedPerson = mapListingsContext.peopleById?.[selectedId];
    if (!selectedPerson) return [];

    const typeFilter = normalizeText(mapListingsContext.relationshipTypeFilter);
    const minStrength = normalizeRelationshipStrength(mapListingsContext.relationshipMinStrength);
    const edges = [];
    const dedupe = new Set();

    const pushEdge = (sourcePerson, relation, targetPerson, direction) => {
        if (!sourcePerson || !targetPerson || !relation) return;
        const sourceId = normalizePersonId(sourcePerson._id);
        const targetId = normalizePersonId(targetPerson._id);
        if (!sourceId || !targetId || sourceId === targetId) return;
        if (!isPersonLoadedInCurrentView(sourceId) || !isPersonLoadedInCurrentView(targetId)) return;

        const type = normalizeRelationshipType(relation.type);
        const strength = normalizeRelationshipStrength(relation.strength);
        if (typeFilter && type !== typeFilter) return;
        if (strength < minStrength) return;

        const edgeKey = `${sourceId}|${targetId}|${type}|${strength}|${normalizeRelationshipStatus(relation.status)}|${normalizeText(relation.note)}|${normalizeText(relation.source)}`;
        if (dedupe.has(edgeKey)) return;
        dedupe.add(edgeKey);

        edges.push({
            sourceId,
            targetId,
            sourcePerson,
            targetPerson,
            type,
            strength,
            status: normalizeRelationshipStatus(relation.status),
            note: normalizeText(relation.note),
            source: normalizeText(relation.source),
            confidence: normalizeRelationshipConfidence(relation.confidence),
            direction
        });
    };

    normalizePersonRelationships(selectedPerson).forEach((relation) => {
        const target = mapListingsContext.peopleById?.[normalizePersonId(relation.targetPersonId)];
        if (!target) return;
        pushEdge(selectedPerson, relation, target, 'outbound');
    });

    const loadedIds = mapListingsContext.loadedPersonIds instanceof Set
        ? Array.from(mapListingsContext.loadedPersonIds)
        : [];
    loadedIds.forEach((personId) => {
        if (!personId || personId === selectedId) return;
        const candidate = mapListingsContext.peopleById?.[personId];
        if (!candidate) return;
        normalizePersonRelationships(candidate).forEach((relation) => {
            if (normalizePersonId(relation.targetPersonId) !== selectedId) return;
            pushEdge(candidate, relation, selectedPerson, 'inbound');
        });
    });

    return edges.slice(0, RELATIONSHIP_MAX_EDGES);
}

async function renderRelationshipOverlay() {
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance) return;
    const renderToken = ++mapListingsContext.relationshipRenderToken;

    if (!mapListingsContext.relationshipsEnabled) {
        clearRelationshipOverlay();
        return;
    }

    const selectedId = normalizePersonId(mapListingsContext.relationshipSelectedPersonId);
    if (!selectedId) {
        clearRelationshipOverlay();
        return;
    }

    const selectedPerson = mapListingsContext.peopleById?.[selectedId];
    if (!selectedPerson) {
        clearRelationshipOverlay();
        return;
    }

    const edges = collectRelationshipEdgesForSelectedPerson(selectedId);
    const layer = ensureRelationshipLayer();
    if (!layer) return;
    layer.clearLayers();
    if (!edges.length) return;

    const selectedAnchor = await resolvePersonRelationshipAnchor(selectedPerson);
    if (renderToken !== mapListingsContext.relationshipRenderToken) return;
    if (selectedAnchor) {
        L.circleMarker(selectedAnchor, {
            radius: 8,
            color: '#ffffff',
            weight: 2,
            fillColor: '#00bcd4',
            fillOpacity: 0.35
        }).addTo(layer);
    }

    for (const edge of edges) {
        const sourceAnchor = await resolvePersonRelationshipAnchor(edge.sourcePerson);
        if (renderToken !== mapListingsContext.relationshipRenderToken) return;
        const targetAnchor = await resolvePersonRelationshipAnchor(edge.targetPerson);
        if (renderToken !== mapListingsContext.relationshipRenderToken) return;
        if (!sourceAnchor || !targetAnchor) continue;

        const style = getRelationshipStyle(edge);
        const path = [sourceAnchor, targetAnchor];
        const polyline = L.polyline(path, style).addTo(layer);
        polyline.bindPopup(buildRelationshipLinePopupHtml(edge), { className: 'relationship-popup-wrapper' });
    }
}

function setRelationshipFocusPerson(personId) {
    const normalizedId = normalizePersonId(personId);
    mapListingsContext.relationshipSelectedPersonId = normalizedId || null;

    document.querySelectorAll('.listing-card.relationship-focused').forEach((card) => {
        card.classList.remove('relationship-focused');
    });
    if (normalizedId) {
        document.querySelectorAll(`.listing-card[data-id="${normalizedId}"]`).forEach((card) => {
            card.classList.add('relationship-focused');
        });
    }
    renderRelationshipOverlay();
}

function enableRelationshipOverlay() {
    mapListingsContext.relationshipsEnabled = true;
    const modeSelect = document.getElementById('relationshipOverlayMode');
    if (modeSelect && modeSelect.value !== 'on') {
        modeSelect.value = 'on';
    }
}

function lerpLatLng(start, end, t) {
    const lat = start.lat + ((end.lat - start.lat) * t);
    const lng = start.lng + ((end.lng - start.lng) * t);
    return L.latLng(lat, lng);
}

async function animateMapTraversalBetweenPeople(sourcePerson, targetPerson) {
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance || !targetPerson) return false;

    const sourceAnchor = await resolvePersonRelationshipAnchor(sourcePerson);
    const targetAnchor = await resolvePersonRelationshipAnchor(targetPerson);
    if (!sourceAnchor || !targetAnchor) return false;

    const traversalToken = ++mapListingsContext.relationshipTraversalToken;
    const traversalLayer = ensureRelationshipTraversalLayer();
    if (!traversalLayer) return false;
    traversalLayer.clearLayers();

    const pathLine = L.polyline([sourceAnchor, targetAnchor], {
        color: '#00d7f2',
        weight: 4,
        opacity: 0.95,
        dashArray: null
    }).addTo(traversalLayer);

    const tracer = L.circleMarker(sourceAnchor, {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#00d7f2',
        fillOpacity: 0.95
    }).addTo(traversalLayer);

    mapListingsContext.isProgrammaticMovement = true;
    const durationMs = 700;
    const startedAt = performance.now();

    await new Promise((resolve) => {
        const step = (now) => {
            if (traversalToken !== mapListingsContext.relationshipTraversalToken) {
                resolve();
                return;
            }

            const elapsed = now - startedAt;
            const p = Math.max(0, Math.min(1, elapsed / durationMs));
            // easeInOutCubic
            const eased = p < 0.5
                ? 4 * p * p * p
                : 1 - Math.pow(-2 * p + 2, 3) / 2;

            const pos = lerpLatLng(sourceAnchor, targetAnchor, eased);
            try { tracer.setLatLng(pos); } catch (_) {}
            try { mapInstance.panTo(pos, { animate: false }); } catch (_) {}

            if (p < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        };
        requestAnimationFrame(step);
    });

    if (traversalToken !== mapListingsContext.relationshipTraversalToken) return true;

    const targetId = normalizePersonId(targetPerson?._id);
    const targetMarker = targetId ? mapListingsContext.markersByPersonId?.[targetId] : null;
    if (targetMarker) {
        try { targetMarker.openPopup(); } catch (_) {}
    }
    try { mapInstance.panTo(targetAnchor, { animate: true }); } catch (_) {}

    setTimeout(() => {
        if (traversalToken === mapListingsContext.relationshipTraversalToken) {
            clearRelationshipTraversal();
        }
    }, 900);
    setTimeout(() => {
        if (traversalToken === mapListingsContext.relationshipTraversalToken) {
            mapListingsContext.isProgrammaticMovement = false;
        }
    }, 700);

    return true;
}

function focusPersonOnMap(person) {
    if (!personHasExactCoordinates(person) || !map) return;

    const coords = person.location.coordinates;
    const lng = coords?.[0];
    const lat = coords?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const personId = normalizePersonId(person?._id);
    const marker = personId ? mapListingsContext.markersByPersonId?.[personId] : null;
    const currentZoom = typeof map.getZoom === 'function' ? Number(map.getZoom()) : 6;
    const nextZoom = Number.isFinite(currentZoom) ? Math.max(currentZoom, 14) : 14;

    mapListingsContext.isProgrammaticMovement = true;
    map.setView([lat, lng], nextZoom, { animate: true });
    if (marker) {
        marker.openPopup();
        // Keep selected person exactly centered after popup auto-pan.
        setTimeout(() => {
            try { map.panTo([lat, lng], { animate: true }); } catch (_) {}
        }, 80);
    }
    setTimeout(() => {
        mapListingsContext.isProgrammaticMovement = false;
    }, 700);
}

function initRelationshipControls() {
    const modeSelect = document.getElementById('relationshipOverlayMode');
    const typeSelect = document.getElementById('relationshipTypeFilter');
    const strengthSelect = document.getElementById('relationshipStrengthFilter');
    if (!modeSelect || !typeSelect || !strengthSelect) return;
    if (modeSelect.dataset.bound === '1') return;

    const updateOverlaySettings = () => {
        mapListingsContext.relationshipsEnabled = modeSelect.value === 'on';
        mapListingsContext.relationshipTypeFilter = normalizeText(typeSelect.value).toLowerCase();
        mapListingsContext.relationshipMinStrength = normalizeRelationshipStrength(strengthSelect.value || '1');
        renderRelationshipOverlay();
    };

    modeSelect.addEventListener('change', updateOverlaySettings);
    typeSelect.addEventListener('change', updateOverlaySettings);
    strengthSelect.addEventListener('change', updateOverlaySettings);

    modeSelect.dataset.bound = '1';
    updateOverlaySettings();
}

/**
 * Read current authenticated user from auth API (if available).
 */
function getCurrentAuthUser() {
    if (typeof authAPI === 'undefined' || !authAPI || typeof authAPI.getCurrentUser !== 'function') {
        return null;
    }
    return authAPI.getCurrentUser();
}

/**
 * Extract creator user id from person.createdBy (object or string).
 */
function getPersonCreatedById(person) {
    const createdBy = person?.createdBy;
    if (!createdBy) return null;
    if (typeof createdBy === 'string') return createdBy;
    if (typeof createdBy === 'object') {
        if (createdBy._id) return String(createdBy._id);
        if (createdBy.id) return String(createdBy.id);
    }
    return null;
}

function getPersonCreatedByName(person) {
    const createdBy = person?.createdBy;
    if (!createdBy) return '';
    if (typeof createdBy === 'string') return '';
    if (typeof createdBy === 'object') {
        return normalizeText(createdBy.username || createdBy.name || createdBy.email || '');
    }
    return '';
}

function handleOwnerProfileClick(ownerLinkEl) {
    const ownerId = normalizeText(ownerLinkEl?.dataset?.ownerId);
    if (!ownerId) return;
    window.location.href = `public-profile.html?userId=${encodeURIComponent(ownerId)}`;
}

/**
 * Permission helper with backward compatibility for legacy permission names.
 */
function userHasPermission(user, permission) {
    if (!user) return false;
    if (user.role === 'Almighty') return true;
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    if (permissions.includes(permission)) return true;
    if (permission === 'posts:edit:all' && permissions.includes('edit:posts')) return true;
    if (permission === 'posts:delete:all' && permissions.includes('delete:posts')) return true;
    return false;
}

/**
 * Determine whether current user can edit/delete a person listing.
 * Must match backend middleware rules.
 */
function getPostManagementCapabilities(person) {
    const user = getCurrentAuthUser();
    if (!user) {
        return { canEdit: false, canDelete: false };
    }
    if (user.role === 'Almighty') {
        return { canEdit: true, canDelete: true };
    }

    const currentUserId = String(user.id || user._id || '');
    const ownerId = getPersonCreatedById(person);
    const isOwner = Boolean(ownerId && currentUserId && ownerId === currentUserId);

    const hasEditAll = userHasPermission(user, 'posts:edit:all');
    const hasDeleteAll = userHasPermission(user, 'posts:delete:all');
    const hasEditOwn = userHasPermission(user, 'posts:edit:own');
    const hasDeleteOwn = userHasPermission(user, 'posts:delete:own');

    return {
        canEdit: isOwner || hasEditAll || (hasEditOwn && isOwner),
        canDelete: isOwner || hasDeleteAll || (hasDeleteOwn && isOwner)
    };
}

/**
 * Build three-dots menu for listing cards (owner/edit/delete).
 */
function buildManageActionsHtml(person, capabilities) {
    const caps = capabilities || getPostManagementCapabilities(person);

    const personId = person?._id ? String(person._id) : '';
    const ownerName = getPersonCreatedByName(person) || tf('index.unknownOwner', 'Unknown user', 'Unknown user');
    const ownerId = getPersonCreatedById(person);
    const editTitle = tf('common.edit', 'ویرایش', 'Edit');
    const deleteTitle = tf('common.delete', 'حذف', 'Delete');
    const moreTitle = tf('index.moreActions', 'More options', 'More options');

    const ownerMenuItem = ownerId
        ? `<button type="button" class="listing-more-item listing-owner-link" data-owner-id="${escapeAttr(ownerId)}" title="${escapeAttr(ownerName)}">&#128100; ${escapeHtml(ownerName)}</button>`
        : `<span class="listing-more-item listing-more-item-disabled">&#128100; ${escapeHtml(ownerName)}</span>`;

    return `<div class="listing-more-wrap">
        <button type="button" class="listing-manage-btn listing-more-btn" data-id="${escapeAttr(personId)}" title="${escapeAttr(moreTitle)}" aria-label="${escapeAttr(moreTitle)}">&#8942;</button>
        <div class="listing-more-menu" role="menu">
            ${ownerMenuItem}
            ${caps.canEdit ? `<button type="button" class="listing-more-item listing-edit-btn" data-id="${escapeAttr(personId)}" title="${escapeAttr(editTitle)}">&#9998; ${escapeHtml(editTitle)}</button>` : ''}
            ${caps.canDelete ? `<button type="button" class="listing-more-item listing-delete-btn listing-more-item-danger" data-id="${escapeAttr(personId)}" title="${escapeAttr(deleteTitle)}">&#128465;&#65039; ${escapeHtml(deleteTitle)}</button>` : ''}
        </div>
    </div>`;
}
/**
 * Navigate to edit page for a person listing.
 */
function handleListingEdit(btn) {
    const personId = btn?.dataset?.id || btn?.closest('.listing-card')?.dataset?.id;
    if (!personId) return;
    window.location.href = `create-person.html?edit=${encodeURIComponent(personId)}`;
}

/**
 * Delete listing via API, then refresh map + both listing columns.
 */
async function handleListingDelete(btn) {
    const personId = btn?.dataset?.id || btn?.closest('.listing-card')?.dataset?.id;
    if (!personId) return;

    const token = (typeof authAPI !== 'undefined' && authAPI?.getToken) ? authAPI.getToken() : null;
    if (!token) {
        alert('Please log in to continue.');
        return;
    }

    if (!window.confirm('Are you sure you want to delete this post?')) return;

    const wasDisabled = btn.disabled;
    btn.disabled = true;
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }

        if (!res.ok || !data?.success) {
            throw new Error(data?.message || `Failed to delete post (${res.status})`);
        }

        try {
            map?.closePopup();
        } catch (_) {}

        await Promise.all([loadListingsForViewport(), loadPeopleWithoutAddress()]);
    } catch (err) {
        console.error('Delete listing error:', err);
        alert(err?.message || 'Failed to delete post');
    } finally {
        btn.disabled = wasDisabled;
    }
}

function closeAllListingMoreMenus() {
    document.querySelectorAll('.listing-more-wrap.open').forEach((el) => {
        el.classList.remove('open');
        const card = el.closest('.listing-card');
        if (card) card.classList.remove('listing-menu-open');
    });
}

function toggleListingMoreMenu(btn) {
    const wrap = btn?.closest('.listing-more-wrap');
    if (!wrap) return;
    const shouldOpen = !wrap.classList.contains('open');
    closeAllListingMoreMenus();
    if (shouldOpen) {
        wrap.classList.add('open');
        const card = wrap.closest('.listing-card');
        if (card) card.classList.add('listing-menu-open');
    }
}

function isPersonBookmarked(person) {
    if (!person) return false;
    if (typeof person.isBookmarked === 'boolean') return person.isBookmarked;
    const personId = person?._id ? String(person._id) : '';
    if (!personId) return false;
    return mapListingsContext.bookmarkIds instanceof Set && mapListingsContext.bookmarkIds.has(personId);
}

function getBookmarkButtonInnerHtml(isBookmarked) {
    if (isBookmarked) {
        return `
            <svg class="bookmark-icon bookmark-icon-filled" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M7 3h10c1.1 0 2 .9 2 2v16l-7-4-7 4V5c0-1.1.9-2 2-2z"></path>
            </svg>
        `;
    }
    return `
        <svg class="bookmark-icon bookmark-icon-outline" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 3h10c1.1 0 2 .9 2 2v16l-7-4-7 4V5c0-1.1.9-2 2-2z"></path>
        </svg>
    `;
}

function getShareButtonInnerHtml() {
    return `
        <svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="18" cy="5" r="2.2"></circle>
            <circle cx="6" cy="12" r="2.2"></circle>
            <circle cx="18" cy="19" r="2.2"></circle>
            <path d="M8 11l8-5"></path>
            <path d="M8 13l8 5"></path>
        </svg>
    `;
}

function buildBookmarkButtonHtml(person) {
    const personId = person?._id ? String(person._id) : '';
    const active = isPersonBookmarked(person);
    const label = active
        ? tf('index.bookmarkRemove', 'Remove bookmark', 'Remove bookmark')
        : tf('index.bookmarkAdd', 'Bookmark', 'Bookmark');

    return `<button type="button" class="listing-manage-btn listing-bookmark-btn ${active ? 'active' : ''}" data-id="${escapeAttr(personId)}" data-bookmarked="${active ? '1' : '0'}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${getBookmarkButtonInnerHtml(active)}</button>`;
}

function applyBookmarkState(personId, isBookmarked) {
    const key = String(personId || '');
    if (!key) return;

    if (!(mapListingsContext.bookmarkIds instanceof Set)) {
        mapListingsContext.bookmarkIds = new Set();
    }
    if (isBookmarked) mapListingsContext.bookmarkIds.add(key);
    else mapListingsContext.bookmarkIds.delete(key);

    if (mapListingsContext.peopleById && mapListingsContext.peopleById[key]) {
        mapListingsContext.peopleById[key].isBookmarked = Boolean(isBookmarked);
    }
    if (Array.isArray(mapListingsContext.currentListings)) {
        mapListingsContext.currentListings = mapListingsContext.currentListings.map((p) => {
            if (!p || String(p._id) !== key) return p;
            return { ...p, isBookmarked: Boolean(isBookmarked) };
        });
    }

    document.querySelectorAll(`.listing-bookmark-btn[data-id="${key}"]`).forEach((btn) => {
        btn.classList.toggle('active', Boolean(isBookmarked));
        btn.dataset.bookmarked = isBookmarked ? '1' : '0';
        const label = isBookmarked
            ? tf('index.bookmarkRemove', 'Remove bookmark', 'Remove bookmark')
            : tf('index.bookmarkAdd', 'Bookmark', 'Bookmark');
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = getBookmarkButtonInnerHtml(Boolean(isBookmarked));
    });
}

async function loadBookmarkedIds() {
    const token = (typeof authAPI !== 'undefined' && authAPI?.getToken) ? authAPI.getToken() : null;
    if (!token) {
        mapListingsContext.bookmarkIds = new Set();
        return;
    }

    try {
        const res = await fetch(`${MAP_API_BASE_URL}/users/bookmarks/ids`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data?.success) {
            mapListingsContext.bookmarkIds = new Set();
            return;
        }
        const ids = Array.isArray(data?.data?.bookmarks) ? data.data.bookmarks.map((id) => String(id)) : [];
        mapListingsContext.bookmarkIds = new Set(ids);
    } catch (err) {
        console.warn('Failed to load bookmark IDs:', err);
        mapListingsContext.bookmarkIds = new Set();
    }
}

async function handleBookmarkToggle(btn) {
    const token = (typeof authAPI !== 'undefined' && authAPI?.getToken) ? authAPI.getToken() : null;
    if (!token) {
        alert(tf('index.loginToBookmark', 'Please log in to bookmark items.', 'Please log in to bookmark items.'));
        return;
    }

    const personId = btn?.dataset?.id || btn?.closest('.listing-card')?.dataset?.id;
    if (!personId) return;

    const currentlyBookmarked = btn.classList.contains('active');
    const method = currentlyBookmarked ? 'DELETE' : 'POST';
    const wasDisabled = btn.disabled;
    btn.disabled = true;

    try {
        const res = await fetch(`${MAP_API_BASE_URL}/users/bookmarks/${encodeURIComponent(personId)}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await res.json();
        if (!res.ok || !data?.success) {
            throw new Error(data?.message || `Bookmark update failed (${res.status})`);
        }
        const isBookmarked = Boolean(data?.data?.isBookmarked);
        applyBookmarkState(personId, isBookmarked);
    } catch (err) {
        console.error('Bookmark toggle error:', err);
        alert(err?.message || 'Failed to update bookmark');
    } finally {
        btn.disabled = wasDisabled;
    }
}

/**
 * Initialize map
 */
function initMap() {
    if (map) return map;
    const mapEl = document.getElementById('map');
    if (!mapEl) {
        console.error('Map element #map not found');
        return null;
    }

    const countryCode = (typeof languageManager !== 'undefined') ? languageManager.getCurrentLanguage() : 'fa';
    const coords = (typeof languageManager !== 'undefined' && languageManager.getCountryMapCoordinates)
        ? languageManager.getCountryMapCoordinates(countryCode)
        : { center: [35.6892, 51.389], zoom: 10 };
    const center = coords?.center || [35.6892, 51.389];
    const zoom = coords?.zoom || 10;

    console.log('Using country coordinates:', center, 'zoom:', zoom);
    map = L.map('map', {
        zoomControl: false,
        attributionControl: true
    }).setView(center, zoom);

    // Zoom controls disabled per user request
    if (map.attributionControl) {
        map.attributionControl.setPrefix('');
        map.attributionControl.addAttribution('Long live KING , Long live IRAN #javid_shah');
    }
    console.log('Map controls configured: zoomControl=false, attributionControl=true');
    console.log('Map attribution set to custom text');

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: ''
    }).addTo(map);

    mapListingsContext.map = map;
    window.map = map; // overwrite id="map" HTMLElement global so callers get Leaflet, not the DIV
    console.log('Map initialized successfully');
    return map;
}

/**
 * Load listings for current viewport and filters
 */
async function loadListingsForViewport(options = {}) {
    if (isSharedFocusMode()) {
        return;
    }
    const append = Boolean(options && options.append);
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance) return;
    if (append && !mapListingsContext.viewportNextCursor) return;
    /* Append must wait for an idle loader; fresh (non-append) always starts and invalidates older fetches.
       Without this, map-click section filter reloads were dropped while moveend loads were in flight —
       which is why ?person= (shared focus skips moveend loads) looked fine but bare / did not. */
    if (append) {
        if (mapListingsContext.viewportLoading) return;
    } else {
        mapListingsContext.viewportLoadGen += 1;
        mapListingsContext.viewportNextCursor = '';
        mapListingsContext.hasMorePages = false;
    }
    const loadGen = mapListingsContext.viewportLoadGen;
    mapListingsContext.viewportLoading = true;

    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    const roleSelect = document.getElementById('roleFilter');
    const sortSelect = document.getElementById('sortFilter');
    const searchInput = document.getElementById('searchInput');

    const province = provinceSelect?.value?.trim() || '';
    const section = sectionSelect?.value?.trim() || '';
    const sectionLevel = sectionSelect?.selectedOptions?.[0]?.dataset?.level || '';
    const role = roleSelect?.value?.trim() || '';
    const search = searchInput?.value?.trim() || '';
    const sortValue = sortSelect?.value?.trim() || 'likes:desc';
    const [sortBy, sortDir] = sortValue.split(':');

    const bounds = mapInstance.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const minLng = sw.lng;
    const minLat = sw.lat;
    const maxLng = ne.lng;
    const maxLat = ne.lat;

    console.log('Loading listings for viewport...');
    console.log('Current filters:', { role, province, section });
    console.log('Map bounds:', { minLng, minLat, maxLng, maxLat });

    const params = new URLSearchParams({
        minLng: String(minLng),
        minLat: String(minLat),
        maxLng: String(maxLng),
        maxLat: String(maxLat),
        limit: '50'
    });
    params.set('includeTotals', append ? 'false' : 'true');
    if (append && mapListingsContext.viewportNextCursor) {
        params.set('cursor', mapListingsContext.viewportNextCursor);
    }
    if (province) params.set('province', province);
    if (section) {
        if (sectionLevel === 'bakhsh') params.set('bakhsh', section);
        else params.set('county', section);
    }
    if (role) params.set('role', role);
    if (search) params.set('search', search);
    if (sortBy) params.set('sortBy', sortBy);
    if (sortDir) params.set('sortDir', sortDir);

    const url = `${MAP_API_BASE_URL}/people/within-bounds?${params.toString()}`;
    console.log('Fetching from viewport API:', url);

    try {
        const token = authAPI?.getToken?.();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (loadGen !== mapListingsContext.viewportLoadGen) return; // newer filter/viewport request won

        if (!data.success || !data.data) {
            console.warn('Invalid API response:', data);
            if (!append) {
                renderListings([]);
                updateMarkers([]);
            }
            return;
        }

        const incomingPeople = (data.data.people || []).filter((p) => isExactLikePerson(p));
        const pagination = data.data.pagination || {};
        const mergedPeople = append
            ? mergePeopleUnique(mapListingsContext.currentListings, incomingPeople)
            : incomingPeople;

        indexPeopleById(mergedPeople);
        mapListingsContext.currentListings = mergedPeople;
        mapListingsContext.viewportNextCursor = pagination.nextCursor || '';
        mapListingsContext.hasMorePages = Boolean(pagination.hasNextPage && mapListingsContext.viewportNextCursor);
        refreshLoadedPersonIds();

        console.log(`Loaded ${incomingPeople.length} listings for viewport${append ? ' (append)' : ''}`);
        console.log(
            'Total listings in viewport:',
            Number.isFinite(pagination.total) ? pagination.total : mergedPeople.length
        );
        console.log('Has more pages:', mapListingsContext.hasMorePages);

        if (typeof window !== 'undefined' && window.languageManager) {
            window.languageManager.translatePage?.();
        }
        renderListings(mergedPeople);
        updateMarkers(mergedPeople);
        if (append) {
            const currentTotal = Number.isFinite(mapListingsContext.withAddressTotal)
                ? mapListingsContext.withAddressTotal
                : undefined;
            updateListingsCount(mergedPeople.length, currentTotal);
        } else {
            updateListingsCount(mergedPeople.length, pagination.total);
        }
        renderRelationshipOverlay();
    } catch (err) {
        console.error('Error loading listings:', err);
        if (loadGen !== mapListingsContext.viewportLoadGen) return;
        if (!append) {
            mapListingsContext.currentListings = [];
            mapListingsContext.viewportNextCursor = '';
            mapListingsContext.hasMorePages = false;
            refreshLoadedPersonIds();
            renderListings([]);
            updateMarkers([]);
            renderRelationshipOverlay();
        }
    } finally {
        if (loadGen === mapListingsContext.viewportLoadGen) {
            mapListingsContext.viewportLoading = false;
        }
    }
}

/**
 * Render listings list in DOM
 */
function renderListings(people) {
    const safePeople = Array.isArray(people) ? people : [];
    renderWithAddressCards(safePeople, mapListingsContext.withAddressTotal ?? safePeople.length);

    const container = document.getElementById('listingsList');
    if (!container) return;

    if (safePeople.length === 0) {
        container.innerHTML = '<div class="loading-indicator" data-i18n="index.noListings">No listings found</div>';
        if (typeof window !== 'undefined' && window.languageManager) {
            window.languageManager.translatePage?.();
        }
        return;
    }

    const html = safePeople.map((p) => buildListingCardHtml(p, { noAddress: false })).join('');

    container.innerHTML = html;

    if (!container.dataset.listingClickBound) {
        container.addEventListener('click', handleListingCardClick);
        container.dataset.listingClickBound = '1';
    }

    /* Address, vote, comment are handled by document-level delegation (bindListingActionsDelegation) so they work in both sidebar cards and map popup cards */

    /* Comment submit is handled via document-level delegation so modal panel works (see bindCommentsModalAndDelegation) */

    /* Event delegation for comment vote/edit/delete - comments are loaded dynamically */
    if (!container.dataset.commentDelegationBound) {
        container.dataset.commentDelegationBound = '1';
        container.addEventListener('click', (ev) => {
            const voteBtn = ev.target.closest('.comment-vote-btn');
            const editBtn = ev.target.closest('.comment-edit-btn');
            const deleteBtn = ev.target.closest('.comment-delete-btn');
            if (voteBtn) { ev.preventDefault(); ev.stopPropagation(); handleCommentVote(voteBtn); return; }
            if (editBtn) { ev.preventDefault(); ev.stopPropagation(); handleCommentEdit(editBtn); return; }
            if (deleteBtn) { ev.preventDefault(); ev.stopPropagation(); handleCommentDelete(deleteBtn); return; }
        });
    }

    if (typeof window !== 'undefined' && window.languageManager) {
        window.languageManager.translatePage?.();
    }
}

/**
 * Render "with address" cards inside filters panel tab.
 * Mirrors viewport listings so mobile users can switch between with/without-address lists.
 */
function renderWithAddressCards(people, total) {
    const container = document.getElementById('withAddressListContainer');
    if (!container) return;

    const safePeople = (Array.isArray(people) ? people : []).filter((p) => isExactLikePerson(p));
    const totalCount = Number.isFinite(total) ? total : safePeople.length;
    const ofText = getNoAddressTranslation('index.of');

    if (safePeople.length === 0) {
        container.innerHTML = `<div class="with-address-list"><p class="filters-hint" data-i18n="index.noListings">${t('index.noListings') || 'No listings found'}</p></div>`;
    } else {
        let html = '<div class="with-address-list" id="withAddressListSection"><div class="with-address-cards">';
        safePeople.forEach((p) => {
            html += buildListingCardHtml(p, { noAddress: false });
        });
        html += '</div>';
        if (totalCount > safePeople.length) {
            html += `<p class="filters-hint">${safePeople.length} ${ofText} ${totalCount}</p>`;
        }
        if (mapListingsContext.hasMorePages) {
            html += `<button type="button" class="btn-load-more with-address-load-more" ${mapListingsContext.viewportLoading ? 'disabled' : ''}>${t('common.loadMore') || 'Load more'}</button>`;
        }
        html += '</div>';
        container.innerHTML = html;
    }

    if (!container.dataset.listingClickBound) {
        container.addEventListener('click', handleListingCardClick);
        container.dataset.listingClickBound = '1';
    }

    if (!container.dataset.withAddressLoadMoreBound) {
        container.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.with-address-load-more');
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (mapListingsContext.viewportLoading || !mapListingsContext.hasMorePages) return;
            loadListingsForViewport({ append: true });
        });
        container.dataset.withAddressLoadMoreBound = '1';
    }

    if (typeof window !== 'undefined' && window.languageManager) {
        window.languageManager.translatePage?.();
    }
}

async function handleVote(btn) {
    if (!btn) return;
    if (typeof authAPI === 'undefined' || !authAPI.isAuthenticated()) {
        alert(t('index.loginToVote') || 'Please log in to vote.');
        return;
    }
    const personId = btn.dataset.id;
    const type = btn.dataset.type;
    const card = btn.closest('.listing-card');
    if (!personId || !type || !card) return;
    const token = authAPI.getToken();
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ type })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Vote failed');
        const { likes, dislikes, userVote } = data.data;
        card.dataset.likes = likes;
        card.dataset.dislikes = dislikes;
        card.dataset.userVote = userVote || '';
        card.querySelectorAll('.listing-vote-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.type === userVote);
            const cnt = b.querySelector('.vote-count');
            if (cnt) cnt.textContent = b.dataset.type === 'like' ? likes : dislikes;
        });
    } catch (err) {
        console.error('Vote error:', err);
        alert(err.message || 'Failed to vote');
    }
}

/**
 * Open comments in a popup modal instead of inline panel.
 * Uses the global #listing-comments-modal; sets data-id and loads comments.
 */
function toggleCommentsPanel(btn) {
    if (!btn) return;
    const personId = btn.dataset.id;
    const modal = document.getElementById('listing-comments-modal');
    const panel = modal?.querySelector('.listing-comments-panel');
    if (!modal || !panel) return;
    panel.dataset.id = personId;
    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    loadComments(panel, personId);
    bindCommentsModalCloseOnce();
}

async function copyTextToClipboard(text) {
    if (!text) return false;

    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {
            // Try legacy fallback below.
        }
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return Boolean(ok);
    } catch (_) {
        return false;
    }
}

/**
 * Handle share button click:
 * 1) Always try to copy link to clipboard.
 * 2) Also open native share dialog when available.
 * Shareable URL format: <origin>/?person=<id> (never localhost in production).
 * Uses canonical app URL from meta[name="radgir-app-url"] when set (injected by server from APP_URL).
 */
async function handleShare(btn) {
    if (!btn) return;
    const personId = btn.dataset.id;
    const name = (btn.dataset.name || '').trim();
    if (!personId) {
        console.warn('Share: missing person id');
        return;
    }

    // Prefer canonical app URL from server-injected meta so share link is never localhost in production
    const meta = typeof document !== 'undefined' && document.querySelector && document.querySelector('meta[name="radgir-app-url"]');
    const canonicalBase = (meta && meta.getAttribute && meta.getAttribute('content') || '').trim().replace(/\/$/, '');
    const baseUrl = canonicalBase
        ? (canonicalBase + '/')
        : (window.location.origin.replace(/\/$/, '') + (window.location.pathname || '/index.html'));
    const shareUrl = (baseUrl.replace(/\?.*$/, '')) + (baseUrl.includes('?') ? '&' : '?') + 'person=' + encodeURIComponent(personId);
    const shareText = name ? `${name} - Radgir` : 'Radgir';

    // Always try clipboard copy first.
    const copied = await copyTextToClipboard(shareUrl);

    // If native share exists, use it too.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
            await navigator.share({
                title: shareText,
                text: shareText,
                url: shareUrl
            });
            console.log(`Share completed via Web Share API${copied ? ' (link also copied)' : ''}`);
            return;
        } catch (err) {
            if (err?.name === 'AbortError') {
                // User canceled share dialog; clipboard copy may already exist.
                console.log('Share cancelled by user');
                return;
            }
            console.warn('Web Share failed, keeping clipboard fallback:', err);
        }
    }

    // No native share available: clipboard copy was already attempted.
    if (!copied) {
        console.warn('Share/clipboard unavailable for this browser context.');
    }
}

/** One-time bind: close comments modal on backdrop/close button; document delegation for submit and comment actions inside modal */
function bindCommentsModalCloseOnce() {
    const modal = document.getElementById('listing-comments-modal');
    if (!modal || modal.dataset.commentsModalBound === '1') return;
    modal.dataset.commentsModalBound = '1';

    function closeCommentsModal() {
        modal.setAttribute('aria-hidden', 'true');
        modal.style.display = 'none';
    }

    modal.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-action="close-comments-modal"]')) {
            ev.preventDefault();
            ev.stopPropagation();
            closeCommentsModal();
        }
    });

    /* Document-level: submit comment (so modal panel works; no inline panels anymore) */
    document.addEventListener('click', (ev) => {
        const submitBtn = ev.target.closest('.comment-submit-btn');
        if (!submitBtn) return;
        const panel = submitBtn.closest('.listing-comments-panel');
        if (!panel) return;
        ev.stopPropagation();
        submitComment(panel);
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        const input = ev.target.closest('.comment-input');
        if (!input) return;
        const panel = input.closest('.listing-comments-panel');
        if (!panel) return;
        ev.preventDefault();
        ev.stopPropagation();
        submitComment(panel);
    });

    /* Document-level: comment vote/edit/delete when inside modal (modal is outside listings container) */
    document.addEventListener('click', (ev) => {
        if (!modal.contains(ev.target)) return;
        const voteBtn = ev.target.closest('.comment-vote-btn');
        const editBtn = ev.target.closest('.comment-edit-btn');
        const deleteBtn = ev.target.closest('.comment-delete-btn');
        if (voteBtn) { ev.preventDefault(); ev.stopPropagation(); handleCommentVote(voteBtn); return; }
        if (editBtn) { ev.preventDefault(); ev.stopPropagation(); handleCommentEdit(editBtn); return; }
        if (deleteBtn) { ev.preventDefault(); ev.stopPropagation(); handleCommentDelete(deleteBtn); return; }
    });
}

/**
 * Update the comment count displayed on the listing card (by person id). Used when panel is in modal and not inside card.
 */
function updateListingCommentCount(personId, count) {
    const card = document.querySelector(`.listing-card[data-id="${personId}"]`);
    const countEl = card?.querySelector('.comment-count');
    if (countEl) countEl.textContent = String(count);
}

/**
 * Load comments for a listing. Sends auth token when logged in so API returns userVote and isOwn.
 * Renders each comment with like/dislike buttons and edit/delete for own comments.
 */
async function loadComments(panel, personId) {
    const list = panel?.querySelector('.comments-list');
    if (!list) return;
    list.innerHTML = '<span class="loading-comments">...</span>';
    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = (typeof authAPI !== 'undefined' && authAPI?.getToken) ? authAPI.getToken() : null;
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}/comments`, { headers });
        const data = await res.json();
        list.innerHTML = '';
        if (!data.success || !data.data?.comments?.length) {
            list.innerHTML = '<p class="no-comments">هنوز نظری ثبت نشده</p>';
            updateListingCommentCount(personId, 0);
            return;
        }
        data.data.comments.forEach(c => {
            const div = document.createElement('div');
            div.className = 'comment-item';
            div.dataset.commentId = c.id;
            const likes = c.likes ?? 0;
            const dislikes = c.dislikes ?? 0;
            const userVote = c.userVote || '';
            const likeActive = userVote === 'like' ? ' active' : '';
            const dislikeActive = userVote === 'dislike' ? ' active' : '';
            /* Show edit/delete for own comments or when Almighty (canEdit from API) */
            const editDeleteHtml = c.canEdit
                ? `<button type="button" class="comment-edit-btn" title="${tf('common.edit', 'ویرایش', 'Edit')}">✏️</button><button type="button" class="comment-delete-btn" title="${tf('common.delete', 'حذف', 'Delete')}">🗑️</button>`
                : '';
            div.innerHTML = `
                <div class="comment-body">
                    <strong>${escapeHtml(c.username)}</strong>: <span class="comment-text">${escapeHtml(c.text)}</span>
                    <small>${new Date(c.createdAt).toLocaleDateString('fa-IR')}</small>
                </div>
                <div class="comment-actions">
                    <button type="button" class="comment-vote-btn${likeActive}" data-vote="like" data-person-id="${escapeAttr(personId)}" data-comment-id="${escapeAttr(c.id)}" title="Like">👍 <span class="comment-vote-count">${likes}</span></button>
                    <button type="button" class="comment-vote-btn${dislikeActive}" data-vote="dislike" data-person-id="${escapeAttr(personId)}" data-comment-id="${escapeAttr(c.id)}" title="Dislike">👎 <span class="comment-vote-count">${dislikes}</span></button>
                    ${editDeleteHtml}
                </div>
            `;
            list.appendChild(div);
        });
        updateListingCommentCount(personId, data.data.comments.length);
    } catch (err) {
        console.error('Load comments error:', err);
        list.innerHTML = '<p class="comments-error">خطا در بارگذاری نظرات</p>';
    }
}

async function submitComment(panel) {
    if (!panel) return;
    if (typeof authAPI === 'undefined' || !authAPI.isAuthenticated()) {
        alert(t('index.loginToComment') || 'Please log in to comment.');
        return;
    }
    const personId = panel.dataset.id;
    const input = panel.querySelector('.comment-input');
    const text = input?.value?.trim();
    if (!text) return;
    const token = authAPI.getToken();
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Comment failed');
        input.value = '';
        await loadComments(panel, personId);
        /* Count is updated inside loadComments via updateListingCommentCount */
    } catch (err) {
        console.error('Comment error:', err);
        alert(err.message || 'Failed to add comment');
    }
}

/**
 * Like or dislike a comment. Requires login. Updates UI on success.
 */
async function handleCommentVote(btn) {
    if (!btn) return;
    if (typeof authAPI === 'undefined' || !authAPI.isAuthenticated()) {
        alert(t('index.loginToVote') || 'Please log in to vote.');
        return;
    }
    const personId = btn.dataset.personId;
    const commentId = btn.dataset.commentId;
    const vote = btn.dataset.vote;
    if (!personId || !commentId || !vote) return;
    const token = authAPI.getToken();
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}/comments/${commentId}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ vote })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Vote failed');
        const { likes, dislikes, userVote } = data.data;
        const item = btn.closest('.comment-item');
        if (!item) return;
        item.querySelectorAll('.comment-vote-btn').forEach(b => {
            const isLike = b.dataset.vote === 'like';
            b.classList.toggle('active', (isLike && userVote === 'like') || (!isLike && userVote === 'dislike'));
            const cnt = b.querySelector('.comment-vote-count');
            if (cnt) cnt.textContent = isLike ? likes : dislikes;
        });
    } catch (err) {
        console.error('Comment vote error:', err);
        alert(err.message || 'Failed to vote');
    }
}

/**
 * Delete own comment. Confirms first, then calls DELETE API and reloads comments.
 */
async function handleCommentDelete(btn) {
    if (!btn) return;
    if (typeof authAPI === 'undefined' || !authAPI.isAuthenticated()) {
        alert(t('index.loginToComment') || 'Please log in.');
        return;
    }
    const panel = btn.closest('.listing-comments-panel');
    const personId = panel?.dataset?.id;
    const commentId = btn.closest('.comment-item')?.dataset?.commentId;
    if (!personId || !commentId || !panel) return;
    if (!confirm(t('index.deleteCommentConfirm') || 'Are you sure you want to delete this comment?')) return;
    const token = authAPI.getToken();
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}/comments/${commentId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Delete failed');
        await loadComments(panel, personId);
        const count = panel.querySelectorAll('.comments-list .comment-item').length;
        updateListingCommentCount(personId, count);
    } catch (err) {
        console.error('Comment delete error:', err);
        alert(err.message || 'Failed to delete comment');
    }
}

/**
 * Edit own comment. Toggles inline edit mode: text becomes input, save/cancel buttons appear.
 */
function handleCommentEdit(btn) {
    if (!btn) return;
    const item = btn.closest('.comment-item');
    const panel = btn.closest('.listing-comments-panel');
    const personId = panel?.dataset?.id;
    const commentId = item?.dataset?.commentId;
    if (!item || !personId || !commentId) return;
    const textEl = item.querySelector('.comment-text');
    if (!textEl) return;
    if (item.dataset.editing === '1') return; /* Already in edit mode */
    const originalText = textEl.textContent;
    const actionsDiv = item.querySelector('.comment-actions');
    if (!actionsDiv) return;
    item.dataset.editing = '1';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'comment-edit-input';
    input.value = originalText;
    input.maxLength = 500;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'comment-save-btn';
    saveBtn.textContent = t('common.save') || 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'comment-cancel-btn';
    cancelBtn.textContent = t('common.cancel') || 'Cancel';
    textEl.replaceWith(input);
    input.focus();
    actionsDiv.prepend(saveBtn, cancelBtn);
    const cleanup = () => {
        item.dataset.editing = '';
        input.replaceWith(textEl);
        textEl.textContent = originalText;
        saveBtn.remove();
        cancelBtn.remove();
    };
    const doSave = async () => {
        const newText = input.value.trim();
        if (!newText) return;
        if (typeof authAPI === 'undefined' || !authAPI.isAuthenticated()) {
            alert(t('index.loginToComment') || 'Please log in.');
            cleanup();
            return;
        }
        const token = authAPI.getToken();
        try {
            const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}/comments/${commentId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ text: newText })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Edit failed');
            textEl.textContent = newText;
            input.replaceWith(textEl);
            saveBtn.remove();
            cancelBtn.remove();
            item.dataset.editing = '';
        } catch (err) {
            console.error('Comment edit error:', err);
            alert(err.message || 'Failed to edit comment');
        }
    };
    saveBtn.addEventListener('click', () => {
        if (input.value.trim()) doSave();
    });
    cancelBtn.addEventListener('click', cleanup);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) doSave(); }
        if (e.key === 'Escape') cleanup();
    });
}

function escapeHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function escapeAttr(s) {
    if (s == null || s === '') return '';
    const str = String(s);
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let listingsCarouselState = { images: [], index: 0, personId: '' };
let _listingsCarouselInitialized = false;

function initListingsCarouselHandlers() {
    if (_listingsCarouselInitialized) return;
    _listingsCarouselInitialized = true;
    document.getElementById('listingsCarouselPrev')?.addEventListener('click', () => showListingsCarouselSlide(listingsCarouselState.index - 1));
    document.getElementById('listingsCarouselNext')?.addEventListener('click', () => showListingsCarouselSlide(listingsCarouselState.index + 1));
    document.getElementById('listingsCarouselClose')?.addEventListener('click', closeListingsImageCarousel);
    document.getElementById('listingsImageCarouselModal')?.addEventListener('click', (e) => { if (e.target.id === 'listingsImageCarouselModal') closeListingsImageCarousel(); });
}

function showListingsCarouselSlide(idx) {
    const { images } = listingsCarouselState;
    if (!images || images.length === 0) return;
    listingsCarouselState.index = Math.max(0, Math.min(idx, images.length - 1));
    const imgEl = document.getElementById('listingsCarouselImage');
    const dotsEl = document.getElementById('listingsCarouselDots');
    const counterEl = document.getElementById('listingsCarouselCounter');
    if (imgEl) imgEl.src = images[listingsCarouselState.index];
    if (imgEl) imgEl.alt = `Image ${listingsCarouselState.index + 1} of ${images.length}`;
    dotsEl?.querySelectorAll('.carousel-dot').forEach((d, i) => d.classList.toggle('active', i === listingsCarouselState.index));
    if (counterEl) counterEl.textContent = `${listingsCarouselState.index + 1} / ${images.length}`;
}

function setListingsCarouselDetails(person) {
    const detailsEl = document.getElementById('listingsCarouselDetails');
    if (!detailsEl) return;

    if (!person) {
        detailsEl.innerHTML = '';
        detailsEl.style.display = 'none';
        return;
    }

    const fullName = getPersonFullName(person);
    const tags = (person.tags || person.metadata?.tags || []).join(', ');
    const addressStatus = inferPersonAddressStatus(person);
    const noAddressLabel = getNoAddressTranslation('index.noAddressLabel');
    const approximateRegion = getPersonApproximateRegion(person);
    const addressPreview = normalizeText(person.address);
    const displayAddress = addressStatus === 'exact'
        ? addressPreview
        : (approximateRegion || noAddressLabel);
    const detailsBlock = buildPersonDetailsHtml(person);

    detailsEl.innerHTML = `
        <div class="carousel-details-name">${escapeHtml(fullName || tf('index.unknownPerson', '\u0641\u0631\u062f \u0646\u0627\u0634\u0646\u0627\u0633', 'Unknown person'))}</div>
        ${displayAddress ? `<p class="carousel-details-address">${escapeHtml(displayAddress)}</p>` : ''}
        ${tags ? `<p class="carousel-details-tags">${escapeHtml(tags)}</p>` : ''}
        ${detailsBlock}
    `;
    detailsEl.style.display = 'block';
}

/**
 * When user clicks address (with coords): show a modal popup with "بریم شکار" only.
 * Clicking "بریم شکار" opens Google Maps. Clicking backdrop or anywhere outside closes the popup.
 */
function handleAddressClick(addressEl) {
    if (!addressEl || !addressEl.classList.contains('listing-address-clickable')) return;
    const lat = parseFloat(addressEl.dataset.lat);
    const lng = parseFloat(addressEl.dataset.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    /* Remove any existing popup */
    document.querySelectorAll('.listing-address-popup-overlay').forEach(n => n.remove());

    const navLabel = 'بریم شکار';
    const fullAddress = (addressEl.textContent || '').trim();
    const overlay = document.createElement('div');
    overlay.className = 'listing-address-popup-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', fullAddress || navLabel);
    overlay.innerHTML = `
        <div class="listing-address-popup-backdrop"></div>
        <div class="listing-address-popup-box">
            ${fullAddress ? `<p class="listing-address-popup-full">${escapeHtml(fullAddress)}</p>` : ''}
            <button type="button" class="listing-address-nav-btn">${navLabel}</button>
        </div>
    `;
    document.body.appendChild(overlay);

    const closePopup = () => {
        overlay.remove();
        document.removeEventListener('click', outsideClick);
    };

    overlay.querySelector('.listing-address-nav-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
        window.open(url, '_blank', 'noopener,noreferrer');
        closePopup();
    });
    /* Clicking backdrop or overlay closes the popup */
    overlay.querySelector('.listing-address-popup-backdrop').addEventListener('click', closePopup);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePopup();
    });

    /* Click anywhere outside the popup (e.g. map, another card) to close */
    const outsideClick = (e) => {
        if (!overlay.parentNode) return;
        if (overlay.contains(e.target)) return;
        closePopup();
    };
    setTimeout(() => document.addEventListener('click', outsideClick), 0);
}

function handleListingCardClick(e) {
    const card = e.target.closest('.listing-card');
    if (!card) return;

    const stackBtn = e.target.closest('.listing-card-stack-btn');
    if (stackBtn) {
        e.preventDefault();
        e.stopPropagation();
        const stackEl = card.querySelector('.listing-card-stack');
        const dirRaw = Number.parseInt(stackBtn.dataset.stackDir || '1', 10);
        const direction = Number.isFinite(dirRaw) && dirRaw < 0 ? -1 : 1;
        cycleCardStack(stackEl, direction);
        return;
    }

    const stackEl = e.target.closest('.listing-card-stack');
    if (stackEl) {
        e.preventDefault();
        e.stopPropagation();
        if (stackEl.dataset.stackConsumeClick === '1') {
            delete stackEl.dataset.stackConsumeClick;
            return;
        }
        cycleCardStack(stackEl, 1);
        return;
    }
    if (e.target.closest('.listing-nav-btn') || e.target.closest('.listing-owner-link') || e.target.closest('.listing-bookmark-btn') || e.target.closest('.listing-more-wrap') || e.target.closest('.listing-address-clickable') || e.target.closest('.listing-address-popup-overlay') || e.target.closest('.listing-vote-btn') || e.target.closest('.listing-comment-btn') || e.target.closest('.listing-share-btn') || e.target.closest('.listing-edit-btn') || e.target.closest('.listing-delete-btn') || e.target.closest('.listing-comments-panel')) return;

    const personId = card.dataset.id;
    const lat = parseFloat(card.dataset.lat);
    const lng = parseFloat(card.dataset.lng);

    if (e.target.closest('.listing-image img')) {
        e.preventDefault();
        e.stopPropagation();
        const imgContainer = e.target.closest('.listing-image');
        const imagesJson = imgContainer?.dataset?.images;
        const person = getPersonFromCard(card);
        if (personId) setRelationshipFocusPerson(personId);
        if (imagesJson) {
            try {
                const images = JSON.parse(imagesJson);
                if (images && images.length > 0) {
                    openListingsImageCarousel(images, person);
                    return;
                }
            } catch (err) {
                console.warn('Failed to parse listing images JSON:', err);
            }
        }
        return;
    }

    if (personId) {
        setRelationshipFocusPerson(personId);
    }

    if (personId && !isNaN(lat) && !isNaN(lng) && map) {
        const marker = mapListingsContext.markersByPersonId[personId];
        mapListingsContext.isProgrammaticMovement = true;
        map.setView([lat, lng], 14);
        if (marker) marker.openPopup();
        setTimeout(() => { mapListingsContext.isProgrammaticMovement = false; }, 1000);
    }
}

function openListingsImageCarousel(images, person) {
    if (!images || images.length === 0) return;
    const modal = document.getElementById('listingsImageCarouselModal');
    const imgEl = document.getElementById('listingsCarouselImage');
    const dotsEl = document.getElementById('listingsCarouselDots');
    if (!modal || !imgEl) return;

    const resolvedPerson = person || null;
    listingsCarouselState = { images, index: 0, personId: resolvedPerson?._id ? String(resolvedPerson._id) : '' };
    initListingsCarouselHandlers();
    setListingsCarouselDetails(resolvedPerson);

    dotsEl.innerHTML = images.map((_, i) =>
        `<button type="button" class="carousel-dot ${i === 0 ? 'active' : ''}" data-index="${i}" aria-label="Go to image ${i + 1}"></button>`
    ).join('');
    dotsEl.querySelectorAll('.carousel-dot').forEach((dot) => {
        dot.addEventListener('click', () => showListingsCarouselSlide(parseInt(dot.dataset.index, 10)));
    });

    showListingsCarouselSlide(0);
    modal.style.display = 'flex';
    modal.classList.add('active');
    const escHandler = (ev) => {
        if (ev.key === 'Escape') {
            closeListingsImageCarousel();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

function closeListingsImageCarousel() {
    const modal = document.getElementById('listingsImageCarouselModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
    }
    setListingsCarouselDetails(null);
    listingsCarouselState = { images: [], index: 0, personId: '' };
}

function getRelatedStackCards(person, maxItems = 8) {
    const unique = new Set();
    const items = [];

    const selfId = normalizePersonId(person?._id);
    if (!selfId) return [];

    const selfName = getPersonFullName(person) || selfId;
    const selfImage = getPersonImages(person)[0] || '';
    items.push({
        id: selfId,
        name: selfName,
        subtitle: tf('index.currentCardLabel', 'Current card', 'Current card'),
        image: selfImage
    });
    unique.add(selfId);

    const pushRelatedItem = (targetPerson, targetId, relation) => {
        if (!targetId || unique.has(targetId)) return;
        unique.add(targetId);

        const targetName = targetPerson ? (getPersonFullName(targetPerson) || targetId) : targetId;
        const targetImage = targetPerson ? (getPersonImages(targetPerson)[0] || '') : '';
        const targetAddress = targetPerson
            ? (normalizeText(targetPerson.address) || getPersonApproximateRegion(targetPerson))
            : '';
        const relationTypeLabel = getRelationshipTypeLabel(relation?.type);
        const subtitle = [relationTypeLabel, targetAddress].filter(Boolean).join(' - ');

        items.push({
            id: targetId,
            name: targetName,
            subtitle,
            image: targetImage
        });
    };

    // Outgoing edges: current card -> related cards.
    const outgoingRelations = normalizePersonRelationships(person);
    for (const relation of outgoingRelations) {
        if (items.length >= maxItems) break;
        const targetId = normalizePersonId(relation?.targetPersonId);
        const targetPerson = targetId ? (mapListingsContext.peopleById?.[targetId] || null) : null;
        pushRelatedItem(targetPerson, targetId, relation);
    }

    // Incoming edges: other cards -> current card (auto bidirectional traversal).
    const loadedIds = mapListingsContext.loadedPersonIds instanceof Set
        ? Array.from(mapListingsContext.loadedPersonIds)
        : Object.keys(mapListingsContext.peopleById || {});

    for (const candidateId of loadedIds) {
        if (items.length >= maxItems) break;
        const normalizedCandidateId = normalizePersonId(candidateId);
        if (!normalizedCandidateId || normalizedCandidateId === selfId || unique.has(normalizedCandidateId)) {
            continue;
        }

        const candidate = mapListingsContext.peopleById?.[normalizedCandidateId];
        if (!candidate) continue;

        const candidateRelations = normalizePersonRelationships(candidate);
        const incomingRelation = candidateRelations.find((relation) => {
            return normalizePersonId(relation?.targetPersonId) === selfId;
        });
        if (!incomingRelation) continue;

        pushRelatedItem(candidate, normalizedCandidateId, incomingRelation);
    }

    // Stack mode requires at least self + one related card.
    return items.length >= 2 ? items : [];
}

function buildCardStackLayerHtml(item, layerPos) {
    const safeName = escapeHtml(normalizeText(item?.name) || '');
    const safeSubtitle = escapeHtml(normalizeText(item?.subtitle) || '');
    const thumb = normalizeText(item?.image)
        ? `<img src="${escapeAttr(item.image)}" alt="${escapeAttr(item?.name || '')}" class="listing-card-stack-thumb" loading="lazy">`
        : `<span class="listing-card-stack-thumb listing-card-stack-thumb-placeholder">${escapeHtml((normalizeText(item?.name).charAt(0) || '•').toUpperCase())}</span>`;

    return `<span class="listing-card-stack-layer" data-layer-pos="${layerPos}" style="--card-stack-index:${layerPos}">
        <span class="listing-card-stack-layer-inner">
            <span class="listing-card-stack-text">
                <span class="listing-card-stack-name">${safeName}</span>
                ${safeSubtitle ? `<span class="listing-card-stack-subtitle">${safeSubtitle}</span>` : ''}
            </span>
            ${thumb}
        </span>
    </span>`;
}

function buildCardStackLayersMarkup(stackItems, startIndex) {
    const safeItems = Array.isArray(stackItems) ? stackItems : [];
    if (!safeItems.length) return '';

    const layerCount = Math.min(3, safeItems.length);
    let html = '';
    for (let pos = 1; pos <= layerCount; pos += 1) {
        const itemIndex = (startIndex + (pos - 1)) % safeItems.length;
        html += buildCardStackLayerHtml(safeItems[itemIndex], pos);
    }
    if (safeItems.length > layerCount) {
        html += `<span class="listing-card-stack-count">+${safeItems.length - layerCount}</span>`;
    }
    return html;
}

function parseCardStackItems(stackEl) {
    if (!stackEl) return [];
    const raw = stackEl.dataset.stackItems;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => item && typeof item === 'object');
    } catch (err) {
        console.warn('Failed to parse card stack items:', err);
        return [];
    }
}

function buildPersistentCardStackHtml(stackItems, startIndex = 0) {
    const safeItems = Array.isArray(stackItems) ? stackItems : [];
    if (!safeItems.length) return '';

    const hint = tf(
        'index.relationshipStackHint',
        'برای دیدن کارت مرتبط بعدی لمس کنید یا به بالا بکشید',
        'Tap or drag up to cycle related cards'
    );

    let normalizedStart = Number.parseInt(String(startIndex), 10);
    if (!Number.isFinite(normalizedStart) || normalizedStart < 0) normalizedStart = 0;
    if (normalizedStart >= safeItems.length) normalizedStart = normalizedStart % safeItems.length;

    return `<div class="listing-card-stack" data-stack-items="${escapeAttr(JSON.stringify(safeItems))}" data-stack-index="${normalizedStart}" title="${escapeAttr(hint)}">
        ${buildCardStackLayersMarkup(safeItems, normalizedStart)}
    </div>`;
}

function htmlToElement(html) {
    if (!html || typeof html !== 'string') return null;
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function applyPersistentStackStateToCard(cardEl, stackItems, stackIndex = 0) {
    if (!cardEl) return;
    const safeItems = Array.isArray(stackItems) ? stackItems : [];
    if (safeItems.length < 2) {
        const existingStack = cardEl.querySelector('.listing-card-stack');
        if (existingStack) existingStack.remove();
        const existingControls = cardEl.querySelector('.listing-card-stack-controls');
        if (existingControls) existingControls.remove();
        cardEl.classList.remove('has-card-stack');
        return;
    }

    const stackEl = htmlToElement(buildPersistentCardStackHtml(safeItems, stackIndex));
    const controlsEl = htmlToElement(buildCardStackControlsHtml());
    if (!stackEl || !controlsEl) return;

    const existingStack = cardEl.querySelector('.listing-card-stack');
    if (existingStack) {
        existingStack.replaceWith(stackEl);
    } else {
        cardEl.insertBefore(stackEl, cardEl.firstChild);
    }

    const existingControls = cardEl.querySelector('.listing-card-stack-controls');
    if (existingControls) {
        existingControls.replaceWith(controlsEl);
    } else {
        cardEl.insertBefore(controlsEl, stackEl.nextSibling);
    }
    cardEl.classList.add('has-card-stack');
}

function getRootStackItems(person) {
    if (!person) return [];
    return getRelatedStackCards(person, 8);
}

function getCardColumnMode(cardEl) {
    if (!cardEl) return null;
    if (cardEl.classList.contains('listing-card-popup')) return 'popup';

    const panel = cardEl.closest('[data-people-tab-panel]');
    const panelMode = normalizeText(panel?.dataset?.peopleTabPanel).toLowerCase();
    if (panelMode === 'with-address') return 'exact';
    if (panelMode === 'without-address') return 'non-exact';

    const noAddressFlag = cardEl?.dataset?.noAddress;
    if (noAddressFlag === '1') return 'non-exact';
    if (noAddressFlag === '0') return 'exact';
    return null;
}

function isPersonAllowedInCardColumn(person, columnMode) {
    if (!person) return false;
    if (columnMode === 'exact') return isExactLikePerson(person);
    if (columnMode === 'non-exact') return !isExactLikePerson(person);
    return true;
}

function replaceStackOwnerCard(ownerCard, targetPerson, direction, sourcePerson) {
    if (!ownerCard || !targetPerson) return null;

    const isPopup = ownerCard.classList.contains('listing-card-popup');
    const noAddress = !isExactLikePerson(targetPerson);
    const html = isPopup
        ? buildMapPopupCardHtml(targetPerson)
        : buildListingCardHtml(targetPerson, { noAddress });

    const host = ownerCard.parentElement;
    if (!host) return null;

    const temp = document.createElement('div');
    temp.innerHTML = html.trim();
    const newCard = temp.firstElementChild;
    if (!newCard) return null;

    const rootStackItems = getRootStackItems(targetPerson);
    applyPersistentStackStateToCard(newCard, rootStackItems, 0);

    newCard.classList.add(direction < 0 ? 'stack-shift-prev' : 'stack-shift-next');
    host.replaceChild(newCard, ownerCard);
    window.setTimeout(() => {
        newCard.classList.remove('stack-shift-prev', 'stack-shift-next');
    }, 160);

    return newCard;
}

function renderCardStackLayers(stackEl) {
    if (!stackEl) return;
    const items = parseCardStackItems(stackEl);
    if (!items.length) {
        stackEl.innerHTML = '';
        return;
    }
    let startIndex = Number.parseInt(stackEl.dataset.stackIndex || '0', 10);
    if (!Number.isFinite(startIndex) || startIndex < 0) startIndex = 0;
    if (startIndex >= items.length) startIndex = startIndex % items.length;
    stackEl.dataset.stackIndex = String(startIndex);
    stackEl.innerHTML = buildCardStackLayersMarkup(items, startIndex);
}

function cycleCardStack(stackEl, direction = 1) {
    if (!stackEl) return false;
    const items = parseCardStackItems(stackEl);
    if (items.length < 2) return false;
    if (stackEl.dataset.stackCycling === '1') return true;

    stackEl.dataset.stackCycling = '1';
    const ownerCard = stackEl.closest('.listing-card');
    let startIndex = Number.parseInt(stackEl.dataset.stackIndex || '0', 10);
    if (!Number.isFinite(startIndex)) startIndex = 0;
    const normalizeIndex = (idx) => ((idx % items.length) + items.length) % items.length;
    let nextIndex = normalizeIndex(startIndex + direction);
    let targetId = normalizePersonId(items[nextIndex]?.id);
    let targetPerson = targetId ? mapListingsContext.peopleById?.[targetId] : null;

    // If target person is available, slide to that actual card data.
    if (ownerCard && targetPerson) {
        const sourceId = normalizePersonId(ownerCard?.dataset?.id || items[startIndex]?.id);
        const sourcePerson = sourceId ? mapListingsContext.peopleById?.[sourceId] : null;
        const replacedCard = replaceStackOwnerCard(ownerCard, targetPerson, direction, sourcePerson);
        if (!replacedCard) {
            stackEl.dataset.stackIndex = String(nextIndex);
            renderCardStackLayers(stackEl);
            stackEl.dataset.stackCycling = '0';
            return true;
        }
        stackEl.dataset.stackCycling = '0';
        if (targetPerson?._id) {
            enableRelationshipOverlay();
            setRelationshipFocusPerson(targetPerson._id);
        }
        animateMapTraversalBetweenPeople(sourcePerson, targetPerson).then((animated) => {
            if (!animated) {
                focusPersonOnMap(targetPerson);
            }
        });
        return true;
    }

    // Fallback: rotate decorative stack items.
    const leadLayer = stackEl.querySelector('.listing-card-stack-layer[data-layer-pos="1"]');
    if (leadLayer) leadLayer.classList.add('is-leaving');
    window.setTimeout(() => {
        stackEl.dataset.stackIndex = String(nextIndex);
        renderCardStackLayers(stackEl);
        stackEl.dataset.stackCycling = '0';
    }, 150);

    return true;
}

function initCardStackDelegation() {
    if (mapListingsContext.cardStackDelegationBound) return;

    document.addEventListener('pointerdown', (ev) => {
        const stackEl = ev.target?.closest?.('.listing-card-stack');
        if (!stackEl) return;
        stackEl.dataset.stackStartY = String(ev.clientY);
        stackEl.dataset.stackStartX = String(ev.clientX);
    }, true);

    document.addEventListener('pointerup', (ev) => {
        const stackEl = ev.target?.closest?.('.listing-card-stack');
        if (!stackEl) return;

        const startY = Number.parseFloat(stackEl.dataset.stackStartY || 'NaN');
        const startX = Number.parseFloat(stackEl.dataset.stackStartX || 'NaN');
        delete stackEl.dataset.stackStartY;
        delete stackEl.dataset.stackStartX;

        if (!Number.isFinite(startY) || !Number.isFinite(startX)) return;

        const dy = startY - ev.clientY;
        const dx = Math.abs(startX - ev.clientX);
        const swipeUp = dy > 14 && dx < 24;
        const tap = Math.abs(dy) < 8 && dx < 8;
        if (!swipeUp && !tap) return;

        ev.preventDefault();
        ev.stopPropagation();
        if (cycleCardStack(stackEl, 1)) {
            stackEl.dataset.stackConsumeClick = '1';
            window.setTimeout(() => {
                if (stackEl.dataset.stackConsumeClick === '1') {
                    delete stackEl.dataset.stackConsumeClick;
                }
            }, 260);
        }
    }, true);

    mapListingsContext.cardStackDelegationBound = true;
}

function buildCardStackLayersHtml(person) {
    const stackItems = getRelatedStackCards(person, 8);
    if (!stackItems.length) return '';
    return buildPersistentCardStackHtml(stackItems, 0);
}

function buildCardStackControlsHtml() {
    return `<div class="listing-card-stack-controls" aria-hidden="false">
        <button type="button" class="listing-card-stack-btn listing-card-stack-btn-prev" data-stack-dir="-1" aria-label="${escapeAttr(tf('index.prevRelatedCard', 'کارت مرتبط قبلی', 'Previous related card'))}" title="${escapeAttr(tf('index.prevRelatedCard', 'کارت مرتبط قبلی', 'Previous related card'))}">&larr;</button>
        <button type="button" class="listing-card-stack-btn listing-card-stack-btn-next" data-stack-dir="1" aria-label="${escapeAttr(tf('index.nextRelatedCard', 'کارت مرتبط بعدی', 'Next related card'))}" title="${escapeAttr(tf('index.nextRelatedCard', 'کارت مرتبط بعدی', 'Next related card'))}">&rarr;</button>
    </div>`;
}

function buildListingImageBlock(person, images, fullName) {
    const normalizedImages = Array.isArray(images) ? images : [];
    const image = normalizedImages[0] || '';
    if (!image) return '';
    const imagesJson = escapeAttr(JSON.stringify(normalizedImages));
    return `<div class="listing-image" data-images="${imagesJson}">
        <img src="${escapeAttr(image)}" alt="${escapeAttr(fullName || '')}" loading="lazy" class="listing-thumb">
    </div>`;
}

/**
 * Build popup HTML for a map marker so it looks exactly like the listing card in the sidebar.
 * Same structure: listing-card, listing-card-row, listing-content (name, address, tags, actions), optional image.
 * Uses same CSS classes as #listingsList .listing-card so styling matches.
 */
function buildMapPopupCardHtml(p) {
    const loc = p.location?.coordinates;
    const lat = loc?.[1];
    const lng = loc?.[0];
    const addr = normalizeText(p.address).substring(0, 80);
    const tagsInfo = formatPersonTagsForCard(p, 3);
    const images = getPersonImages(p);
    const fullName = getPersonFullName(p);
    const nameHtml = `<h3 class="listing-name">${fullName || ' '}</h3>`;
    const imageBlock = buildListingImageBlock(p, images, fullName);
    const cardStackHtml = buildCardStackLayersHtml(p);
    const cardStackControlsHtml = cardStackHtml ? buildCardStackControlsHtml() : '';
    const cardStackClass = cardStackHtml ? ' has-card-stack' : '';
    const hasCoords = lat != null && lng != null;
    const vs = p.voteSummary || {};
    const likes = vs.likes || 0;
    const dislikes = vs.dislikes || 0;
    const userVote = p.userVote || '';
    const commentCount = p.commentCount ?? (p.comments || []).length;
    const postCaps = getPostManagementCapabilities(p);
    const bookmarkBtn = buildBookmarkButtonHtml(p);
    const addressLine = addr
        ? `<p class="listing-address${hasCoords ? ' listing-address-clickable' : ''}" ${hasCoords ? `data-lat="${lat}" data-lng="${lng}"` : ''}>${escapeHtml(addr)}</p>`
        : '';
    const tagsBlock = tagsInfo.shortText
        ? `<p class="listing-tags" title="${escapeAttr(tagsInfo.fullText)}">${escapeHtml(tagsInfo.shortText)}</p>`
        : '';
    const actionsBlock = `<div class="listing-actions">
        <div class="listing-votes">
            <button type="button" class="listing-vote-btn ${userVote === 'like' ? 'active' : ''}" data-type="like" data-id="${p._id}" title="Like">👍 <span class="vote-count">${likes}</span></button>
            <button type="button" class="listing-vote-btn ${userVote === 'dislike' ? 'active' : ''}" data-type="dislike" data-id="${p._id}" title="Dislike">👎 <span class="vote-count">${dislikes}</span></button>
        </div>
        <button type="button" class="listing-comment-btn" data-id="${p._id}" title="Comments">💬 <span class="comment-count">${commentCount}</span></button>
        ${bookmarkBtn}
        ${buildManageActionsHtml(p, postCaps)}
    </div>`;
    const shareCorner = `<div class="listing-share-corner"><button type="button" class="listing-share-btn" data-id="${p._id}" data-name="${escapeAttr(fullName)}" title="${escapeAttr(t('index.share') || 'Share')}" aria-label="${escapeAttr(t('index.share') || 'Share')}">${getShareButtonInnerHtml()}</button></div>`;
    return `<div class="listing-card listing-card-popup${cardStackClass}" data-id="${p._id}" data-lat="${lat ?? ''}" data-lng="${lng ?? ''}" data-likes="${likes}" data-dislikes="${dislikes}" data-user-vote="${escapeAttr(userVote)}">
        ${cardStackHtml}
        ${cardStackControlsHtml}
        ${shareCorner}
        <div class="listing-card-row">
            <div class="listing-content">
                <div class="listing-content-top">
                    ${nameHtml}
                    ${addressLine}
                    ${tagsBlock}
                </div>
                ${actionsBlock}
            </div>
            ${imageBlock}
        </div>
    </div>`;
}

/**
 * Update map markers
 */
function updateMarkers(people) {
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance) return;

    (mapListingsContext.markers || []).forEach(m => { try { mapInstance.removeLayer(m); } catch (_) {} });
    mapListingsContext.markers = [];
    mapListingsContext.markersByPersonId = {};

    if (!people || people.length === 0) {
        console.log('No listings to display on map');
        return;
    }

    people.forEach(p => {
        const loc = p.location?.coordinates;
        if (!loc || loc.length < 2) return;
        const lng = loc[0];
        const lat = loc[1];
        const popupHtml = buildMapPopupCardHtml(p);
        const marker = L.marker([lat, lng])
            .bindPopup(popupHtml, { className: 'listing-popup-wrapper' })
            .addTo(mapInstance);
        marker.on('popupopen', () => {
            if (p && p._id) {
                setRelationshipFocusPerson(p._id);
            }
        });
        mapListingsContext.markers.push(marker);
        if (p._id) mapListingsContext.markersByPersonId[p._id] = marker;
    });
    console.log(`Added ${mapListingsContext.markers.length} markers to map`);
}

/** Last count passed to updateListingsCount so we can refresh label on language change */
let lastListingsCountCurrent = 0;
let lastListingsCountTotal = null;

/**
 * Update listings count display. Uses translated label (e.g. "مورد" for Persian, "listings" for English).
 */
function updateListingsCount(current, total) {
    const safeCurrent = Number.isFinite(current) ? current : 0;
    const safeTotal = Number.isFinite(total) ? total : safeCurrent;
    lastListingsCountCurrent = safeCurrent;
    lastListingsCountTotal = safeTotal;
    const totalStr = safeTotal;
    mapListingsContext.withAddressTotal = safeTotal;
    let label = t('index.listingsCount');
    /* Never show raw key if i18n not ready; default to Persian "مورد" */
    if (!label || label === 'index.listingsCount') {
        label = 'مورد';
    }
    const el = document.getElementById('listingsCount');
    if (el) {
        el.textContent = `${totalStr} ${label}`;
    }
    const mobileEl = document.getElementById('mobileListingsCount');
    if (mobileEl) {
        mobileEl.innerHTML = `${totalStr} <span>${label}</span>`;
    }
    const tabCountEl = document.getElementById('withAddressTabCount');
    if (tabCountEl) {
        tabCountEl.textContent = String(totalStr);
    }
    const inlineCaptionEl = document.getElementById('withAddressInlineCaption');
    if (inlineCaptionEl) {
        let heading = t('index.listingsHeading');
        if (!heading || heading === 'index.listingsHeading') heading = 'فهرست افراد';
        inlineCaptionEl.textContent = `${heading} ${totalStr} ${label}`;
    }
}

/**
 * Switch between filters-side tabs:
 * - without-address: people missing exact address
 * - with-address: viewport listings with coordinates/address
 */
function setPeopleTab(tab) {
    const normalized = tab === 'with-address' ? 'with-address' : 'without-address';
    const previousTab = mapListingsContext.peopleTab || null;
    mapListingsContext.peopleTab = normalized;

    const tabButtons = document.querySelectorAll('#filtersPeopleTabs .people-tab-btn');
    tabButtons.forEach((btn) => {
        const active = btn.dataset.peopleTab === normalized;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const panels = document.querySelectorAll('#filtersPeopleContent .people-tab-panel');
    panels.forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.peopleTabPanel === normalized);
    });

    // Keep mobile list tabs visually in sync with the people address tab.
    document.querySelectorAll('#mobileListTabs .mobile-list-tab').forEach((btn) => {
        const raw = String(btn.dataset.mobileListTab || '').toLowerCase();
        const isWith = raw === 'with' || raw === 'with-address';
        const active = normalized === 'with-address' ? isWith : !isWith;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // On phone, show one list full-width instead of two cramped columns.
    const isWithout = normalized === 'without-address';
    document.body.classList.toggle('mobile-list-show-without', isWithout);
    document.body.classList.toggle('mobile-list-show-with', !isWithout);

    if (previousTab !== normalized && window.analyticsTracker?.trackTabChange) {
        window.analyticsTracker.trackTabChange({
            tabGroup: 'people_address',
            tabName: normalized,
            previousTab,
            appZone: 'people_tabs',
            label: normalized,
            source: 'setPeopleTab'
        });
    }
}

/**
 * Initialize tab UI in filters header. Safe to call multiple times.
 */
function initPeopleTabs() {
    const tabsRoot = document.getElementById('filtersPeopleTabs');
    if (tabsRoot) {
        if (tabsRoot.dataset.bound !== '1') {
            tabsRoot.addEventListener('click', (ev) => {
                const btn = ev.target.closest('.people-tab-btn');
                if (!btn) return;
                ev.preventDefault();
                setPeopleTab(btn.dataset.peopleTab);
            });
            tabsRoot.dataset.bound = '1';
        }
        setPeopleTab(mapListingsContext.peopleTab);
    }

    // Mobile with/without-address tabs were present in HTML but not previously wired.
    const mobileTabs = document.getElementById('mobileListTabs');
    if (mobileTabs && mobileTabs.dataset.bound !== '1') {
        mobileTabs.dataset.bound = '1';
        mobileTabs.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.mobile-list-tab,[data-mobile-list-tab]');
            if (!btn) return;
            ev.preventDefault();
            const raw = String(btn.dataset.mobileListTab || '').toLowerCase();
            const next = (raw === 'with' || raw === 'with-address') ? 'with-address' : 'without-address';
            setPeopleTab(next); // Tracks people_address; delegated analytics click also records the mobile tab zone.
        });
    }
}

/** localStorage key for persisting map filters so refresh keeps user's selection */
const FILTERS_STORAGE_KEY = 'mapListingsFilters';

/**
 * Read saved province/section/country/role from localStorage (so refresh doesn't reset to default).
 */
function getSavedFilters() {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FILTERS_STORAGE_KEY) : null;
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (e) {
        return {};
    }
}

/**
 * Save current filter values to localStorage so they are restored on refresh.
 */
function saveFilters() {
    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    const countrySwitcher = document.getElementById('countrySwitcher');
    const roleSelect = document.getElementById('roleFilter');
    try {
        const state = {
            province: provinceSelect?.value?.trim() || '',
            section: sectionSelect?.value?.trim() || '',
            country: countrySwitcher?.value?.trim() || 'fa',
            role: roleSelect?.value?.trim() || ''
        };
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(state));
        }
    } catch (e) {
        console.warn('Could not save filters to localStorage:', e.message);
    }
}

function getAllRolesOptionLabel() {
    let label = t('index.roleAll');
    if (!label || label === 'index.roleAll') {
        label = isPersianLanguage() ? 'همه نقش‌ها' : 'All Roles';
    }
    return label;
}

function normalizeTagList(rawTags) {
    if (!Array.isArray(rawTags)) return [];
    const seen = new Set();
    const out = [];
    rawTags.forEach((tag) => {
        const text = normalizeText(typeof tag === 'string' ? tag : (tag && tag.name));
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
    });
    return out;
}

/**
 * Load role/tag options dynamically from the backend catalog managed by Almighty.
 * Rebuilds all roleFilter selects (there are two in index.html for current + legacy layout).
 */
async function loadRoleFilterOptions() {
    const selects = Array.from(document.querySelectorAll('select#roleFilter'));
    if (!selects.length) return;

    const saved = getSavedFilters();
    const currentSelected = normalizeText(selects[0].value);
    const preferredRole = currentSelected || normalizeText(saved.role);

    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/tags`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data?.success || !data?.data) throw new Error(data?.message || 'Invalid tags response');

        const tags = normalizeTagList(data.data.tags);
        if (!tags.length) {
            console.warn('Tags API returned empty list, keeping existing role options');
            return;
        }

        const firstOptionLabel = getAllRolesOptionLabel();
        const optionsHtml = [
            `<option value="">${escapeHtml(firstOptionLabel)}</option>`,
            ...tags.map((tag) => (
                `<option value="${escapeHtml(tag)}" data-name="${escapeHtml(tag)}" data-namefa="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`
            ))
        ].join('');

        selects.forEach((select) => {
            const previousValue = normalizeText(select.value);
            select.innerHTML = optionsHtml;
            const finalValue = previousValue || preferredRole;
            if (finalValue && tags.includes(finalValue)) {
                select.value = finalValue;
            } else {
                select.value = '';
            }
        });

        applyFilterCounts();
        saveFilters();
        console.log(`Loaded ${tags.length} dynamic role filter options from /people/tags`);

        // Tell the header logo rotator to pick up the live catalog (avoids stale static options).
        if (typeof window.refreshRotatingLogoFromRoleFilter === 'function') {
            window.refreshRotatingLogoFromRoleFilter();
        } else if (typeof window.initRotatingLogo === 'function') {
            window.initRotatingLogo();
        }
        document.dispatchEvent(new CustomEvent('roleFilterOptionsLoaded', { detail: { tags } }));
    } catch (err) {
        console.warn('Could not load dynamic role options; using static options:', err.message || err);
    }
}

/**
 * Load provinces. No "All Provinces" option (reduces server load when listing thousands).
 * Default: تهران. On refresh, restore saved province from localStorage if it exists in options.
 * @param {Object} opts - Optional: { forSharedPerson: person } - when set, use person's region or empty; skip saved filters.
 */
async function loadProvinces(opts) {
    opts = opts || {};
    const forSharedPerson = opts.forSharedPerson;
    const personForMap = opts.personForMap;

    const countrySwitcher = document.getElementById('countrySwitcher');
    const countryCode = countrySwitcher?.value || 'fa';
    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    if (!provinceSelect) return;

    console.log('Loading provinces for country:', countryCode);
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/provinces?country=${countryCode}`);
        const data = await res.json();
        if (!data.success || !data.data) {
            console.warn('Failed to load provinces:', data);
            return;
        }

        const provinces = data.data || [];
        console.log('Loaded', provinces.length, 'provinces');

        provinceSelect.innerHTML = provinces.map(p => {
            const name = p.nameFa || p.name || '';
            const nameEn = p.name || p.nameFa || '';
            return `<option value="${escapeHtml(name)}" data-name="${escapeHtml(nameEn)}" data-namefa="${escapeHtml(p.nameFa || p.name || '')}">${escapeHtml(name)}</option>`;
        }).join('');

        let selected = '';
        if (forSharedPerson && personForMap) {
            /* Shared link: use person's administrativeRegion or leave empty so viewport query returns them */
            const adm = personForMap.administrativeRegion || {};
            const provName = (adm.province || '').trim();
            if (provName && provinces.some(p => (p.nameFa || p.name || '').trim() === provName)) {
                selected = provName;
            }
            provinceSelect.value = selected;
            if (sectionSelect) {
                sectionSelect.innerHTML = '';
                sectionSelect.value = '';
            }
            if (selected) {
                await loadSections();
                const bakhsh = (adm.bakhsh || '').trim();
                const county = (adm.county || '').trim();
                const secName = bakhsh || county;
                if (secName && sectionSelect && sectionSelect.options.length) {
                    const optValues = Array.from(sectionSelect.options).map(o => o.value);
                    if (optValues.includes(secName)) sectionSelect.value = secName;
                }
            }
            applyFilterCounts();
            if (typeof window !== 'undefined' && window.languageManager) {
                window.languageManager.translatePage?.();
            }
            return;
        }

        const defaultProvince = 'تهران';
        const matchTehran = provinces.find((p) => normalizeRegionName(p.nameFa || p.name || '') === defaultProvince);
        if (matchTehran) {
            selected = matchTehran.nameFa || matchTehran.name || defaultProvince;
        } else if (provinces.length > 0) {
            selected = provinces[0].nameFa || provinces[0].name || '';
        }
        provinceSelect.value = selected;
        await loadSections();
        applyFilterCounts();
        if (typeof window !== 'undefined' && window.languageManager) {
            window.languageManager.translatePage?.();
        }
    } catch (err) {
        console.error('Error loading provinces:', err);
    }
}

/**
 * Load sections (counties/bakhsh) for the selected province.
 * @param {object} [options]
 * @param {string|null} [options.preferredSection] - Prefer this section after load (map click)
 * @param {string|null} [options.preferredLevel] - Preferred section level (county|bakhsh)
 * @param {boolean} [options.silent=false] - If true, do not auto-pick capital and do not fire change (avoids race overwrites)
 */
async function loadSections(options = {}) {
    const preferredSection = options.preferredSection || null;
    const preferredLevel = options.preferredLevel || null;
    const silent = Boolean(options.silent);

    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    if (!sectionSelect) return;

    const province = provinceSelect?.value?.trim() || '';
    sectionSelect.innerHTML = '';

    if (!province) {
        sectionSelect.value = '';
        applyFilterCounts();
        return;
    }

    const countrySwitcher = document.getElementById('countrySwitcher');
    const countryCode = countrySwitcher?.value || 'fa';

    console.log('Loading sections for province:', province);
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/sections?province=${encodeURIComponent(province)}&country=${countryCode}`);
        const data = await res.json();
        if (!data.success || !data.data) {
            applyFilterCounts();
            return;
        }

        const sections = data.data || [];
        console.log('Loaded', sections.length, 'sections for province:', province);

        sections.forEach(s => {
            const name = s.nameFa || s.name || '';
            const nameEn = s.name || s.nameFa || '';
            const level = s.level || 'county';
            const opt = document.createElement('option');
            opt.value = name;
            opt.dataset.level = level;
            opt.dataset.name = nameEn;
            opt.dataset.namefa = name;
            opt.textContent = name;
            sectionSelect.appendChild(opt);
        });

        const norm = (s) => normalizeRegionName(s || '');
        const optionValues = Array.from(sectionSelect.options).map(o => o.value);
        let selected = '';

        // Prefer exact map-click target first
        if (preferredSection) {
            const want = norm(preferredSection);
            for (let i = 0; i < sectionSelect.options.length; i++) {
                const opt = sectionSelect.options[i];
                const candidates = [opt.value, opt.dataset.name, opt.dataset.namefa, opt.textContent]
                    .map((x) => norm(x));
                const levelOk = !preferredLevel || !opt.dataset.level || opt.dataset.level === preferredLevel;
                if (levelOk && candidates.includes(want)) {
                    selected = opt.value;
                    break;
                }
            }
            // If not in list yet, inject so filtering can still use the API section name
            if (!selected && preferredSection) {
                const opt = document.createElement('option');
                opt.value = preferredSection;
                opt.dataset.level = preferredLevel || 'county';
                opt.dataset.name = preferredSection;
                opt.dataset.namefa = preferredSection;
                opt.textContent = preferredSection;
                sectionSelect.appendChild(opt);
                selected = preferredSection;
            }
        }

        if (!selected && !silent) {
            const capital = PROVINCE_CAPITALS[province];
            if (capital && optionValues.includes(capital)) {
                selected = capital;
            } else if (province === 'تهران' && optionValues.includes('تهران')) {
                selected = 'تهران';
            } else if (optionValues.length > 0) {
                selected = optionValues[0];
            }
        }

        sectionSelect.value = selected;
        // Only fire change for normal UI interactions — silent map-click path reloads itself
        if (!silent) {
            sectionSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        applyFilterCounts();
    } catch (err) {
        console.error('Error loading sections:', err);
    }
}

function normalizeRegionName(s) {
    if (!s || typeof s !== 'string') return '';
    return s
        .replace(/\u200C/g, ' ')
        .replace(/ك/g, 'ک')
        .replace(/ي/g, 'ی')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Province capital (مرکز استان) – section name to auto-select when user selects that province.
 * Keys: normalized province name. Values: section name as returned by API (county/bakhsh).
 * Used so selecting a province automatically selects its capital section and draws that border.
 */
const PROVINCE_CAPITALS = {
    'آذربایجان شرقی': 'تبریز',
    'آذربایجان غربی': 'ارومیه',
    'اردبیل': 'اردبیل',
    'اصفهان': 'اصفهان',
    'البرز': 'کرج',
    'ایلام': 'ایلام',
    'بوشهر': 'بوشهر',
    'تهران': 'تهران',
    'چهارمحال و بختیاری': 'شهرکرد',
    'خراسان جنوبی': 'بیرجند',
    'خراسان رضوی': 'مشهد',
    'خراسان شمالی': 'بجنورد',
    'خوزستان': 'اهواز',
    'زنجان': 'زنجان',
    'سمنان': 'سمنان',
    'سیستان و بلوچستان': 'زاهدان',
    'فارس': 'شیراز',
    'قزوین': 'قزوین',
    'قم': 'قم',
    'کردستان': 'سنندج',
    'کرمان': 'کرمان',
    'کرمانشاه': 'کرمانشاه',
    'کهگیلویه و بویراحمد': 'یاسوج',
    'گلستان': 'گرگان',
    'گیلان': 'رشت',
    'لرستان': 'خرم آباد',
    'مازندران': 'ساری',
    'مرکزی': 'اراک',
    'هرمزگان': 'بندر عباس',
    'همدان': 'همدان',
    'یزد': 'یزد'
};

function normalizeCountsMap(counts) {
    const out = {};
    if (!counts) return out;
    Object.entries(counts).forEach(([key, count]) => {
        const n = normalizeRegionName(key);
        if (n) out[n] = (out[n] || 0) + count;
    });
    return out;
}

function applyCountsToSelect(select, countsMap) {
    if (!select || !countsMap) return;
    const norm = normalizeCountsMap(countsMap);
    Array.from(select.options).forEach(opt => {
        if (!opt.value) return;
        if (!opt.dataset.originalText) opt.dataset.originalText = opt.textContent.trim();
        const candidates = [opt.dataset.name, opt.dataset.namefa, opt.value, opt.dataset.originalText];
        let count = 0;
        for (const c of candidates) {
            const n = normalizeRegionName(c);
            if (n && norm[n] !== undefined) { count = norm[n]; break; }
        }
        opt.textContent = `${opt.dataset.originalText} (${count})`;
    });
}

function applyCountryCounts(select, countries) {
    if (!select || !countries) return;
    Array.from(select.options).forEach(opt => {
        if (!opt.value) return;
        if (!opt.dataset.originalText) opt.dataset.originalText = opt.textContent.trim();
        const count = countries[opt.value] ?? 0;
        opt.textContent = `${opt.dataset.originalText} (${count})`;
    });
}

async function fetchFilterCounts() {
    try {
        const res = await fetch(`${MAP_API_BASE_URL}/people/counts`);
        if (!res.ok) return;
        const result = await res.json();
        if (!result?.success || !result.data) return;
        filterCounts = result.data;
        applyFilterCounts();
    } catch (err) {
        console.error('Error fetching filter counts:', err);
    }
}

function applyFilterCounts() {
    if (!filterCounts) return;
    const countrySelect = document.getElementById('countrySwitcher');
    if (countrySelect) applyCountryCounts(countrySelect, filterCounts.countries || {});
    const provinceSelect = document.getElementById('provinceFilter');
    if (provinceSelect) applyCountsToSelect(provinceSelect, filterCounts.provinces || {});
    const sectionSelect = document.getElementById('sectionFilter');
    if (sectionSelect) applyCountsToSelect(sectionSelect, filterCounts.sections || {});
    const roleSelect = document.getElementById('roleFilter');
    if (roleSelect) applyCountsToSelect(roleSelect, filterCounts.roles || {});
}

/**
 * ============================================
 * Clear Boundary Border
 * ============================================
 * Removes the red boundary layer from the map (e.g. when filters are cleared or region has no border).
 * Logs for debugging and learning.
 */
function clearBoundaryBorder() {
    const mapInstance = mapListingsContext.map || map;
    if (!boundaryLayer || !mapInstance) return;
    try {
        mapInstance.removeLayer(boundaryLayer);
        boundaryLayer = null;
        console.log('Boundary border cleared from map');
    } catch (err) {
        console.warn('Error clearing boundary border:', err);
        boundaryLayer = null;
    }
}

/**
 * ============================================
 * Draw Boundary Border on Map
 * ============================================
 * Fetches boundary geometry from API and draws it as a red border on the map.
 * Used when user selects a province or section so the selected region is visible.
 *
 * @param {string} name - Boundary name (e.g. province name or section/county name)
 * @param {string} level - Boundary level: 'province' | 'county' | 'bakhsh' | 'city'
 * @param {boolean} [fitMap=true] - If true, fit map view to the boundary; if false, only draw the border (e.g. on map click).
 */
async function drawBoundaryBorder(name, level, fitMap = true) {
    const mapInstance = mapListingsContext.map || map;
    if (!name || !level || !mapInstance) {
        console.warn('drawBoundaryBorder: missing name, level, or map');
        return;
    }
    /* Strip trailing " (N)" from province/section names (e.g. "مازندران (0)") so boundary API receives clean name */
    const cleanName = (name || '').toString().replace(/\s*\(\d+\)\s*$/, '').trim() || name;
    try {
        console.log('Fetching boundary geometry for:', cleanName, '(' + level + ')');
        const url = `${MAP_API_BASE_URL}/people/boundary?name=${encodeURIComponent(cleanName)}&level=${encodeURIComponent(level)}`;
        const res = await fetch(url);
        const result = await res.json();

        if (!result.success || !result.data) {
            // County/bakhsh names sometimes exist under the other level — retry once
            if (res.status === 404 && (level === 'county' || level === 'bakhsh')) {
                const altLevel = level === 'county' ? 'bakhsh' : 'county';
                console.warn('Boundary not found at', level, '- retrying as', altLevel, cleanName);
                return drawBoundaryBorder(cleanName, altLevel, fitMap);
            }
            if (res.status === 404) {
                console.warn('Boundary not found:', name, level);
                if (typeof window !== 'undefined' && window.showAlert) {
                    try {
                        const msg = (typeof t === 'function' && t('index.boundaryNotFound')) || 'Boundary for this region could not be loaded. Try selecting another province or section.';
                        window.showAlert(msg, 'warning');
                    } catch (e) { /* ignore */ }
                }
            } else {
                console.warn('Boundary API error:', result.message || res.statusText);
            }
            return;
        }

        const geoJSON = result.data;
        clearBoundaryBorder();

        /* Draw boundary from API (backend serves correct geometry from provinces.json for بوشهر/مازندران) */
        boundaryLayer = L.geoJSON(geoJSON, {
            style: {
                color: '#ff0000',
                weight: 3,
                opacity: 0.8,
                fillColor: '#ff0000',
                fillOpacity: 0.1
            }
        }).addTo(mapInstance);

        if (fitMap) {
            // Prefer bounds from the actual drawn layer (real geometry) over API bbox
            let bounds = boundaryLayer.getBounds && boundaryLayer.getBounds();
            const hasValidBounds = bounds && (
                (Array.isArray(bounds) && bounds.length >= 2) ||
                (typeof bounds.isValid === 'function' && bounds.isValid()) ||
                (bounds.getSouthWest && bounds.getNorthEast)
            );
            if (!hasValidBounds && geoJSON.bbox && Array.isArray(geoJSON.bbox) && geoJSON.bbox.length >= 4) {
                bounds = [[geoJSON.bbox[1], geoJSON.bbox[0]], [geoJSON.bbox[3], geoJSON.bbox[2]]];
            }
            if (bounds && (Array.isArray(bounds) ? bounds.length >= 2 : (bounds.isValid && bounds.isValid()))) {
                mapListingsContext.isProgrammaticMovement = true;
                mapInstance.fitBounds(Array.isArray(bounds) ? bounds : bounds, { padding: [50, 50] });
                setTimeout(() => { mapListingsContext.isProgrammaticMovement = false; }, 500);
            }
        }
        console.log('Boundary border drawn:', cleanName, level);
    } catch (err) {
        console.error('Error drawing boundary border:', err);
    }
}

/**
 * Re-draw the selected region border from current province/section dropdowns.
 * Called when user clicks the map so the selected section border is visible.
 * @param {boolean} [fitMap=false] - When true, fit map to boundary; when false (e.g. on map click), only redraw border.
 */
function refreshSelectedRegionBorder(fitMap = false) {
    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    const province = provinceSelect?.value?.trim() || '';
    const section = sectionSelect?.value?.trim() || '';
    const sectionLevel = sectionSelect?.selectedOptions?.[0]?.dataset?.level || 'county';

    if (section) {
        drawBoundaryBorder(section, sectionLevel, fitMap);
    } else if (province) {
        drawBoundaryBorder(province, 'province', fitMap);
    } else {
        clearBoundaryBorder();
    }
}

/**
 * Known bounding boxes for provinces whose DB geometry is wrong (point-in-polygon fails).
 * Used so map clicks in these areas still select the correct province.
 * Format: [minLng, minLat, maxLng, maxLat].
 */
const KNOWN_PROVINCE_BOXES = {
    'مازندران': [50.2, 35.5, 54.2, 36.9],
    'بوشهر': [50.5, 27.5, 52.2, 29.5],
    'هرمزگان': [52.5, 25.5, 59, 28.5]
};

/**
 * If point (lat, lng) falls inside a known province box, return that province name; else null.
 */
function getProvinceFromKnownBox(lat, lng) {
    for (const [name, bbox] of Object.entries(KNOWN_PROVINCE_BOXES)) {
        const [minLng, minLat, maxLng, maxLat] = bbox;
        if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
            return name;
        }
    }
    return null;
}

/**
 * ============================================
 * Select Region by Map Click (Point-in-Polygon)
 * ============================================
 * When user clicks the map, find which province/section contains that point,
 * set the province and section dropdowns to that region, draw the border, and reload listings.
 * This is the original behavior: "click on map â†’ select that section".
 *
 * @param {number} lat - Latitude of the clicked point
 * @param {number} lng - Longitude of the clicked point
 */
async function selectRegionByPoint(lat, lng) {
    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    if (!provinceSelect || !sectionSelect) return;

    clearTimeout(debounceTimer); // cancel pending moveend reload so it cannot overwrite this selection
    debounceTimer = null;
    regionClickToken += 1;
    const clickToken = regionClickToken;

    try {
        console.log('Map clicked: fetching region at', lat, lng);
        const url = `${MAP_API_BASE_URL}/people/regions-by-point?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`;
        const res = await fetch(url);
        const result = await res.json();
        if (clickToken !== regionClickToken) return; // a newer map click superseded this one

        if (!result.success || !result.data) {
            console.warn('No region found for point:', lat, lng, result.message || '');
            return;
        }

        let data = result.data;
        let provinceName = data.province || data.provinceFa || null;
        let provinceNameFa = data.provinceFa || data.province || null;
        let countyName = data.county || data.countyFa || null;
        let countyNameFa = data.countyFa || data.county || null;
        let bakhshName = data.bakhsh || data.bakhshFa || null;
        let bakhshNameFa = data.bakhshFa || data.bakhsh || null;

        /* Client-side fallback: when API returns no province (e.g. bad DB geometry for مازندران/بوشهر), use known bbox */
        if (!provinceName) {
            const knownProvince = getProvinceFromKnownBox(lat, lng);
            if (knownProvince) {
                console.log('Using known province box for point (API returned no province):', knownProvince);
                provinceName = knownProvince;
                provinceNameFa = knownProvince;
                countyName = countyName || null;
                countyNameFa = countyNameFa || null;
                bakhshName = bakhshName || null;
                bakhshNameFa = bakhshNameFa || null;
            } else {
                console.warn('No province in API response for point:', lat, lng, '- region may be in sea or outside boundaries');
                return;
            }
        }

        const normRegion = (s) => (s || '').replace(/\uFEFF/g, '').replace(/\s+/g, ' ').replace(/ك/g, 'ک').replace(/ي/g, 'ی').replace(/ى/g, 'ی').trim();

        /* Set province: try nameFa first (matches dropdown from JSON), then name; use normalized match and option text */
        let provinceSet = false;
        const provinceCandidates = [provinceNameFa, provinceName].filter(Boolean);
        const normProvince = normRegion(provinceName);
        for (let i = 0; i < provinceSelect.options.length; i++) {
            const opt = provinceSelect.options[i];
            const v = (opt.value || '').trim();
            const n = (opt.dataset.name || '').trim();
            const fa = (opt.dataset.namefa || '').trim();
            const text = (opt.textContent || '').trim();
            const match = provinceCandidates.some(c => c === v || c === n || c === fa || c === text)
                || (normProvince && (normRegion(v) === normProvince || normRegion(n) === normProvince || normRegion(fa) === normProvince || normRegion(text) === normProvince));
            if (match) {
                provinceSelect.selectedIndex = i;
                provinceSet = true;
                break;
            }
        }
        if (!provinceSet) {
            const tryProvinceValues = [provinceNameFa, provinceName].filter(Boolean);
            for (const tryVal of tryProvinceValues) {
                provinceSelect.value = tryVal;
                if (provinceSelect.value === tryVal) {
                    provinceSet = true;
                    break;
                }
            }
            if (!provinceSet) {
                console.warn('Province not found in dropdown:', provinceName, provinceNameFa);
                await drawBoundaryBorder(provinceNameFa || provinceName, 'province', true);
                if (clickToken !== regionClickToken) return;
                mapListingsContext.viewportPage = 1;
                await Promise.all([loadListingsForViewport(), loadPeopleWithoutAddress()]);
                console.log('Region selected by map click (province only, no dropdown match):', { province: provinceName });
                return;
            }
        }

        /* Load sections silently for selected province, preferring the clicked section (no capital auto-select race). */
        const preferredSectionName = bakhshNameFa || bakhshName || countyNameFa || countyName || null;
        const preferredSectionLevel = (bakhshName || bakhshNameFa) ? 'bakhsh' : 'county';
        await loadSections({
            preferredSection: preferredSectionName,
            preferredLevel: preferredSectionLevel,
            silent: true
        });
        if (clickToken !== regionClickToken) return;

        const sectionName = bakhshName || countyName || null;
        const sectionNameFa = bakhshNameFa || countyNameFa || (bakhshName || countyName) || null;
        const sectionLevel = preferredSectionLevel;

        if (sectionName || sectionNameFa) {
            const nameToUse = sectionSelect.value || sectionNameFa || sectionName;
            const normSection = normRegion(nameToUse);
            let sectionSet = Boolean(sectionSelect.value);
            if (!sectionSet) {
                for (let i = 0; i < sectionSelect.options.length; i++) {
                    const opt = sectionSelect.options[i];
                    if (!opt.value) continue;
                    const v = (opt.value || '').trim();
                    const n = (opt.dataset.name || '').trim();
                    const fa = (opt.dataset.namefa || '').trim();
                    const text = (opt.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim();
                    const match = (nameToUse && (v === nameToUse || n === nameToUse || fa === nameToUse || text === nameToUse))
                        || (sectionName && (v === sectionName || n === sectionName || fa === sectionName || text === sectionName))
                        || (sectionNameFa && (v === sectionNameFa || n === sectionNameFa || fa === sectionNameFa || text === sectionNameFa))
                        || (normSection && (normRegion(v) === normSection || normRegion(n) === normSection || normRegion(fa) === normSection || normRegion(text) === normSection));
                    if (match) {
                        sectionSelect.selectedIndex = i;
                        sectionSet = true;
                        break;
                    }
                }
            }
            if (!sectionSet) {
                const trySectionValues = [nameToUse, sectionNameFa, sectionName].filter(Boolean);
                for (const val of trySectionValues) {
                    sectionSelect.value = val;
                    if (sectionSelect.value === val) {
                        sectionSet = true;
                        break;
                    }
                }
            }
            if (!sectionSet && preferredSectionName) {
                const opt = document.createElement('option');
                opt.value = preferredSectionName;
                opt.dataset.level = sectionLevel;
                opt.dataset.name = sectionName || preferredSectionName;
                opt.dataset.namefa = sectionNameFa || preferredSectionName;
                opt.textContent = preferredSectionName;
                sectionSelect.appendChild(opt);
                sectionSelect.value = preferredSectionName;
                sectionSet = true;
            }

            const nameForBoundary = sectionSelect.value || preferredSectionName || nameToUse;
            const levelForBoundary = sectionSelect.selectedOptions?.[0]?.dataset?.level || sectionLevel;
            await drawBoundaryBorder(nameForBoundary, levelForBoundary, true);
        } else {
            // No county/bakhsh from point — only then show province outline
            await drawBoundaryBorder(provinceNameFa || provinceName, 'province', true);
        }
        if (clickToken !== regionClickToken) return;

        saveFilters();
        mapListingsContext.viewportPage = 1;
        mapListingsContext.viewportNextCursor = '';
        mapListingsContext.noAddressNextCursor = '';
        await Promise.all([
            loadListingsForViewport(),
            loadPeopleWithoutAddress()
        ]);
        console.log('Region selected by map click:', {
            province: provinceSelect.value,
            section: sectionSelect.value,
            sectionLevel: sectionSelect.selectedOptions?.[0]?.dataset?.level || null,
            county: countyName,
            bakhsh: bakhshName
        });
    } catch (err) {
        console.error('Error selecting region by point:', err);
    }
}

/**
 * Setup viewport-based loading and filter handlers
 */
function setupViewportLoading() {
    const mapInstance = mapListingsContext.map || map;
    if (!mapInstance) return;

    const onViewportChange = () => {
        if (mapListingsContext.isProgrammaticMovement) {
            console.log('Programmatic movement detected, skipping reload (flag:', mapListingsContext.isProgrammaticMovement, ')');
            return;
        }
        if (isSharedFocusMode()) {
            exitSharedFocusMode('map movement');
        }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (!mapListingsContext.initialBoundsSet) {
                mapListingsContext.initialBoundsSet = true;
                console.log('Initial bounds set, programmatic movements will not trigger reloads');
            }
            mapListingsContext.viewportPage = 1;
            loadListingsForViewport();
        }, DEBOUNCE_MS);
    };

    mapInstance.on('moveend', onViewportChange);
    mapInstance.on('zoomend', onViewportChange);

    /* When user clicks the map, select the section that contains the clicked point:
       call API regions-by-point, set province/section dropdowns, draw border, reload listings. */
    mapInstance.on('click', (e) => {
        clearTimeout(debounceTimer); // stop queued pan/zoom reloads before region select runs
        debounceTimer = null;
        if (isSharedFocusMode()) exitSharedFocusMode('map click');
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        selectRegionByPoint(lat, lng);
    });

    console.log('Setting up viewport-based loading...');
    console.log('Viewport loading setup complete');
}

/**
 * Setup cascading filters and apply/clear buttons
 */
function setupFilters() {
    const countrySwitcher = document.getElementById('countrySwitcher');
    const provinceSelect = document.getElementById('provinceFilter');
    const sectionSelect = document.getElementById('sectionFilter');
    const roleSelect = document.getElementById('roleFilter');
    const sortSelect = document.getElementById('sortFilter');
    const relationshipModeSelect = document.getElementById('relationshipOverlayMode');
    const relationshipTypeSelect = document.getElementById('relationshipTypeFilter');
    const relationshipStrengthSelect = document.getElementById('relationshipStrengthFilter');
    const searchInput = document.getElementById('searchInput');
    const applyBtn = document.querySelector('.btn-apply-filters, [data-action="apply-filters"]');
    const clearBtn = document.querySelector('.btn-clear-filters, [data-action="clear-filters"]');

    const reload = () => {
        if (isSharedFocusMode()) exitSharedFocusMode('filters changed');
        mapListingsContext.viewportPage = 1;
        mapListingsContext.viewportNextCursor = '';
        mapListingsContext.noAddressNextCursor = '';
        loadListingsForViewport();
        loadPeopleWithoutAddress();
    };

    if (countrySwitcher) {
        countrySwitcher.addEventListener('change', async () => {
            clearBoundaryBorder();
            await loadProvinces();
            saveFilters();
            reload();
        });
    }
    if (provinceSelect) {
        provinceSelect.addEventListener('change', async () => {
            const province = provinceSelect.value?.trim() || '';
            if (!province) {
                clearBoundaryBorder();
                loadSections();
                saveFilters();
                reload();
                return;
            }
            await loadSections();
            const section = sectionSelect?.value?.trim() || '';
            const level = sectionSelect?.selectedOptions?.[0]?.dataset?.level || 'county';
            if (section) {
                drawBoundaryBorder(section, level);
            } else {
                drawBoundaryBorder(province, 'province');
            }
            saveFilters();
            reload();
        });
    }
    if (sectionSelect) {
        sectionSelect.addEventListener('change', () => {
            const province = provinceSelect?.value?.trim() || '';
            const section = sectionSelect.value?.trim() || '';
            const level = sectionSelect.selectedOptions?.[0]?.dataset?.level || 'county';
            if (section) {
                drawBoundaryBorder(section, level);
            } else if (province) {
                drawBoundaryBorder(province, 'province');
            } else {
                clearBoundaryBorder();
            }
            saveFilters();
            reload();
        });
    }
    if (roleSelect) {
        roleSelect.addEventListener('change', () => {
            saveFilters();
            reload();
        });
    }
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            saveFilters();
            reload();
        });
    }
    /* Single search and sort in combined header; reload refreshes both viewport list and no-address list */
    if (searchInput) {
        let searchDebounce;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(reload, 400);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); reload(); }
        });
    }

    if (applyBtn) applyBtn.addEventListener('click', reload);
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            clearBoundaryBorder();
            if (roleSelect) roleSelect.value = '';
            if (relationshipModeSelect) relationshipModeSelect.value = 'off';
            if (relationshipTypeSelect) relationshipTypeSelect.value = '';
            if (relationshipStrengthSelect) relationshipStrengthSelect.value = '1';
            if (searchInput) searchInput.value = '';
            if (sortSelect) sortSelect.value = 'likes:desc';
            if (provinceSelect) provinceSelect.value = 'تهران';
            await loadSections();
            const section = sectionSelect?.value?.trim() || '';
            const level = sectionSelect?.selectedOptions?.[0]?.dataset?.level || 'county';
            if (section) drawBoundaryBorder(section, level);
            saveFilters();
            reload();
            mapListingsContext.relationshipsEnabled = false;
            mapListingsContext.relationshipTypeFilter = '';
            mapListingsContext.relationshipMinStrength = 1;
            clearRelationshipOverlay();
        });
    }
    console.log('Cascading filters setup complete');
}

/**
 * Resolve translation for "people without address" panel (avoids showing raw i18n keys).
 * Persian fallback for "Add address" is "Ø§ÙØ²ÙˆØ¯Ù† آدرس".
 */
function getNoAddressTranslation(key) {
    const fallbacks = {
        en: {
            'index.peopleWithoutAddressHeading': 'People without address',
            'index.peopleWithoutAddressEmpty': 'No one listed without address.',
            'index.noAddressLabel': 'No address',
            'index.of': 'of'
        },
        fa: {
            'index.peopleWithoutAddressHeading': '\u0627\u0641\u0631\u0627\u062f \u0628\u062f\u0648\u0646 \u0622\u062f\u0631\u0633',
            'index.peopleWithoutAddressEmpty': '\u0647\u06cc\u0686 \u0641\u0631\u062f\u06cc \u0628\u062f\u0648\u0646 \u0622\u062f\u0631\u0633 \u062f\u0631 \u0641\u0647\u0631\u0633\u062a \u0646\u06cc\u0633\u062a.',
            'index.noAddressLabel': '\u0628\u062f\u0648\u0646 \u0622\u062f\u0631\u0633',
            'index.of': '\u0627\u0632'
        }
    };

    // Default to Persian so pre-i18n render paths do not show English in the default app locale.
    let currentLang = 'fa';

    if (typeof document !== 'undefined') {
        const htmlLang = (document.documentElement && document.documentElement.lang)
            ? String(document.documentElement.lang).toLowerCase()
            : '';
        if (htmlLang) currentLang = htmlLang;
    }

    if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('language');
        if (saved) currentLang = String(saved).toLowerCase();
    }

    if (typeof window !== 'undefined' && window.languageManager) {
        if (typeof window.languageManager.getCurrentLanguage === 'function') {
            const lmLang = String(window.languageManager.getCurrentLanguage() || '').toLowerCase();
            if (lmLang) currentLang = lmLang;
        }

        if (typeof window.languageManager.getTranslation === 'function') {
            const val = window.languageManager.getTranslation(key);
            if (val && typeof val === 'string' && val !== key) {
                // Guard against stale cached English text when UI language is Persian.
                if (currentLang.startsWith('fa') && key === 'index.noAddressLabel' && val.trim().toLowerCase() === 'no address') {
                    return fallbacks.fa[key];
                }
                return val;
            }
        }
    }

    const langBucket = currentLang.startsWith('fa') ? fallbacks.fa : fallbacks.en;
    return langBucket[key] || fallbacks.en[key] || key;
}

/**
 * Build one listing-card HTML for a person (with or without address). Used by main listings and by no-address list.
 * For no-address, pass noAddress: true; shows only "Add address" link (Persian: Ø§ÙØ²ÙˆØ¯Ù† آدرس), no "آدرس Ù†دارد" line.
 */
function buildListingCardHtml(p, options) {
    const noAddress = options && options.noAddress === true;
    const loc = p.location?.coordinates;
    const lat = loc?.[1];
    const lng = loc?.[0];
    const addr = noAddress ? '' : normalizeText(p.address).substring(0, 80);
    const tagsInfo = formatPersonTagsForCard(p, 3);
    const images = getPersonImages(p);
    const fullName = getPersonFullName(p);
    const nameHtml = `<h3 class="listing-name">${fullName || ' '}</h3>`;
    const imageBlock = buildListingImageBlock(p, images, fullName);
    const cardStackHtml = buildCardStackLayersHtml(p);
    const cardStackControlsHtml = cardStackHtml ? buildCardStackControlsHtml() : '';
    const cardStackClass = cardStackHtml ? ' has-card-stack' : '';
    const hasCoords = !noAddress && lat != null && lng != null;
    const vs = p.voteSummary || {};
    const likes = vs.likes || 0;
    const dislikes = vs.dislikes || 0;
    const userVote = p.userVote || '';
    const commentCount = p.commentCount ?? (p.comments || []).length;
    const postCaps = getPostManagementCapabilities(p);
    const bookmarkBtn = buildBookmarkButtonHtml(p);
    const approximateRegionLabel = noAddress ? getPersonApproximateRegion(p) : '';
    const noAddressLabel = getNoAddressTranslation('index.noAddressLabel');
    const addressLine = noAddress
        ? `${approximateRegionLabel
            ? `<p class="listing-address">${escapeHtml(approximateRegionLabel)}</p>`
            : `<p class="listing-address listing-address-none">${escapeHtml(noAddressLabel)}</p>`}`
        : (addr ? `<p class="listing-address${hasCoords ? ' listing-address-clickable' : ''}" ${hasCoords ? `data-lat="${lat}" data-lng="${lng}"` : ''}>${escapeHtml(addr)}</p>` : '');
    const tagsBlock = tagsInfo.shortText
        ? `<p class="listing-tags" title="${escapeAttr(tagsInfo.fullText)}">${escapeHtml(tagsInfo.shortText)}</p>`
        : '';
    const actionsBlock = `<div class="listing-actions">
                        <div class="listing-votes">
                            <button type="button" class="listing-vote-btn ${userVote === 'like' ? 'active' : ''}" data-type="like" data-id="${p._id}" title="Like">👍 <span class="vote-count">${likes}</span></button>
                            <button type="button" class="listing-vote-btn ${userVote === 'dislike' ? 'active' : ''}" data-type="dislike" data-id="${p._id}" title="Dislike">👎 <span class="vote-count">${dislikes}</span></button>
                        </div>
                        <button type="button" class="listing-comment-btn" data-id="${p._id}" title="Comments">💬 <span class="comment-count">${commentCount}</span></button>
                        ${bookmarkBtn}
                        ${buildManageActionsHtml(p, postCaps)}
                    </div>`;
    const shareCorner = `<div class="listing-share-corner"><button type="button" class="listing-share-btn" data-id="${p._id}" data-name="${escapeAttr(fullName)}" title="${escapeAttr(t('index.share') || 'Share')}" aria-label="${escapeAttr(t('index.share') || 'Share')}">${getShareButtonInnerHtml()}</button></div>`;
    if (noAddress) {
        return `
        <div class="listing-card${cardStackClass}" data-id="${p._id}" data-lat="${lat ?? ''}" data-lng="${lng ?? ''}" data-likes="${likes}" data-dislikes="${dislikes}" data-user-vote="${escapeAttr(userVote)}" data-no-address="1">
            ${cardStackHtml}
            ${cardStackControlsHtml}
            ${shareCorner}
            <div class="listing-card-row">
                <div class="listing-content">
                    <div class="listing-content-top">
                        ${nameHtml}
                        ${addressLine}
                        ${tagsBlock}
                    </div>
                    ${actionsBlock}
                </div>
                ${imageBlock}
            </div>
        </div>
    `;
    }
    return `
        <div class="listing-card${cardStackClass}" data-id="${p._id}" data-lat="${lat ?? ''}" data-lng="${lng ?? ''}" data-likes="${likes}" data-dislikes="${dislikes}" data-user-vote="${escapeAttr(userVote)}" data-no-address="0">
            ${cardStackHtml}
            ${cardStackControlsHtml}
            ${shareCorner}
            <div class="listing-card-row">
                <div class="listing-content">
                    <div class="listing-content-top">
                        ${nameHtml}
                        ${addressLine}
                        ${tagsBlock}
                    </div>
                    ${actionsBlock}
                </div>
                ${imageBlock}
            </div>
        </div>
    `;
}

/**
 * Update the "people without address" count in the filters header (e.g. "2 مورد").
 * Uses same label as listings count (index.listingsCount → مورد).
 */
function updateNoAddressCount(count) {
    const safeCount = Number.isFinite(count) ? count : 0;
    let label = typeof t === 'function' ? t('index.listingsCount') : '';
    if (!label || label === 'index.listingsCount') label = 'مورد';
    const el = document.getElementById('noAddressCount');
    if (el) el.textContent = `${safeCount} ${label}`;
    const tabCountEl = document.getElementById('withoutAddressTabCount');
    if (tabCountEl) tabCountEl.textContent = String(safeCount);
    const inlineCaptionEl = document.getElementById('noAddressInlineCaption');
    if (inlineCaptionEl) {
        let heading = typeof t === 'function' ? t('index.peopleWithoutAddressHeading') : '';
        if (!heading || heading === 'index.peopleWithoutAddressHeading') heading = 'افراد بدون آدرس';
        inlineCaptionEl.textContent = `${heading} ${safeCount} ${label}`;
    }
}

/**
 * Load and render "People without address" as listing-style cards.
 * Uses #noAddressListContainer (SPA view) or #filtersSection .filters-content (index.html).
 */
async function loadPeopleWithoutAddress(options = {}) {
    const append = Boolean(options && options.append);
    const container = document.getElementById('noAddressListContainer') || document.querySelector('#filtersSection .filters-content');
    if (!container) {
        console.warn('People without address container not found (#noAddressListContainer or #filtersSection .filters-content)');
        return;
    }
    if (append && !mapListingsContext.noAddressNextCursor) return;
    if (append) {
        if (mapListingsContext.noAddressLoading) return;
    } else {
        mapListingsContext.noAddressLoadGen += 1; // invalidate older no-address fetches when filters change
        mapListingsContext.noAddressNextCursor = '';
        mapListingsContext.noAddressHasMore = false;
    }
    const loadGen = mapListingsContext.noAddressLoadGen;
    mapListingsContext.noAddressLoading = true;
    const emptyKey = 'index.peopleWithoutAddressEmpty';
    try {
        const params = new URLSearchParams({ hasAddress: 'false', limit: '50' });
        /* Single search/sort in combined header applies to both lists */
        const searchInput = document.getElementById('searchInput');
        const sortSelect = document.getElementById('sortFilter');
        const provinceSelect = document.getElementById('provinceFilter');
        const search = searchInput?.value?.trim() || '';
        const sortValue = sortSelect?.value?.trim() || 'likes:desc';
        const province = provinceSelect?.value?.trim() || '';
        const [sortBy, sortDir] = sortValue.split(':');
        if (search) params.set('search', search);
        if (sortBy) params.set('sortBy', sortBy);
        if (sortDir) params.set('sortDir', sortDir);
        /* Province only — no county/bakhsh. Approximate/unknown people rarely have a section,
           so map-click section filters were wiping this whole panel (0 results). */
        if (province) params.set('province', province);
        params.set('includeTotals', append ? 'false' : 'true');
        if (append && mapListingsContext.noAddressNextCursor) {
            params.set('cursor', mapListingsContext.noAddressNextCursor);
        }
        const url = `${MAP_API_BASE_URL}/people?${params.toString()}`;
        const token = (typeof authAPI !== 'undefined' && authAPI?.getToken) ? authAPI.getToken() : null;
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (loadGen !== mapListingsContext.noAddressLoadGen) return; // superseded by a newer filter reload
        if (!res.ok || !data.success) {
            if (!append) {
                updateNoAddressCount(0);
                container.innerHTML = `<div class="no-address-list"><p class="filters-hint" data-i18n="${emptyKey}">${getNoAddressTranslation(emptyKey)}</p></div>`;
            }
            if (typeof window !== 'undefined' && window.languageManager) window.languageManager.translatePage?.();
            return;
        }
        const rawPeople = data.data?.people || [];
        let people = rawPeople.filter((p) => !isExactLikePerson(p));
        if (isSharedFocusExactMode() && mapListingsContext.sharedPerson) {
            const shared = mapListingsContext.sharedPerson;
            people = people.filter((p) => !isLikelySamePerson(p, shared));
        }
        const mergedPeople = append
            ? mergePeopleUnique(mapListingsContext.currentNoAddressListings, people)
            : people;
        mapListingsContext.currentNoAddressListings = mergedPeople;
        indexPeopleById(mergedPeople);
        refreshLoadedPersonIds();
        const pagination = data.data?.pagination || {};
        mapListingsContext.noAddressNextCursor = pagination.nextCursor || '';
        mapListingsContext.noAddressHasMore = Boolean(pagination.hasNextPage && mapListingsContext.noAddressNextCursor);
        const rawTotal = pagination.total ?? mergedPeople.length;
        const removedCount = rawPeople.length - people.length;
        const total = (removedCount > 0 && Number.isFinite(rawTotal))
            ? Math.max(0, rawTotal - removedCount)
            : rawTotal;
        mapListingsContext.noAddressTotal = Number.isFinite(total) ? total : mergedPeople.length;
        updateNoAddressCount(total);
        let html = `<div class="no-address-list" id="noAddressListSection">`;
        if (mergedPeople.length === 0) {
            html += `<p class="filters-hint" data-i18n="${emptyKey}">${getNoAddressTranslation(emptyKey)}</p>`;
        } else {
            html += '<div class="no-address-cards">';
            mergedPeople.forEach(function (p) {
                html += buildListingCardHtml(p, { noAddress: true });
            });
            html += '</div>';
            if (total > mergedPeople.length) {
                const ofText = getNoAddressTranslation('index.of');
                html += `<p class="filters-hint">${mergedPeople.length} ${ofText} ${total}</p>`;
            }
            if (mapListingsContext.noAddressHasMore) {
                html += `<button type="button" class="btn-load-more no-address-load-more" ${mapListingsContext.noAddressLoading ? 'disabled' : ''}>${t('common.loadMore') || 'Load more'}</button>`;
            }
        }
        html += '</div>';
        container.innerHTML = html;
        bindNoAddressCardEvents(container);
        if (!container.dataset.noAddressLoadMoreBound) {
            container.addEventListener('click', (ev) => {
                const btn = ev.target.closest('.no-address-load-more');
                if (!btn) return;
                ev.preventDefault();
                ev.stopPropagation();
                if (mapListingsContext.noAddressLoading || !mapListingsContext.noAddressHasMore) return;
                loadPeopleWithoutAddress({ append: true });
            });
            container.dataset.noAddressLoadMoreBound = '1';
        }
        if (typeof window !== 'undefined' && window.languageManager) window.languageManager.translatePage?.();
        renderRelationshipOverlay();
        console.log('People without address list rendered:', mergedPeople.length, 'items');
    } catch (err) {
        console.error('Error loading people without address:', err);
        if (loadGen !== mapListingsContext.noAddressLoadGen) return;
        if (!append) {
            mapListingsContext.currentNoAddressListings = [];
            mapListingsContext.noAddressNextCursor = '';
            mapListingsContext.noAddressHasMore = false;
            refreshLoadedPersonIds();
            updateNoAddressCount(0);
            container.innerHTML = `<div class="no-address-list"><p class="filters-hint" data-i18n="${emptyKey}">${getNoAddressTranslation(emptyKey)}</p></div>`;
            if (typeof window !== 'undefined' && window.languageManager) window.languageManager.translatePage?.();
            renderRelationshipOverlay();
        }
    } finally {
        if (loadGen === mapListingsContext.noAddressLoadGen) {
            mapListingsContext.noAddressLoading = false;
        }
    }
}

/**
 * Bind handlers for listing cards inside the no-address container.
 * Vote and comment are handled by document-level delegation (bindListingActionsDelegation).
 */
function bindNoAddressCardEvents(container) {
    if (!container) return;
    if (!container.dataset.listingClickBound) {
        container.addEventListener('click', handleListingCardClick);
        container.dataset.listingClickBound = '1';
    }
}

/**
 * Bind document-level click delegation for listing actions so they work in both sidebar (#listingsList) and map popup cards.
 * Run once so vote/comment/share/edit/delete and clickable-address work everywhere (including inside .leaflet-popup-content).
 */
function bindListingActionsDelegation() {
    if (document.body.dataset.listingActionsDelegationBound === '1') return;
    document.body.dataset.listingActionsDelegationBound = '1';
    document.addEventListener('click', (ev) => {
        const moreBtn = ev.target.closest('.listing-more-btn');
        if (moreBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleListingMoreMenu(moreBtn);
            return;
        }

        if (!ev.target.closest('.listing-more-wrap')) {
            closeAllListingMoreMenus();
        }

        const voteBtn = ev.target.closest('.listing-vote-btn');
        if (voteBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            handleVote(voteBtn);
            return;
        }
        const bookmarkBtn = ev.target.closest('.listing-bookmark-btn');
        if (bookmarkBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            handleBookmarkToggle(bookmarkBtn);
            return;
        }
        const commentBtn = ev.target.closest('.listing-comment-btn');
        if (commentBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleCommentsPanel(commentBtn);
            return;
        }
        const shareBtn = ev.target.closest('.listing-share-btn');
        if (shareBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            handleShare(shareBtn);
            return;
        }
        const ownerLink = ev.target.closest('.listing-owner-link');
        if (ownerLink) {
            ev.preventDefault();
            ev.stopPropagation();
            handleOwnerProfileClick(ownerLink);
            closeAllListingMoreMenus();
            return;
        }
        const editBtn = ev.target.closest('.listing-edit-btn');
        if (editBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            handleListingEdit(editBtn);
            closeAllListingMoreMenus();
            return;
        }
        const deleteBtn = ev.target.closest('.listing-delete-btn');
        if (deleteBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            handleListingDelete(deleteBtn);
            closeAllListingMoreMenus();
            return;
        }
        const addressEl = ev.target.closest('.listing-address-clickable');
        if (addressEl) {
            ev.preventDefault();
            ev.stopPropagation();
            handleAddressClick(addressEl);
            return;
        }
        const imgContainer = ev.target.closest('.listing-image');
        if (imgContainer && ev.target.closest('img')) {
            const imagesJson = imgContainer.dataset.images;
            if (imagesJson) {
                try {
                    const images = JSON.parse(imagesJson);
                    if (images && images.length > 0) {
                        const person = getPersonFromCard(imgContainer.closest('.listing-card'));
                        ev.preventDefault();
                        ev.stopPropagation();
                        openListingsImageCarousel(images, person);
                    }
                } catch (_) {}
            }
        }
    });
    console.log('Listing actions delegation bound (vote, bookmark, comment, share, menu, owner, edit, delete, address) for sidebar and map popup');
}

/**
 * Fetch a single person by ID from the API. Used when ?person=ID is in the URL
 * to ensure the shared person is always shown, even if they're outside current filters.
 */
async function fetchPersonById(personId) {
    if (!personId) return null;
    try {
        const token = authAPI?.getToken?.();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${MAP_API_BASE_URL}/people/${personId}`, { headers });
        const data = await res.json();
        if (!data.success || !data.data?.person) return null;
        return data.data.person;
    } catch (err) {
        console.warn('fetchPersonById error:', err);
        return null;
    }
}

function personHasExactCoordinates(person) {
    const coords = person?.location?.coordinates;
    return Boolean(
        Array.isArray(coords) &&
        coords.length === 2 &&
        Number.isFinite(coords[0]) &&
        Number.isFinite(coords[1])
    );
}

function personHasAddressText(person) {
    return Boolean(normalizeText(person?.address));
}

function isExactLikePerson(person) {
    const status = inferPersonAddressStatus(person);
    if (status === 'exact') return true;
    if (personHasExactCoordinates(person)) return true;
    // Guard against inconsistent saved data: any concrete address text is treated as with-address.
    if (personHasAddressText(person)) return true;
    return false;
}

function openSharedPersonDetails(person) {
    const normalized = normalizePersonForRendering(person);
    if (!normalized) return;
    const images = getPersonImages(normalized);
    const fallbackImage = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#1f2933"/><text x="50%" y="50%" fill="#9fb3c8" font-size="28" text-anchor="middle" dominant-baseline="middle">No image</text></svg>'
    )}`;
    openListingsImageCarousel(images.length ? images : [fallbackImage], normalized);
}

function applySharedPersonFocus(person) {
    const focusedPerson = normalizePersonForRendering(person);
    if (!focusedPerson || !focusedPerson._id) return;

    indexPeopleById([focusedPerson]);
    mapListingsContext.currentListings = [focusedPerson];
    refreshLoadedPersonIds();

    const exactWithCoords = isExactLikePerson(focusedPerson);

    if (exactWithCoords) {
        const lng = focusedPerson.location.coordinates[0];
        const lat = focusedPerson.location.coordinates[1];
        mapListingsContext.isProgrammaticMovement = true;
        map.setView([lat, lng], 15);
        renderListings([focusedPerson]);
        updateMarkers([focusedPerson]);
        updateListingsCount(1, 1);
        /* Keep filters panel on without-address so desktop does not duplicate the focused exact card. */
        setPeopleTab('without-address');
        setTimeout(() => {
            const marker = mapListingsContext.markersByPersonId?.[String(focusedPerson._id)];
            if (marker) marker.openPopup();
            mapListingsContext.isProgrammaticMovement = false;
            setRelationshipFocusPerson(focusedPerson._id);
        }, 350);
        console.log('Shared focus mode applied for exact-address person:', focusedPerson._id);
        return 'exact';
    }

    updateMarkers([]);
    renderListings([]);
    updateListingsCount(0, 0);
    renderNoAddressEmptyState();
    updateNoAddressCount(0);
    setPeopleTab('without-address');
    openSharedPersonDetails(focusedPerson);
    setRelationshipFocusPerson(focusedPerson._id);
    console.log('Shared focus mode applied for approximate/unknown person:', focusedPerson._id);
    return 'non-exact';
}

/**
 * On a user's very first visit (no prior localStorage flag), open one random
 * with-address person popup so the map immediately shows what a listing looks like.
 * Skipped when a shared/?person= or post-edit focus already targets someone.
 */
function maybeShowRandomPersonPopupOnFirstVisit() {
    try {
        if (typeof localStorage === 'undefined') return false;
        if (localStorage.getItem(FIRST_VISIT_RANDOM_POPUP_KEY)) return false; // already shown on a previous visit
        if (isSharedFocusMode()) return false;

        const peopleWithMarkers = (mapListingsContext.currentListings || []).filter((person) => {
            const id = normalizePersonId(person?._id);
            return id && personHasExactCoordinates(person) && mapListingsContext.markersByPersonId?.[id];
        });
        if (!peopleWithMarkers.length) return false;

        const randomPerson = peopleWithMarkers[Math.floor(Math.random() * peopleWithMarkers.length)]; // pick uniformly among visible markers
        localStorage.setItem(FIRST_VISIT_RANDOM_POPUP_KEY, '1'); // mark first-visit showcase as done before opening
        setTimeout(() => focusPersonOnMap(randomPerson), 350); // slight delay so initial map settle / marker bind finishes
        console.log('First-visit random person popup opened for:', normalizePersonId(randomPerson._id));
        return true;
    } catch (e) {
        console.warn('maybeShowRandomPersonPopupOnFirstVisit error:', e);
        return false;
    }
}

/**
 * Handle ?person=ID in URL: scroll to the card and highlight it, or pan map to marker.
 * Called after loadListingsForViewport and loadPeopleWithoutAddress complete.
 */
function handlePersonFromUrl(personIdOverride, options = {}) {
    try {
        const allowTabSwitch = options?.allowTabSwitch !== false;
        const params = new URLSearchParams(window.location.search);
        const personId = normalizePersonId(personIdOverride || params.get('person'));
        if (!personId) return;
        const cards = Array.from(document.querySelectorAll(`.listing-card[data-id="${personId}"]`));
        const person = mapListingsContext.peopleById?.[personId];
        const wantExactCard = person ? isExactLikePerson(person) : null;
        const preferredCard = cards.find((candidate) => {
            if (!candidate || candidate.classList.contains('listing-card-popup')) return false;
            if (wantExactCard === true) return candidate.dataset.noAddress === '0';
            if (wantExactCard === false) return candidate.dataset.noAddress === '1';
            return true;
        });
        const card = preferredCard || cards.find((candidate) => !candidate.classList.contains('listing-card-popup')) || cards[0] || null;
        if (card) {
            if (allowTabSwitch) {
                const peoplePanel = card.closest('[data-people-tab-panel]');
                if (peoplePanel && peoplePanel.dataset.peopleTabPanel) {
                    setPeopleTab(peoplePanel.dataset.peopleTabPanel);
                }
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            card.classList.add('active');
            setTimeout(() => card.classList.remove('active'), 3000);
            setRelationshipFocusPerson(personId);
            const lat = parseFloat(card.dataset.lat);
            const lng = parseFloat(card.dataset.lng);
            if (!isNaN(lat) && !isNaN(lng) && map && mapListingsContext.markersByPersonId?.[personId]) {
                mapListingsContext.isProgrammaticMovement = true;
                map.setView([lat, lng], 14);
                mapListingsContext.markersByPersonId[personId].openPopup();
                setTimeout(() => { mapListingsContext.isProgrammaticMovement = false; }, 1000);
            }
            console.log('handlePersonFromUrl: scrolled to card for person', personId);
        }
    } catch (e) {
        console.warn('handlePersonFromUrl error:', e);
    }
}

/**
 * Initialize Radgir map and listings application.
 * When ?person=ID is in the URL, fetches that person first, centers map on them,
 * clears or sets filters to their region, and ensures they appear in the list.
 */
async function initMapAndListings() {
    console.log('Initializing Radgir application...');
    bindListingActionsDelegation();
    initCardStackDelegation();
    initMap();
    if (!map) {
        console.error('Map initialization failed');
        return;
    }

    const filtersSection = document.getElementById('filtersSection');
    const listingsSection = document.getElementById('listingsSection');
    const mapContainer = document.querySelector('.map-container');
    console.log('Checking for required DOM elements...');
    console.log('Filters section found:', !!filtersSection);
    console.log('Listings section found:', !!listingsSection);
    console.log('Map container found:', !!mapContainer);

    setupViewportLoading();
    await loadRoleFilterOptions();
    fetchFilterCounts();
    setupFilters();
    initRelationshipControls();
    initPeopleTabs();
    await loadBookmarkedIds();

    /* Check for shared link: ?person=ID */
    mapListingsContext.sharedFocusMode = false;
    mapListingsContext.sharedPersonId = null;
    mapListingsContext.sharedPerson = null;
    const params = new URLSearchParams(window.location.search);
    const sharedPersonId = normalizePersonId(params.get('person'));
    const pendingFocusPersonId = consumePendingFocusPersonId();
    let sharedNonExactPerson = null;
    if (sharedPersonId) {
        const sharedPerson = await fetchPersonById(sharedPersonId);
        if (sharedPerson) {
            const sharedIsExact = isExactLikePerson(sharedPerson);
            mapListingsContext.sharedPersonId = sharedPersonId;
            mapListingsContext.sharedPerson = sharedPerson;

            if (sharedIsExact) {
                mapListingsContext.sharedFocusMode = true;
                const focusMode = applySharedPersonFocus(sharedPerson);
                if (focusMode === 'exact') {
                    await loadPeopleWithoutAddress();
                }

                document.addEventListener('visibilitychange', function () {
                    if (document.visibilityState === 'visible') {
                        if (focusMode === 'exact') {
                            loadPeopleWithoutAddress();
                        }
                    }
                });

                console.log('Application initialized successfully (shared focus mode)');
                return;
            }

            // Non-exact shared links should open details, but keep normal map/list/filter behavior enabled.
            mapListingsContext.sharedFocusMode = false;
            sharedNonExactPerson = sharedPerson;
            console.log('Shared link is approximate/unknown; continuing normal mode after opening details.');
        } else {
            console.warn('Shared link person not found; falling back to normal listings mode:', sharedPersonId);
        }
    }

    await loadProvinces();

    mapListingsContext.viewportPage = 1;
    await Promise.all([loadPeopleWithoutAddress(), loadListingsForViewport()]);

    if (!sharedPersonId && pendingFocusPersonId) {
        setPeopleTab('without-address');
    }

    // Normal home flow: auto-select edited card without entering shared-focus mode.
    handlePersonFromUrl(sharedPersonId || pendingFocusPersonId, {
        // Keep right panel in "without-address" on post-edit redirect (pending focus),
        // and only switch tab automatically for explicit shared links.
        allowTabSwitch: Boolean(sharedPersonId)
    });

    // First visit only: open a random person popup when nothing else is already focusing one.
    if (!sharedPersonId && !pendingFocusPersonId && !sharedNonExactPerson) {
        maybeShowRandomPersonPopupOnFirstVisit();
    }

    if (sharedNonExactPerson) {
        openSharedPersonDetails(sharedNonExactPerson);
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') loadPeopleWithoutAddress();
    });

    console.log('Application initialized successfully');
}

if (typeof window !== 'undefined') {
    window.initMapAndListings = initMapAndListings;
}
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('map') && document.getElementById('app-view-container')) {
            initMapAndListings();
        }
        /* Refresh listings count label when language changes (e.g. to show "مورد" vs "listings") */
        document.addEventListener('languageChanged', () => {
            updateListingsCount(lastListingsCountCurrent, lastListingsCountTotal);
        });
    });
}
