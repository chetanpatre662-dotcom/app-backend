// ── User Notification Helper ─────────────────────────────────────────────────
const admin = require("firebase-admin");
const { sanitize } = require("./sanitize");

async function createUserNotification(userId, type, title, body, data = {}) {
  try {
    await admin.firestore().collection("user_notifications").add({
      userId,
      type,
      title: sanitize(title),
      body: sanitize(body),
      data,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}
}

module.exports = { createUserNotification };
