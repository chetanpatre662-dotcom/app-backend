// ── Authentication Middleware ─────────────────────────────────────────────────
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const { JWT_SECRET } = require("../config/env");

// Admin JWT authentication
function adminAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.admin) throw new Error();
    req.adminRole = decoded.role || "admin";
    req.adminInstitution = decoded.institution || null;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Firebase ID Token authentication
async function authenticateFirebaseUser(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required. Send: Authorization: Bearer <idToken>" });
  }
  try {
    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired authentication token" });
  }
}

// Bus Pass admin authentication
function busPassAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.buspass && decoded.role !== "bus_pass_admin") throw new Error();
    req.buspassOperator = decoded.operator || decoded.role || "admin";
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// RBAC institution filter helper
function resolveInstitutionFilter(req, queryParam) {
  if (req.adminRole === "superadmin") {
    const explicit = (queryParam || "").toLowerCase();
    if (["college", "school"].includes(explicit)) return explicit;
    return null;
  }
  return req.adminInstitution;
}

module.exports = { adminAuth, authenticateFirebaseUser, busPassAuth, resolveInstitutionFilter };
