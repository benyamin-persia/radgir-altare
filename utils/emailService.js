/**
 * ============================================
 * Email Service Utility
 * ============================================
 * Handles sending emails for:
 * - Email verification
 * - Password reset
 * - Account recovery
 * - Security notifications
 * - Public contact-form notifications
 *
 * Uses nodemailer for email delivery.
 * Outbound path: Brevo SMTP. From must be an address on an authenticated
 * domain (radgir.com). Do NOT use @protonmail.com as From — Proton DMARC
 * quarantines/rejects third-party relays spoofing their domain.
 */

const nodemailer = require('nodemailer');

/**
 * Base public URL for links inside emails (no trailing slash).
 * Prefer APP_URL in production so reset/verify links hit the real domain.
 */
function getAppBaseUrl() {
    const raw = process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`; // fallback for local dev
    return String(raw).replace(/\/$/, ''); // strip trailing slash so we can append paths safely
}

/** True when address is on Proton's locked domains (cannot be a valid Brevo From). */
function isProtonMailbox(email) {
    const host = String(email || '').split('@')[1]?.toLowerCase() || '';
    return host === 'protonmail.com' || host === 'proton.me' || host === 'pm.me';
}

/**
 * Resolve the visible From address.
 * Prefer EMAIL_FROM on an authenticated domain (e.g. noreply@radgir.com).
 */
function resolveFromAddress() {
    const configured = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
    if (configured && !isProtonMailbox(configured)) {
        return configured.trim();
    }
    if (configured && isProtonMailbox(configured)) {
        console.warn('⚠️  EMAIL_FROM is a Proton address; Proton DMARC will block Brevo delivery. Use noreply@radgir.com instead.');
    }
    // Domain is already Brevo-authenticated (brevo1/2 DKIM + brevo-code on radgir.com).
    return 'noreply@radgir.com';
}

/**
 * Default Reply-To for system mail (owner's Proton inbox for human replies).
 */
function resolveDefaultReplyTo() {
    const replyTo = process.env.EMAIL_REPLY_TO || process.env.CONTACT_EMAIL || '';
    if (replyTo) return replyTo.trim();
    return 'radgir@protonmail.com';
}

/**
 * True when SMTP host is loopback (Proton Mail Bridge / local relay).
 */
function isLocalSmtpHost(host) {
    const h = String(host || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * Resolve SMTP settings from either SMTP_* or EMAIL_* env names.
 * Defaults target Brevo free SMTP relay (smtp-relay.brevo.com:587).
 */
function getEmailAuthConfig() {
    const host = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp-relay.brevo.com'; // free Brevo relay
    const port = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT, 10) || 587;
    const secure = process.env.SMTP_SECURE === 'true' || process.env.EMAIL_SECURE === 'true';

    return {
        host,
        port,
        secure,
        auth: {
            user: process.env.SMTP_USER || process.env.EMAIL_USER || null, // Brevo login email (not necessarily EMAIL_FROM)
            pass: process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD || null // Brevo SMTP key
        }
    };
}

/**
 * Create nodemailer transporter, or null if SMTP is not configured.
 * For Proton Bridge, accept the local self-signed TLS certificate.
 */
function createTransporter() {
    const emailConfig = getEmailAuthConfig();

    if (!emailConfig.auth.user || !emailConfig.auth.pass) {
        console.warn('⚠️  Email credentials not configured. Emails will be logged, not sent.');
        console.warn('⚠️  For free mail: use Brevo SMTP and set EMAIL_FROM=noreply@radgir.com (authenticated domain).');
        return null; // no credentials → caller logs the message instead of crashing
    }

    // Port 465 implies implicit TLS even if SECURE flag was omitted
    if (emailConfig.port === 465 && process.env.SMTP_SECURE === undefined && process.env.EMAIL_SECURE === undefined) {
        emailConfig.secure = true;
    }

    // Bridge presents a self-signed cert on 127.0.0.1 — nodemailer rejects it unless we allow it
    const rejectUnauthorizedEnv = process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
    const rejectUnauthorized = rejectUnauthorizedEnv !== undefined
        ? rejectUnauthorizedEnv !== 'false'
        : !isLocalSmtpHost(emailConfig.host); // default: allow self-signed only for localhost Bridge

    const transportOptions = {
        host: emailConfig.host,
        port: emailConfig.port,
        secure: emailConfig.secure,
        auth: emailConfig.auth,
        requireTLS: !emailConfig.secure && (isLocalSmtpHost(emailConfig.host) || emailConfig.port === 587 || emailConfig.port === 1025), // STARTTLS for Bridge
        tls: {
            rejectUnauthorized // false for Proton Bridge localhost
        }
    };

    return nodemailer.createTransport(transportOptions); // correct API is createTransport (not createTransporter)
}

/**
 * Pull the first http(s) link from HTML so we can print verify/reset URLs when SMTP is off.
 */
function extractFirstLink(html = '') {
    const match = String(html).match(/https?:\/\/[^\s"'<>]+/);
    return match ? match[0] : null;
}

/**
 * Generic send helper. If SMTP is missing, logs the email (including link) and returns success:false.
 */
async function sendEmail({ to, subject, html, text, replyTo }) {
    try {
        const transporter = createTransporter();
        const fromUser = resolveFromAddress(); // Must be @radgir.com (or other Brevo-authenticated domain)
        const defaultReplyTo = resolveDefaultReplyTo(); // Proton inbox for human replies
        const link = extractFirstLink(html);

        // Dev / misconfigured hosts: still surface the action link in server logs
        if (!transporter) {
            console.log('📧 EMAIL NOT SENT (SMTP not configured)');
            console.log(`   To: ${to}`);
            console.log(`   Subject: ${subject}`);
            console.log(`   From: ${fromUser}`);
            if (replyTo || defaultReplyTo) console.log(`   Reply-To: ${replyTo || defaultReplyTo}`);
            if (link) console.log(`   Link: ${link}`);
            return {
                success: false,
                error: 'Email credentials not configured',
                previewUrl: link || null
            };
        }

        const mailOptions = {
            from: `"${process.env.APP_NAME || 'Radgir'}" <${fromUser}>`,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]*>/g, ''), // plain-text fallback for clients that block HTML
            replyTo: replyTo || defaultReplyTo, // Contact form passes visitor email; otherwise owner's Proton
            headers: {
                'X-Mailer': 'Radgir'
            }
        };

        const info = await transporter.sendMail(mailOptions);

        console.log(`✅ Email sent successfully to ${to}`);
        console.log(`   From: ${fromUser}`);
        console.log(`   Message ID: ${info.messageId}`);
        if (info.response) console.log(`   SMTP response: ${info.response}`);

        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
            console.log(`   Preview URL: ${previewUrl}`);
        }

        return {
            success: true,
            messageId: info.messageId,
            previewUrl: previewUrl || null,
            response: info.response || null,
            from: fromUser
        };
    } catch (error) {
        console.error('❌ Error sending email:', error);
        // Surface Brevo/SMTP response codes when available (e.g. unverified sender).
        const smtpDetail = error.response || error.responseCode || error.code || '';
        return {
            success: false,
            error: smtpDetail ? `${error.message} (${smtpDetail})` : error.message
        };
    }
}

/**
 * Send email verification link (registration or email change).
 */
async function sendVerificationEmail(user, verificationToken) {
    const verificationUrl = `${getAppBaseUrl()}/verify-email?token=${verificationToken}`; // clean URL; server maps to verify-email.html

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4CAF50; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .button { display: inline-block; padding: 12px 24px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Verify Your Email Address</h1>
                </div>
                <div class="content">
                    <p>Hello ${user.username},</p>
                    <p>Please verify your email address by clicking the button below:</p>
                    <p style="text-align: center;">
                        <a href="${verificationUrl}" class="button">Verify Email Address</a>
                    </p>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all; color: #4CAF50;">${verificationUrl}</p>
                    <p>This link will expire in 24 hours.</p>
                    <p>If you did not create an account or change your email, please ignore this email.</p>
                </div>
                <div class="footer">
                    <p>This is an automated message. Please do not reply.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({
        to: user.email,
        subject: 'Verify Your Email Address',
        html
    });
}

/**
 * Send password reset link (forgot-password flow).
 */
async function sendPasswordResetEmail(user, resetToken) {
    const resetUrl = `${getAppBaseUrl()}/reset-password?token=${resetToken}`;

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #FF9800; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .button { display: inline-block; padding: 12px 24px; background: #FF9800; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
                .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Password Reset Request</h1>
                </div>
                <div class="content">
                    <p>Hello ${user.username},</p>
                    <p>We received a request to reset your password. Click the button below to reset it:</p>
                    <p style="text-align: center;">
                        <a href="${resetUrl}" class="button">Reset Password</a>
                    </p>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all; color: #FF9800;">${resetUrl}</p>
                    <div class="warning">
                        <strong>⚠️ Security Notice:</strong>
                        <ul>
                            <li>This link will expire in 1 hour</li>
                            <li>If you did not request a password reset, please ignore this email</li>
                            <li>Your password will remain unchanged if you don't click the link</li>
                        </ul>
                    </div>
                </div>
                <div class="footer">
                    <p>This is an automated message. Please do not reply.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({
        to: user.email,
        subject: 'Password Reset Request',
        html
    });
}

/**
 * Send account recovery / unlock link.
 */
async function sendAccountRecoveryEmail(user, recoveryToken) {
    const recoveryUrl = `${getAppBaseUrl()}/recover-account?token=${recoveryToken}`;

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #2196F3; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .button { display: inline-block; padding: 12px 24px; background: #2196F3; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Account Recovery</h1>
                </div>
                <div class="content">
                    <p>Hello ${user.username},</p>
                    <p>We received a request to recover your account. Click the button below to unlock and recover your account:</p>
                    <p style="text-align: center;">
                        <a href="${recoveryUrl}" class="button">Recover Account</a>
                    </p>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all; color: #2196F3;">${recoveryUrl}</p>
                    <p>This link will expire in 24 hours.</p>
                    <p>If you did not request account recovery, please contact support immediately.</p>
                </div>
                <div class="footer">
                    <p>This is an automated message. Please do not reply.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({
        to: user.email,
        subject: 'Account Recovery Request',
        html
    });
}

/**
 * Send security notifications (password changed, new device, lockout).
 */
async function sendSecurityNotification(user, notificationType, details = {}) {
    const notifications = {
        password_changed: {
            subject: 'Password Changed',
            message: 'Your password has been successfully changed. If you did not make this change, please contact support immediately.'
        },
        login_new_device: {
            subject: 'New Login Detected',
            message: `A new login was detected from ${details.ipAddress || 'unknown location'}. If this was not you, please secure your account immediately.`
        },
        account_locked: {
            subject: 'Account Locked',
            message: 'Your account has been temporarily locked due to multiple failed login attempts. Please use account recovery to unlock it.'
        }
    };

    const notification = notifications[notificationType] || {
        subject: 'Security Notification',
        message: 'A security event has occurred on your account.'
    };

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #f44336; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Security Notification</h1>
                </div>
                <div class="content">
                    <p>Hello ${user.username},</p>
                    <p>${notification.message}</p>
                    <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
                    ${details.ipAddress ? `<p><strong>IP Address:</strong> ${details.ipAddress}</p>` : ''}
                    ${details.userAgent ? `<p><strong>Device:</strong> ${details.userAgent}</p>` : ''}
                    <p>If you did not perform this action, please contact support immediately.</p>
                </div>
                <div class="footer">
                    <p>This is an automated security notification. Please do not reply.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({
        to: user.email,
        subject: notification.subject,
        html
    });
}

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendAccountRecoveryEmail,
    sendSecurityNotification,
    getAppBaseUrl,
    resolveFromAddress,
    isProtonMailbox
};
