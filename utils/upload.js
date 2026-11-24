/**
 * ============================================
 * File Upload Utility
 * ============================================
 * Handles file uploads for person images
 * Uses multer middleware for handling multipart/form-data
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary');
// multer-storage-cloudinary exports the storage class/function directly (no named export)
const CloudinaryStorage = require('multer-storage-cloudinary');

// Cloudinary configuration (optional)
// If Cloudinary env vars are not present, we fall back to local disk storage
const CLOUDINARY_ENABLED = Boolean(
    process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET)
);
const DEFAULT_CLOUDINARY_FOLDER = 'radgir/persons';
const rawCloudinaryFolder = process.env.CLOUDINARY_PERSONS_FOLDER || DEFAULT_CLOUDINARY_FOLDER;
const CLOUDINARY_FOLDER = rawCloudinaryFolder.includes('://')
    ? DEFAULT_CLOUDINARY_FOLDER
    : rawCloudinaryFolder;
// Enable async Cloudinary uploads by default to avoid Heroku 30s timeouts
// Set CLOUDINARY_ASYNC_UPLOAD=false to revert to direct multer Cloudinary uploads
const CLOUDINARY_ASYNC_UPLOAD = CLOUDINARY_ENABLED
    ? process.env.CLOUDINARY_ASYNC_UPLOAD !== 'false'
    : false;

if (CLOUDINARY_ENABLED) {
    if (rawCloudinaryFolder.includes('://')) {
        console.warn('⚠️ CLOUDINARY_PERSONS_FOLDER looks like a URL, using default:', DEFAULT_CLOUDINARY_FOLDER);
    }
    if (process.env.CLOUDINARY_URL) {
        cloudinary.v2.config({ cloudinary_url: process.env.CLOUDINARY_URL });
        console.log('✅ Cloudinary upload enabled via CLOUDINARY_URL:', CLOUDINARY_FOLDER);
    } else {
        cloudinary.v2.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });
        console.log('✅ Cloudinary upload enabled via key/secret:', CLOUDINARY_FOLDER);
    }
    console.log(`Cloudinary upload mode: ${CLOUDINARY_ASYNC_UPLOAD ? 'async (local temp + background upload)' : 'direct (multer-storage-cloudinary)'}`);
} else {
    console.log('⚠️ Cloudinary not configured, using local disk storage');
}

// Upload directory for person images (local disk mode only)
// This directory will store all uploaded person images
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'persons');
const TEMP_DIR = path.join(UPLOAD_DIR, 'temp');
const PROJECT_ROOT = path.join(__dirname, '..');

// Ensure upload directory exists (local disk mode)
// Create the directory structure if it doesn't exist
if (!CLOUDINARY_ENABLED && !fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log('Created upload directory:', UPLOAD_DIR);
}

/**
 * Configure multer storage
 * Stores files on disk with organized folder structure
 */
const storage = (CLOUDINARY_ENABLED && !CLOUDINARY_ASYNC_UPLOAD)
    ? CloudinaryStorage({
        cloudinary,
        params: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const ext = path.extname(file.originalname || '').toLowerCase();
            const basename = path.basename(file.originalname || 'image', ext);
            const safeBasename = basename
                .replace(/\s+/g, '-')
                .replace(/[^a-zA-Z0-9-_]/g, '')
                .slice(0, 100) || 'image';

            const publicId = `${safeBasename}-${uniqueSuffix}`;
            const userFolder = req?.user?.id ? `${CLOUDINARY_FOLDER}/${req.user.id}` : CLOUDINARY_FOLDER;

            console.log('Uploading image to Cloudinary:', { folder: userFolder, publicId });
            return {
                folder: userFolder,
                public_id: publicId,
                resource_type: 'image'
            };
        }
    })
    : multer.diskStorage({
        // Destination function determines where to store the file
        destination: function(req, file, cb) {
            // For new persons (POST), use temp directory
            // For updates (PUT), use person ID from URL params
            const personId = req.params?.id || req.body?.personId || 'temp';
            const personDir = path.join(UPLOAD_DIR, personId);

            // Create person-specific directory if it doesn't exist
            if (!fs.existsSync(personDir)) {
                fs.mkdirSync(personDir, { recursive: true });
            }

            cb(null, personDir);
        },

        // Filename function determines the name of the uploaded file
        filename: function(req, file, cb) {
            // Generate unique filename: timestamp-random-originalname
            // This prevents filename conflicts
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const ext = path.extname(file.originalname);
            const basename = path.basename(file.originalname, ext);
            const filename = `${basename}-${uniqueSuffix}${ext}`;

            console.log('Uploading file:', filename);
            cb(null, filename);
        }
    });

