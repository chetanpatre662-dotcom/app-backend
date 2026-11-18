// ── Firebase Admin SDK Initialization ────────────────────────────────────────
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

const serviceAccountPath = path.resolve(__dirname, "../../serviceAccountKey.json");

if (!admin.apps.length) {
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: "scep-bus.firebasestorage.app",
    });
    console.log("Firebase Storage Bucket:", admin.storage().bucket().name);
  } else {
    console.warn("⚠️ serviceAccountKey.json not found — Firebase not initialized (dev mode)");
  }
}

module.exports = admin;
