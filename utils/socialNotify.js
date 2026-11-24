/**
 * Social notify — post new person listings to Telegram / Instagram.
 *
 * Telegram (Bot API): set TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID (@radgir_com).
 *   Bot must be an admin of the channel.
 *
 * Instagram (Graph API): set INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ACCOUNT_ID.
 *   Requires an Instagram Professional account linked to a Facebook Page.
 *   Posts need a public https image URL (Cloudinary works; local /uploads do not).
 */

/** Public site origin for share links (no trailing slash). Never use localhost in captions. */
function getAppBaseUrl() {
    const raw = process.env.APP_URL || process.env.PUBLIC_APP_URL || '';
    const cleaned = String(raw).trim().replace(/\/$/, '');
    // Local fallbacks must not leak into Telegram/Instagram share links
    if (!cleaned || /localhost|127\.0\.0\.1/i.test(cleaned)) {
        return 'https://www.radgir.com';
    }
    return cleaned;
}

/** First publicly reachable https image from a person listing. */
function pickPublicImageUrl(images) {
    if (!Array.isArray(images)) return null;
    for (const entry of images) {
        const url = typeof entry === 'string' ? entry : (entry && (entry.url || entry.path || entry.secure_url));
        if (typeof url === 'string' && /^https:\/\//i.test(url)) return url;
    }
    return null;
}

/** Escape user text for Telegram HTML captions. */
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Truncate plain text for Telegram photo caption budget (1024). */
function truncateText(value, maxLen) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

/**
 * Build Persian caption that ALWAYS keeps the Radgir share URL.
 * Photo captions max out at 1024 chars — older code sliced the end and dropped the link.
 */
function buildListingCaption(person, { isUpdate = false, isBackfill = false, forPhoto = true } = {}) {
    const maxLen = forPhoto ? 1024 : 4096;
    const id = person && (person._id || person.id);
    const name = [person?.name, person?.familyName].filter(Boolean).join(' ').trim() || 'بدون نام';
    const job = person?.job ? String(person.job).trim() : '';
    const tags = Array.isArray(person?.tags) ? person.tags.filter(Boolean).slice(0, 6) : [];
    const region = person?.administrativeRegion || {};
    const place = [region.city, region.county, region.province].filter(Boolean).join('، ');
    const address = person?.address ? String(person.address).trim() : '';
    const notes = person?.metadata?.notes ? String(person.metadata.notes).trim() : '';
    const listingUrl = `${getAppBaseUrl()}/?person=${encodeURIComponent(String(id))}`;

    // GeoJSON is [lng, lat] — Google Maps expects lat,lng
    const coords = person?.location?.coordinates;
    const hasCoords = Array.isArray(coords) && coords.length === 2
        && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]));
    const mapsUrl = hasCoords
        ? `https://www.google.com/maps?q=${encodeURIComponent(`${coords[1]},${coords[0]}`)}`
        : null;

    const header = (isUpdate || isBackfill)
        ? '📌 <b>آگهی در ردگیر</b>'
        : '🆕 <b>آگهی جدید در ردگیر</b>';

    // Footer reserved first so the share link can never be truncated away
    // Only the labeled HTML link — no raw URL line (users should tap the Persian text)
    const footer = [
        '',
        `🔗 <a href="${listingUrl}">ادرس این حرومزاده روی نقشه</a>`
    ].join('\n');

    const bodyBudget = Math.max(80, maxLen - footer.length - 1);

    const pushLine = (lines, line) => {
        if (!line) return;
        const next = lines.length ? `${lines.join('\n')}\n${line}` : line;
        if (next.length <= bodyBudget) lines.push(line);
    };

    const lines = [];
    pushLine(lines, header);
    pushLine(lines, `👤 ${escapeHtml(name)}`);
    if (job) pushLine(lines, `💼 ${escapeHtml(job)}`);

    // Shrink address/notes to whatever budget remains
    const used = () => lines.join('\n').length;
    const remaining = () => Math.max(0, bodyBudget - used() - 1);

    if (address) {
        const room = remaining();
        if (room > 20) {
            const addrText = truncateText(address, Math.min(180, room - 10));
            pushLine(
                lines,
                mapsUrl
                    ? `🏠 <a href="${mapsUrl}">${escapeHtml(addrText)}</a>`
                    : `🏠 ${escapeHtml(addrText)}`
            );
        }
    } else if (place) {
        pushLine(
            lines,
            mapsUrl
                ? `📍 <a href="${mapsUrl}">${escapeHtml(truncateText(place, Math.min(80, remaining())))}</a>`
                : `📍 ${escapeHtml(truncateText(place, Math.min(80, remaining())))}`
        );
    } else if (mapsUrl && remaining() > 30) {
        pushLine(lines, `📍 <a href="${mapsUrl}">موقعیت روی نقشه</a>`);
    }

    if (tags.length && remaining() > 20) {
        pushLine(lines, `🏷 ${escapeHtml(truncateText(tags.join(' · '), remaining() - 4))}`);
    }

    if (notes && remaining() > 24) {
        pushLine(lines, `📝 ${escapeHtml(truncateText(notes, remaining() - 4))}`);
    }

    let caption = `${lines.join('\n')}${footer}`;
    if (caption.length > maxLen) {
        // Last-resort: keep header + name + footer only
        const minimal = [header, `👤 ${escapeHtml(name)}`, footer].join('\n');
        caption = minimal.length <= maxLen ? minimal : `${header}${footer}`.slice(0, maxLen);
    }
    return caption;
}

function isTelegramConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
}

function isInstagramConfigured() {
    return Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID);
}

/** Resolve bot token + channel id, stripping accidental quotes from env. */
function getTelegramCredentials(chatIdOverride) {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
    const chatId = String(chatIdOverride || process.env.TELEGRAM_CHANNEL_ID || '')
        .trim()
        .replace(/^['"]|['"]$/g, '');
    return { token, chatId, base: token ? `https://api.telegram.org/bot${token}` : '' };
}

/** Persist Telegram message linkage on the Person document. */
async function persistTelegramMessage(personId, { messageId, chatId, hasPhoto }) {
    if (!personId || !messageId) return;
    try {
        const Person = require('../models/Person');
        await Person.updateOne(
            { _id: personId },
            {
                $set: {
                    telegramMessage: {
                        messageId: Number(messageId),
                        chatId: String(chatId || ''),
                        hasPhoto: Boolean(hasPhoto),
                        postedAt: new Date()
                    }
                }
            }
        );
    } catch (error) {
        console.error('❌ Failed to persist telegramMessage:', error.message || error);
    }
}

/** Clear stored Telegram linkage after delete. */
async function clearTelegramMessage(personId) {
    if (!personId) return;
    try {
        const Person = require('../models/Person');
        await Person.updateOne(
            { _id: personId },
            { $unset: { telegramMessage: 1 } }
        );
    } catch (error) {
        console.error('❌ Failed to clear telegramMessage:', error.message || error);
    }
}

/**
 * Post text (and optional photo) to Telegram.
 * chatId defaults to TELEGRAM_CHANNEL_ID (public channel for listings).
 */
async function postToTelegram({ caption, imageUrl, chatId: chatIdOverride } = {}) {
    const { token, chatId, base } = getTelegramCredentials(chatIdOverride);
    if (!token || !chatId) return { skipped: true, reason: 'telegram_not_configured' };

    const usePhoto = typeof imageUrl === 'string' && /^https:\/\//i.test(imageUrl);
    const endpoint = usePhoto ? `${base}/sendPhoto` : `${base}/sendMessage`;
    const maxLen = usePhoto ? 1024 : 4096;
    // Caption is already budgeted by buildListingCaption; keep a safe clamp that preserves the URL footer
    let text = String(caption || '');
    if (text.length > maxLen) {
        const linkMatch = text.match(/<a href="(https:\/\/[^"]+)"[^>]*>ادرس این حرومزاده روی نقشه<\/a>/i);
        const footer = linkMatch
            ? `\n\n🔗 <a href="${linkMatch[1]}">ادرس این حرومزاده روی نقشه</a>`
            : `\n\n🔗 <a href="https://www.radgir.com">ادرس این حرومزاده روی نقشه</a>`;
        text = `${text.slice(0, Math.max(0, maxLen - footer.length - 1)).trim()}${footer}`.slice(0, maxLen);
    }
    const body = usePhoto
        ? { chat_id: chatId, photo: imageUrl, caption: text, parse_mode: 'HTML' }
        : { chat_id: chatId, text, disable_web_page_preview: false, parse_mode: 'HTML' };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
        throw new Error(result.description || `Telegram HTTP ${response.status}`);
    }
    return {
        ok: true,
        messageId: result.result?.message_id,
        chatId,
        hasPhoto: usePhoto
    };
}

