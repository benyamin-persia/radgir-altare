/**
 * ============================================
 * Role Upgrade Request Routes
 * ============================================
 * These routes handle role upgrade requests:
 * - POST /api/role-upgrade/request - Guest users can request role upgrade
 * - GET /api/role-upgrade/my-requests - Get user's own requests
 * - GET /api/role-upgrade/pending - Get all pending requests (Almighty only)
 * - POST /api/role-upgrade/:id/approve - Approve request (Almighty only)
 * - POST /api/role-upgrade/:id/deny - Deny request (Almighty only)
 */

const express = require('express');
const router = express.Router();

const RoleUpgradeRequest = require('../models/RoleUpgradeRequest');
const User = require('../models/User');
const authenticate = require('../middleware/auth');
const { isAlmighty } = require('../middleware/authorize');
const { body, validationResult } = require('express-validator');
const AuditLog = require('../models/AuditLog');

/**
 * POST /api/role-upgrade/request
 * Guest users can request role upgrade to User only
 */
router.post('/request', [
    authenticate,
    body('requestedRole')
        .equals('User')
        .withMessage('Guests can only request to become User. Higher roles must be assigned by an administrator.'),
    body('message')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Message cannot exceed 500 characters')
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

        const user = req.user;
        const { requestedRole, message } = req.body;

        // Only Guest users can request upgrades
        if (user.role !== 'Guest') {
            return res.status(403).json({
                success: false,
                message: 'Only Guest users can request role upgrades. Your current role is already higher than Guest.'
            });
        }

        // Force requested role to User (Guests can only request to become User)
        const finalRequestedRole = 'User';

        // Check if user already has a pending request
        const existingRequest = await RoleUpgradeRequest.findOne({
            userId: user._id,
            status: 'pending'
        });

        if (existingRequest) {
            return res.status(409).json({
                success: false,
                message: 'You already have a pending role upgrade request. Please wait for it to be processed.'
            });
        }

        // Create upgrade request (Guest → User only)
        const upgradeRequest = new RoleUpgradeRequest({
            userId: user._id,
            username: user.username,
            currentRole: user.role,
            requestedRole: finalRequestedRole, // Always User for Guest requests
            message: message || null,
            status: 'pending'
        });

        await upgradeRequest.save();

        // Log the action
        await AuditLog.logAction({
            userId: user._id,
            username: user.username,
            userRole: user.role,
            action: 'user_role_changed',
            description: `Requested role upgrade from ${user.role} to ${requestedRole}`,
            ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent'],
            requestMethod: 'POST',
            requestPath: '/api/role-upgrade/request',
            success: true,
            metadata: {
                requestedRole,
                message
            }
        });

        console.log(`Role upgrade request created by ${user.username}: ${user.role} -> ${requestedRole}`);

        res.status(201).json({
            success: true,
            message: 'Role upgrade request submitted successfully. An administrator will review your request.',
            data: {
                request: {
                    id: upgradeRequest._id,
                    currentRole: upgradeRequest.currentRole,
                    requestedRole: upgradeRequest.requestedRole,
                    status: upgradeRequest.status,
                    createdAt: upgradeRequest.createdAt
                }
            }
        });
    } catch (error) {
        console.error('Error creating role upgrade request:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating role upgrade request'
        });
    }
});

/**
 * GET /api/role-upgrade/my-requests
 * Get current user's role upgrade requests
 */
router.get('/my-requests', authenticate, async (req, res) => {
    try {
        const requests = await RoleUpgradeRequest.getUserRequests(req.user._id);

        res.json({
            success: true,
            data: { requests }
        });
    } catch (error) {
        console.error('Error fetching user requests:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching requests'
        });
    }
});

/**
 * GET /api/role-upgrade/pending
 * Get all pending upgrade requests (Almighty and SuperAdmin only)
 */
router.get('/pending', authenticate, async (req, res) => {
    // Check if user is Almighty or SuperAdmin
    if (req.user.role !== 'Almighty' && req.user.role !== 'SuperAdmin') {
        return res.status(403).json({
            success: false,
            message: 'Only Almighty and SuperAdmin users can view pending upgrade requests'
        });
    }
    try {
        const { page = 1, limit = 20 } = req.query;
        const result = await RoleUpgradeRequest.getPendingRequests({ page, limit });

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error fetching pending requests:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching pending requests'
        });
    }
});

