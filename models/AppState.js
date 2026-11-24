/**
 * Persistent key/value state for server features (e.g. Telegram analytics message id).
 */
const mongoose = require('mongoose');

const appStateSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('AppState', appStateSchema);
