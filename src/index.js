/**
 * SCEP Bus Tracking Server — Modular Entry Point
 * 
 * This is the NEW modular entry point. The legacy index.js (root) still works
 * and contains all functionality. This file demonstrates the modular structure
 * and can be used once all routes are fully migrated.
 * 
 * Structure:
 *   src/config/     — Environment, Firebase, Razorpay configuration
 *   src/middleware/  — Auth, rate limiting
 *   src/routes/      — Express route handlers (future migration)
 *   src/services/    — Business logic (future migration)
 *   src/utils/       — Helpers (sanitize, audit, notifications)
 *   src/cron/        — Scheduled tasks (future migration)
 * 
 * Current status: Modules extracted and testable. Legacy index.js remains
 * the production entry point until route migration is complete.
 */

// Validate environment before anything else
const config = require("./config/env");

// Firebase (must init before other modules use admin)
const admin = require("./config/firebase");

// Razorpay
const razorpay = require("./config/razorpay");

// Middleware
const { adminAuth, authenticateFirebaseUser, busPassAuth, resolveInstitutionFilter } = require("./middleware/auth");
const { loginLimiter, paymentLimiter, uploadLimiter, apiLimiter } = require("./middleware/rateLimiter");

// Utilities
const { sanitize } = require("./utils/sanitize");
const { logAuditEvent } = require("./utils/audit");
const { createUserNotification } = require("./utils/notifications");

console.log("✅ All modules loaded successfully");
console.log(`   Config: PORT=${config.PORT}, WS_PORT=${config.WS_PORT}`);
console.log(`   Firebase: ${admin.apps.length} app(s)`);
console.log(`   Razorpay: ${config.RAZORPAY_KEY_ID.substring(0, 12)}...`);

module.exports = {
  config,
  admin,
  razorpay,
  adminAuth,
  authenticateFirebaseUser,
  busPassAuth,
  resolveInstitutionFilter,
  loginLimiter,
  paymentLimiter,
  uploadLimiter,
  apiLimiter,
  sanitize,
  logAuditEvent,
  createUserNotification,
};
