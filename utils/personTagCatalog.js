const PersonTag = require('../models/PersonTag');
const { VALID_PERSON_TAGS } = require('./personTags');

let defaultTagsSeedChecked = false;

/** Join active tag names the way the about page lead text expects (space-separated list). */
function formatActiveTagsAsSummary(tags) {
    return uniqueNormalizedTagNames(tags).join(' ');
}

function normalizeTagName(value) {
    return PersonTag.normalizeTagName(value);
}

function uniqueNormalizedTagNames(values) {
    const seen = new Set();
    const result = [];

    (values || []).forEach((value) => {
        const normalized = normalizeTagName(value);
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(normalized);
    });

    return result;
}

async function ensureDefaultPersonTags() {
    if (defaultTagsSeedChecked) return;

    const existingCount = await PersonTag.countDocuments();
    if (existingCount > 0) {
        defaultTagsSeedChecked = true;
        return;
    }

    const defaults = uniqueNormalizedTagNames(VALID_PERSON_TAGS).map((name, index) => ({
        name,
        normalizedName: name.toLowerCase(),
        isActive: true,
        sortOrder: (index + 1) * 10
    }));

    if (defaults.length > 0) {
        try {
            await PersonTag.insertMany(defaults, { ordered: false });
        } catch (error) {
            const duplicateKey = error && (error.code === 11000 || error.name === 'BulkWriteError');
            if (!duplicateKey) {
                throw error;
            }
        }
    }

    defaultTagsSeedChecked = true;
}

async function getActivePersonTags() {
    await ensureDefaultPersonTags();

    const tags = await PersonTag.find({ isActive: true })
        .sort({ sortOrder: 1, name: 1 })
        .select('name')
        .lean();

    const names = uniqueNormalizedTagNames(tags.map((tag) => tag.name));
    if (names.length > 0) {
        return names;
    }

    return uniqueNormalizedTagNames(VALID_PERSON_TAGS);
}

async function getAllPersonTagsForAdmin() {
    await ensureDefaultPersonTags();

    return PersonTag.find({})
        .sort({ sortOrder: 1, name: 1 })
        .select('_id name isActive sortOrder createdAt updatedAt')
        .lean();
}

async function validateTagsAgainstCatalog(values) {
    if (!Array.isArray(values)) {
        return { valid: false, cleanedTags: [], invalidTags: [], error: 'Tags must be an array' };
    }

    const cleanedTags = uniqueNormalizedTagNames(values);
    const activeTags = await getActivePersonTags(); // Only active catalog tags may be assigned on create/edit.
    const allowed = new Set(uniqueNormalizedTagNames(activeTags));
    const invalidTags = cleanedTags.filter((tag) => !allowed.has(tag));

    return {
        valid: invalidTags.length === 0,
        cleanedTags,
        invalidTags,
        error: invalidTags.length > 0 ? `Invalid tags: ${invalidTags.join(', ')}` : null
    };
}

/**
 * Keep Almighty about-page summary in lockstep with active PersonTag names.
 * Call after any tag create / update / delete so #aboutSummary mirrors the catalog.
 */
async function syncAboutSummaryFromActiveTags(UserModel) {
    if (!UserModel) return { synced: false, summary: '' };

    const activeTags = await getActivePersonTags();
    const summary = formatActiveTagsAsSummary(activeTags);

    const almightyUser = await UserModel.findOne({ role: 'Almighty', isActive: true })
        .sort({ level: -1, createdAt: 1 })
        .select('metadata');

    if (!almightyUser) {
        return { synced: false, summary };
    }

    if (!almightyUser.metadata || typeof almightyUser.metadata !== 'object') {
        almightyUser.metadata = {};
    }
    if (!almightyUser.metadata.aboutContact || typeof almightyUser.metadata.aboutContact !== 'object') {
        almightyUser.metadata.aboutContact = {};
    }

    almightyUser.metadata.aboutContact.summary = String(summary || '').slice(0, 20000);
    almightyUser.markModified('metadata');
    await almightyUser.save();

    return { synced: true, summary, tagCount: activeTags.length };
}

/**
 * When a catalog tag is renamed, rewrite matching strings on existing Person.tags arrays.
 */
async function renameTagOnPeople(PersonModel, oldName, newName) {
    const from = normalizeTagName(oldName);
    const to = normalizeTagName(newName);
    if (!PersonModel || !from || !to || from.toLowerCase() === to.toLowerCase()) {
        return { matched: 0 };
    }

    const result = await PersonModel.updateMany(
        { tags: from },
        { $set: { 'tags.$[elem]': to } },
        { arrayFilters: [{ elem: from }] }
    );

    return { matched: result.modifiedCount || 0 };
}

module.exports = {
    normalizeTagName,
    uniqueNormalizedTagNames,
    formatActiveTagsAsSummary,
    ensureDefaultPersonTags,
    getActivePersonTags,
    getAllPersonTagsForAdmin,
    validateTagsAgainstCatalog,
    syncAboutSummaryFromActiveTags,
    renameTagOnPeople
};
