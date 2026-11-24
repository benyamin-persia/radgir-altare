/**
 * ============================================
 * User Routes
 * ============================================
 * These routes handle user profile operations.
 * Some routes are public, while profile/bookmark routes require authentication.
 */

// Import Express Router
const express = require('express');
const router = express.Router();

// Import User model
const User = require('../models/User');
const Person = require('../models/Person');
const ContactMessage = require('../models/ContactMessage');
const mongoose = require('mongoose');
const { getActivePersonTags, formatActiveTagsAsSummary } = require('../utils/personTagCatalog');

// Import authentication middleware
const authenticate = require('../middleware/auth');

// Email + token helpers for re-verification when profile email/password changes
const { sendVerificationEmail, sendSecurityNotification, sendEmail } = require('../utils/emailService');
const { generateEmailVerificationToken, hashToken } = require('../utils/tokenGenerator');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { notifyContactFormToTelegramAsync } = require('../utils/socialNotify');

// Limit public contact-form spam: a few submissions per IP per window
const contactFormLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many contact messages from this IP, please try again later.'
});

// Default public about/contact content
const DEFAULT_ABOUT_CONTACT = {
    headline: 'درباره من و راه‌های ارتباطی',
    summary: 'این صفحه برای معرفی کوتاه و دریافت نظرها و پیشنهادهای شما ساخته شده است.',
    seeking: 'به دنبال افراد عاقل و کاربلد برای همکاری هستم.',
    email: 'radgir@protonmail.com'
};

function mergeAboutContact(raw = {}) {
    const merged = { ...DEFAULT_ABOUT_CONTACT };
    const fields = ['headline', 'summary', 'seeking', 'email'];

    fields.forEach((field) => {
        const value = raw ? raw[field] : undefined;
        if (typeof value === 'string' && value.trim().length > 0) {
            merged[field] = value.trim();
        }
    });

    return merged;
}

/** About lead (#aboutSummary) always mirrors active PersonTag catalog managed in the portal. */
async function withLiveTagSummary(aboutContact) {
    const merged = mergeAboutContact(aboutContact);
    try {
        const tags = await getActivePersonTags();
        const liveSummary = formatActiveTagsAsSummary(tags);
        if (liveSummary) {
            merged.summary = liveSummary;
        }
    } catch (error) {
        console.warn('Could not load live tag summary for about-contact:', error.message || error);
    }
    return merged;
}

function toAbsoluteImageUrl(imagePath, req) {
    if (!imagePath) return null;
    const raw = String(imagePath).trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) return raw;

    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    if (normalized.startsWith('/uploads/')) {
        return `${req.protocol}://${req.get('host')}${normalized}`;
    }
    return `${req.protocol}://${req.get('host')}/uploads/${raw.replace(/^\/+/, '')}`;
}

function normalizeBookmarkedPerson(person, req) {
    const p = { ...person };
    if (Array.isArray(p.images)) {
        p.images = p.images
            .map((entry) => {
                if (typeof entry === 'string') return toAbsoluteImageUrl(entry, req);
                if (entry && typeof entry === 'object' && entry.url) {
                    return toAbsoluteImageUrl(entry.url, req);
                }
                return null;
            })
            .filter(Boolean);
    } else {
        p.images = [];
    }
    p.isBookmarked = true;
    return p;
}

function sanitizePublicUser(userDoc, req) {
    const metadata = userDoc?.metadata || {};
    const firstName = typeof metadata.firstName === 'string' ? metadata.firstName.trim() : '';
    const lastName = typeof metadata.lastName === 'string' ? metadata.lastName.trim() : '';
    const bio = typeof metadata.bio === 'string' ? metadata.bio.trim() : '';
    const website = typeof metadata.website === 'string' ? metadata.website.trim() : '';
    const location = typeof metadata.location === 'string' ? metadata.location.trim() : '';
    const avatarRaw = typeof metadata.avatar === 'string' ? metadata.avatar.trim() : '';

    return {
        id: String(userDoc._id),
        username: userDoc.username,
        role: userDoc.role,
        createdAt: userDoc.createdAt,
        metadata: {
            firstName,
            lastName,
            bio,
            website,
            location,
            avatar: avatarRaw ? toAbsoluteImageUrl(avatarRaw, req) : null
        },
        allowDirectMessages: metadata.allowDirectMessages !== false
    };
}

