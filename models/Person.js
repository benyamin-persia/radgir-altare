/**
 * ============================================
 * Person Model - MongoDB Schema Definition
 * ============================================
 * This model defines the structure of person listings in the system
 * People can be listed with their location information (geolocation),
 * contact details, family members, and roles
 * 
 * This is similar to Zillow's property listings but for people locations
 */

// Import Mongoose for schema definition
const mongoose = require('mongoose');

/**
 * Family Member Sub-Schema
 * Represents a family member associated with a person listing
 */
const familyMemberSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Family member name is required'],
        trim: true
    },
    relationship: {
        type: String,
        required: [true, 'Relationship is required'],
        trim: true,
        // Examples: 'Spouse', 'Child', 'Parent', 'Sibling', 'Other'
    },
    role: {
        type: String,
        trim: true
        // Role in the listing (e.g., 'Primary Contact', 'Emergency Contact')
    },
    phone: {
        type: String,
        trim: true
    },
    notes: {
        type: String,
        trim: true
    }
}, {
    _id: true // Each family member gets a unique ID
});

/**
 * Person-to-person Relationship Sub-Schema
 * Represents a relationship edge from this person to another listed person.
 */
const personRelationshipSchema = new mongoose.Schema({
    targetPersonId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Person',
        required: [true, 'Relationship target person is required'],
        index: true
    },
    type: {
        type: String,
        enum: ['family', 'work', 'command', 'financial', 'social', 'other'],
        default: 'other',
        trim: true,
        index: true
    },
    strength: {
        type: Number,
        min: 1,
        max: 5,
        default: 3
    },
    note: {
        type: String,
        trim: true,
        maxlength: 500
    },
    source: {
        type: String,
        trim: true,
        maxlength: 300
    },
    confidence: {
        type: Number,
        min: 0,
        max: 1,
        default: 0.5
    },
    status: {
        type: String,
        enum: ['confirmed', 'unverified'],
        default: 'unverified',
        trim: true,
        index: true
    }
}, {
    _id: true
});

/**
 * Person Schema Definition
 * This schema represents a person listing with location information
 * 
 * Schema Fields:
 * - name: Person's name
 * - address: Full address string
 * - location: GeoJSON point with coordinates (longitude, latitude)
 * - phone: Primary phone number
 * - familyMembers: Array of family members with their relationships and roles
 * - createdBy: Reference to user who created this listing
 * - isActive: Whether the listing is active
 * - metadata: Additional information about the person
 */
