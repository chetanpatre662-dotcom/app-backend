// ── Audit Logging ────────────────────────────────────────────────────────────
const admin = require("firebase-admin");

async function logAuditEvent(action, adminRole, adminInst, details = {}) {
  try {
    await admin.firestore().collection("audit_logs").add({
      action,
      adminRole: adminRole || "unknown",
      adminInstitution: adminInst || "unknown",
      details,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}
}

module.exports = { logAuditEvent };
