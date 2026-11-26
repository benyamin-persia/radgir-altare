/**
 * ============================================
 * Main Server File - Radgir
 * ============================================
 * This is the entry point for the Express server
 * It initializes the database connection, sets up middleware,
 * and starts the HTTP server
 */

// Load environment variables from .env file
// This allows us to keep sensitive configuration separate
require('dotenv').config();

// Built-in modules for reading and injecting index.html with canonical share URL
const path = require('path');
const fs = require('fs');

// Import Express framework for building the REST API
const express = require('express');

// Import CORS middleware to allow cross-origin requests
// This is essential for frontend-backend communication
const cors = require('cors');

// Import database connection utility
const connectDB = require('./config/database');

// Import route handlers for different API endpoints
const authRoutes = require('./routes/auth');
const authSecurityRoutes = require('./routes/authSecurity');
const userRoutes = require('./routes/users');
const almightyRoutes = require('./routes/almighty');
const analyticsAdminRoutes = require('./routes/analyticsAdmin');
const peopleRoutes = require('./routes/people');
const analyticsRoutes = require('./routes/analytics');
const dataPrivacyRoutes = require('./routes/dataPrivacy');
const roleUpgradeRoutes = require('./routes/roleUpgrade');
const messageRoutes = require('./routes/messages');

// Import middleware for error handling
const errorHandler = require('./middleware/errorHandler');
const notFoundHandler = require('./middleware/notFoundHandler');

// Import security middleware
const securityHeaders = require('./middleware/securityHeaders');

// Import function to initialize Almighty user on startup
const initializeAlmighty = require('./utils/initializeAlmighty');
const { startAnalyticsRollupScheduler } = require('./utils/analyticsRollups');
const { startAnalyticsTelegramScheduler } = require('./utils/analyticsTelegram');
const { ensureDefaultPersonTags, syncAboutSummaryFromActiveTags } = require('./utils/personTagCatalog');

// Create Express application instance
const app = express();

// Get port from environment variables or use default 5000
// This allows flexibility for different deployment environments
const PORT = process.env.PORT || 5000;

// ============================================
// Middleware Configuration
// ============================================

// Security headers - must be first to apply to all responses
app.use(securityHeaders);

// Enable CORS for all routes
// This allows the frontend (running on different port) to make API requests
app.use(cors());

// Parse JSON request bodies
// This middleware extracts JSON data from incoming requests
app.use(express.json());

// Parse URL-encoded request bodies
// This handles form submissions and query parameters
app.use(express.urlencoded({ extended: true }));

// ============================================
// API Routes (must come before static files)
// ============================================

// Authentication routes (login, register, token refresh)
// These endpoints handle user authentication
app.use('/api/auth', authRoutes);

// Authentication security routes (password reset, email verification, account recovery)
// These endpoints handle security-related authentication features
app.use('/api/auth', authSecurityRoutes);

// User management routes (protected, requires authentication)
// Regular users can access their own profile
app.use('/api/users', userRoutes);

// Almighty user routes (protected, requires Almighty role)
// Only Almighty user can access these endpoints
app.use('/api/almighty/analytics', analyticsAdminRoutes);
app.use('/api/almighty', almightyRoutes);

// People listings routes (for person location listings)
// Some endpoints require authentication, others are public
app.use('/api/people', peopleRoutes);

// Static serving for intelligence media archive
app.use('/pezeshkan_sahmiei/media', express.static(path.join(__dirname, '..', 'data', 'pezeshkan_sahmiei', 'media')));
app.use('/poshtpardeha/media', express.static(path.join(__dirname, '..', 'data', 'poshtpardeha', 'media')));
app.use('/poshtpardeha2/media', express.static(path.join(__dirname, '..', 'data', 'poshtpardeha2', 'media')));
app.use('/sepehrazadi-db/media', express.static(path.join(__dirname, '..', 'data', 'sepehrazadi-db', 'media')));

// Analytics collection routes (public ingestion + health)
app.use('/api/analytics', analyticsRoutes);

// Data privacy routes (GDPR compliance, data export, deletion)
// All routes require authentication
app.use('/api/privacy', dataPrivacyRoutes);

// Role upgrade request routes
// Allows Guest users to request role upgrades
app.use('/api/role-upgrade', roleUpgradeRoutes);

// Direct messaging routes (authenticated inbox and conversations)
app.use('/api/messages', messageRoutes);

