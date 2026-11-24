/**
 * ============================================
 * Almighty User Routes
 * ============================================
 * These routes are exclusively for Almighty users
 * They handle user management, role assignment, and permission management
 * All routes require Almighty role
 */

// Import Express Router
const express = require('express');
const router = express.Router();

// Import User model
const User = require('../models/User');

// Import Person model (needed to delete/soft-delete posts when user is deleted)
const Person = require('../models/Person');
const PersonTag = require('../models/PersonTag');
const ContactMessage = require('../models/ContactMessage');
const { sendEmail } = require('../utils/emailService');
const {
    notifyNewListingToSocials,
    isTelegramConfigured,
    pickPublicImageUrl
} = require('../utils/socialNotify');
const { getImageUrl } = require('../utils/upload');
const {
    ensureDefaultPersonTags,
    getAllPersonTagsForAdmin,
    getActivePersonTags,
    formatActiveTagsAsSummary,
    normalizeTagName,
    syncAboutSummaryFromActiveTags,
    renameTagOnPeople
} = require('../utils/personTagCatalog');

// Import authentication and authorization middleware
const authenticate = require('../middleware/auth');
const { isAlmighty } = require('../middleware/authorize');

// Import validation
const { body, param, validationResult } = require('express-validator');

// All routes require authentication and Almighty role
router.use(authenticate);
router.use(isAlmighty);

const DEFAULT_ABOUT_CONTACT = {
    headline: 'درباره من و راه‌های ارتباطی',
    summary: 'این صفحه برای معرفی کوتاه و دریافت نظرها و پیشنهادهای شما ساخته شده است.',
    seeking: 'به دنبال افراد عاقل و کاربلد برای همکاری هستم.',
    email: 'radgir@protonmail.com'
};

function mergeAboutContact(raw = {}) {
    const merged = { ...DEFAULT_ABOUT_CONTACT };
    const fields = ['headline', 'summary', 'seeking', 'email']; // position/contactPrompt removed from about page

    fields.forEach((field) => {
        const value = raw ? raw[field] : undefined;
        if (typeof value === 'string' && value.trim().length > 0) {
            merged[field] = value.trim();
        }
    });

    return merged;
}

/**
 * Basic safety check to prevent publishing direct violent threats.
 * This is intentionally conservative and blocks clear threat language.
 */
function hasThreateningLanguage(text) {
    if (!text || typeof text !== 'string') return false;
    const patterns = [
        /مرگ\s*بر/iu,
        /انتقام/iu,
        /به\s*حساب(?:شون|شان)?\s*می[‌\s-]*رسیم/iu,
        /پیدا\s*می[‌\s-]*کنیم/iu,
        /می[‌\s-]*کش(?:یم|ن|د)/iu,
        /\bkill\b/iu,
        /\brevenge\b/iu
    ];
    return patterns.some((p) => p.test(text));
}

function normalizeAboutContact(bodyData = {}) {
    return {
        headline: (bodyData.headline || '').toString().trim(),
        summary: (bodyData.summary || '').toString().trim(),
        seeking: (bodyData.seeking || '').toString().trim(),
        email: (bodyData.email || '').toString().trim().toLowerCase()
    };
}

/**
 * GET /api/almighty/users
 * Get all users in the system
 * Almighty can see all users with full details
 * 
 * Query parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 10)
 * - role: Filter by role
 * - search: Search by username or email
 */
router.get('/users', async (req, res) => {
    try {
        const { page = 1, limit = 10, role, search } = req.query;
        
        console.log(`Almighty user ${req.user.username} requested user list`);

        // Build query filter
        const filter = {};
        
        if (role) {
            filter.role = role;
        }
        
        if (search) {
            filter.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        // Calculate pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Get total count for pagination
        const total = await User.countDocuments(filter);

        // Get users with pagination
        const users = await User.find(filter)
            .select('-password')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        console.log(`Found ${users.length} users matching criteria`);

        res.json({
            success: true,
            data: {
                users,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching users'
        });
    }
});

/**
 * GET /api/almighty/users/:id
 * Get specific user by ID
 * Almighty can see full user details
 */
router.get('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;

        console.log(`Almighty user ${req.user.username} requested user: ${id}`);

        const user = await User.findById(id).select('-password');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            data: { user }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching user'
        });
    }
});

/**
 * POST /api/almighty/users
 * Create a new user
 * Almighty can create users with any role and permissions
 * 
 * Request body:
 * - username: string (required)
 * - email: string (required)
 * - password: string (required)
 * - role: string (required)
 * - level: number (optional, defaults to role level)
 * - permissions: string[] (optional)
 * - metadata: object (optional)
 */