/** Delete a channel message by id (Bot API deleteMessage). */
async function deleteTelegramMessage({ messageId, chatId: chatIdOverride } = {}) {
    const { token, chatId, base } = getTelegramCredentials(chatIdOverride);
    if (!token || !chatId || !messageId) return { skipped: true, reason: 'missing_message_or_config' };

    const response = await fetch(`${base}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) })
    });
    const result = await response.json().catch(() => ({}));
    // 400 "message to delete not found" is fine — already gone
    if (!response.ok || result.ok === false) {
        const desc = String(result.description || '');
        if (/message to delete not found|message can't be deleted/i.test(desc)) {
            return { ok: true, alreadyGone: true };
        }
        throw new Error(desc || `Telegram delete HTTP ${response.status}`);
    }
    return { ok: true };
}

/**
 * Update an existing channel post, or create one if none is linked yet.
 * Handles photo↔text transitions by delete+repost when Telegram can't convert in place.
 */
async function updateTelegramListing(person, options = {}) {
    const disabled = process.env.SOCIAL_NOTIFY_ENABLED === 'false';
    if (disabled || !person) return { skipped: true, reason: 'disabled_or_missing_person' };
    if (!isTelegramConfigured()) return { skipped: true, reason: 'telegram_not_configured' };

    const personId = person._id || person.id;
    const imageUrl = pickPublicImageUrl(options.imageUrls) || pickPublicImageUrl(person.images);
    const forPhoto = Boolean(imageUrl) || Boolean(person.telegramMessage?.hasPhoto);
    const caption = buildListingCaption(person, { isUpdate: true, forPhoto });
    const stored = person.telegramMessage || {};
    const messageId = stored.messageId;
    const chatId = stored.chatId || process.env.TELEGRAM_CHANNEL_ID;
    const { base } = getTelegramCredentials(chatId);

    // Soft-deactivated listings should disappear from the channel
    if (person.isActive === false) {
        if (messageId) {
            await deleteTelegramMessage({ messageId, chatId });
            await clearTelegramMessage(personId);
            return { ok: true, deleted: true };
        }
        return { skipped: true, reason: 'inactive_without_telegram_message' };
    }

    // No prior channel post — publish as new
    if (!messageId) {
        const created = await postToTelegram({
            caption: buildListingCaption(person, { forPhoto: Boolean(imageUrl) }),
            imageUrl,
            chatId
        });
        if (created?.messageId) {
            await persistTelegramMessage(personId, created);
        }
        return created;
    }

    const text = caption; // already sized for photo/text limits with URL reserved

    if (stored.hasPhoto) {
        if (imageUrl) {
            const response = await fetch(`${base}/editMessageMedia`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: Number(messageId),
                    media: {
                        type: 'photo',
                        media: imageUrl,
                        caption: text,
                        parse_mode: 'HTML'
                    }
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.ok === false) {
                throw new Error(result.description || `Telegram editMedia HTTP ${response.status}`);
            }
            await persistTelegramMessage(personId, { messageId, chatId, hasPhoto: true });
            return { ok: true, messageId, updated: true, hasPhoto: true };
        }

        const response = await fetch(`${base}/editMessageCaption`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: Number(messageId),
                caption: text,
                parse_mode: 'HTML'
            })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) {
            // "message is not modified" is success for unchanged content
            if (/message is not modified/i.test(String(result.description || ''))) {
                return { ok: true, messageId, unchanged: true };
            }
            throw new Error(result.description || `Telegram editCaption HTTP ${response.status}`);
        }
        return { ok: true, messageId, updated: true, hasPhoto: true };
    }

    // Original was text-only
    if (imageUrl) {
        await deleteTelegramMessage({ messageId, chatId });
        const created = await postToTelegram({ caption, imageUrl, chatId });
        if (created?.messageId) await persistTelegramMessage(personId, created);
        return created;
    }

    const response = await fetch(`${base}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: Number(messageId),
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: false
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
        if (/message is not modified/i.test(String(result.description || ''))) {
            return { ok: true, messageId, unchanged: true };
        }
        throw new Error(result.description || `Telegram editText HTTP ${response.status}`);
    }
    return { ok: true, messageId, updated: true, hasPhoto: false };
}