// Health check endpoint
// Useful for monitoring and deployment verification
app.get('/api/health', (req, res) => {
    console.log('Health check endpoint called');
    res.status(200).json({ 
        status: 'OK', 
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// API info endpoint (separate from root to avoid conflicts)
// This provides API documentation for developers
app.get('/api/info', (req, res) => {
    console.log('API info endpoint accessed');
    res.json({ 
        message: 'Radgir API',
        version: '1.0.0',
        endpoints: {
            auth: '/api/auth',
            users: '/api/users',
            almighty: '/api/almighty',
            health: '/api/health'
        }
    });
});

// ============================================
// Index HTML with canonical share URL injection
// ============================================
// Serve index.html with APP_URL injected so share/copy-link always uses production URL
// (never localhost) when APP_URL is set on Heroku or in production env.
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const RADGIR_APP_URL_PLACEHOLDER = '__RADGIR_APP_URL__';

function serveIndexWithAppUrl(req, res, next) {
    const appUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
    fs.readFile(INDEX_HTML_PATH, 'utf8', (err, html) => {
        if (err) {
            console.error('Failed to read index.html for APP_URL injection:', err);
            return next(err);
        }
        const injected = html.replace(RADGIR_APP_URL_PLACEHOLDER, appUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(injected);
    });
}

app.get('/', serveIndexWithAppUrl);
app.get('/index.html', serveIndexWithAppUrl);

// ============================================
// Static File Serving
// ============================================

// Clean URLs used in emails (without .html) so verify/reset links work
const emailPageRoutes = {
    '/verify-email': 'verify-email.html',
    '/reset-password': 'reset-password.html',
    '/forgot-password': 'forgot-password.html',
    '/await-verification': 'await-verification.html'
};
Object.entries(emailPageRoutes).forEach(([routePath, fileName]) => {
    app.get(routePath, (req, res) => {
        res.sendFile(path.join(__dirname, fileName)); // preserve ?token= query for the page JS
    });
});

// Serve static files (HTML, CSS, JavaScript) from the root directory
// This allows the browser to access login.html, register.html, dashboard.html, etc.
// Placed after API routes so API endpoints are checked first
// Express.static automatically serves index.html when accessing the root URL '/'
// The files are served as-is, without any processing
app.use(express.static(__dirname, {
    // Set content type explicitly for HTML files to ensure proper rendering
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        // Avoid stale frontend bundles in browser / Cloudflare edge cache.
        if (
            path.endsWith('.html') ||
            path.endsWith('.js') ||
            path.endsWith('.css') ||
            path.endsWith('/sw.js') ||
            path.endsWith('\\sw.js')
        ) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('CDN-Cache-Control', 'no-store'); // stop shared CDN caches holding HTML/JS
            res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store'); // Cloudflare-specific edge bypass
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
    // index option specifies which file to serve for directory requests
    // By default, it serves 'index.html' for the root directory
    index: 'index.html'
}));

// ============================================
// 404 Not Found Handler
// ============================================

// This middleware must be placed after all routes
// It catches any requests to routes that don't exist
// Returns a 404 JSON response with consistent format
app.use(notFoundHandler);

// ============================================
// Error Handling Middleware
// ============================================

// This must be last middleware to catch all errors
// It handles errors from all routes and provides consistent error responses
// The error handler receives errors passed via next(error) from route handlers
app.use(errorHandler);

// ============================================
// Database Connection and Server Startup
// ============================================

/**
 * Initialize database connection and start server
 * This function:
 * 1. Connects to MongoDB database
 * 2. Initializes Almighty user if it doesn't exist
 * 3. Starts the HTTP server
 */
async function startServer() {
    // Bind immediately so App Hosting health checks pass even if Mongo/Atlas is down
    const listenPort = Number(process.env.SERVER_PORT || process.env.APP_PORT || PORT);
    app.listen(listenPort, '0.0.0.0', () => {
        console.log('===========================================');
        console.log(`✓ Server running on 0.0.0.0:${listenPort}`);
        console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`✓ API Base URL: http://0.0.0.0:${listenPort}/api`);
        console.log('===========================================');
    });

    try {
        // Connect to MongoDB after listen so a dead Atlas host does not take the whole site offline
        console.log('Attempting to connect to MongoDB...');
        await connectDB();
        console.log('✓ MongoDB connected successfully');

        // Initialize Almighty user if it doesn't exist
        console.log('Checking for Almighty user...');
        await initializeAlmighty();
        console.log('✓ Almighty user initialized');

        // Ensure default person classification tags exist.
        await ensureDefaultPersonTags();
        console.log('✓ Person tags catalog initialized');

        // Mirror active tags into about-page summary so public about lead stays in sync.
        try {
            const User = require('./models/User');
            const syncResult = await syncAboutSummaryFromActiveTags(User);
            if (syncResult.synced) {
                console.log(`✓ About summary synced from ${syncResult.tagCount} active tags`);
            }
        } catch (syncError) {
            console.warn('About summary sync skipped:', syncError.message || syncError);
        }

        // Keep daily analytics aggregates fresh for long-range reporting.
        startAnalyticsRollupScheduler();
        // Live private Telegram analytics snapshot (edits one message in place).
        startAnalyticsTelegramScheduler();
    } catch (error) {
        // Stay up for static pages/UI; API routes that need DB will fail until Mongo is fixed
        console.error('✗ Database init failed (server still listening):', error.message);
        console.error('Full error:', error);
    }
}

// Start the server
// This is the entry point that triggers the entire initialization process
startServer();

// Export app for testing purposes (if needed)
module.exports = app;