router.post('/users', [
    body('username')
        .trim()
        .isLength({ min: 3, max: 30 })
        .withMessage('Username must be between 3 and 30 characters'),
    body('email')
        .trim()
        .isEmail()
        .withMessage('Please provide a valid email address'),
    body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters'),
    body('role')
        .isIn(['Almighty', 'SuperAdmin', 'Admin', 'Manager', 'User', 'Guest'])
        .withMessage('Invalid role'),
    body('level')
        .optional()
        .isInt({ min: 0, max: 100 })
        .withMessage('Level must be between 0 and 100')
], async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { username, email, password, role, level, permissions = [], metadata = {} } = req.body;

        console.log(`Almighty user ${req.user.username} creating new user: ${username} (${role})`);

        // Check if user already exists
        const existingUser = await User.findOne({
            $or: [{ username }, { email }]
        });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: existingUser.username === username 
                    ? 'Username already exists' 
                    : 'Email already exists'
            });
        }

        // Get level (use provided or default for role)
        const userLevel = level !== undefined ? level : User.getRoleLevel(role);

        // Determine permissions: use provided permissions, or empty array (pre-save middleware will assign defaults)
        // If permissions are explicitly provided, use them; otherwise let pre-save middleware assign defaults
        const userPermissions = permissions && permissions.length > 0 ? permissions : [];

        // Create new user
        // Permissions will be automatically assigned by pre-save middleware if empty
        const user = new User({
            username,
            email,
            password,
            role,
            level: userLevel,
            permissions: userPermissions, // Empty array = use defaults, non-empty = use provided
            createdBy: req.user._id, // Track who created this user
            isActive: true,
            metadata
        });

        await user.save();

        console.log(`User created successfully: ${username} by Almighty ${req.user.username}`);

        res.status(201).json({
            success: true,
            message: 'User created successfully',
            data: {
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    level: user.level,
                    permissions: user.permissions,
                    createdBy: user.createdBy,
                    metadata: user.metadata
                }
            }
        });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating user'
        });
    }
});

/**
 * PUT /api/almighty/users/:id
 * Update user (role, level, permissions, etc.)
 * Almighty can update any user's information
 */
router.put('/users/:id', [
    body('role')
        .optional()
        .isIn(['Almighty', 'SuperAdmin', 'Admin', 'Manager', 'User', 'Guest'])
        .withMessage('Invalid role'),
    body('level')
        .optional()
        .isInt({ min: 0, max: 100 })
        .withMessage('Level must be between 0 and 100')
], async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { id } = req.params;
        const { username, email, password, role, level, permissions, isActive, metadata } = req.body;

        console.log(`Almighty user ${req.user.username} updating user: ${id}`);

        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Update fields
        if (username && username !== user.username) {
            const usernameExists = await User.findOne({ username, _id: { $ne: id } });
            if (usernameExists) {
                return res.status(409).json({
                    success: false,
                    message: 'Username already exists'
                });
            }
            user.username = username;
        }

        if (email && email !== user.email) {
            const emailExists = await User.findOne({ email, _id: { $ne: id } });
            if (emailExists) {
                return res.status(409).json({
                    success: false,
                    message: 'Email already exists'
                });
            }
            user.email = email;
        }

        if (password) {
            user.password = password; // Will be hashed by pre-save middleware
        }

        if (role) {
            user.role = role;
            // Update level if not explicitly provided
            if (level === undefined) {
                user.level = User.getRoleLevel(role);
            }
        }

        if (level !== undefined) {
            user.level = level;
        }

        if (permissions !== undefined) {
            user.permissions = permissions;
        }

        if (isActive !== undefined) {
            user.isActive = isActive;
        }

        if (metadata) {
            user.metadata = { ...user.metadata, ...metadata };
        }

        await user.save();

        console.log(`User updated successfully: ${user.username}`);

        res.json({
            success: true,
            message: 'User updated successfully',
            data: {
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    level: user.level,
                    permissions: user.permissions,
                    isActive: user.isActive,
                    metadata: user.metadata,
                    updatedAt: user.updatedAt
                }
            }
        });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user'
        });
    }
});

/**
 * DELETE /api/almighty/users/:id
 * Delete a user
 * Almighty can delete any user (except themselves)
 */
