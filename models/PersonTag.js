/**
 * Person Tag model
 * Stores the configurable classification tags used in create-person step 3.
 */
const mongoose = require('mongoose');

function normalizeTagName(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\u0643/g, '\u06A9') // Arabic Kaf -> Persian Kaf
        .replace(/\u064A/g, '\u06CC') // Arabic Yeh -> Persian Yeh
        .replace(/\u06D2/g, '\u06CC'); // Farsi Yeh variants -> Persian Yeh
}

const personTagSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Tag name is required'],
        trim: true,
        maxlength: [100, 'Tag name cannot exceed 100 characters']
    },
    normalizedName: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    sortOrder: {
        type: Number,
        default: 0,
        index: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true
});

personTagSchema.pre('validate', function(next) {
    this.name = normalizeTagName(this.name);
    this.normalizedName = normalizeTagName(this.name).toLowerCase();
    next();
});

personTagSchema.statics.normalizeTagName = normalizeTagName;

module.exports = mongoose.model('PersonTag', personTagSchema);