const personSchema = new mongoose.Schema({
    // Basic information
    name: {
        type: String,
        required: [true, 'Person name is required'],
        trim: true,
        index: true // Index for faster searches
    },
    familyName: {
        type: String,
        required: false,
        trim: true,
        default: null,
        maxlength: 100,
        index: true // For search (create/edit form sends this)
    },
    nationalId: {
        type: String,
        required: false,
        trim: true,
        default: null,
        maxlength: 50
    },
    job: {
        type: String,
        required: false,
        trim: true,
        default: null,
        maxlength: 200
    },
    
    // Address information (optional when person is listed "without address" for now)
    address: {
        type: String,
        required: false,
        default: '',
        trim: true,
        index: true // Index for address searches
    },

    // Address precision status:
    // - exact: full address + coordinates are known (shown on map)
    // - approximate: only coarse region is known (not shown on map)
    // - unknown: no reliable location data yet (not shown on map)
    addressStatus: {
        type: String,
        enum: ['exact', 'approximate', 'unknown'],
        required: false,
        index: true
    },

    // Normalized address type kept for fast filtering/sorting at scale.
    // Mirrors addressStatus and is backfilled automatically in hooks.
    addressType: {
        type: String,
        enum: ['exact', 'approximate', 'unknown'],
        required: false,
        index: true
    },

    // Optional coarse location when addressStatus="approximate"
    approximateRegion: {
        province: {
            type: String,
            trim: true,
            index: true
        },
        section: {
            type: String,
            trim: true,
            index: true
        },
        level: {
            type: String,
            enum: ['province', 'section'],
            required: false
        }
    },
    
    // Geolocation (GeoJSON format for MongoDB geospatial queries). Optional when person has no address yet.
    // Do not set default on type/coordinates so that omitting location does not write invalid geo (2dsphere index would fail).
    location: {
        type: {
            type: String,
            enum: ['Point']
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: false,
            validate: {
                validator: function(v) {
                    if (v == null || v.length === 0) return true; // No coords = no address yet
                    return Array.isArray(v) && v.length === 2 &&
                           typeof v[0] === 'number' && typeof v[1] === 'number' &&
                           v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90;
                },
                message: 'Coordinates must be [longitude, latitude] with valid ranges'
            }
        }
    },
    
    // Contact information
    phone: {
        type: String,
        required: false,
        trim: true,
        default: null,
        index: true // Index for phone searches
    },
    email: {
        type: String,
        required: false,
        trim: true,
        lowercase: true,
        default: null,
        maxlength: 255
    },
    xAccount: {
        type: String,
        required: false,
        trim: true,
        default: null,
        maxlength: 100
    },
    instagramAccount: {
        type: String,
        required: false,
        trim: true,
        default: null,
        maxlength: 100
    },
    facebookAccount: {
        type: String,
        required: false,
        trim: true,
        default: null,
        maxlength: 200
    },
    
    // Family members array
    familyMembers: {
        type: [familyMemberSchema],
        default: []
    },

    // Graph edges to other people listings (for relationship overlays on map).
    relationships: {
        type: [personRelationshipSchema],
        default: []
    },
    
    // Images array - supports local paths or cloud metadata
    // Backward compatible with existing string entries
    // New uploads can store richer objects: { url, publicId, storage }
    // The first image in the array is considered the main/primary image
    images: {
        type: [mongoose.Schema.Types.Mixed],
        default: []
    },

    // Telegram channel post linkage so edits/deletes can sync to @radgir_com
    telegramMessage: {
        messageId: { type: Number, default: null },
        chatId: { type: String, trim: true, default: '' },
        hasPhoto: { type: Boolean, default: false },
        postedAt: { type: Date, default: null }
    },
    
    // Who created this listing
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Creator user is required'],
        // This tracks which user added this person listing
    },
    
    // Listing status
    isActive: {
        type: Boolean,
        default: true,
        index: true // Index for filtering active listings
    },
    
    // Administrative region information (province, county, bakhsh, city)
    // This is set automatically based on coordinates using Boundary model
    administrativeRegion: {
        province: {
            type: String,
            trim: true,
            index: true
        },
        county: {
            type: String,
            trim: true,
            index: true
        },
        bakhsh: {
            type: String,
            trim: true,
            index: true
        },
        city: {
            type: String,
            trim: true,
            index: true
        }
    },
    
    // Tags for categorization (roles, classifications, etc.)
    // This is a top-level field for easier querying
    tags: {
        type: [String],
        default: [],
        index: true // Index for role/tag filtering
    },
    
    // Voting (like/dislike) - users can vote once per listing
    votes: {
        likes: { type: Number, default: 0 },
        dislikes: { type: Number, default: 0 },
        likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        dislikedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    },
    
    // Comments - array of user comments (each can be voted on)
    comments: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        username: { type: String, required: true },
        text: { type: String, required: true, trim: true, maxlength: 500 },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
        likes: { type: Number, default: 0 },
        dislikes: { type: Number, default: 0 },
        likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        dislikedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    }],
    
    // Additional metadata
    metadata: {
        email: {
            type: String,
            trim: true,
            lowercase: true
        },
        occupation: {
            type: String,
            trim: true
        },
        notes: {
            type: String,
            trim: true
        },
        tags: {
            type: [String],
            default: []
            // Tags for categorization (e.g., 'verified', 'priority', 'family')
        }
    }
}, {
    // Schema options
    timestamps: true, // Automatically adds createdAt and updatedAt fields
    toJSON: {
        // Transform the document when converting to JSON
        transform: function(doc, ret) {
            // Format coordinates for easier use in frontend
            if (ret.location && ret.location.coordinates) {
                ret.longitude = ret.location.coordinates[0];
                ret.latitude = ret.location.coordinates[1];
            }
            return ret;
        }
    }
});

/**
 * Pre-save hook: never write invalid location to DB (avoids "Can't extract geo keys" from 2dsphere index).
 * If location exists but has no valid coordinates (missing or not length 2), remove location so the
 * document is stored without a location field and is not indexed by 2dsphere.
 */
personSchema.pre('save', function (next) {
    if (this.location != null) {
        const coords = this.location && this.location.coordinates;
        if (!Array.isArray(coords) || coords.length !== 2) {
            this.set('location', undefined);
            if (this._doc && this._doc.location !== undefined) {
                delete this._doc.location;
            }
        }
    }

    const normalizedStatus = (this.addressStatus || '').trim().toLowerCase();
    if (normalizedStatus === 'exact' || normalizedStatus === 'approximate' || normalizedStatus === 'unknown') {
        this.addressType = normalizedStatus;
    } else {
        const hasAddress = Boolean(this.address && String(this.address).trim());
        const hasCoords = Array.isArray(this.location?.coordinates) && this.location.coordinates.length === 2;
        const hasApproximate = Boolean(this.approximateRegion?.province || this.approximateRegion?.section);
        this.addressType = hasAddress && hasCoords
            ? 'exact'
            : (hasApproximate ? 'approximate' : 'unknown');
    }

    next();
});