router.delete('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;

        console.log(`Almighty user ${req.user.username} deleting user: ${id}`);

        // Prevent Almighty from deleting themselves
        if (id === req.user._id.toString()) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete your own account'
            });
        }

        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Get count of posts created by this user before deletion
        const postsCount = await Person.countDocuments({ createdBy: id });
        console.log(`User ${user.username} has ${postsCount} posts that will be soft-deleted`);

        // Soft-delete all posts created by this user (set isActive to false)
        // This ensures posts from deleted users are hidden but not permanently removed
        const softDeleteResult = await Person.updateMany(
            { createdBy: id },
            { $set: { isActive: false } }
        );
        console.log(`Soft-deleted ${softDeleteResult.modifiedCount} posts for user: ${user.username} (${id})`);

        // Delete user account
        await User.findByIdAndDelete(id);

        console.log(`User deleted successfully: ${user.username} (${id}). ${softDeleteResult.modifiedCount} posts were soft-deleted.`);

        res.json({
            success: true,
            message: `User deleted successfully. ${softDeleteResult.modifiedCount} posts created by this user have been hidden.`,
            postsDeleted: softDeleteResult.modifiedCount
        });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting user'
        });
    }
});

/**
 * GET /api/almighty/stats
 * Get system statistics
 * Almighty can see system-wide statistics
 */
router.get('/stats', async (req, res) => {
    try {
        console.log(`Almighty user ${req.user.username} requested system stats`);

        // Get user counts by role
        const roleCounts = await User.aggregate([
            {
                $group: {
                    _id: '$role',
                    count: { $sum: 1 }
                }
            }
        ]);

        // Get total user count
        const totalUsers = await User.countDocuments();

        // Get active/inactive counts
        const activeUsers = await User.countDocuments({ isActive: true });
        const inactiveUsers = await User.countDocuments({ isActive: false });

        // Get recent registrations (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentUsers = await User.countDocuments({
            createdAt: { $gte: sevenDaysAgo }
        });

        res.json({
            success: true,
            data: {
                totalUsers,
                activeUsers,
                inactiveUsers,
                recentUsers,
                roleCounts: roleCounts.reduce((acc, item) => {
                    acc[item._id] = item.count;
                    return acc;
                }, {})
            }
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching statistics'
        });
    }
});

/**
 * GET /api/almighty/tags
 * Returns all person tags (active + inactive) for Almighty management.
 */
router.get('/tags', async (req, res) => {
    try {
        await ensureDefaultPersonTags();
        const tags = await getAllPersonTagsForAdmin();

        res.json({
            success: true,
            data: { tags }
        });
    } catch (error) {
        console.error('Get almighty tags error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching tags'
        });
    }
});

/**
 * POST /api/almighty/tags
 * Creates a new configurable person tag.
 */
router.post(
    '/tags',
    [
        body('name')
            .trim()
            .notEmpty().withMessage('Tag name is required')
            .isLength({ max: 100 }).withMessage('Tag name max length is 100'),
        body('sortOrder')
            .optional()
            .isInt({ min: -100000, max: 100000 })
            .withMessage('sortOrder must be a valid integer')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array()
                });
            }

            await ensureDefaultPersonTags();

            const normalizedName = normalizeTagName(req.body.name);
            if (!normalizedName) {
                return res.status(400).json({
                    success: false,
                    message: 'Tag name is required'
                });
            }

            const existing = await PersonTag.findOne({ normalizedName: normalizedName.toLowerCase() }).select('_id');
            if (existing) {
                return res.status(409).json({
                    success: false,
                    message: 'Tag already exists'
                });
            }

            const tag = new PersonTag({
                name: normalizedName,
                sortOrder: req.body.sortOrder !== undefined ? parseInt(req.body.sortOrder, 10) : 0,
                isActive: req.body.isActive !== undefined
                    ? (req.body.isActive === true || req.body.isActive === 'true')
                    : true,
                createdBy: req.user._id,
                updatedBy: req.user._id
            });

            await tag.save();
            await syncAboutSummaryFromActiveTags(User); // Keep aboutSummary / logo / form catalog in sync.

            res.status(201).json({
                success: true,
                message: 'Tag created successfully',
                data: { tag }
            });
        } catch (error) {
            if (error && error.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: 'Tag already exists'
                });
            }
            console.error('Create almighty tag error:', error);
            res.status(500).json({
                success: false,
                message: 'Error creating tag'
            });
        }
    }
);

/**
 * PUT /api/almighty/tags/:id
 * Updates tag name, active state, and sort order.
 */