/** Delete the channel post for a listing (if linked). */
async function deleteTelegramListing(person) {
    const disabled = process.env.SOCIAL_NOTIFY_ENABLED === 'false';
    if (disabled || !person) return { skipped: true, reason: 'disabled_or_missing_person' };

    const stored = person.telegramMessage || {};
    if (!stored.messageId) return { skipped: true, reason: 'no_telegram_message' };

    const result = await deleteTelegramMessage({
        messageId: stored.messageId,
        chatId: stored.chatId || process.env.TELEGRAM_CHANNEL_ID
    });
    await clearTelegramMessage(person._id || person.id);
    return result;
}

function updateTelegramListingAsync(person, options = {}) {
    setImmediate(() => {
        updateTelegramListing(person, options)
            .then((result) => {
                if (result?.ok) console.log('✅ Telegram listing updated for', person._id || person.id);
                else if (result?.skipped) console.log('ℹ️ Telegram update skipped:', result.reason);
            })
            .catch((error) => console.error('❌ Telegram update failed:', error.message || error));
    });
}

function deleteTelegramListingAsync(person) {
    setImmediate(() => {
        deleteTelegramListing(person)
            .then((result) => {
                if (result?.ok) console.log('✅ Telegram listing deleted for', person._id || person.id);
                else if (result?.skipped) console.log('ℹ️ Telegram delete skipped:', result.reason);
            })
            .catch((error) => console.error('❌ Telegram delete failed:', error.message || error));
    });
}

/** Chat for private alerts (contact form). Prefer personal chat over public channel. */
function resolveContactTelegramChatId() {
    return process.env.TELEGRAM_CONTACT_CHAT_ID || process.env.TELEGRAM_CHANNEL_ID || '';
}

/** Build a private Telegram alert with every contact-form field. */
function buildContactFormCaption(payload = {}) {
    const fullName = [payload.firstName, payload.lastName].filter(Boolean).join(' ').trim() || 'بدون نام';
    const lines = [
        '📩 پیام جدید از فرم تماس ردگیر',
        `👤 نام: ${fullName}`,
        `📧 ایمیل: ${payload.email || '—'}`,
        `📱 تلفن: ${payload.phone || '—'}`,
        '',
        '💬 پیام:',
        String(payload.message || '').trim() || '—'
    ];
    return lines.join('\n').slice(0, 4096);
}

/**
 * Send contact-form submission to Telegram (private chat preferred).
 * Set TELEGRAM_CONTACT_CHAT_ID to your personal chat id so emails/phones are not public.
 */
async function notifyContactFormToTelegram(payload) {
    const disabled = process.env.SOCIAL_NOTIFY_ENABLED === 'false';
    if (disabled) return { skipped: true, reason: 'disabled' };
    if (!process.env.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: 'telegram_not_configured' };

    const chatId = resolveContactTelegramChatId();
    if (!chatId) return { skipped: true, reason: 'telegram_contact_chat_missing' };

    const caption = buildContactFormCaption(payload);
    return postToTelegram({ caption, chatId });
}

/** Non-blocking contact-form Telegram notify. */
function notifyContactFormToTelegramAsync(payload) {
    setImmediate(() => {
        notifyContactFormToTelegram(payload).then((result) => {
            if (result?.ok) console.log('✅ Telegram notified for contact form');
            else if (result?.skipped) console.log('ℹ️ Contact Telegram skipped:', result.reason);
        }).catch((error) => {
            console.error('❌ Contact Telegram notify failed:', error.message || error);
        });
    });
}


/**
 * Publish a feed image post to Instagram via Graph API (Business/Creator only).
 * Instagram Content Publishing requires a public image URL — text-only is not supported.
 */