/**
 * GET /api/users/about-contact
 * Public endpoint to read About/Contact content for the public page.
 */
router.get('/about-contact', async (req, res) => {
    try {
        // Use the highest-level active Almighty user as source of truth.
        const almightyUser = await User.findOne({ role: 'Almighty', isActive: true })
            .sort({ level: -1, createdAt: 1 })
            .select('username metadata.aboutContact');

        const aboutContact = await withLiveTagSummary(almightyUser?.metadata?.aboutContact || {});

        res.json({
            success: true,
            data: {
                owner: almightyUser?.username || null,
                aboutContact
            }
        });
    } catch (error) {
        console.error('Get public about-contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching about/contact content'
        });
    }
});

/**
 * POST /api/users/about-contact/message
 * Public contact form: always stores the message, then emails the site owner.
 */
router.post('/about-contact/message', contactFormLimiter, async (req, res) => {
    try {
        const firstName = String(req.body?.firstName || '').trim().slice(0, 80);
        const lastName = String(req.body?.lastName || '').trim().slice(0, 80);
        const phone = String(req.body?.phone || '').trim().slice(0, 40);
        const email = String(req.body?.email || '').trim().slice(0, 120).toLowerCase();
        const message = String(req.body?.message || '').trim().slice(0, 4000);

        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); // lightweight format check before SMTP
        if (!emailOk) {
            return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
        }
        if (!message) {
            return res.status(400).json({ success: false, message: 'Please write a message.' });
        }

        const almightyUser = await User.findOne({ role: 'Almighty', isActive: true })
            .sort({ level: -1, createdAt: 1 })
            .select('metadata.aboutContact email');

        const aboutContact = mergeAboutContact(almightyUser?.metadata?.aboutContact || {});
        const destination = aboutContact.email || almightyUser?.email || DEFAULT_ABOUT_CONTACT.email; // Prefer published contact email

        // Persist first so the message is never lost if SMTP later fails or lands in spam
        const saved = await ContactMessage.create({
            firstName,
            lastName,
            phone,
            email,
            message,
            destinationEmail: destination,
            ipAddress: String(req.ip || '').slice(0, 80),
            userAgent: String(req.get('user-agent') || '').slice(0, 400)
        });

        const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Anonymous';
        const safe = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const html = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"></head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #243C4C;">
                <h2>New Radgir contact form message</h2>
                <p><strong>Name:</strong> ${safe(fullName)}</p>
                <p><strong>Email:</strong> ${safe(email)}</p>
                <p><strong>Phone:</strong> ${safe(phone) || '—'}</p>
                <p><strong>Message:</strong></p>
                <pre style="white-space: pre-wrap; background: #F4FCFB; padding: 12px; border-radius: 8px;">${safe(message)}</pre>
                <p style="color:#698696;font-size:12px;">Also saved in Almighty Portal → About &amp; Contact.</p>
            </body>
            </html>
        `;

        const result = await sendEmail({
            to: destination,
            subject: `Radgir contact form — ${fullName}`,
            html,
            text: `New Radgir contact form message\n\nName: ${fullName}\nEmail: ${email}\nPhone: ${phone || '—'}\n\n${message}\n\nAlso saved in Almighty Portal → About & Contact.`,
            replyTo: email // Owner can hit Reply and reach the visitor directly
        });

        saved.emailDelivered = !!result.success;
        saved.emailError = result.success ? '' : String(result.error || 'Unknown email error').slice(0, 500);
        saved.emailMessageId = result.success ? String(result.messageId || '').slice(0, 200) : '';
        await saved.save();

        // Also push every form field to Telegram (private chat if TELEGRAM_CONTACT_CHAT_ID is set)
        notifyContactFormToTelegramAsync({ firstName, lastName, phone, email, message });

        if (!result.success) {
            console.warn('Contact form email not delivered:', result.error, 'savedId=', saved._id.toString());
            // Message is already stored — treat as success so visitors are not blocked by SMTP issues
            return res.json({
                success: true,
                message: 'Your message was received.',
                data: {
                    id: saved._id,
                    emailDelivered: false
                }
            });
        }

        res.json({
            success: true,
            message: 'Your message was sent successfully.',
            data: {
                id: saved._id,
                emailDelivered: true,
                messageId: result.messageId || null
            }
        });
    } catch (error) {
        console.error('Post about-contact message error:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending contact message'
        });
    }
});

/**
 * GET /api/users/public/:userId
 * Public endpoint to fetch a safe public profile for any active user.
 */
router.get('/public/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID'
            });
        }

        const user = await User.findOne({ _id: userId, isActive: true })
            .select([
                'username',
                'role',
                'createdAt',
                'metadata.firstName',
                'metadata.lastName',
                'metadata.bio',
                'metadata.avatar',
                'metadata.website',
                'metadata.location',
                'metadata.allowDirectMessages'
            ].join(' '))
            .lean();

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const userObjectId = new mongoose.Types.ObjectId(userId);
        const [postsCount, activePostsCount] = await Promise.all([
            Person.countDocuments({ createdBy: userObjectId }),
            Person.countDocuments({ createdBy: userObjectId, isActive: true })
        ]);

        res.json({
            success: true,
            data: {
                user: sanitizePublicUser(user, req),
                stats: {
                    postsCount,
                    activePostsCount
                }
            }
        });
    } catch (error) {
        console.error('Get public profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching public profile'
        });
    }
});

/**
 * GET /api/users/profile
 * Get current user's profile
 * Requires authentication
 */
router.get('/profile', authenticate, async (req, res) => {
    try {
        // User is already attached to request by authenticate middleware
        const user = req.user;

        console.log(`Profile requested by: ${user.username}`);

        // Populate favorites count for response
        const favoritesCount = user.favorites ? user.favorites.length : 0;

        res.json({
            success: true,
            data: {
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    level: user.level,
                    permissions: user.permissions,
                    isActive: user.isActive,
                    emailVerified: user.emailVerified, // required for dashboard verification status UI
                    lastLogin: user.lastLogin,
                    metadata: user.metadata,
                    favoritesCount: favoritesCount,
                    createdAt: user.createdAt,
                    updatedAt: user.updatedAt
                }
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching profile'
        });
    }
});

/**
 * PUT /api/users/profile
 * Update current user's profile
 * Requires authentication
 * Users can only update their own profile (not role, level, or permissions)
 */
router.put('/profile', authenticate, async (req, res) => {
    try {
        const user = req.user;
        const { email, password, metadata } = req.body;

        console.log(`Profile update requested by: ${user.username}`);

        // Enhanced metadata fields support
        if (metadata) {
            // Update metadata fields if provided
            if (metadata.firstName !== undefined) user.metadata.firstName = metadata.firstName?.trim() || null;
            if (metadata.lastName !== undefined) user.metadata.lastName = metadata.lastName?.trim() || null;
            if (metadata.phone !== undefined) user.metadata.phone = metadata.phone?.trim() || null;
            if (metadata.department !== undefined) user.metadata.department = metadata.department?.trim() || null;
            if (metadata.bio !== undefined) {
                const bio = metadata.bio?.trim();
                if (bio && bio.length > 500) {
                    return res.status(400).json({
                        success: false,
                        message: 'Bio cannot exceed 500 characters'
                    });
                }
                user.metadata.bio = bio || null;
            }
            if (metadata.avatar !== undefined) user.metadata.avatar = metadata.avatar?.trim() || null;
            if (metadata.website !== undefined) user.metadata.website = metadata.website?.trim() || null;
            if (metadata.location !== undefined) user.metadata.location = metadata.location?.trim() || null;
            if (metadata.notes !== undefined) user.metadata.notes = metadata.notes?.trim() || null;
        }

        // Update email if provided — changing email requires fresh verification
        let emailChanged = false;
        let verificationToken = null;
        if (email && email !== user.email) {
            // Check if new email is already taken
            const emailExists = await User.findOne({ email, _id: { $ne: user._id } });
            if (emailExists) {
                return res.status(409).json({
                    success: false,
                    message: 'Email already in use'
                });
            }
            user.email = email;
            user.emailVerified = false; // new address is untrusted until link is clicked
            verificationToken = generateEmailVerificationToken();
            user.emailVerificationToken = hashToken(verificationToken); // store hash only
            user.emailVerificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
            emailChanged = true;
        }

        // Update password if provided
        let passwordChanged = false;
        if (password) {
            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: 'Password must be at least 6 characters'
                });
            }
            user.password = password; // Will be hashed by pre-save middleware
            passwordChanged = true;
        }

        // Save changes (metadata already updated above if provided)
        await user.save();

        // Fire-and-forget emails after successful save
        if (emailChanged && verificationToken) {
            sendVerificationEmail(user, verificationToken).catch(err => {
                console.error('Error sending verification email after email change:', err);
            });
        }
        if (passwordChanged) {
            sendSecurityNotification(user, 'password_changed', {
                ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']
            }).catch(err => {
                console.error('Error sending password-changed notification:', err);
            });
        }

        console.log(`Profile updated successfully: ${user.username}`);

        res.json({
            success: true,
            message: emailChanged
                ? 'Profile updated. Please verify your new email address.'
                : 'Profile updated successfully',
            data: {
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    level: user.level,
                    permissions: user.permissions,
                    emailVerified: user.emailVerified,
                    metadata: user.metadata,
                    favoritesCount: user.favorites ? user.favorites.length : 0,
                    updatedAt: user.updatedAt
                }
            }
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating profile'
        });
    }
});

/**
 * GET /api/users/bookmarks/ids
 * Returns only bookmarked person IDs for lightweight client checks.
 */
router.get('/bookmarks/ids', authenticate, async (req, res) => {
    try {
        const ids = Array.isArray(req.user.favorites)
            ? req.user.favorites.map((id) => String(id))
            : [];

        res.json({
            success: true,
            data: {
                bookmarks: ids
            }
        });
    } catch (error) {
        console.error('Get bookmark IDs error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching bookmark IDs'
        });
    }
});

/**
 * GET /api/users/bookmarks
 * Returns bookmarked person cards for dashboard profile page.
 */
router.get('/bookmarks', authenticate, async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const favoriteIds = Array.isArray(req.user.favorites)
            ? req.user.favorites.map((id) => String(id))
            : [];
        const orderedIds = favoriteIds.slice().reverse();
        const total = orderedIds.length;
        const pagedIds = orderedIds.slice(skip, skip + limit);

        if (pagedIds.length === 0) {
            return res.json({
                success: true,
                data: {
                    people: [],
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit) || 1,
                        hasNextPage: false,
                        hasPrevPage: page > 1
                    }
                }
            });
        }

        const docs = await Person.find({ _id: { $in: pagedIds } })
            .populate('createdBy', 'username email')
            .lean();

        const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
        const people = pagedIds
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map((person) => normalizeBookmarkedPerson(person, req));

        const totalPages = Math.ceil(total / limit) || 1;
        res.json({
            success: true,
            data: {
                people,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1
                }
            }
        });
    } catch (error) {
        console.error('Get bookmarks error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching bookmarks'
        });
    }
});

/**
 * POST /api/users/bookmarks/:personId
 * Adds a person to current user's bookmarks.
 */
router.post('/bookmarks/:personId', authenticate, async (req, res) => {
    try {
        const { personId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(personId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid person ID'
            });
        }

        const personExists = await Person.exists({ _id: personId });
        if (!personExists) {
            return res.status(404).json({
                success: false,
                message: 'Person not found'
            });
        }

        const alreadyBookmarked = Array.isArray(req.user.favorites)
            && req.user.favorites.some((id) => String(id) === String(personId));

        if (!alreadyBookmarked) {
            req.user.favorites.push(personId);
            await req.user.save();
        }

        res.json({
            success: true,
            message: 'Bookmark added',
            data: {
                personId: String(personId),
                isBookmarked: true,
                favoritesCount: Array.isArray(req.user.favorites) ? req.user.favorites.length : 0
            }
        });
    } catch (error) {
        console.error('Add bookmark error:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding bookmark'
        });
    }
});

/**
 * DELETE /api/users/bookmarks/:personId
 * Removes a person from current user's bookmarks.
 */
router.delete('/bookmarks/:personId', authenticate, async (req, res) => {
    try {
        const { personId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(personId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid person ID'
            });
        }

        const favorites = Array.isArray(req.user.favorites) ? req.user.favorites : [];
        req.user.favorites = favorites.filter((id) => String(id) !== String(personId));
        await req.user.save();

        res.json({
            success: true,
            message: 'Bookmark removed',
            data: {
                personId: String(personId),
                isBookmarked: false,
                favoritesCount: Array.isArray(req.user.favorites) ? req.user.favorites.length : 0
            }
        });
    } catch (error) {
        console.error('Remove bookmark error:', error);
        res.status(500).json({
            success: false,
            message: 'Error removing bookmark'
        });
    }
});

// Export router
module.exports = router;