/**
 * File filter function
 * Validates file types - only allows images
 * 
 * @param {Object} req - Express request object
 * @param {Object} file - Multer file object
 * @param {Function} cb - Callback function
 */
const fileFilter = (req, file, cb) => {
    // Allowed image MIME types
    const allowedMimes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp'
    ];
    
    // Check if file MIME type is allowed
    if (allowedMimes.includes(file.mimetype)) {
        // Accept the file
        cb(null, true);
    } else {
        // Reject the file with error message
        cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'), false);
    }
};

/**
 * Multer upload configuration
 * Configured to handle multiple image files
 * 
 * Limits:
 * - Max file size: 5MB per file
 * - Max files: 10 images per person
 */
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB max file size
        files: 10 // Maximum 10 images per person
    }
});

/**
 * Move files from temp directory to person directory
 * Called after person is created to organize files properly
 * 
 * @param {string} personId - Person ID (MongoDB ObjectId)
 * @returns {Promise<Array>} Array of file paths
 */
async function moveTempFilesToPerson(personId) {
    const tempDir = TEMP_DIR;
    const personDir = path.join(UPLOAD_DIR, personId);
    
    // If temp directory doesn't exist, return empty array
    if (!fs.existsSync(tempDir)) {
        return [];
    }
    
    // Create person directory if it doesn't exist
    if (!fs.existsSync(personDir)) {
        fs.mkdirSync(personDir, { recursive: true });
    }
    
    const files = fs.readdirSync(tempDir);
    const movedFiles = [];
    
    // Move each file from temp to person directory
    for (const file of files) {
        const oldPath = path.join(tempDir, file);
        const newPath = path.join(personDir, file);
        
        try {
            fs.renameSync(oldPath, newPath);
            // Store relative path for database
            const relativePath = path.join('uploads', 'persons', personId, file).replace(/\\/g, '/');
            movedFiles.push(relativePath);
            console.log(`Moved file: ${oldPath} -> ${newPath}`);
        } catch (error) {
            console.error(`Error moving file ${file}:`, error);
        }
    }
    
    // Remove temp directory if empty
    try {
        const remainingFiles = fs.readdirSync(tempDir);
        if (remainingFiles.length === 0) {
            fs.rmdirSync(tempDir);
        }
    } catch (error) {
        console.error('Error removing temp directory:', error);
    }
    
    return movedFiles;
}

/**
 * Normalize image input to a usable path/URL string
 * Supports legacy strings and new metadata objects
 *
 * @param {string|Object} imageEntry - Image path or metadata
 * @returns {string|null} Normalized image path/URL
 */
function normalizeImageEntry(imageEntry) {
    if (!imageEntry) return null;
    if (typeof imageEntry === 'string') return imageEntry;
    if (typeof imageEntry === 'object') {
        if (typeof imageEntry.url === 'string') return imageEntry.url;
        if (typeof imageEntry.secure_url === 'string') return imageEntry.secure_url;
        if (typeof imageEntry.path === 'string') return imageEntry.path;
        // Handle nested shapes like { url: { url: "..." } }
        if (imageEntry.url && typeof imageEntry.url.url === 'string') return imageEntry.url.url;
        if (imageEntry.url && typeof imageEntry.url.secure_url === 'string') return imageEntry.url.secure_url;
        if (imageEntry.path && typeof imageEntry.path.path === 'string') return imageEntry.path.path;
    }
    return null;
}

/**
 * Check whether a local image path exists on disk
 *
 * @param {string} relativePath - Relative path like uploads/persons/...
 * @returns {boolean} True if the file exists locally
 */
function localImageExists(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const absolutePath = path.join(PROJECT_ROOT, normalizedPath);
    return fs.existsSync(absolutePath);
}