router.put(
    '/tags/:id',
    [
        param('id').isMongoId().withMessage('Invalid tag ID'),
        body('name').optional().trim().notEmpty().isLength({ max: 100 }).withMessage('Tag name max length is 100'),
        body('sortOrder').optional().isInt({ min: -100000, max: 100000 }).withMessage('sortOrder must be a valid integer'),
        body('isActive').optional().isBoolean().withMessage('isActive must be boolean')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array()
                });
            }

            await ensureDefaultPersonTags();

            const tag = await PersonTag.findById(req.params.id);
            if (!tag) {
                return res.status(404).json({
                    success: false,
                    message: 'Tag not found'
                });
            }

            const previousName = tag.name; // Capture old name so Person.tags strings can be rewritten on rename.

            if (req.body.name !== undefined) {
                const normalizedName = normalizeTagName(req.body.name);
                const existing = await PersonTag.findOne({
                    normalizedName: normalizedName.toLowerCase(),
                    _id: { $ne: tag._id }
                }).select('_id');
                if (existing) {
                    return res.status(409).json({
                        success: false,
                        message: 'Tag already exists'
                    });
                }
                tag.name = normalizedName;
            }

            if (req.body.sortOrder !== undefined) {
                tag.sortOrder = parseInt(req.body.sortOrder, 10);
            }

            if (req.body.isActive !== undefined) {
                tag.isActive = req.body.isActive === true || req.body.isActive === 'true';
            }

            tag.updatedBy = req.user._id;
            await tag.save();

            if (previousName && tag.name && previousName !== tag.name) {
                await renameTagOnPeople(Person, previousName, tag.name); // Propagate rename into existing listings.
            }
            await syncAboutSummaryFromActiveTags(User);

            res.json({
                success: true,
                message: 'Tag updated successfully',
                data: { tag }
            });
        } catch (error) {
            if (error && error.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: 'Tag already exists'
                });
            }
            console.error('Update almighty tag error:', error);
            res.status(500).json({
                success: false,
                message: 'Error updating tag'
            });
        }
    }
);

/**
 * DELETE /api/almighty/tags/:id
 * Deletes a tag from the catalog.
 */
router.delete('/tags/:id', [
    param('id').isMongoId().withMessage('Invalid tag ID')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        await ensureDefaultPersonTags();

        const deletedTag = await PersonTag.findByIdAndDelete(req.params.id);
        if (!deletedTag) {
            return res.status(404).json({
                success: false,
                message: 'Tag not found'
            });
        }

        await syncAboutSummaryFromActiveTags(User); // Drop deleted tag from about lead + public catalog consumers.

        res.json({
            success: true,
            message: 'Tag deleted successfully'
        });
    } catch (error) {
        console.error('Delete almighty tag error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting tag'
        });
    }
});

/**
 * POST /api/almighty/telegram/backfill
 * Publish active listings that are not yet linked to a Telegram channel message.
 * Body/query: { limit?: number, all?: boolean }
 */
router.post('/telegram/backfill', async (req, res) => {
    try {
        if (!isTelegramConfigured()) {
            return res.status(400).json({
                success: false,
                message: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID).'
            });
        }

        const wantAll = req.body?.all === true || req.query.all === 'true' || req.query.all === '1';
        const limitRaw = parseInt(req.body?.limit ?? req.query.limit, 10);
        const limit = wantAll ? 500 : Math.min(Math.max(limitRaw || 20, 1), 100);

        const filter = {
            isActive: true,
            $or: [
                { telegramMessage: { $exists: false } },
                { 'telegramMessage.messageId': null },
                { 'telegramMessage.messageId': { $exists: false } }
            ]
        };

        const missing = await Person.countDocuments(filter);
        const people = await Person.find(filter).sort({ createdAt: -1 }).limit(limit).lean();

        const results = [];
        for (const person of people) {
            const imageUrls = (person.images || [])
                .map((img) => getImageUrl(img, req))
                .filter(Boolean);
            const publicUrls = imageUrls.filter((u) => /^https:\/\//i.test(String(u)));
            try {
                const notify = await notifyNewListingToSocials(person, {
                    imageUrls: publicUrls.length ? publicUrls : imageUrls,
                    telegram: true,
                    instagram: false,
                    isBackfill: true
                });
                results.push({
                    id: person._id,
                    name: person.name,
                    ok: Boolean(notify?.telegram?.ok || notify?.telegram?.messageId),
                    messageId: notify?.telegram?.messageId || null,
                    error: notify?.telegram?.error || null
                });
            } catch (error) {
                results.push({
                    id: person._id,
                    name: person.name,
                    ok: false,
                    error: String(error.message || error)
                });
            }
            // Small pause to avoid Telegram flood limits
            await new Promise((r) => setTimeout(r, 800));
        }

        const posted = results.filter((r) => r.ok).length;
        res.json({
            success: true,
            message: `Backfill finished: ${posted}/${results.length} posted (missing before: ${missing}).`,
            data: {
                missingBefore: missing,
                attempted: results.length,
                posted,
                results
            }
        });
    } catch (error) {
        console.error('Telegram backfill error:', error);
        res.status(500).json({
            success: false,
            message: 'Error backfilling Telegram listings'
        });
    }
});