/**
 * POST /api/role-upgrade/:id/approve
 * Approve a role upgrade request (Almighty or SuperAdmin)
 */
router.post('/:id/approve', [
    authenticate,
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Notes cannot exceed 500 characters')
], async (req, res) => {
    try {
        const { id } = req.params;
        const { notes } = req.body;

        const request = await RoleUpgradeRequest.findById(id);
        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Upgrade request not found'
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Request has already been ${request.status}`
            });
        }

        // Approve the request (this also updates the user's role)
        await request.approve(req.user._id, notes);

        // Get updated user for logging
        const updatedUser = await User.findById(request.userId);

        // Log the action
        await AuditLog.logAction({
            userId: req.user._id,
            username: req.user.username,
            userRole: req.user.role,
            action: 'user_role_changed',
            description: `Approved role upgrade for ${request.username}: ${request.currentRole} -> ${request.requestedRole}`,
            resourceType: 'user',
            resourceId: request.userId,
            ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent'],
            requestMethod: 'POST',
            requestPath: `/api/role-upgrade/${id}/approve`,
            success: true,
            metadata: {
                targetUserId: request.userId,
                targetUsername: request.username,
                oldRole: request.currentRole,
                newRole: request.requestedRole,
                notes
            }
        });

        console.log(`Role upgrade approved by ${req.user.username}: ${request.username} (${request.currentRole} -> ${request.requestedRole})`);

        res.json({
            success: true,
            message: `Role upgrade approved. ${request.username} is now a ${request.requestedRole}.`,
            data: {
                request: {
                    id: request._id,
                    status: request.status,
                    processedBy: request.processedBy,
                    processedAt: request.processedAt
                },
                user: {
                    id: updatedUser._id,
                    username: updatedUser.username,
                    role: updatedUser.role,
                    level: updatedUser.level
                }
            }
        });
    } catch (error) {
        console.error('Error approving upgrade request:', error);
        res.status(500).json({
            success: false,
            message: 'Error approving upgrade request'
        });
    }
});

/**
 * POST /api/role-upgrade/:id/deny
 * Deny a role upgrade request (Almighty or SuperAdmin)
 */
router.post('/:id/deny', [
    authenticate,
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Notes cannot exceed 500 characters')
], async (req, res) => {
    try {
        // Check if user is Almighty or SuperAdmin
        if (req.user.role !== 'Almighty' && req.user.role !== 'SuperAdmin') {
            return res.status(403).json({
                success: false,
                message: 'Only Almighty and SuperAdmin users can deny upgrade requests'
            });
        }

        const { id } = req.params;
        const { notes } = req.body;

        const request = await RoleUpgradeRequest.findById(id);
        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Upgrade request not found'
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Request has already been ${request.status}`
            });
        }

        // Deny the request
        await request.deny(req.user._id, notes);

        // Log the action
        await AuditLog.logAction({
            userId: req.user._id,
            username: req.user.username,
            userRole: req.user.role,
            action: 'user_role_changed',
            description: `Denied role upgrade request for ${request.username}: ${request.currentRole} -> ${request.requestedRole}`,
            resourceType: 'user',
            resourceId: request.userId,
            ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent'],
            requestMethod: 'POST',
            requestPath: `/api/role-upgrade/${id}/deny`,
            success: true,
            metadata: {
                targetUserId: request.userId,
                targetUsername: request.username,
                requestedRole: request.requestedRole,
                notes
            }
        });

        console.log(`Role upgrade denied by ${req.user.username}: ${request.username} (${request.currentRole} -> ${request.requestedRole})`);

        res.json({
            success: true,
            message: 'Role upgrade request denied.',
            data: {
                request: {
                    id: request._id,
                    status: request.status,
                    processedBy: request.processedBy,
                    processedAt: request.processedAt,
                    processingNotes: request.processingNotes
                }
            }
        });
    } catch (error) {
        console.error('Error denying upgrade request:', error);
        res.status(500).json({
            success: false,
            message: 'Error denying upgrade request'
        });
    }
});

module.exports = router;