/**
 * Build a local image entry object from a relative path
 *
 * @param {string} relativePath - Relative path under project root
 * @returns {Object} Image metadata object
 */
function createLocalImageEntry(relativePath) {
    return {
        url: relativePath,
        storage: 'local'
    };
}

/**
 * Build a Cloudinary image entry object from multer file
 *
 * @param {Object} file - Multer file object
 * @returns {Object|null} Image metadata object
 */
function createCloudinaryImageEntry(file) {
    const imageUrl = file?.path || file?.secure_url;
    const publicId = file?.filename || file?.public_id || null;
    if (!imageUrl) return null;

    return {
        url: imageUrl,
        publicId,
        storage: 'cloudinary'
    };
}

/**
 * Build image entries for the current request
 * Handles Cloudinary mode and local disk mode
 *
 * @param {Object} options - Options with files/personId
 * @param {Array} options.files - Multer file array
 * @param {string} options.personId - Person ID for local disk moves
 * @returns {Promise<Array>} Array of image entries
 */
async function getUploadedImages({ files, personId }) {
    if (!files || files.length === 0) return [];

    if (CLOUDINARY_ENABLED && !CLOUDINARY_ASYNC_UPLOAD) {
        const cloudEntries = files.map(createCloudinaryImageEntry).filter(Boolean);
        if (cloudEntries.length === 0) {
            console.warn('Cloudinary enabled but no image entries were created');
        }
        return cloudEntries;
    }

    return getLocalImageEntriesForRequest({ files, personId });
}

/**
 * Build local image entries for the current request
 * Always stores local paths (used for async Cloudinary mode)
 */
async function getLocalImageEntriesForRequest({ files, personId }) {
    if (!files || files.length === 0) return [];

    const tempUploads = files.some(file =>
        String(file?.destination || '').includes(`${path.sep}uploads${path.sep}persons${path.sep}temp`)
    );
    const movedPaths = tempUploads && personId
        ? await moveTempFilesToPerson(personId)
        : [];

    if (movedPaths.length > 0) {
        return movedPaths.map(createLocalImageEntry);
    }

    // Fallback: use the file paths directly (already in person folder)
    const projectRoot = path.join(__dirname, '..');
    return files
        .map(file => {
            if (!file?.path) return null;
            const relativePath = path.relative(projectRoot, file.path).replace(/\\/g, '/');
            return createLocalImageEntry(relativePath);
        })
        .filter(Boolean);
}

function getAbsolutePathFromRelative(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    return path.join(PROJECT_ROOT, normalizedPath);
}

/**
 * Upload local files to Cloudinary in the background (async mode)
 * Returns Cloudinary image entries for DB storage.
 */
async function uploadLocalImagesToCloudinary({ imageEntries, userId }) {
    if (!CLOUDINARY_ENABLED || !CLOUDINARY_ASYNC_UPLOAD) {
        return [];
    }
    if (!imageEntries || imageEntries.length === 0) {
        return [];
    }

    const userFolder = userId ? `${CLOUDINARY_FOLDER}/${userId}` : CLOUDINARY_FOLDER;
    const uploads = await Promise.allSettled(
        imageEntries.map(async (entry) => {
            const localPath = typeof entry === 'string' ? entry : entry?.url;
            if (!localPath) return null;
            const absolutePath = getAbsolutePathFromRelative(localPath);
            if (!fs.existsSync(absolutePath)) {
                console.warn('Local file missing before Cloudinary upload:', absolutePath);
                return null;
            }

            const result = await cloudinary.v2.uploader.upload(absolutePath, {
                folder: userFolder,
                resource_type: 'image'
            });

            // Clean up local file after successful upload
            try {
                fs.unlinkSync(absolutePath);
            } catch (cleanupError) {
                console.warn('Failed to delete local upload after Cloudinary:', cleanupError.message);
            }

            return {
                url: result.secure_url,
                publicId: result.public_id,
                storage: 'cloudinary'
            };
        })
    );

    return uploads
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value);
}

/**
 * Parse a Cloudinary public ID from a URL
 *
 * @param {string} url - Cloudinary URL
 * @returns {string|null} Public ID or null if not parseable
 */
function parseCloudinaryPublicIdFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const cleanUrl = url.split('?')[0];
    const uploadIndex = cleanUrl.indexOf('/upload/');
    if (uploadIndex === -1) return null;

    const publicIdPart = cleanUrl.substring(uploadIndex + '/upload/'.length);
    const segments = publicIdPart.split('/').filter(Boolean);
    const versionIndex = segments.findIndex(segment => /^v\d+$/.test(segment));

    const publicIdSegments = versionIndex >= 0
        ? segments.slice(versionIndex + 1)
        : segments;

    if (publicIdSegments.length === 0) return null;

    const publicIdWithExt = publicIdSegments.join('/');
    return publicIdWithExt.replace(/\.[^/.]+$/, '');
}

/**
 * Extract Cloudinary public ID from stored image entry
 *
 * @param {string|Object} imageEntry - Stored image metadata or URL
 * @returns {string|null} Cloudinary public ID
 */
function getCloudinaryPublicId(imageEntry) {
    if (!imageEntry) return null;
    if (typeof imageEntry === 'object') {
        if (imageEntry.publicId) return imageEntry.publicId;
        if (imageEntry.url) return parseCloudinaryPublicIdFromUrl(imageEntry.url);
    }
    if (typeof imageEntry === 'string' && imageEntry.includes('res.cloudinary.com')) {
        return parseCloudinaryPublicIdFromUrl(imageEntry);
    }
    return null;
}

/**
 * Delete person images directory
 * Called when person is deleted
 * 
 * @param {string} personId - Person ID
 */
async function deletePersonImages(personId, images = []) {
    // Delete Cloudinary images first (if any)
        const cloudinaryPublicIds = images
        .map(getCloudinaryPublicId)
        .filter(Boolean);

    if (CLOUDINARY_ENABLED && cloudinaryPublicIds.length > 0) {
        for (const publicId of cloudinaryPublicIds) {
            try {
                const result = await cloudinary.v2.uploader.destroy(publicId, { resource_type: 'image' });
                console.log(`Deleted Cloudinary image: ${publicId}`, result);
            } catch (error) {
                console.error(`Error deleting Cloudinary image ${publicId}:`, error);
            }
        }
    }

    // Delete local files (if present on disk)
    const personDir = path.join(UPLOAD_DIR, personId);
    
    if (fs.existsSync(personDir)) {
        try {
            // Remove all files in directory
            const files = fs.readdirSync(personDir);
            files.forEach(file => {
                fs.unlinkSync(path.join(personDir, file));
            });
            
            // Remove directory
            fs.rmdirSync(personDir);
            console.log(`Deleted images directory for person: ${personId}`);
        } catch (error) {
            console.error(`Error deleting images for person ${personId}:`, error);
        }
    }
}

/**
 * Get full URL for an image path
 * Converts relative path to full URL
 * 
 * @param {string} imagePath - Relative image path
 * @param {Object} req - Express request object (optional)
 * @returns {string} Full URL to image
 */
function getImageUrl(imagePath, req = null) {
    const normalizedPath = normalizeImageEntry(imagePath);
    if (!normalizedPath) return null;
    if (typeof normalizedPath !== 'string') return null;
    
    // If already a full URL, return as is
    if (normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')) {
        return normalizedPath;
    }

    // For local paths, verify the file exists to avoid 404s
    if (!localImageExists(normalizedPath)) {
        console.warn('Missing local image file:', normalizedPath);
        return null;
    }
    
    // If request object provided, use it to build URL
    if (req) {
        const protocol = req.protocol;
        const host = req.get('host');
        return `${protocol}://${host}/${normalizedPath}`;
    }
    
    // Otherwise, return relative path (frontend will handle)
    return `/${normalizedPath}`;
}

module.exports = {
    upload,
    getUploadedImages,
    getLocalImageEntriesForRequest,
    uploadLocalImagesToCloudinary,
    CLOUDINARY_ASYNC_UPLOAD,
    CLOUDINARY_ENABLED,
    moveTempFilesToPerson,
    deletePersonImages,
    getImageUrl,
    UPLOAD_DIR
};