async function postToInstagram({ caption, imageUrl }) {
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
    if (!token || !igUserId) return { skipped: true, reason: 'instagram_not_configured' };
    if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
        return { skipped: true, reason: 'instagram_needs_public_image' };
    }

    const createUrl = new URL(`https://graph.facebook.com/v21.0/${igUserId}/media`);
    createUrl.searchParams.set('image_url', imageUrl);
    createUrl.searchParams.set('caption', caption.slice(0, 2200));
    createUrl.searchParams.set('access_token', token);

    const createRes = await fetch(createUrl, { method: 'POST' });
    const createJson = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createJson.id) {
        throw new Error(createJson.error?.message || `Instagram create media HTTP ${createRes.status}`);
    }

    const publishUrl = new URL(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`);
    publishUrl.searchParams.set('creation_id', createJson.id);
    publishUrl.searchParams.set('access_token', token);

    const publishRes = await fetch(publishUrl, { method: 'POST' });
    const publishJson = await publishRes.json().catch(() => ({}));
    if (!publishRes.ok || !publishJson.id) {
        throw new Error(publishJson.error?.message || `Instagram publish HTTP ${publishRes.status}`);
    }
    return { ok: true, mediaId: publishJson.id };
}

/**
 * Fire-and-forget social posts for a newly created listing.
 * Never throws to callers — failures are logged only so create API stays fast.
 *
 * @param {object} person - Saved person document / lean object
 * @param {object} [options]
 * @param {string[]} [options.imageUrls] - Prefer already-resolved https URLs
 * @param {boolean} [options.telegram=true]
 * @param {boolean} [options.instagram=true]
 */
async function notifyNewListingToSocials(person, options = {}) {
    const telegram = options.telegram !== false;
    const instagram = options.instagram !== false;
    const disabled = process.env.SOCIAL_NOTIFY_ENABLED === 'false';
    if (disabled || !person) return { skipped: true, reason: 'disabled_or_missing_person' };

    const caption = buildListingCaption(person, {
        isBackfill: options.isBackfill === true,
        forPhoto: Boolean(pickPublicImageUrl(options.imageUrls) || pickPublicImageUrl(person.images))
    });
    const imageUrl = pickPublicImageUrl(options.imageUrls) || pickPublicImageUrl(person.images);
    const results = { telegram: null, instagram: null };

    if (telegram && isTelegramConfigured()) {
        try {
            results.telegram = await postToTelegram({ caption, imageUrl });
            if (results.telegram?.messageId) {
                await persistTelegramMessage(person._id || person.id, results.telegram);
            }
            console.log('✅ Telegram channel notified for listing', person._id || person.id);
        } catch (error) {
            console.error('❌ Telegram notify failed:', error.message || error);
            results.telegram = { ok: false, error: String(error.message || error) };
        }
    } else if (telegram) {
        results.telegram = { skipped: true, reason: 'telegram_not_configured' };
    }

    if (instagram && isInstagramConfigured()) {
        try {
            results.instagram = await postToInstagram({ caption, imageUrl });
            if (results.instagram?.ok) {
                console.log('✅ Instagram notified for listing', person._id || person.id);
            } else if (results.instagram?.skipped) {
                console.log('ℹ️ Instagram skipped:', results.instagram.reason);
            }
        } catch (error) {
            console.error('❌ Instagram notify failed:', error.message || error);
            results.instagram = { ok: false, error: String(error.message || error) };
        }
    } else if (instagram) {
        results.instagram = { skipped: true, reason: 'instagram_not_configured' };
    }

    return results;
}

/** Non-blocking wrapper — safe to call without await from route handlers. */
function notifyNewListingToSocialsAsync(person, options = {}) {
    setImmediate(() => {
        notifyNewListingToSocials(person, options).catch((error) => {
            console.error('❌ Social notify unexpected error:', error);
        });
    });
}

module.exports = {
    notifyNewListingToSocials,
    notifyNewListingToSocialsAsync,
    updateTelegramListing,
    updateTelegramListingAsync,
    deleteTelegramListing,
    deleteTelegramListingAsync,
    notifyContactFormToTelegram,
    notifyContactFormToTelegramAsync,
    isTelegramConfigured,
    isInstagramConfigured,
    pickPublicImageUrl,
    buildListingCaption,
    buildContactFormCaption
};
