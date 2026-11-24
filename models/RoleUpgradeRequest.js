/**
 * ============================================
 * Role Upgrade Request Model
 * ============================================
 * This model tracks requests from Guest users who want to be elevated to User role
 * Almighty users can approve or deny these requests
 */

const mongoose = require('mongoose');

/**
 * Role Upgrade Request Schema
 */
const roleUpgradeRequestSchema = new mongoose.Schema({
    // User who made the request
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    
    // Username at time of request (for reference)
    username: {
        type: String,
        required: true
    },
    
    // Current role
    currentRole: {
        type: String,
        required: true,
        enum: ['Guest']
    },
    
    // Requested role (for now, only User is allowed for Guest requests)
    requestedRole: {
        type: String,
        required: true,
        enum: ['User'], // Only User role allowed for Guest upgrade requests
        default: 'User'
    },
    
    // Request message/reason (optional)
    message: {
        type: String,
        trim: true,
        maxlength: [500, 'Message cannot exceed 500 characters']
    },
    
    // Request status
    status: {
        type: String,
        enum: ['pending', 'approved', 'denied'],
        default: 'pending',
        index: true
    },
    
    // Who processed the request (Almighty user)
    processedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    
    // Processing notes (optional)
    processingNotes: {
        type: String,
        trim: true
    },
    
    // Timestamps
    processedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true // createdAt and updatedAt
});

/**
 * Indexes for efficient querying
 */
roleUpgradeRequestSchema.index({ userId: 1, status: 1 });
roleUpgradeRequestSchema.index({ status: 1, createdAt: -1 });

/**
 * Static Method: Get Pending Requests
 * Get all pending upgrade requests
 */
roleUpgradeRequestSchema.statics.getPendingRequests = async function(options = {}) {
    const {
        page = 1,
        limit = 20
    } = options;

    const skip = (page - 1) * limit;

    const [requests, total] = await Promise.all([
        this.find({ status: 'pending' })
            .populate('userId', 'username email role level')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        this.countDocuments({ status: 'pending' })
    ]);

    return {
        requests,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

/**
 * Static Method: Get User Requests
 * Get all requests for a specific user
 */
roleUpgradeRequestSchema.statics.getUserRequests = async function(userId) {
    return await this.find({ userId })
        .sort({ createdAt: -1 })
        .lean();
};

/**
 * Instance Method: Approve Request
 * Approves the upgrade request and updates user role
 */
roleUpgradeRequestSchema.methods.approve = async function(processedBy, notes = null) {
    const User = mongoose.model('User');
    
    // Update request status
    this.status = 'approved';
    this.processedBy = processedBy;
    this.processedAt = new Date();
    if (notes) {
        this.processingNotes = notes;
    }
    await this.save();
    
    // Update user role
    const user = await User.findById(this.userId);
    if (user) {
        user.role = this.requestedRole;
        user.level = User.getRoleLevel(this.requestedRole);
        // Permissions will be automatically assigned by pre-save middleware
        await user.save();
    }
    
    return this;
};

/**
 * Instance Method: Deny Request
 * Denies the upgrade request
 */
roleUpgradeRequestSchema.methods.deny = async function(processedBy, notes = null) {
    this.status = 'denied';
    this.processedBy = processedBy;
    this.processedAt = new Date();
    if (notes) {
        this.processingNotes = notes;
    }
    await this.save();
    
    return this;
};

const RoleUpgradeRequest = mongoose.model('RoleUpgradeRequest', roleUpgradeRequestSchema);

module.exports = RoleUpgradeRequest;