/**
 * GET /api/almighty/contact-messages
 * Lists public contact-form submissions newest first.
 */
router.get('/contact-messages', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const messages = await ContactMessage.find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        const unreadCount = await ContactMessage.countDocuments({ isRead: false });

        res.json({
            success: true,
            data: { messages, unreadCount }
        });
    } catch (error) {
        console.error('Get contact-messages error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching contact messages'
        });
    }
});

/**
 * PATCH /api/almighty/contact-messages/:id/read
 * Marks one contact-form message as read.
 */
router.patch('/contact-messages/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        if (!require('mongoose').Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid message id' });
        }

        const message = await ContactMessage.findByIdAndUpdate(
            id,
            { isRead: true },
            { new: true }
        ).lean();

        if (!message) {
            return res.status(404).json({ success: false, message: 'Message not found' });
        }

        res.json({ success: true, data: { message } });
    } catch (error) {
        console.error('Mark contact-message read error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating contact message'
        });
    }
});

/**
 * POST /api/almighty/contact-messages/test-email
 * Sends a probe email to the configured About/Contact address.
 */
router.post('/contact-messages/test-email', async (req, res) => {
    try {
        const currentUser = await User.findById(req.user._id).select('metadata.aboutContact email');
        const aboutContact = mergeAboutContact(currentUser?.metadata?.aboutContact || {});
        const destination = aboutContact.email || currentUser?.email || 'radgir@protonmail.com';

        const result = await sendEmail({
            to: destination,
            subject: `Radgir contact email test — ${new Date().toISOString()}`,
            html: `<p>This is a test from the Almighty portal.</p><p>If you received this, outbound SMTP to <strong>${destination}</strong> works.</p>`,
            text: `This is a test from the Almighty portal. Destination: ${destination}`
        });

        if (!result.success) {
            return res.status(502).json({
                success: false,
                message: result.error || 'Test email failed',
                data: { destination }
            });
        }

        res.json({
            success: true,
            message: `Test email queued for ${destination}`,
            data: {
                destination,
                messageId: result.messageId || null
            }
        });
    } catch (error) {
        console.error('Test contact email error:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending test email'
        });
    }
});

/**
 * GET /api/almighty/about-contact
 * Returns editable About/Contact content for current Almighty user.
 */
router.get('/about-contact', async (req, res) => {
    try {
        const currentUser = await User.findById(req.user._id).select('metadata.aboutContact');
        const aboutContact = mergeAboutContact(currentUser?.metadata?.aboutContact || {});
        // Summary is owned by the PersonTag catalog — show live active tags in the editor too.
        aboutContact.summary = formatActiveTagsAsSummary(await getActivePersonTags()) || aboutContact.summary;

        res.json({
            success: true,
            data: { aboutContact }
        });
    } catch (error) {
        console.error('Get almighty about-contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching about/contact content'
        });
    }
});

/**
 * PUT /api/almighty/about-contact
 * Updates About/Contact content for current Almighty user.
 */
router.put(
    '/about-contact',
    [
        body('headline').optional().isLength({ max: 200 }).withMessage('Headline max length is 200'),
        body('seeking').optional().isLength({ max: 2000 }).withMessage('Seeking max length is 2000'),
        body('email').optional().isEmail().withMessage('Please provide a valid email address')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array()
                });
            }

            const payload = normalizeAboutContact(req.body);
            // Summary is owned by the PersonTag catalog — never trust a client textarea dump.
            const liveSummary = formatActiveTagsAsSummary(await getActivePersonTags());
            payload.summary = (liveSummary || '').slice(0, 20000);

            const user = await User.findById(req.user._id);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            const previous = mergeAboutContact(user.metadata?.aboutContact || {});
            user.metadata = user.metadata || {};
            user.metadata.aboutContact = mergeAboutContact({
                ...previous,
                headline: payload.headline || previous.headline,
                seeking: payload.seeking || previous.seeking,
                email: payload.email || previous.email,
                summary: payload.summary || previous.summary
            });
            user.markModified('metadata'); // Nested metadata.aboutContact must be marked dirty for Mongoose

            await user.save();

            res.json({
                success: true,
                message: 'About/Contact content updated successfully',
                data: {
                    aboutContact: user.metadata.aboutContact
                }
            });
        } catch (error) {
            console.error('Update almighty about-contact error:', error);
            res.status(500).json({
                success: false,
                message: 'Error updating about/contact content'
            });
        }
    }
);

// Export router
module.exports = router;