personSchema.pre('findOneAndUpdate', function(next) {
    const update = this.getUpdate() || {};
    const payload = update.$set || update;

    const explicitStatus = payload.addressStatus;
    if (typeof explicitStatus === 'string') {
        const normalizedStatus = explicitStatus.trim().toLowerCase();
        if (normalizedStatus === 'exact' || normalizedStatus === 'approximate' || normalizedStatus === 'unknown') {
            if (update.$set) update.$set.addressType = normalizedStatus;
            else update.addressType = normalizedStatus;
            this.setUpdate(update);
            return next();
        }
    }

    if (payload.addressType) {
        this.setUpdate(update);
        return next();
    }

    const nextLocation = payload.location || update.location;
    const nextAddress = payload.address || update.address;
    const nextApprox = payload.approximateRegion || update.approximateRegion;
    const hasCoords = Array.isArray(nextLocation?.coordinates) && nextLocation.coordinates.length === 2;
    const hasAddress = Boolean(nextAddress && String(nextAddress).trim());
    const hasApproximate = Boolean(nextApprox?.province || nextApprox?.section);
    const inferredType = hasAddress && hasCoords
        ? 'exact'
        : (hasApproximate ? 'approximate' : null);

    if (inferredType) {
        if (update.$set) update.$set.addressType = inferredType;
        else update.addressType = inferredType;
    }
    this.setUpdate(update);
    next();
});

/**
 * Create compound indexes for common query patterns
 */
// Partial 2dsphere index: only index documents that have valid location.coordinates (length 2).
// Documents without address (no location or empty coordinates) are not indexed and do not trigger geo key extraction.
personSchema.index(
    { location: '2dsphere' },
    { partialFilterExpression: { 'location.coordinates': { $exists: true, $size: 2 } } }
);

// Index for searching by name and active status
personSchema.index({ name: 1, isActive: 1 });

// Index for searching by phone and active status
personSchema.index({ phone: 1, isActive: 1 });

// Index for searching by address and active status
personSchema.index({ address: 1, isActive: 1 });

// Indexes for address status and coarse approximate region filters
personSchema.index({ addressStatus: 1, isActive: 1 });
personSchema.index({ addressType: 1, isActive: 1 });
personSchema.index({ 'approximateRegion.province': 1, 'approximateRegion.section': 1, isActive: 1 });

// Index for searching by creator and active status
personSchema.index({ createdBy: 1, isActive: 1 });

// Index for tag/role filtering
personSchema.index({ tags: 1, isActive: 1 }); // Compound index for role filtering
personSchema.index({ tags: 1, 'administrativeRegion.province': 1, 'administrativeRegion.bakhsh': 1 }); // For role + region filtering

// Indexes for relationship graph queries
personSchema.index({ 'relationships.targetPersonId': 1, isActive: 1 });
personSchema.index({ 'relationships.type': 1, isActive: 1 });

// Index for administrative region filtering
personSchema.index({ 'administrativeRegion.province': 1, 'administrativeRegion.county': 1, 'administrativeRegion.bakhsh': 1 });
personSchema.index({ 'administrativeRegion.province': 1, isActive: 1 });
personSchema.index({ tags: 1, isActive: 1 }); // Index for role/tag filtering
personSchema.index({ isActive: 1, createdAt: -1 });
personSchema.index({ isActive: 1, updatedAt: -1 });
personSchema.index({ 'votes.likes': -1, isActive: 1 });
personSchema.index({ addressType: 1, 'administrativeRegion.province': 1, 'administrativeRegion.county': 1, createdAt: -1, isActive: 1 });

/**
 * Instance Method: Get Full Address
 * Returns formatted address string
 * @returns {string} Formatted address
 */
personSchema.methods.getFullAddress = function() {
    return this.address;
};

/**
 * Instance Method: Get Coordinates
 * Returns coordinates in a simple format
 * @returns {Object} {longitude, latitude}
 */
personSchema.methods.getCoordinates = function() {
    if (!this.location || !this.location.coordinates || this.location.coordinates.length < 2) {
        return null; // No address / no location yet
    }
    return {
        longitude: this.location.coordinates[0],
        latitude: this.location.coordinates[1]
    };
};

/**
 * Static Method: Find Nearby Persons
 * Finds persons within a certain distance from a point
 * Uses MongoDB geospatial queries
 * 
 * @param {number} longitude - Longitude of center point
 * @param {number} latitude - Latitude of center point
 * @param {number} maxDistance - Maximum distance in meters
 * @param {Object} options - Additional query options (isActive, etc.)
 * @returns {Promise<Array>} Array of person documents
 */
personSchema.statics.findNearby = async function(longitude, latitude, maxDistance = 10000, options = {}) {
    const query = {
        location: {
            $near: {
                $geometry: {
                    type: 'Point',
                    coordinates: [longitude, latitude]
                },
                $maxDistance: maxDistance // Distance in meters
            }
        },
        ...options // Merge additional query options
    };
    
    console.log(`Finding persons near [${longitude}, ${latitude}] within ${maxDistance}m`);
    
    return await this.find(query);
};

// Create and export the Person model
// This makes the model available for use in other files
const Person = mongoose.model('Person', personSchema);

module.exports = Person;
