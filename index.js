const WebSocket = require("ws");
const axios = require("axios");
const express = require("express");
require("dotenv").config();
process.env.TZ = "Asia/Kolkata";

// ── Environment Validation ──────────────────────────────────────────────────
const REQUIRED_ENV = ["ADMIN_USER", "ADMIN_PASS_HASH", "SCHOOL_ADMIN_USER", "SCHOOL_ADMIN_PASS_HASH",
  "SUPER_ADMIN_USER", "SUPER_ADMIN_PASS_HASH", "JWT_SECRET", "BUSPASS_USERNAME", "BUSPASS_PASS_HASH"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ FATAL: Missing env variable: ${key}`); process.exit(1); }
}
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const helmet = require("helmet");
const compression = require("compression");
const xss = require("xss");
const lastStartNotification = {};
const START_COOLDOWN_MS = 50 * 60 * 1000; // 50 min — legacy alias, kept for safety
const START_COOLDOWN_SEC = START_COOLDOWN_MS / 1000;
const busState = {};
const cron = require("node-cron");
const lastBusLocationTime = {};
const trackerMonitor = {};
const busDistanceTracker = {};
const busRouteState = {};
// ── Redis key prefixes for persistent crash-recovery state ──────────────────
const REDIS_GPS_PREFIX  = "lastBusGps:";       // last N GPS fixes per bus
const REDIS_DIR_PREFIX  = "lastDirection:";    // confirmed isForward + pending
const GPS_TTL_SEC       = 4 * 3600;            // 4 h — covers a full morning window
const DIR_TTL_SEC       = 4 * 3600;
const busGpsHistory     = {};                  // in-memory, restored from Redis on cold start
const lastSentData = {};
const busStartTimes = {};
let routeCache = {};
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min in-memory TTL (matches Redis TTL)
const tripStatusMap = {};
const busCollegeArrival = {};
let latestBuses = [];
let recentActivities = [];
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS_HASH;
const SCHOOL_ADMIN_USER = process.env.SCHOOL_ADMIN_USER;
const SCHOOL_ADMIN_PASS = process.env.SCHOOL_ADMIN_PASS_HASH;
const SUPER_ADMIN_USER = process.env.SUPER_ADMIN_USER;
const SUPER_ADMIN_PASS = process.env.SUPER_ADMIN_PASS_HASH;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const attendanceMarked = {};

const redis = require("./redis");
setInterval(() => {
  const today = new Date().toISOString().split("T")[0];

  for (const key in attendanceMarked) {
    // Key format: studentId_YYYY-MM-DD — use lastIndexOf to handle IDs with underscores
    const keyDate = key.slice(key.lastIndexOf("_") + 1);

    if (keyDate !== today) {
      delete attendanceMarked[key];
    }
  }
}, 3600000);

let redisReady = false;
const COLLEGE_LAT = 21.825334035623513;
const COLLEGE_LNG = 80.1513767355824;
const COLLEGE_RADIUS = 0.4;

(async () => {
  try {
    await redis.connectRedis();
    redisReady = true;
    console.log("Redis connected");
  } catch (e) {
    console.log("Redis connect error:", e.message);
  }
})();

const jwt = require("jsonwebtoken");

function adminAuth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.admin) throw new Error();
    // RBAC: attach role + institution from JWT
    req.adminRole        = decoded.role || "admin";         // "admin" | "superadmin"
    req.adminInstitution = decoded.institution || null;     // "college" | "school" | "all"
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ── RBAC Helper: resolve institution filter ──────────────────────────────────
// If superadmin → returns null (no filter = return all)
// If regular admin → returns their institution string
// Used by all filtered endpoints to decide query scope.
function resolveInstitutionFilter(req, queryParam) {
  if (req.adminRole === "superadmin") {
    // Superadmin can optionally filter by passing ?institution=X, or get all
    const explicit = (queryParam || "").toLowerCase();
    if (["college", "school"].includes(explicit)) return explicit;
    return null; // null = no filter = return all
  }
  // Regular admin: MUST use their JWT institution (ignore query param tampering)
  return req.adminInstitution;
}

async function getAllUsers() {
  const [students, parents, faculty] = await Promise.all([
    admin.firestore().collection("students").get(),
    admin.firestore().collection("parents").get(),
    admin.firestore().collection("faculty").get(),
  ]);

  return {
    totalStudents: students.size,
    students: students.size,
    parents: parents.size,
    faculty: faculty.size,
    totalUsers: students.size + parents.size + faculty.size,
  };
}

require("events").EventEmitter.defaultMaxListeners = 50;

const serviceAccount = require("./serviceAccountKey.json");


if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "scep-bus.firebasestorage.app",
  });
}
console.log("Firebase Storage Bucket:", admin.storage().bucket().name);

(async () => {
  try {
    if (redisReady) {
      await redis.set("test", "hello");
    }
    const val = await redis.get("test");
    console.log("Redis Test:", val);
  } catch (e) {
    console.log("Redis Error:", e.message);
  }
})();

const app = express();

// ── Trust Proxy (Nginx reverse proxy) ───────────────────────────────────────
app.set("trust proxy", 1);

// ── Helmet: HTTP Security Headers ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── Compression ─────────────────────────────────────────────────────────────
app.use(compression({ threshold: 1024 }));

// ── CORS: Restrict to known origins ─────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://bustracker.satpudaengineeringcollege.com",
  "http://localhost:3000",
  "http://localhost:8080",
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, true); // In production with mobile app, allow all origins but set proper headers
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "x-firebase-uid"],
}));

// ── Body Parser ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = buf; } }));

// ── Request ID Middleware ────────────────────────────────────────────────────
app.use((req, res, next) => {
  const id = req.headers["x-request-id"] || crypto.randomUUID();
  req.id = id;
  res.setHeader("X-Request-ID", id);
  next();
});

// ── Structured Request Logging ──────────────────────────────────────────────
const requestCounts = { total: 0, success: 0, clientError: 0, serverError: 0 };
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    requestCounts.total++;
    if (res.statusCode < 400) requestCounts.success++;
    else if (res.statusCode < 500) requestCounts.clientError++;
    else requestCounts.serverError++;
    if (req.path !== "/health" && req.path !== "/metrics") {
      const log = {
        ts: new Date().toISOString(),
        reqId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        ip: req.ip,
      };
      if (ms > 1000) log.slow = true;
      console.log(JSON.stringify(log));
    }
  });
  next();
});

// ── Health Check Endpoint ───────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    redis: redisReady,
    memory: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
  });
});

// ── Performance Metrics Endpoint ────────────────────────────────────────────
app.get("/metrics", adminAuth, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.round(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
      external: Math.round(mem.external / 1048576),
    },
    requests: { ...requestCounts },
    redis: redisReady,
    activeBuses: Object.keys(busState).length,
    wsClients: typeof wss !== "undefined" ? wss.clients.size : 0,
    nodeVersion: process.version,
    pid: process.pid,
  });
});

// ── Input Sanitization Helper ───────────────────────────────────────────────
function sanitize(str) {
  if (!str || typeof str !== "string") return str;
  return xss(str.trim());
}

// ── Invalid FCM Token Pruning ───────────────────────────────────────────────
// Called when messaging().send() fails with token-not-registered or invalid-token.
// Removes the token from the user's Firestore document and bus_tokens array.
async function _pruneInvalidToken(token, userId, collection) {
  try {
    if (!token || !userId || !collection) return;
    // Clear from user document
    await admin.firestore().collection(collection).doc(userId).update({ fcmToken: "" });
    // Clear from bus_tokens
    const userDoc = await admin.firestore().collection(collection).doc(userId).get();
    if (userDoc.exists) {
      const busId = userDoc.data().busId;
      if (busId) {
        await admin.firestore().collection("bus_tokens").doc(busId).update({
          tokens: admin.firestore.FieldValue.arrayRemove([token]),
        });
      }
    }
    console.log(`🧹 Pruned invalid token for ${userId} (${collection})`);
  } catch (_) { /* Best-effort — never crash the sender loop */ }
}

// ── Rate Limiters ───────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: "Too many upload attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Rate limit exceeded." },
  standardHeaders: true,
  legacyHeaders: false,
});
const ticketLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests. Please wait." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(apiLimiter);

function isAtCollege(lat, lng) {
  const dist = calculateDistance(lat, lng, COLLEGE_LAT, COLLEGE_LNG);

  return dist <= COLLEGE_RADIUS;
}
async function getStudentLocation(studentId) {
  try {
    const data = await redis.get(`student:${studentId}`);
    return data || null;
  } catch (e) {
    console.log("Redis error:", e.message);
    return null;
  }
}
async function handleAttendance(bus, students) {
  const busStudents = students.filter(
    (s) => s.busId === bus.busId && s.studentId && s.studentType === "college",
  );

  if (busStudents.length === 0) return;

  const today = new Date().toISOString().split("T")[0];
  const now   = Date.now();

  // ── Stale GPS threshold: 5 minutes ──────────────────────────────────────
  const STALE_GPS_MS = 5 * 60 * 1000;

  // ── BATCH: Pre-fetch all student locations concurrently (Promise.all) ────
  // Previously: sequential await per student (N round-trips).
  // Now: single concurrent batch (1 round-trip time for all N students).
  const locations = await Promise.all(
    busStudents.map((s) => getStudentLocation(s.studentId))
  );

  for (let i = 0; i < busStudents.length; i++) {
    const student = busStudents[i];
    const loc = locations[i];

    if (!loc || typeof loc !== "object") continue;

    if (!loc.lat || !loc.lng) continue;

    // ── Stale GPS detection ────────────────────────────────────────────────
    // loc.lastUpdated is epoch ms set by /student-location endpoint.
    // If the student's GPS is older than 5 minutes, it cannot be trusted
    // for proximity-based arrival verification.
    const locAge = loc.lastUpdated ? (now - loc.lastUpdated) : Infinity;
    const isStale = locAge > STALE_GPS_MS;

    const distance = calculateDistance(bus.lat, bus.lng, loc.lat, loc.lng);
    const ATT_KEY = `${student.studentId}_${today}`;

    let att = {};

    const raw = await redis.get(`att:${ATT_KEY}`);

    // redis.get() already JSON.parses — use directly
    if (raw && typeof raw === "object") {
      att = raw;
    }

    // =========================
    // BOARDING
    // =========================
    // Multi-update confirmation: student must be within 0.05 km of the moving
    // bus for BOARDING_CONFIRM_COUNT consecutive loop ticks before boarding
    // is marked. This prevents a student standing near the road from getting
    // a false boarding mark from a single GPS proximity coincidence.
    //
    // Note: Boarding uses bus GPS proximity (bus moving past student).
    // Stale student GPS still allows boarding detection because the bus GPS
    // is always fresh (from the tracking device). The student just needs to
    // be physically near the bus — their last-known position is sufficient
    // for the 90m radius check within a short staleness window.
    const BOARDING_CONFIRM_COUNT = 5;   // ~45 s at 15 s/tick
    const BOARDING_RADIUS_KM     = 0.09; // 90 m

    if (!att.boarded) {
      // Skip boarding check if student GPS is extremely stale (>10 min)
      // This prevents boarding marks from yesterday's cached location.
      if (locAge > 10 * 60 * 1000) continue;

      if (distance <= BOARDING_RADIUS_KM && bus.speed > 5) {
        // Increment consecutive-proximity counter
        att.boardingTicks = (att.boardingTicks || 0) + 1;
        await redis.setEx(`att:${ATT_KEY}`, 86400, att);
      } else {
        // Student moved away or bus slowed — reset counter
        if (att.boardingTicks) {
          att.boardingTicks = 0;
          await redis.setEx(`att:${ATT_KEY}`, 86400, att);
        }
      }

      // Only confirm boarding after BOARDING_CONFIRM_COUNT consecutive hits
      if ((att.boardingTicks || 0) >= BOARDING_CONFIRM_COUNT) {
        att.boarded      = true;
        att.arrived      = false;
        att.boardingTicks = 0; // clean up counter after confirmation

        // Atomic write with TTL — crash-safe
        await redis.setEx(`att:${ATT_KEY}`, 86400, att);

        await admin
          .firestore()
          .collection("students")
          .doc(student.studentId)
          .set(
            {
              liveStatus: {
                onboarded: true,
                present: false,
              },
            },
            { merge: true },
          );

        await admin
          .firestore()
          .collection("attendance")
          .doc(ATT_KEY)
          .set(
            {
              studentId:    student.studentId,
              studentName:  student.name  || "",
              branch:       student.branch || "",
              course:       student.course || "",
              studentType:  student.studentType || "",
              busId:        bus.busId,
              route:        bus.route || "",
              date:         today,
              monthKey:     getMonthKey(),
              academicYear: student.academicYear || student.year || "",
              day: new Date().toLocaleDateString("en-US", { weekday: "long" }),
              boardingTime: admin.firestore.FieldValue.serverTimestamp(),
              arrivalTime:  null,
              present:      false,
              verificationStatus: "gps_verified",  // boarding confirmed via GPS proximity
              createdAt:    admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );

        console.log("✅ Boarded (confirmed)", student.studentId);
      }
    }
    // =========================
    // EXIT DETECTION
    // Student boarded but is now far from the bus and the bus is NOT at
    // college → they exited the bus mid-route.
    //
    // Conditions (all must be true):
    //   1. att.boarded == true      (was confirmed as boarded today)
    //   2. att.exited != true       (not already recorded as exited)
    //   3. !isAtCollege(bus)        (bus hasn't reached college yet)
    //   4. distance > EXIT_RADIUS_KM (student is far from the bus)
    //   5. bus.speed > 5            (bus is still moving, not just stopped)
    //
    // A 3-tick confirmation is used to avoid transient GPS drift marking a
    // genuine passenger as exited due to a momentary bad GPS fix.
    //
    // Stale GPS: If student GPS is stale, do NOT mark as exited — the student
    // may still be on the bus but their phone stopped uploading GPS.
    // =========================
    const EXIT_RADIUS_KM   = 0.5;   // 300 m — clearly off the bus
    const EXIT_CONFIRM_COUNT = 3;   // ~45 s at 15 s/tick

    if (att.boarded && !att.exited && !att.arrived && !isAtCollege(bus.lat, bus.lng)) {
      if (isStale) {
        // Student GPS is stale — cannot determine if they exited.
        // Flag as pending verification in Redis (does not affect Firestore yet).
        if (!att.pendingVerification) {
          att.pendingVerification = true;
          await redis.setEx(`att:${ATT_KEY}`, 86400, att);
          console.log("⏳ Pending verification (stale GPS)", student.studentId);
        }
      } else if (distance > EXIT_RADIUS_KM && bus.speed > 5) {
        att.exitTicks = (att.exitTicks || 0) + 1;
        await redis.setEx(`att:${ATT_KEY}`, 86400, att);
      } else {
        // Student back near bus (e.g. bus stopped and student still aboard)
        if (att.exitTicks) {
          att.exitTicks = 0;
          await redis.setEx(`att:${ATT_KEY}`, 86400, att);
        }
        // Fresh GPS near bus clears pending verification
        if (att.pendingVerification) {
          att.pendingVerification = false;
          await redis.setEx(`att:${ATT_KEY}`, 86400, att);
        }
      }

      if ((att.exitTicks || 0) >= EXIT_CONFIRM_COUNT) {
        att.exited    = true;
        att.exitTicks = 0;
        att.pendingVerification = false;
        await redis.setEx(`att:${ATT_KEY}`, 86400, att);

        // Update Firestore attendance document with exit info
        await admin.firestore().collection("attendance").doc(ATT_KEY).set(
          {
            exited:    true,
            exitTime:  admin.firestore.FieldValue.serverTimestamp(),
            present:   false,   // did not complete journey to college
            verificationStatus: "gps_verified",  // exit confirmed via GPS
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Update student liveStatus
        await admin.firestore().collection("students")
          .doc(student.studentId)
          .set(
            { liveStatus: { onboarded: false, present: false } },
            { merge: true },
          );

        console.log("🚪 Exited mid-route", student.studentId);
      }
    }

    // =========================
    // ARRIVAL
    // =========================
    // ── Stale GPS guard for arrival ──────────────────────────────────────────
    // Arrival requires BOTH:
    //   1. Bus is at college (bus GPS — always fresh from tracking device)
    //   2. Student is within 1.5 km of bus (student GPS — must be fresh)
    //
    // If student GPS is stale, we cannot verify they are actually at college.
    // Mark as "pending_verification" instead of "present: true".
    // This prevents false arrivals from cached GPS coordinates.

    const latestAtt = (await redis.get(`att:${ATT_KEY}`)) || {};
    // redis.get() already JSON.parses — latestAtt is already an object
    if (
      latestAtt.boarded &&
      !latestAtt.arrived &&
      !latestAtt.exited &&
      isAtCollege(bus.lat, bus.lng) &&
      distance <= 1.5
    ) {
      if (isStale) {
        // ── Stale GPS: cannot confirm arrival — mark as pending ────────────
        if (!latestAtt.pendingVerification) {
          latestAtt.pendingVerification = true;
          await redis.setEx(`att:${ATT_KEY}`, 86400, latestAtt);

          // Write pending status to Firestore so admin can see it
          await admin.firestore().collection("attendance").doc(ATT_KEY).set(
            {
              verificationStatus: "pending_verification",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
          console.log("⏳ Arrival pending (stale student GPS)", student.studentId,
            `locAge=${Math.round(locAge/1000)}s`);
        }
      } else {
        // ── Fresh GPS: confirm arrival ──────────────────────────────────────
        latestAtt.arrived = true;
        latestAtt.pendingVerification = false;

        // Atomic write with TTL
        await redis.setEx(`att:${ATT_KEY}`, 86400, latestAtt);

        await admin
          .firestore()
          .collection("students")
          .doc(student.studentId)
          .set(
            {
              liveStatus: {
                onboarded: true,
                present: true,
              },
            },
            { merge: true },
          );

        await admin.firestore().collection("attendance").doc(ATT_KEY).set(
          {
            arrivalTime: admin.firestore.FieldValue.serverTimestamp(),
            present: true,
            verificationStatus: "gps_verified",  // arrival confirmed via fresh GPS
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        console.log("🏫 Arrived (GPS verified)", student.studentId);
      }
    }
  }
}
/* =========================
   APIs
========================= */
const API_1 = {
  url: "http://india.voltysoft.com/api/v12/vehicles/SatpudaValley",
  key: "ZSC6ieTmLhVtQZU",
};
const SML_API = {
  loginUrl: "https://customer-api.smlsaarthi.com/login",

  vehicleUrl: "https://customer-api.smlsaarthi.com/allVehicles",

  username: "9425836824",

  password: "9425836824",

  token: null,

  tokenExpiry: null,
};

/* ======================== =
   BUS MAP
========================= */
const busMap = {
 "866477065754528": "BUS-2",
  "866477065667928": "BUS-3",
  "860560064978408": "BUS-10",
  "860560065510150": "BUS-7",
  "868329087892307": "BUS-9",
  "860560067136350": "BUS-11",
  "866334078434509": "BUS-15",
  "862567077140767": "BUS-14",
};

const driverMap = {
 
  "BUS-10": "Yogesh Matre",
  "BUS-7": "Dilendra",
  "BUS-11": "Sampat",
  "BUS-15": "Yogesh Matre",
  "BUS-14": "Shyam ",
};

const driverMobileMap = {
 
  "BUS-7": "9165266310",
  "BUS-10": "9876543214",
  "BUS-11": "9876543215",
  "BUS-14": "9876543216",
  "BUS-15": "9876543217",
};

const smlBusMap = {
  MBUZT54XBK0325975: {
    imei: "866334078434509",
    busId: "BUS-15",
  },

  MBUZT54XEK0331171: {
    imei: "862567077140767",
    busId: "BUS-14",
  },

  MBUZT54XGL0317250: {
    imei: "860560067136350",
    busId: "BUS-11",
  },
};

/* ==========================================================================
   GPS DIRECTION ENGINE
   ─────────────────────────────────────────────────────────────────────────
   Algorithm (same approach as Google Maps / Uber):

   1. Maintain a rolling window of the last 5 GPS fixes per bus.
   2. Filter out fixes that are too close together (GPS noise < 30 m).
   3. Compute a WEIGHTED bearing average across all consecutive pairs,
      weighting each pair by its distance travelled (longer moves = more
      reliable signal, short jitters = low weight).
   4. Convert the averaged bearing to a unit vector (cos, sin).
   5. For each route segment adjacent to the nearest stop, compute a unit
      vector in both the forward and backward direction.
   6. Choose the direction whose unit vector has the highest dot product
      with the bus velocity vector (cosine similarity).
   7. Apply a FLIP-PREVENTION gate: only accept a direction change when the
      new evidence score exceeds the old by a clear margin AND the bus has
      maintained that heading for at least 2 consecutive updates.
   ========================================================================== */

const GPS_HISTORY_SIZE   = 5;     // rolling window size
const GPS_NOISE_MIN_KM   = 0.03;  // ignore moves < 30 m (GPS jitter)
const DIRECTION_MIN_SCORE_GAP = 0.25; // dot-product gap needed to flip direction
const FLIP_CONFIRM_COUNT = 3;     // consecutive updates needed to confirm a flip — prevents GPS-jitter flips

/**
 * Record a new GPS fix for a bus.
 * On first call for a busId, restores history from Redis so direction
 * detection continues seamlessly after a server restart.
 * Persists the updated history to Redis after every real point added.
 */
async function updateBusGpsHistory(busId, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  // ── Cold-start restore ────────────────────────────────────────────────────
  if (!busGpsHistory[busId]) {
    try {
      const saved = await redis.get(`${REDIS_GPS_PREFIX}${busId}`);
      if (Array.isArray(saved) && saved.length > 0) {
        busGpsHistory[busId] = saved;
      } else {
        busGpsHistory[busId] = [];
      }
    } catch (_) {
      busGpsHistory[busId] = [];
    }
  }

  const hist = busGpsHistory[busId];

  // Skip duplicates or points within 10 m of last point (GPS noise)
  if (hist.length > 0) {
    const last = hist[0];
    if (calculateDistance(last.lat, last.lng, lat, lng) < 0.01) return;
  }

  hist.unshift({ lat, lng, ts: Date.now() });
  if (hist.length > GPS_HISTORY_SIZE) hist.pop();

  // Persist to Redis asynchronously — don't block the hot path
  redis.setEx(`${REDIS_GPS_PREFIX}${busId}`, GPS_TTL_SEC, hist).catch(() => {});
}

/**
 * Bearing (0–360°) from (lat1,lng1) to (lat2,lng2).
 * Returns null when the two points are effectively identical.
 */

/**
 * Parse a Voltysoft GPS timestamp correctly.
 *
 * The Voltysoft provider sends IST (Asia/Kolkata, UTC+5:30) timestamps but
 * appends a fake "Z" suffix, e.g. "2026-06-19T17:48:23Z".
 * JavaScript treats the Z as UTC, so the parsed value is 5h30m ahead of
 * true UTC → delaySec ≈ −19800 s.
 *
 * Fix: strip the trailing Z (if present) and replace it with "+05:30"
 * so the JS Date constructor correctly interprets the value as IST.
 *
 * Non-Z strings (bare local time like "2026-06-19 17:48:23") are also
 * handled by replacing the space separator and appending +05:30.
 *
 * Returns milliseconds since epoch, or NaN on invalid input.
 */
function parseVoltyTime(raw) {
  if (!raw) return NaN;
  const s = String(raw).trim();

  // Already has a real timezone offset → trust it as-is.
  if (_tzOffsetRe.test(s)) return new Date(s).getTime();

  // Has a fake Z → strip it, add IST offset.
  if (s.charCodeAt(s.length - 1) === 90 || s.charCodeAt(s.length - 1) === 122) { // 'Z' or 'z'
    return new Date(s.slice(0, -1) + "+05:30").getTime();
  }

  // Bare local time with space separator (e.g. "2026-06-19 17:48:23").
  return new Date(s.replace(" ", "T") + "+05:30").getTime();
}
// Pre-compiled regex for parseVoltyTime (avoids re-compilation per call)
const _tzOffsetRe = /[+-]\d{2}:\d{2}$/;

function logBusUpdate(busId, gpsTime, preParseMs) {
  const serverNow = Date.now();
  // Use pre-parsed value if available, otherwise parse (backward compat)
  const parsed = preParseMs !== undefined ? preParseMs : parseVoltyTime(gpsTime);

  if (!Number.isFinite(parsed)) {
    return;
  }

  const delaySec = Math.round((serverNow - parsed) / 1000);

  console.log(`🚌 BUS UPDATE: ${busId} delay = ${delaySec}s`);  console.log(`🚌 BUS UPDATE: ${busId} delay = ${delaySec}s`);

  // ── Abnormal delay guard ──────────────────────────────────────────────────
  // delay < -300 s  → GPS timestamp is AHEAD of server clock.
  //   Cause (API-1/Voltysoft): item.time is a bare local-time string
  //   (e.g. "2024-01-15 09:23:41") which JS parses as UTC; when the
  //   server TZ is IST (UTC+5:30) the parsed ms is 19800 s (5.5 h) too
  //   large → delay ≈ -19800 s.
  //   Fix needed: parse item.time as IST, not UTC.
  //
  // delay > 300 s  → GPS timestamp is FAR behind server clock.
  //   Cause (SML): item.lastOnline may be in milliseconds, not seconds.
  //   Multiplying by 1000 again produces a year-3000 timestamp →
  //   delay ≈ +(several days in seconds).
  //   Fix needed: detect whether lastOnline > 1e12 (already ms) and skip ×1000.
  if (delaySec < -300 || delaySec > 300) {
    // console.warn("⚠️  ABNORMAL DELAY", {
    //   busId,
    //   delaySec,
    //   gpsTimestamp:    gpsTime,
    //   parsedMs:        parsed,
    //   serverTimestamp: new Date(serverNow).toISOString(),
    //   gpsAge:          new Date(parsed).toISOString(),
    // });
  }
}

function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng  = toRad(lng2 - lng1);
  const φ1    = toRad(lat1);
  const φ2    = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  if (y === 0 && x === 0) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Convert a bearing (degrees) to a unit vector [cosine, sine].
 * Using (cos, sin) in bearing space so vectors are directly comparable.
 */
function bearingToVector(degrees) {
  const r = (degrees * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

/**
 * Dot product of two 2-D vectors.
 */
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

/**
 * Compute a WEIGHTED average bearing from the GPS history.
 *
 * Strategy:
 *   - Build all consecutive pairs from the history window.
 *   - Only keep pairs with distance >= GPS_NOISE_MIN_KM.
 *   - Weight each pair by the distance travelled (reliability proxy).
 *   - Average bearings using circular mean via sin/cos components.
 *
 * Returns null when there is insufficient clean movement data.
 */
function getSmoothedHeading(busId) {
  const hist = busGpsHistory[busId];
  if (!hist || hist.length < 2) return null;

  let sumSin = 0, sumCos = 0, totalWeight = 0;

  for (let i = 0; i < hist.length - 1; i++) {
    const from = hist[i + 1]; // older point
    const to   = hist[i];     // newer point
    const dist = calculateDistance(from.lat, from.lng, to.lat, to.lng);

    if (dist < GPS_NOISE_MIN_KM) continue; // skip noise

    const bearing = bearingBetween(from.lat, from.lng, to.lat, to.lng);
    if (bearing === null) continue;

    const weight = dist; // longer move = more trustworthy
    const rad = (bearing * Math.PI) / 180;
    sumSin     += Math.sin(rad) * weight;
    sumCos     += Math.cos(rad) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  const avgRad     = Math.atan2(sumSin / totalWeight, sumCos / totalWeight);
  const avgBearing = ((avgRad * 180) / Math.PI + 360) % 360;
  return avgBearing;
}

/* ==========================================================================
   ROUTE STOP MERGE + GRAPH CACHE
   ─────────────────────────────────────────────────────────────────────────
   "Route graph" = {
     merged:   city[]           — clustered & stably-ordered stops
     segments: { fwdBearing, bwdBearing }[]  — per-stop segment bearings
   }

   Stop clustering algorithm (order-independent, zigzag-safe):
   1. Union-Find: group any two stops within MERGE_KM into the same cluster
   2. Centroid: represent each cluster by the mean lat/lng of its members
      and the name of whichever member appears earliest in the original list
   3. Stable ordering: project every centroid onto the polyline formed by
      the original cities array, accumulate arc-distance, then sort ascending
      This makes the order identical regardless of how the admin entered stops

   Storage layers:
     1. In-memory  routeGraphCache  — O(1), cleared on process restart
     2. Redis      route:graph:{busId} — 10 min TTL, survives restarts
     3. Rebuilt from Firestore route doc when both layers miss
   ========================================================================== */
const ROUTE_GRAPH_REDIS_PREFIX = "route:graph:";
const routeGraphCache          = {};
const STOP_MERGE_KM            = 0.5; // cluster radius (500 m)

/* ── Union-Find (path-compressed) ─────────────────────────────────────── */
function makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a, b) { parent[find(a)] = find(b); }
  return { find, union };
}

/**
 * Cluster stops that are within STOP_MERGE_KM of each other using
 * Union-Find so the result is independent of iteration order.
 * Returns an array of cluster objects sorted by their first-occurrence
 * index in the original list (stable ordering).
 */
function clusterStops(cities) {
  const n  = cities.length;
  const uf = makeUF(n);

  // Build clusters: union any pair within merge radius
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (calculateDistance(
            cities[i].lat, cities[i].lng,
            cities[j].lat, cities[j].lng
          ) < STOP_MERGE_KM) {
        uf.union(i, j);
      }
    }
  }

  // Group by root, keeping track of first occurrence index
  const groups = new Map(); // root → { members[], firstIdx }
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, { members: [], firstIdx: i });
    groups.get(root).members.push(i);
  }

  // Build one representative stop per cluster
  const clusters = [];
  for (const { members, firstIdx } of groups.values()) {
    const centLat = members.reduce((s, idx) => s + cities[idx].lat, 0) / members.length;
    const centLng = members.reduce((s, idx) => s + cities[idx].lng, 0) / members.length;
    // Name = the member with the smallest original index (most "canonical")
    const name = cities[firstIdx].name || "";
    clusters.push({ lat: centLat, lng: centLng, name, firstIdx });
  }

  // Sort by first-occurrence index so the output order matches the route's
  // intended direction regardless of how tightly stops were packed.
  clusters.sort((a, b) => a.firstIdx - b.firstIdx);

  return clusters.map(({ lat, lng, name }) => ({ lat, lng, name }));
}

/**
 * Re-order stop clusters by their arc-distance along the original polyline.
 * This handles zigzag input: even if the admin entered stops out of order,
 * the output list follows the physical road geometry.
 *
 * Strategy: for each cluster centroid, find the closest segment of the
 * original cities polyline, then assign it an arc-distance = sum of all
 * previous segment lengths + fraction along the matching segment.
 */
function stableOrderByPolyline(clusters, originalCities) {
  if (originalCities.length < 2) return clusters;

  // Build cumulative arc-distance for each original vertex
  const arcDist = [0];
  for (let i = 1; i < originalCities.length; i++) {
    arcDist.push(
      arcDist[i - 1] + calculateDistance(
        originalCities[i - 1].lat, originalCities[i - 1].lng,
        originalCities[i].lat,     originalCities[i].lng
      )
    );
  }

  function projectOntoPolyline(lat, lng) {
    let best = Infinity;
    let bestArc = 0;

    for (let i = 0; i < originalCities.length - 1; i++) {
      const ax = originalCities[i].lat,   ay = originalCities[i].lng;
      const bx = originalCities[i + 1].lat, by = originalCities[i + 1].lng;
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;

      let t = 0;
      if (lenSq > 0) {
        t = ((lat - ax) * dx + (lng - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
      }

      const projLat = ax + t * dx;
      const projLng = ay + t * dy;
      const d = calculateDistance(lat, lng, projLat, projLng);

      if (d < best) {
        best    = d;
        bestArc = arcDist[i] + t * (arcDist[i + 1] - arcDist[i]);
      }
    }

    return bestArc;
  }

  return clusters
    .map((c) => ({ ...c, _arc: projectOntoPolyline(c.lat, c.lng) }))
    .sort((a, b) => a._arc - b._arc)
    .map(({ lat, lng, name }) => ({ lat, lng, name }));
}

/**
 * Build a route graph from a raw Firestore route document.
 * Pure function — no I/O.
 */
function buildRouteGraph(route) {
  const cities = route.cities || [];
  if (!cities.length) return { merged: [], segments: [], routeName: route.routeName || "" };

  // ── Step 1: cluster stops (order-independent, zigzag-safe) ──────────────
  const clustered = clusterStops(cities);

  // ── Step 2: stable ordering along polyline ───────────────────────────────
  const merged = cities.length >= 2
    ? stableOrderByPolyline(clustered, cities)
    : clustered;

  // ── Step 3: pre-compute segment bearings for direction detection ─────────
  // segments[i].fwdBearing = bearing stop[i] → stop[i+1]  (null at last)
  // segments[i].bwdBearing = bearing stop[i] → stop[i-1]  (null at first)
  const segments = merged.map((city, i) => ({
    fwdBearing: i < merged.length - 1
      ? bearingBetween(city.lat, city.lng, merged[i + 1].lat, merged[i + 1].lng)
      : null,
    bwdBearing: i > 0
      ? bearingBetween(city.lat, city.lng, merged[i - 1].lat, merged[i - 1].lng)
      : null,
  }));

  return { merged, segments, routeName: route.routeName || "", routeType: (route.routeType || "college").toLowerCase() };
}

/**
 * Get the pre-built route graph for a bus.
 * Cache hierarchy: in-memory → Redis → rebuild from Firestore route doc.
 *
 * @param {string} busId   — normalised bus ID e.g. "BUS-14"
 * @param {object} [routeDoc] — if already fetched, pass it to skip re-fetch
 * @returns {object|null} route graph or null
 */
async function getRouteGraph(busId, routeDoc = null) {
  // ── Layer 1: in-memory ───────────────────────────────────────────────────
  const mem = routeGraphCache[busId];
  if (mem && (Date.now() - mem.fetchedAt) < ROUTE_CACHE_TTL_MS) {
    return mem.graph;
  }

  // ── Layer 2: Redis ───────────────────────────────────────────────────────
  try {
    const cached = await redis.get(`${ROUTE_GRAPH_REDIS_PREFIX}${busId}`);
    if (cached && cached.merged && cached.segments) {
      routeGraphCache[busId] = { graph: cached, fetchedAt: Date.now() };
      return cached;
    }
  } catch (_) { /* Redis unavailable — fall through */ }

  // ── Layer 3: build from route doc (or fetch from Firestore) ──────────────
  const route = routeDoc ?? await _fetchRouteFromFirestore(busId);
  if (!route) return null;

  const graph = buildRouteGraph(route);

  // Write to both layers atomically
  routeGraphCache[busId] = { graph, fetchedAt: Date.now() };
  try {
    await redis.setEx(`${ROUTE_GRAPH_REDIS_PREFIX}${busId}`, ROUTE_CACHE_TTL_SEC, graph);
  } catch (_) { /* Redis write failure is non-fatal */ }

  return graph;
}

/**
 * Fetch raw route doc from Firestore (private helper, not called directly).
 */
async function _fetchRouteFromFirestore(busId) {
  try {
    // Fetch ALL active routes for this bus (may have both college + school)
    const snap = await admin.firestore()
      .collection("routes")
      .where("busId", "==", busId)
      .where("status", "==", "Active")
      .get();
    if (snap.empty) return null;
    // Return the first match — routeType is preserved in the document
    return snap.docs[0].data();
  } catch (e) {
    console.log(`❌ Firestore route fetch error (${busId}):`, e.message);
    return null;
  }
}

/**
 * Fetch route doc for a specific bus AND routeType.
 * Used when a bus is shared between institutions.
 *
 * CACHED: Results are stored in-memory for ROUTE_CACHE_TTL_MS so the
 * hot-path (every 2 s loop iteration) never hits Firestore.
 * Invalidated alongside the main route cache when admin updates routes.
 */
const _institutionRouteCache = {}; // key: "BUS-10:school" → { data, fetchedAt }

async function _fetchRouteForInstitution(busId, routeType) {
  const cacheKey = `${busId}:${routeType}`;
  const cached = _institutionRouteCache[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < ROUTE_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const snap = await admin.firestore()
      .collection("routes")
      .where("busId", "==", busId)
      .where("routeType", "==", routeType)
      .where("status", "==", "Active")
      .limit(1)
      .get();
    const result = snap.empty ? null : snap.docs[0].data();
    _institutionRouteCache[cacheKey] = { data: result, fetchedAt: Date.now() };
    return result;
  } catch (e) {
    // On error, return stale cache if available
    if (cached) return cached.data;
    return null;
  }
}

/**
 * Invalidate both cache layers for a bus (call after a route admin update).
 */
async function invalidateRouteCache(busId) {
  busId = normalizeBusId(busId);
  delete routeGraphCache[busId];
  delete routeCache[busId]; // legacy raw-route cache
  // Clear institution-specific route cache for this bus
  delete _institutionRouteCache[`${busId}:college`];
  delete _institutionRouteCache[`${busId}:school`];
  try { await redis.del(`${ROUTE_GRAPH_REDIS_PREFIX}${busId}`); } catch (_) {}
  try { await redis.del(`${ROUTE_REDIS_PREFIX}${busId}`);       } catch (_) {}
}

/**
 * Pre-warm route graphs for all known buses on server startup.
 * Runs once so the first loop iteration hits in-memory for all buses.
 */
async function preWarmRouteCache() {
  const allBusIds = [
    ...new Set([...Object.values(busMap), ...Object.values(smlBusMap).map((m) => m.busId)])
  ];
  await Promise.allSettled(allBusIds.map((id) => getRouteGraph(normalizeBusId(id))));

  // Also pre-warm institution-specific cache for shared bus handling
  await Promise.allSettled(
    allBusIds.flatMap((id) => {
      const busId = normalizeBusId(id);
      return [
        _fetchRouteForInstitution(busId, "college"),
        _fetchRouteForInstitution(busId, "school"),
      ];
    })
  );
  console.log(`✅ Route graph cache pre-warmed for ${allBusIds.length} buses`);
}

/* ==========================================================================
   ROUTE CACHE  (raw route doc — kept for admin APIs that need the full doc)
   ========================================================================== */
async function getRouteByBus(busId) {
  if (!busId) return null;
  busId = normalizeBusId(busId);

  // ── Layer 1: in-memory ───────────────────────────────────────────────────
  const mem = routeCache[busId];
  if (mem && (Date.now() - mem.fetchedAt) < ROUTE_CACHE_TTL_MS) {
    return mem.data;
  }

  // ── Layer 2: Redis ───────────────────────────────────────────────────────
  try {
    const cached = await redis.get(`${ROUTE_REDIS_PREFIX}${busId}`);
    if (cached && typeof cached === "object") {
      routeCache[busId] = { data: cached, fetchedAt: Date.now() };
      return cached;
    }
  } catch (_) {}

  // ── Layer 3: Firestore ───────────────────────────────────────────────────
  const route = await _fetchRouteFromFirestore(busId);
  if (!route) return mem?.data ?? null;

  routeCache[busId] = { data: route, fetchedAt: Date.now() };
  try {
    await redis.setEx(`${ROUTE_REDIS_PREFIX}${busId}`, ROUTE_CACHE_TTL_SEC, route);
  } catch (_) {}

  // Invalidate graph cache so it rebuilds with fresh data
  delete routeGraphCache[busId];
  try { await redis.del(`${ROUTE_GRAPH_REDIS_PREFIX}${busId}`); } catch (_) {}

  return route;
}

/* ==========================================================================
   ROUTE INFO  (main entry point used by formatBuses / formatSMLBuses)
   Uses the pre-built route graph — no O(n²) merge, no trig on the hot path.
   ========================================================================== */
function getRouteInfo(bus, routeGraph) {
  const EMPTY = { currentCity: "Unknown", nextCity: null,
                  previousCity: null, distanceToNext: null, direction: "Unknown" };
  if (!routeGraph?.merged?.length) return EMPTY;

  const { merged: cities, segments } = routeGraph;
  const busId = bus.busId;
  const speed = bus.speed || 0;

  // ── 1. Find the nearest stop ──────────────────────────────────────────────
  let nearestIndex = 0;
  let minDist      = Infinity;
  for (let i = 0; i < cities.length; i++) {
    const d = calculateDistance(bus.lat, bus.lng, cities[i].lat, cities[i].lng);
    if (d < minDist) { minDist = d; nearestIndex = i; }
  }

  // ── 2. Direction detection (only when bus is moving) ─────────────────────
  if (speed >= 5) {
    const heading = getSmoothedHeading(busId);

    if (heading !== null) {
      const busVec = bearingToVector(heading);
      const seg    = segments[nearestIndex];
      const candidates = [];

      if (seg.fwdBearing !== null)
        candidates.push({ isForward: true,  score: dot(busVec, bearingToVector(seg.fwdBearing)) });
      if (seg.bwdBearing !== null)
        candidates.push({ isForward: false, score: dot(busVec, bearingToVector(seg.bwdBearing)) });

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const best   = candidates[0];
        const second = candidates[1];
        const gap    = second ? (best.score - second.score) : 2;

        if (gap >= DIRECTION_MIN_SCORE_GAP) {
          const prev = busRouteState[busId];

          if (!prev || prev.isForward !== best.isForward) {
            const pending = busRouteState[busId]?._pending;
            if (pending && pending.isForward === best.isForward) {
              pending.count++;
              if (pending.count >= FLIP_CONFIRM_COUNT) {
                // Direction confirmed — commit and persist to Redis
                const confirmed = { isForward: best.isForward };
                busRouteState[busId] = confirmed;
                redis.setEx(`${REDIS_DIR_PREFIX}${busId}`, DIR_TTL_SEC, confirmed)
                     .catch(() => {});
              }
            } else {
              if (!busRouteState[busId]) {
                // First-time: accept immediately and persist
                const init = { isForward: best.isForward };
                busRouteState[busId] = init;
                redis.setEx(`${REDIS_DIR_PREFIX}${busId}`, DIR_TTL_SEC, init)
                     .catch(() => {});
              } else {
                busRouteState[busId]._pending = { isForward: best.isForward, count: 1 };
              }
            }
          } else {
            // Confirmed same direction — clear stale pending
            if (busRouteState[busId]?._pending) {
              delete busRouteState[busId]._pending;
            }
          }
        }
      }

    } else if (!busRouteState[busId]) {
      // No heading yet AND no saved state — use multi-segment scoring as a
      // better seed than raw endpoint distance.
      // Score all segments adjacent to the nearest stop and pick the best.
      // Falls back to endpoint distance only if no segments are available.
      const seg = segments[nearestIndex];
      let seeded = false;

      if (seg && (seg.fwdBearing !== null || seg.bwdBearing !== null)) {
        // Use a rough heading from endpoint distance to score segments
        const dStart = calculateDistance(bus.lat, bus.lng, cities[0].lat, cities[0].lng);
        const dEnd   = calculateDistance(bus.lat, bus.lng,
          cities[cities.length - 1].lat, cities[cities.length - 1].lng);
        // Rough endpoint bearing to use as a proxy when no GPS history exists
        const roughBearing = dEnd < dStart
          ? bearingBetween(bus.lat, bus.lng,
              cities[cities.length - 1].lat, cities[cities.length - 1].lng)
          : bearingBetween(bus.lat, bus.lng,
              cities[0].lat, cities[0].lng);

        if (roughBearing !== null) {
          const roughVec   = bearingToVector(roughBearing);
          const candidates = [];
          if (seg.fwdBearing !== null)
            candidates.push({ isForward: true,  score: dot(roughVec, bearingToVector(seg.fwdBearing)) });
          if (seg.bwdBearing !== null)
            candidates.push({ isForward: false, score: dot(roughVec, bearingToVector(seg.bwdBearing)) });

          if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const init = { isForward: candidates[0].isForward };
            busRouteState[busId] = init;
            redis.setEx(`${REDIS_DIR_PREFIX}${busId}`, DIR_TTL_SEC, init).catch(() => {});
            seeded = true;
          }
        }
      }

      if (!seeded) {
        // Final fallback — pure endpoint distance
        const dStart = calculateDistance(bus.lat, bus.lng, cities[0].lat, cities[0].lng);
        const dEnd   = calculateDistance(bus.lat, bus.lng,
          cities[cities.length - 1].lat, cities[cities.length - 1].lng);
        const init = { isForward: dEnd < dStart };
        busRouteState[busId] = init;
        redis.setEx(`${REDIS_DIR_PREFIX}${busId}`, DIR_TTL_SEC, init).catch(() => {});
      }
    }
  }

  const isForward    = busRouteState[busId]?.isForward ?? true;
  const nextIndex    = isForward ? nearestIndex + 1 : nearestIndex - 1;
  const prevIndex    = isForward ? nearestIndex - 1 : nearestIndex + 1;
  const nextCity     = cities[nextIndex] ?? null;
  const prevCity     = cities[prevIndex] ?? null;

  const distToNext   = nextCity
    ? Number(calculateDistance(bus.lat, bus.lng, nextCity.lat, nextCity.lng).toFixed(2))
    : 0;

  const currentName  = cities[nearestIndex]?.name || null;
  const nextName     = (nextCity && nextCity.name !== currentName) ? nextCity.name : null;
  const start        = cities[0];
  const end          = cities[cities.length - 1];

  if (speed < 5) {
    return {
      currentCity:    currentName || "Unknown",
      nextCity:       nextName,
      previousCity:   prevCity?.name || null,
      distanceToNext: distToNext,
      direction:      "Stopped",
    };
  }

  return {
    currentCity:    currentName || null,
    nextCity:       nextName || currentName || null,
    previousCity:   prevCity?.name || null,
    distanceToNext: distToNext,
    direction: isForward
      ? `${start.name} → ${end.name}`
      : `${end.name} → ${start.name}`,
  };
}

/* =========================
   ROUTE CACHE
   Two-layer: in-memory (fast) + Redis (restart-safe, 10 min TTL).
   On cold start, memory is empty but Redis may still have the route.
   On TTL expiry, both layers refresh from Firestore.
========================= */
const ROUTE_CACHE_TTL_SEC = 10 * 60;         // 10 minutes in seconds
const ROUTE_REDIS_PREFIX  = "route:";

function getBusStatus(bus) {
  const now   = Date.now();
  const busId = bus.busId;

  if (!busState[busId]) busState[busId] = { status: null };
  const prevStatus = busState[busId].status;

  if (isAtCollege(bus.lat, bus.lng)) {
    if (prevStatus !== "At College") addActivity("arrival", `${busId} is at college 🏫`);
    busState[busId].status = "At College";
    return "At College";
  }

  if (bus.lastUpdate) {
    const diff = now - new Date(bus.lastUpdate).getTime();
    if (diff > 60 * 60 * 1000) {
      if (prevStatus !== "Offline") addActivity("offline", `${busId} went offline ❌`);
      busState[busId].status = "Offline";
      return "Offline";
    }
  }

  if (Number(bus.speed) > 0) {
    if (prevStatus !== "Moving") addActivity("running", `${busId} started moving 🚍`);
    busState[busId].status = "Moving";
    return "Moving";
  }

  if (prevStatus !== "Idle") addActivity("idle", `${busId} is idle ⏸️`);
  busState[busId].status = "Idle";
  return "Idle";
}
function getMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function calculateETA(distance, speed) {
  if (!speed || speed < 5) speed = 20;
  const MIN_SPEED = 15;
  const MAX_SPEED = 60;
  speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  const minutes = (distance / speed) * 60;
  return {
    minutes: Math.round(minutes),
    text:
      minutes < 60
        ? `${Math.round(minutes)} min`
        : `${Math.floor(minutes / 60)} hr ${Math.round(minutes % 60)} min`,
  };
}

app.post("/admin/routes", adminAuth, async (req, res) => {
  try {
    let { routeName, busId, cities, status, routeType } = req.body;

    if (!routeName || !busId || !Array.isArray(cities)) {
      return res.status(400).json({
        success: false,
        error: "routeName, busId, cities required",
      });
    }

    // Validate routeType — must be "college" or "school" (case-insensitive).
    // Default to "college" so existing routes created before this change
    // continue to work without any migration.
    const normalizedType = (routeType || "college").toLowerCase();
    if (!["college", "school"].includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        error: 'routeType must be "college" or "school"',
      });
    }

    busId = normalizeBusId(busId);

    const doc = await admin
      .firestore()
      .collection("routes")
      .add({
        routeName,
        busId,
        cities,
        startPoint: cities[0] || null,
        endPoint: cities[cities.length - 1] || null,
        status:    status    || "Active",
        routeType: normalizedType,           // ← new field
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    return res.json({
      success: true,
      id: doc.id,
      busId,
      routeType: normalizedType,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

  app.get("/admin/routes", adminAuth, async (req, res) => {
    try {
      // Server-side institution filtering — never return mixed data
      const inst = resolveInstitutionFilter(req, req.query.institution);
      let query = admin.firestore().collection("routes");
      if (inst) {
        query = query.where("routeType", "==", inst);
      }
      const snap = await query.get();

      const routes = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      return res.json({
        success: true,
        routes,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: e.message,
      });
    }
  });

app.get("/admin/routes/:id", adminAuth, async (req, res) => {
  try {
    const doc = await admin
      .firestore()
      .collection("routes")
      .doc(req.params.id)
      .get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        error: "Route not found",
      });
    }

    return res.json({
      success: true,
      route: {
        id: doc.id,
        ...doc.data(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.put("/admin/routes/:id", adminAuth, async (req, res) => {
  try {
    let { routeName, busId, cities, status, routeType } = req.body;

    busId = normalizeBusId(busId);

    // Preserve existing routeType if not supplied in the update payload.
    // Only validate when the caller explicitly passes a value.
    const updateData = {
      routeName,
      busId,
      cities,
      startPoint: cities?.[0] || null,
      endPoint: cities?.[cities.length - 1] || null,
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (routeType !== undefined) {
      const normalizedType = routeType.toLowerCase();
      if (!["college", "school"].includes(normalizedType)) {
        return res.status(400).json({
          success: false,
          error: 'routeType must be "college" or "school"',
        });
      }
      updateData.routeType = normalizedType;
    }

    await admin
      .firestore()
      .collection("routes")
      .doc(req.params.id)
      .update(updateData);

    // Invalidate both route and graph caches so next loop picks up fresh data
    await invalidateRouteCache(busId);

    return res.json({
      success: true,
      message: "Route Updated",
      busId,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.delete("/admin/routes/:id", adminAuth, async (req, res) => {
  try {
    // Fetch busId before deleting so we can invalidate the route/graph cache.
    const docSnap = await admin.firestore().collection("routes").doc(req.params.id).get();
    const busId   = docSnap.exists ? docSnap.data()?.busId : null;

    await admin.firestore().collection("routes").doc(req.params.id).delete();

    // Invalidate caches — prevents stale route graph being served after delete
    if (busId) await invalidateRouteCache(busId);

    return res.json({
      success: true,
      message: "Route Deleted",
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});
/* =========================
   STUDENT LOCATION API
========================= */
app.post("/student-location", authenticateFirebaseUser, async (req, res) => {
  try {
    const indiaTime = new Date(
      new Date().toLocaleString("en-US", {
        timeZone: "Asia/Kolkata",
      }),
    );

    const currentMinutes = indiaTime.getHours() * 60 + indiaTime.getMinutes();

    const startMinutes = 6 * 60;      // 6:00 AM
    const endMinutes   = 12 * 60;     // 12:00 PM

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
      return res.json({
        success: false,
        message: "Tracking time closed",
      });
    }

    const { studentId, busId, lat, lng, fcmToken, accuracy, deviceTime } = req.body;

    // ── PM2 LOG: Student Location Hit ────────────────────────────────────
    const istStr = indiaTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    console.log("====================================================");
    console.log("📍 STUDENT LOCATION HIT");
    console.log(`  Time       : ${istStr}`);
    console.log(`  Student ID : ${studentId || "N/A"}`);
    console.log(`  Bus ID     : ${busId || "N/A"}`);
    console.log(`  Latitude   : ${lat ?? "N/A"}`);
    console.log(`  Longitude  : ${lng ?? "N/A"}`);
    console.log(`  Accuracy   : ${accuracy ?? "N/A"}`);
    console.log(`  Device Time: ${deviceTime || "N/A"}`);
    console.log(`  IP         : ${clientIp}`);
    console.log("====================================================");

    if (!studentId || !busId || lat == null || lng == null) {
      console.error(`❌ STUDENT LOCATION FAILED | Student: ${studentId || "N/A"} | Reason: Missing fields`);
      return res.status(400).json({ error: "Missing fields" });
    }

    // ── Ownership verification: Firebase UID must match the student document ──
    const collections = ["students", "parents", "faculty"];
    let isOwner = false;
    for (const col of collections) {
      const doc = await admin.firestore().collection(col).doc(studentId).get();
      if (doc.exists) {
        if (doc.data().uid === req.firebaseUid) { isOwner = true; break; }
        // Reverse lookup: UID might match a different doc ID format
        const uidSnap = await admin.firestore().collection(col)
          .where("uid", "==", req.firebaseUid).limit(1).get();
        if (!uidSnap.empty && uidSnap.docs[0].id === studentId) { isOwner = true; break; }
        break; // Doc found but UID doesn't match
      }
    }
    if (!isOwner) {
      console.error(`❌ STUDENT LOCATION FAILED | Student: ${studentId} | Reason: Ownership denied`);
      return res.status(403).json({ error: "Access denied — you can only update your own location" });
    }

    // Validate coordinates (India bounds: lat 6-37, lng 68-98)
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum) || latNum < 6 || latNum > 37 || lngNum < 68 || lngNum > 98) {
      console.error(`❌ STUDENT LOCATION FAILED | Student: ${studentId} | Reason: Invalid coordinates`);
      return res.status(400).json({ error: "Invalid coordinates" });
    }
    // Validate studentId format
    if (typeof studentId !== "string" || studentId.length > 50) {
      console.error(`❌ STUDENT LOCATION FAILED | Student: ${studentId} | Reason: Invalid studentId`);
      return res.status(400).json({ error: "Invalid studentId" });
    }

    // ── Firestore ↔ Redis mismatch check ─────────────────────────────────
    // Verify the incoming studentId/busId matches the Firestore document.
    // Log any mismatch but do NOT reject the request — location tracking
    // must continue even if Firestore is temporarily unavailable.
    try {
      const existingRedis = await redis.get(`student:${studentId}`);

      // Look up the user's Firestore document across all three collections
      const collections = ["students", "parents", "faculty"];
      let firestoreDoc = null;
      let firestoreCol = null;

      for (const col of collections) {
        const snap = await admin.firestore()
          .collection(col)
          .doc(studentId)
          .get();
        if (snap.exists) {
          firestoreDoc = snap.data();
          firestoreCol = col;
          break;
        }
      }

      if (firestoreDoc) {
        // ── Check 1: busId mismatch ──────────────────────────────────────
        const fsBusId = firestoreDoc.busId || "";
        // Normalise both to "BUS-X" format for comparison
        const normFS  = fsBusId.toUpperCase().replace(/\s+/g, "-");
        const normReq = String(busId).toUpperCase().replace(/\s+/g, "-");
        if (normFS !== normReq) {
          console.warn("⚠️  FIREBASE↔REDIS MISMATCH [busId]", {
            studentId,
            firestoreCollection: firestoreCol,
            firestoreBusId: fsBusId,
            requestBusId:   busId,
          });
        }

        // ── Check 2: stale Redis entry (busId changed since last write) ──
        if (existingRedis && existingRedis.busId) {
          const normRedis = String(existingRedis.busId).toUpperCase().replace(/\s+/g, "-");
          if (normRedis !== normReq) {
            console.warn("⚠️  STALE REDIS ENTRY [busId changed]", {
              studentId,
              redisBusId:   existingRedis.busId,
              requestBusId: busId,
              action:       "overwriting with fresh data",
            });
          }
        }
      } else {
        // Document not found by doc ID — may be a uid-keyed doc or deleted user
        console.warn("⚠️  FIREBASE↔REDIS MISMATCH [doc not found]", {
          studentId,
          note: "No Firestore document found with this ID in students/parents/faculty",
        });
      }
    } catch (mismatchErr) {
      // Mismatch check is best-effort — never block location tracking
      console.log("⚠️  Mismatch check error (non-fatal):", mismatchErr.message);
    }

    const payload = {
      studentId,
      busId,
      lat:         Number(lat),
      lng:         Number(lng),
      fcmToken:    fcmToken || null,
      lastUpdated: Date.now(),
    };

    // Write location to Redis with a 6-hour TTL.
    // TTL reasoning: tracking window is 07:00–11:00 (4 h). A 6-hour TTL
    // guarantees the key expires well before the next morning window, so
    // yesterday's GPS fix can never be used for today's boarding or nearby
    // notification checks. Without a TTL the key persists indefinitely and
    // stale coordinates from a previous day would satisfy the distance check.
    await redis.setEx(`student:${studentId}`, 6 * 3600, payload);
    busState[busId] = busState[busId] || {};
    busState[busId].lastSeen = Date.now();

    console.log(`✅ STUDENT LOCATION SAVED | Student: ${studentId}`);

    return res.json({ success: true });
  } catch (e) {
    const failedId = req.body?.studentId || "unknown";
    console.error(`❌ STUDENT LOCATION FAILED | Student: ${failedId} | Reason: ${e.message}`);
    return res.status(500).json({ error: "Server error" });
  }
});

function addActivity(type, message) {
  const last = recentActivities[0];

  // prevent duplicate
  if (last && last.message === message) {
    return;
  }

  recentActivities.unshift({
    type,
    message,
    time: new Date().toISOString(),
  });

  recentActivities = recentActivities.slice(0, 50);
}

/* =========================
   WEBSOCKET
========================= */
const wss = new WebSocket.Server({
  port: 8080,
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 512, // Only compress messages > 512 bytes
  },
});
console.log("🚀 WebSocket running");

// ── Attach ticket room-based WS handler ─────────────────────────────────────
const ticketSocket = require("./src/support/socket");
ticketSocket.attachToWss(wss);

/* =========================
   FETCH API
========================= */
async function fetchAPI(url, key) {
  try {
    const res = await axios.get(url, {
      headers: { "x-api-key": key },
      timeout: 20000,
    });

    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.log("API Error:", err.message);
    return [];
  }
}
async function loginSML() {
  try {
    const res = await axios.post(
      SML_API.loginUrl,
      {
        username: SML_API.username,
        password: SML_API.password,
      },
      { headers: { "Content-Type": "application/json" } },
    );

    SML_API.token = res.data.token;

    // 🔥 MOST IMPORTANT (if API gives expiry)
    if (res.data.expiresIn) {
      SML_API.tokenExpiry = Date.now() + res.data.expiresIn * 1000;
    } else {
      // fallback 50 min assumption
      SML_API.tokenExpiry = Date.now() + 50 * 60 * 1000;
    }

    console.log("✅ SML TOKEN GENERATED");
  } catch (e) {
    console.log("SML LOGIN ERROR:", e.response?.data || e.message);
  }
}

async function fetchSMLData(retry = 0) {
  try {
    // 🔥 CHECK TOKEN BEFORE CALL
    if (
      !SML_API.token ||
      !SML_API.tokenExpiry ||
      Date.now() > SML_API.tokenExpiry
    ) {
      console.log("🔄 TOKEN EXPIRED (refreshing...)");
      await loginSML();
    }

    const res = await axios.get(SML_API.vehicleUrl, {
      headers: {
        Authorization: `Bearer ${SML_API.token}`,
      },
      timeout: 30000,
    });

    return res.data.vehicles || [];
  } catch (err) {
    // token invalid / expired from server side
    if (err.response?.status === 401 && retry < 10) {
      console.log("🔄 401 ERROR → Refreshing token");

      await loginSML();

      return fetchSMLData(retry + 1);
    }

    // retry timeout
    if (err.code === "ECONNABORTED" && retry < 10) {
      console.log(`⏳ Retrying SML API (attempt ${retry + 1})...`);
      return fetchSMLData(retry + 1);
    }

    console.log("SML ERROR:", err.response?.data || err.message);
    return [];
  }
}
// Legacy getAllData — used by admin endpoints that need a one-shot fetch.
// The main loop uses getAllDataWithPriorityEmit() instead for minimum latency.
async function getAllData() {
  const voltyPromise = fetchAPI(API_1.url, API_1.key).then((raw) => ({ source: "volty", raw }));
  const smlPromise   = fetchSMLData().then((raw) => ({ source: "sml", raw }));

  const results = await Promise.allSettled([voltyPromise, smlPromise]);

  let voltyRaw = [];
  let smlRaw   = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.source === "volty") voltyRaw = r.value.raw;
      else smlRaw = r.value.raw;
    }
  }

  const [voltyBuses, smlBuses] = await Promise.all([
    formatBuses(voltyRaw),
    formatSMLBuses(smlRaw),
  ]);

  return [...voltyBuses, ...smlBuses];
}

/**
 * PRIORITY EMIT: Fetch + format + emit with minimal latency.
 * Each API source is processed and emitted independently the INSTANT it
 * returns, without waiting for the other source. This eliminates the
 * "wait for slowest API" bottleneck.
 *
 * Timeline with old architecture:
 *   Voltysoft returns at 5s → waits → SML returns at 15s → format → emit at 15.1s
 *
 * Timeline with new architecture:
 *   Voltysoft returns at 5s → format → emit at 5.1s (partial)
 *   SML returns at 15s → format → emit at 15.1s (merged full)
 */
async function getAllDataWithPriorityEmit() {
  let firstEmitted = false;
  let allBuses = [];

  const voltyPromise = (async () => {
    const T0 = Date.now();
    const raw = await fetchAPI(API_1.url, API_1.key);
    const T1 = Date.now();
    const buses = await formatBuses(raw);
    const T2 = Date.now();
    console.log(`[PRIO] Voltysoft: fetch=${T1-T0}ms format=${T2-T1}ms buses=${buses.length}`);
    return { source: "volty", buses };
  })().catch((e) => {
    console.log(`[PRIO] Voltysoft FAILED: ${e.message}`);
    return { source: "volty", buses: [] };
  });

  const smlPromise = (async () => {
    const T0 = Date.now();
    const raw = await fetchSMLData();
    const T1 = Date.now();
    if (raw.length === 0) {
      console.log(`[PRIO] SML: fetch=${T1-T0}ms — EMPTY RESPONSE (API may be failing)`);
    }
    const buses = await formatSMLBuses(raw);
    const T2 = Date.now();
    console.log(`[PRIO] SML: fetch=${T1-T0}ms format=${T2-T1}ms raw=${raw.length} formatted=${buses.length}`);
    return { source: "sml", buses };
  })().catch((e) => {
    console.log(`[PRIO] SML FAILED: ${e.message}`);
    return { source: "sml", buses: [] };
  });

  // Race: emit whichever API finishes first IMMEDIATELY
  const first = await Promise.race([voltyPromise, smlPromise]);

  // IMMEDIATE EMIT: broadcast the first batch without waiting for the second
  if (first.buses.length > 0) {
    allBuses = mergeBusCache(first.buses);
    latestBuses = allBuses;
    broadcast(allBuses);
    firstEmitted = true;
  }
  const T_first_emit = Date.now();

  // Await the second source (won't throw — errors caught above)
  const second = first.source === "volty" ? await smlPromise : await voltyPromise;

  // MERGED EMIT: combine both sources + stale cache
  const combined = [...first.buses, ...second.buses];
  const T_merge_start = Date.now();
  allBuses = mergeBusCache(combined);
  latestBuses = allBuses;
  const T_merge_done = Date.now();
  if (second.buses.length > 0 || !firstEmitted) {
    broadcast(allBuses);
    if (!firstEmitted) firstEmitted = true;
  }
  const T_broadcast_done = Date.now();
  if (T_broadcast_done - T_merge_start > 10) {
    console.log(`[GPS PERF] priority_emit_merge: merge=${T_merge_done-T_merge_start}ms broadcast=${T_broadcast_done-T_merge_done}ms buses=${allBuses.length}`);
  }

  return { allBuses, firstEmitAt: T_first_emit, firstEmitted };
}

/* =========================
   NORMALIZE
========================= */
function normalize(item) {
  return {
    imei: String(item.imei ?? item.deviceId ?? item.trackerId ?? ""),
    lat: Number(item.lat || item.latitude || item.gps?.lat),
    lng: Number(item.lng || item.lon || item.longitude || item.gps?.lng),
    speed: Number(item.speed || 0),
  };
}

/* =========================
   GPS RELIABILITY ENGINE
   Single source of truth for GPS freshness.
   Flutter displays these values — never calculates them.
========================= */
const GPS_STATE = {
  LIVE:     "LIVE",       // 0–180 sec (0–3 min)
  UPDATING: "UPDATING",   // 181–300 sec (3–5 min)
  OFFLINE:  "OFFLINE",    // >300 sec (>5 min)
};
const GPS_THRESHOLD = {
  LIVE_MAX:     180,  // seconds (0–3 min)
  UPDATING_MAX: 300,  // seconds (3–5 min)
  // OFFLINE: anything above UPDATING_MAX
};

// Track previous state per bus for state-change logging
const _prevGpsState = {};

// Cache IST formatted strings to avoid repeated toLocaleString (expensive)
// Key: parsedMs rounded to 1s → value: formatted IST string
const _istFormatCache = {};
const _IST_CACHE_MAX = 200;
let _istCacheSize = 0;

function _formatIst(parsedMs) {
  // Round to second (avoid cache bloat from ms differences)
  const key = Math.floor(parsedMs / 1000);
  if (_istFormatCache[key]) return _istFormatCache[key];
  const result = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(parsedMs)) + " IST";
  // Evict cache if too large (simple LRU-free eviction)
  if (_istCacheSize >= _IST_CACHE_MAX) {
    const keys = Object.keys(_istFormatCache);
    for (let i = 0; i < 50; i++) delete _istFormatCache[keys[i]];
    _istCacheSize -= 50;
  }
  _istFormatCache[key] = result;
  _istCacheSize++;
  return result;
}

/**
 * Compute GPS reliability metrics for a single bus.
 * Accepts pre-parsed milliseconds to avoid double-parsing timestamps.
 * @param {string} provider - "voltysoft" or "sml"
 * @param {string} busId
 * @param {number} parsedMs - pre-parsed GPS timestamp in ms (NaN if unknown)
 * @param {number} serverNow - Date.now() passed in to avoid repeated calls
 * @returns {{ gpsAgeSeconds, gpsState, lastGpsUpdateUtc, lastGpsUpdateIst }}
 */
function computeGpsReliability(provider, busId, parsedMs, serverNow) {
  // Calculate age
  let gpsAgeSeconds = -1;
  if (Number.isFinite(parsedMs) && parsedMs > 0) {
    gpsAgeSeconds = Math.round((serverNow - parsedMs) / 1000);
    if (gpsAgeSeconds < 0) gpsAgeSeconds = -1;
  }

  // Determine state (3 states only: LIVE, UPDATING, OFFLINE)
  let gpsState;
  if (gpsAgeSeconds < 0) {
    gpsState = GPS_STATE.OFFLINE;
  } else if (gpsAgeSeconds <= GPS_THRESHOLD.LIVE_MAX) {
    gpsState = GPS_STATE.LIVE;
  } else if (gpsAgeSeconds <= GPS_THRESHOLD.UPDATING_MAX) {
    gpsState = GPS_STATE.UPDATING;
  } else {
    gpsState = GPS_STATE.OFFLINE;
  }

  // State change logging (only on transition)
  const prev = _prevGpsState[busId];
  if (prev !== gpsState) {
    if (prev) console.log(`[GPS STATE CHANGE] bus=${busId} ${prev} -> ${gpsState} age=${gpsAgeSeconds}s`);
    _prevGpsState[busId] = gpsState;
  }

  // Format timestamps — always provide IST for display
  let lastGpsUpdateUtc = null;
  let lastGpsUpdateIst = null;
  if (Number.isFinite(parsedMs)) {
    lastGpsUpdateUtc = new Date(parsedMs).toISOString();
    lastGpsUpdateIst = _formatIst(parsedMs);
  }

  // Debug log — only for non-LIVE states (reduces log volume for healthy buses)
  if (gpsState !== GPS_STATE.LIVE) {
    const thresholdRange = gpsState === GPS_STATE.UPDATING ? "181-300" : ">300";
    // Suppressed in production — too noisy for PM2 logs
    // console.log(`[GPS STATE] bus=${busId} age=${gpsAgeSeconds}s state=${gpsState} threshold=${thresholdRange} provider=${provider} gpsTimeIst=${lastGpsUpdateIst}`);
  }

  return { gpsAgeSeconds, gpsState, lastGpsUpdateUtc, lastGpsUpdateIst };
}

/**
 * Detect stale GPS packets. Reuses object to avoid allocation per call.
 */
const _lastGpsPacket = {}; // busId → { lat, lng, speed, time }
function detectStalePacket(provider, busId, lat, lng, speed, rawGpsTime) {
  const prev = _lastGpsPacket[busId];
  if (prev) {
    if (prev.lat === lat && prev.lng === lng && prev.speed === speed && prev.time === rawGpsTime && rawGpsTime) {
      // Suppressed — too noisy
    }
    // Reuse existing object (avoid GC pressure)
    prev.lat = lat; prev.lng = lng; prev.speed = speed; prev.time = rawGpsTime;
  } else {
    _lastGpsPacket[busId] = { lat, lng, speed, time: rawGpsTime };
  }
}

/**
 * Safe SML timestamp parser with overflow guard.
 * Returns milliseconds (number) or null. Does NOT create ISO string.
 */
function parseSmlTimestampMs(lastOnline) {
  if (!lastOnline) return null;
  const raw = Number(lastOnline);
  if (!Number.isFinite(raw) || raw <= 0) {
    console.log(`[SML TIME ERROR] raw=${lastOnline} parsed=NaN`);
    return null;
  }
  const ms = raw > 1e12 ? raw : raw * 1000;
  if (ms > Date.now() + 86400000) {
    console.log(`[SML TIME ERROR] raw=${lastOnline} parsed=${ms} (future — rejected)`);
    return null;
  }
  // Detect IST-as-UTC: if computed age is ~19800s (5.5h), the SML provider
  // likely returns local IST seconds as if they were UTC epoch seconds.
  // Correct by adding the IST offset (19800 seconds = 5.5 hours).
  const ageMs = Date.now() - ms;
  if (ageMs > 18000000 && ageMs < 21600000) { // 5h to 6h range = timezone issue
    console.log(`[SML WARNING] IST-as-UTC detected: raw=${lastOnline} age=${Math.round(ageMs/1000)}s — correcting +19800s`);
    return ms + 19800000;
  }
  return ms;
}

/**
 * Legacy wrapper — returns ISO string for backward compat fields.
 */
function parseSmlTimestamp(lastOnline) {
  const ms = parseSmlTimestampMs(lastOnline);
  return ms ? new Date(ms).toISOString() : null;
}

/* =========================
   PUSH NOTIFICATION
========================= */
async function sendPush(topic, title, body) {
  try {
    await admin.messaging().send({
      topic,
      notification: { title, body },
    });
  } catch (e) {
    console.log("FCM Error:", e.message);
  }
}

function normalizeBusId(busId) {
  return String(busId).trim().toUpperCase().replace(/\s+/g, "-");
}

/* =========================
   FORMAT BUS
========================= */
// Set of unknown IMEIs already logged once — prevents spam
const _unknownImeiLogged = new Set();

async function formatBuses(data) {
  const now = Date.now();

  const results = await Promise.all(
    data.map(async (item) => {
      if (!item) return null;

      const d = normalize(item);

      if (!busMap[d.imei]) {
        if (!_unknownImeiLogged.has(d.imei)) {
          _unknownImeiLogged.add(d.imei);
          console.log("⚠️ Ignoring unknown IMEI (not in busMap):", d.imei);
        }
        return null;
      }

      if (isNaN(d.lat) || isNaN(d.lng)) {
        return null;
      }

      const busId = busMap[d.imei];

      // ── FAST PATH: All cache layers are in-memory after first iteration ──
      // getRouteGraph hits memory cache (O(1) after pre-warm)
      const routeGraph = await getRouteGraph(busId);

      // GPS history restore — only on cold start (guarded by if-check)
      if (!busGpsHistory[busId]) {
        try {
          const saved = await redis.get(`${REDIS_GPS_PREFIX}${busId}`);
          busGpsHistory[busId] = (Array.isArray(saved) && saved.length > 0) ? saved : [];
        } catch (_) {
          busGpsHistory[busId] = [];
        }
      }

      // Direction state restore — only on cold start
      if (!busRouteState[busId]) {
        try {
          const savedDir = await redis.get(`${REDIS_DIR_PREFIX}${busId}`);
          if (savedDir && typeof savedDir === "object" && savedDir.isForward !== undefined) {
            busRouteState[busId] = { isForward: savedDir.isForward };
          }
        } catch (_) {}
      }

      // Update GPS history (sync after cold start — Redis write is fire-and-forget)
      updateBusGpsHistory(busId, d.lat, d.lng);

      const routeInfo = routeGraph
        ? getRouteInfo({ busId, lat: d.lat, lng: d.lng, speed: d.speed }, routeGraph)
        : { currentCity: "Unknown", nextCity: null, previousCity: null,
            distanceToNext: null, direction: "Unknown" };

      lastBusLocationTime[d.imei] = now;

      // ── GPS Reliability Engine (optimized: single parse, shared serverNow) ──
      const rawGpsTime = item.time || null;
      const gpsParsedMs = rawGpsTime ? parseVoltyTime(rawGpsTime) : NaN;
      logBusUpdate(busId, rawGpsTime, gpsParsedMs);
      detectStalePacket("voltysoft", busId, d.lat, d.lng, d.speed, rawGpsTime);
      const gpsReliability = computeGpsReliability("voltysoft", busId, gpsParsedMs, now);

      return {
        busId,
        driver: driverMap[busId] || "N/A",
        route: routeGraph?.routeName || "N/A",
        routeType: routeGraph?.routeType || "college",

        currentCity: routeInfo?.currentCity || null,
        nextCity: routeInfo?.nextCity || null,
        previousCity: routeInfo?.previousCity || null,

        nextCityDistance: routeInfo?.distanceToNext != null
          ? Number(routeInfo.distanceToNext.toFixed(2))
          : null,

        routeDirection: routeInfo?.direction || null,

        imei: d.imei,
        lat: d.lat,
        lng: d.lng,
        speed: d.speed,
        driverMobile: driverMobileMap[busId] || "N/A",

        startTime: busStartTimes[busId]?.time || null,
        todayKm: busDistanceTracker[busId]?.totalKm?.toFixed(2) || "0",
        collegeArrivalTime: busCollegeArrival[busId]?.time || null,

        eta: calculateETA(5, d.speed).text,

        status: getBusStatus({
          busId,
          lat: d.lat,
          lng: d.lng,
          speed: Number(d.speed || 0),
          lastUpdate: rawGpsTime,
        }),

        tripActive: d.speed > 10,

        gpsTime: rawGpsTime,
        lastUpdate: rawGpsTime,
        timestamp: Date.now(),

        // ── GPS Reliability fields (new) ──
        gpsAgeSeconds: gpsReliability.gpsAgeSeconds,
        gpsState: gpsReliability.gpsState,
        lastGpsUpdateUtc: gpsReliability.lastGpsUpdateUtc,
        lastGpsUpdateIst: gpsReliability.lastGpsUpdateIst,
      };
    })
  );

  const filtered = results.filter(Boolean);

  // ── SHARED BUS HANDLING ──────────────────────────────────────────────────
  // When a bus has routes in BOTH institutions, we need to emit a second
  // entry with the other institution's route data so school users see school
  // cities and college users see college cities.
  // Uses Promise.all for parallel lookups — cached hits return synchronously.
  const extras = (await Promise.all(
    filtered.map(async (bus) => {
      if (!bus) return null;
      const currentType = bus.routeType || "college";
      const otherType = currentType === "college" ? "school" : "college";
      // Cached — no Firestore hit on hot path after first call
      const otherRoute = await _fetchRouteForInstitution(bus.busId, otherType);
      if (!otherRoute) return null;
      const otherGraph = buildRouteGraph(otherRoute);
      const otherInfo = getRouteInfo(
        { busId: bus.busId, lat: bus.lat, lng: bus.lng, speed: bus.speed },
        otherGraph
      );
      return {
        ...bus,
        route: otherGraph.routeName || "N/A",
        routeType: otherType,
        currentCity: otherInfo?.currentCity || null,
        nextCity: otherInfo?.nextCity || null,
        previousCity: otherInfo?.previousCity || null,
        nextCityDistance: otherInfo?.distanceToNext != null
          ? Number(otherInfo.distanceToNext.toFixed(2)) : null,
        routeDirection: otherInfo?.direction || null,
      };
    })
  )).filter(Boolean);

  return [...filtered, ...extras];
}

// ── SML Diagnostics State (observation only — no functional impact) ──
const _smlDiag = {
  rawPrinted: {},      // busId → true (print full packet once)
  lastPacket: {},      // busId → { lastOnline, latitude, longitude, speed, gpsSignal }
  packetsReceived: 0,
  packetsChanged: 0,
  timestampChanged: 0,
  locationChanged: 0,
  speedChanged: 0,
  ages: [],            // all computed ages for averaging
};

// Print summary every 60 seconds
setInterval(() => {
  if (_smlDiag.packetsReceived === 0) return;
  const ages = _smlDiag.ages;
  const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : -1;
  const minAge = ages.length > 0 ? Math.min(...ages) : -1;
  const maxAge = ages.length > 0 ? Math.max(...ages) : -1;
  console.log(`\n[SML SUMMARY] received=${_smlDiag.packetsReceived} changed=${_smlDiag.packetsChanged} tsChanged=${_smlDiag.timestampChanged} locChanged=${_smlDiag.locationChanged} speedChanged=${_smlDiag.speedChanged} avgAge=${avgAge}s minAge=${minAge}s maxAge=${maxAge}s\n`);
  // Reset counters for next interval
  _smlDiag.packetsReceived = 0;
  _smlDiag.packetsChanged = 0;
  _smlDiag.timestampChanged = 0;
  _smlDiag.locationChanged = 0;
  _smlDiag.speedChanged = 0;
  _smlDiag.ages = [];
}, 60000);

async function formatSMLBuses(data) {
  const now = Date.now();

  // ── SML DIAGNOSTICS (no functional changes — observing only) ──────────
  _smlDiag.packetsReceived += data.length;
  for (const item of data) {
    const map = smlBusMap[item?.chassisNumber];
    if (!map) continue;
    const busId = map.busId;

    // Print full raw packet ONCE per bus (after server start)
    if (!_smlDiag.rawPrinted[busId]) {
      _smlDiag.rawPrinted[busId] = true;
      console.log(`\n==================== RAW SML PACKET [${busId}] ====================`);
      console.log(JSON.stringify(item, null, 2));
      console.log(`====================================================================\n`);
    }

    // Compare with previous packet
    const prev = _smlDiag.lastPacket[busId];
    const curr = {
      lastOnline: item.lastOnline,
      latitude: item.latitude,
      longitude: item.longitude,
      speed: item.speed,
      gpsSignal: item.gpsSignal,
    };

    if (prev) {
      const changes = [];
      if (prev.lastOnline !== curr.lastOnline) changes.push({ field: "lastOnline", old: prev.lastOnline, new: curr.lastOnline });
      if (prev.latitude !== curr.latitude) changes.push({ field: "latitude", old: prev.latitude, new: curr.latitude });
      if (prev.longitude !== curr.longitude) changes.push({ field: "longitude", old: prev.longitude, new: curr.longitude });
      if (prev.speed !== curr.speed) changes.push({ field: "speed", old: prev.speed, new: curr.speed });
      if (prev.gpsSignal !== curr.gpsSignal) changes.push({ field: "gpsSignal", old: prev.gpsSignal, new: curr.gpsSignal });

      if (changes.length > 0) {
        _smlDiag.packetsChanged++;
        const hasTimestampChange = changes.some(c => c.field === "lastOnline");
        const hasLocationChange = changes.some(c => c.field === "latitude" || c.field === "longitude");
        const hasSpeedChange = changes.some(c => c.field === "speed");
        if (hasTimestampChange) _smlDiag.timestampChanged++;
        if (hasLocationChange) _smlDiag.locationChanged++;
        if (hasSpeedChange) _smlDiag.speedChanged++;

        console.log(`[SML CHANGE] bus=${busId} fields=${changes.map(c=>c.field).join(",")}`);
        for (const c of changes) console.log(`  ${c.field}: ${c.old} → ${c.new}`);

        // Timestamp analysis ONLY when lastOnline changes
        if (hasTimestampChange) {
          const rawVal = curr.lastOnline;
          const asNum = Number(rawVal);
          const ms = asNum > 1e12 ? asNum : asNum * 1000;
          const diffSec = Math.round((now - ms) / 1000);
          _smlDiag.ages.push(diffSec);
          console.log(`[SML TIMESTAMP] bus=${busId} raw=${rawVal} type=${typeof rawVal} ms=${ms} iso=${new Date(ms).toISOString()} serverUtc=${new Date(now).toISOString()} serverIst=${new Date(now).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} age=${diffSec}s (${(diffSec/60).toFixed(1)}min)`);
        }
      }
    } else {
      // First packet for this bus — do initial timestamp analysis
      const rawVal = curr.lastOnline;
      const asNum = Number(rawVal);
      if (Number.isFinite(asNum) && asNum > 0) {
        const ms = asNum > 1e12 ? asNum : asNum * 1000;
        const diffSec = Math.round((now - ms) / 1000);
        _smlDiag.ages.push(diffSec);
        console.log(`[SML TIMESTAMP] bus=${busId} raw=${rawVal} type=${typeof rawVal} ms=${ms} iso=${new Date(ms).toISOString()} serverUtc=${new Date(now).toISOString()} serverIst=${new Date(now).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} age=${diffSec}s (${(diffSec/60).toFixed(1)}min) [INITIAL]`);
      }
    }

    _smlDiag.lastPacket[busId] = curr;
  }
  // ── END SML DIAGNOSTICS ───────────────────────────────────────────────

  const results = await Promise.all(
    data.map(async (item) => {
      const map = smlBusMap[item.chassisNumber];
      if (!map) return null;

      const busId = map.busId;
      const imei = map.imei;

      const smlLat = Number(item.latitude);
      const smlLng = Number(item.longitude);

      if (!Number.isFinite(smlLat) || !Number.isFinite(smlLng)) {
        return null;
      }

      const routeGraph = await getRouteGraph(busId);

      // ── Restore GPS history from Redis on cold start ─────────────────────
      if (!busGpsHistory[busId]) {
        try {
          const saved = await redis.get(`${REDIS_GPS_PREFIX}${busId}`);
          if (Array.isArray(saved) && saved.length > 0) {
            busGpsHistory[busId] = saved;
          } else {
            busGpsHistory[busId] = [];
          }
        } catch (_) {
          busGpsHistory[busId] = [];
        }
      }

      // Restore direction state from Redis on cold start (async, done once)
      if (!busRouteState[busId]) {
        try {
          const savedDir = await redis.get(`${REDIS_DIR_PREFIX}${busId}`);
          if (savedDir && typeof savedDir === "object" && savedDir.isForward !== undefined) {
            busRouteState[busId] = { isForward: savedDir.isForward };
          }
        } catch (_) {}
      }

      // Record GPS history for bearing-based direction detection (fire-and-forget)
      updateBusGpsHistory(busId, smlLat, smlLng);

      const routeInfo = routeGraph
        ? getRouteInfo({
            busId,
            lat:   smlLat,
            lng:   smlLng,
            speed: Number(item.speed || 0),
          }, routeGraph)
        : null;
 lastBusLocationTime[imei] = now;

        const gpsParsedMs = parseSmlTimestampMs(item.lastOnline);
        const gpsTime = gpsParsedMs ? new Date(gpsParsedMs).toISOString() : null;

        // ── SML Diagnostic: log timestamp pipeline ──
        if (!gpsParsedMs || (gpsParsedMs && Math.abs(now - gpsParsedMs) > 300000)) {
          console.log(`[SML TIME] bus=${busId} raw=${item.lastOnline} type=${typeof item.lastOnline} parsedMs=${gpsParsedMs} gpsTime=${gpsTime} serverNow=${now} age=${gpsParsedMs ? Math.round((now - gpsParsedMs)/1000) : 'null'}s speed=${item.speed}`);
        }

        // If SML provides no valid timestamp but we ARE receiving coordinates,
        // the packet is live — use server receipt time as fallback.
        const effectiveGpsMs = gpsParsedMs || now;

logBusUpdate(busId, gpsTime, effectiveGpsMs);

      // ── GPS Reliability Engine (optimized: pre-parsed ms, shared serverNow) ──
      detectStalePacket("sml", busId, Number(item.latitude), Number(item.longitude), Number(item.speed || 0), gpsTime);
      const gpsReliability = computeGpsReliability("sml", busId, effectiveGpsMs, now);

      return {
        busId,
        driver: driverMap[busId] || "N/A",
        route: routeGraph?.routeName || "N/A",
        routeType: routeGraph?.routeType || "college",

        currentCity: routeInfo?.currentCity || null,
        nextCity: routeInfo?.nextCity || null,
        previousCity: routeInfo?.previousCity || null,

        nextCityDistance: routeInfo?.distanceToNext
          ? Number(routeInfo.distanceToNext.toFixed(2))
          : null,

        routeDirection: routeInfo?.direction || null,

        imei,
        driverMobile: driverMobileMap[busId] || "N/A",

        startTime: busStartTimes[busId]?.time || null,

        lat: Number(item.latitude),
        lng: Number(item.longitude),
        speed: Number(item.speed || 0),

        gpsSignal: Number(item.gpsSignal || 0),

        eta: calculateETA(5, Number(item.speed || 0)).text,

        todayKm: busDistanceTracker[busId]?.totalKm?.toFixed(2) || "0",
        collegeArrivalTime: busCollegeArrival[busId]?.time || null,

        status: getBusStatus({
          busId,
          lat: Number(item.latitude),
          lng: Number(item.longitude),
          speed: Number(item.speed || 0),
          lastUpdate: gpsTime,
        }),

        tripActive: Number(item.speed) > 5,

        lastUpdate: gpsTime,
        timestamp: Date.now(),

        // ── GPS Reliability fields (new) ──
        gpsAgeSeconds: gpsReliability.gpsAgeSeconds,
        gpsState: gpsReliability.gpsState,
        lastGpsUpdateUtc: gpsReliability.lastGpsUpdateUtc,
        lastGpsUpdateIst: gpsReliability.lastGpsUpdateIst,
      };
    })
  );

  const filtered = results.filter(Boolean);

  // ── SHARED BUS HANDLING (same as formatBuses) ────────────────────────────
  const extras = (await Promise.all(
    filtered.map(async (bus) => {
      if (!bus) return null;
      const currentType = bus.routeType || "college";
      const otherType = currentType === "college" ? "school" : "college";
      const otherRoute = await _fetchRouteForInstitution(bus.busId, otherType);
      if (!otherRoute) return null;
      const otherGraph = buildRouteGraph(otherRoute);
      const otherInfo = getRouteInfo(
        { busId: bus.busId, lat: bus.lat, lng: bus.lng, speed: bus.speed },
        otherGraph
      );
      return {
        ...bus,
        route: otherGraph.routeName || "N/A",
        routeType: otherType,
        currentCity: otherInfo?.currentCity || null,
        nextCity: otherInfo?.nextCity || null,
        previousCity: otherInfo?.previousCity || null,
        nextCityDistance: otherInfo?.distanceToNext != null
          ? Number(otherInfo.distanceToNext.toFixed(2)) : null,
        routeDirection: otherInfo?.direction || null,
      };
    })
  )).filter(Boolean);

  return [...filtered, ...extras];
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180; 
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

async function trackBusDistance(bus) {
  try {
    const today = new Date().toISOString().split("T")[0];

    if (!busDistanceTracker[bus.busId]) {
      busDistanceTracker[bus.busId] = {
        lastLat: bus.lat,
        lastLng: bus.lng,
        lastTime: Date.now(),
        totalKm: 0,
        date: today,
      };
      return;
    }

    const tracker = busDistanceTracker[bus.busId];

    // ── Daily reset: save previous day's total to Firestore ──────────────
    if (tracker.date !== today) {
      await admin
        .firestore()
        .collection("bus_km_history")
        .doc(`${bus.busId}_${tracker.date}`)
        .set({
          busId: bus.busId,
          route: latestBuses.find((b) => b.busId === bus.busId)?.route || "N/A",
          date: tracker.date,
          monthKey: getMonthKey(),
          totalKm: Number(tracker.totalKm.toFixed(2)),
          createdAt: new Date().toISOString(),
        });

      busDistanceTracker[bus.busId] = {
        lastLat: bus.lat,
        lastLng: bus.lng,
        lastTime: Date.now(),
        totalKm: 0,
        date: today,
      };
      return;
    }

    // ── Calculate distance between consecutive GPS points ─────────────────
    const distance = calculateDistance(
      tracker.lastLat,
      tracker.lastLng,
      bus.lat,
      bus.lng,
    );

    // ── Speed-based validation ───────────────────────────────────────────
    // Instead of a fixed distance threshold (which discards valid highway
    // movement), validate using implied speed between the two points.
    // Accept: implied speed ≤ 120 km/h (reasonable for a bus)
    // Reject: implied speed > 120 km/h (GPS teleport / noise)
    // Also reject: distance < 0.005 km (5 meters — GPS jitter when stopped)
    const now = Date.now();
    const elapsedSec = (now - (tracker.lastTime || now)) / 1000;
    const impliedSpeedKmh = elapsedSec > 0 ? (distance / elapsedSec) * 3600 : 0;

    const MIN_DISTANCE_KM = 0.005;  // 5 meters — ignore GPS jitter
    const MAX_SPEED_KMH   = 120;    // max plausible bus speed

    if (distance >= MIN_DISTANCE_KM && impliedSpeedKmh <= MAX_SPEED_KMH) {
      // Valid movement — accumulate KM
      tracker.totalKm += distance;
      // Only update reference point when point is ACCEPTED
      tracker.lastLat  = bus.lat;
      tracker.lastLng  = bus.lng;
      tracker.lastTime = now;
    } else if (distance < MIN_DISTANCE_KM) {
      // GPS jitter (< 5m) — update reference point but don't count distance
      tracker.lastLat  = bus.lat;
      tracker.lastLng  = bus.lng;
      tracker.lastTime = now;
    }
    // else: GPS teleport (> 120 km/h implied) — discard point entirely,
    // DON'T update lastLat/lastLng so next valid point is measured from
    // the last known good position (preserves accumulated distance).

  } catch (e) {
    console.log("KM TRACK ERROR:", e.message);
  }
}

async function handleBus(bus, students) {
  const today  = new Date().toISOString().split("T")[0];
  const busId  = bus.busId;

  // ── Daily reset: college arrival tracking ─────────────────────────────────
  if (busCollegeArrival[busId]?.date !== today) {
    delete busCollegeArrival[busId];
  }
  if (isAtCollege(bus.lat, bus.lng) && !busCollegeArrival[busId]) {
    busCollegeArrival[busId] = { time: new Date().toISOString(), date: today };
    addActivity("arrival", `🏫 ${busId} arrived at college`);
  }

  // ── Restore in-memory state from Redis on cold start ──────────────────────
  // This prevents false "trip started" notifications after a server restart
  // because busState is empty and every active bus would fire a start event.
  if (!busState[busId]) {
    const savedState = await redis.get(`busState:${busId}`);
    busState[busId] = (savedState && typeof savedState === "object")
      ? savedState
      : { tripActive: bus.tripActive }; // Seed with current value to avoid false trigger
  }

  if (!busStartTimes[busId]) {
    const saved = await redis.get(`busStart:${busId}`);
    if (saved && typeof saved === "object") busStartTimes[busId] = saved;
  }

  const prev = busState[busId];

  // ── Bus trip started ───────────────────────────────────────────────────────
  // Only fires when state transitions false→true AND we have not already sent
  // a notification for this bus today (checked in Redis, restart-safe).
  if (prev.tripActive !== true && bus.tripActive === true) {

    // Record start time once per day
    if (!busStartTimes[busId] || busStartTimes[busId].date !== today) {
      const startRecord = { time: new Date().toISOString(), date: today };
      busStartTimes[busId] = startRecord;
      await redis.setEx(`busStart:${busId}`, 86400, startRecord);
    }

    addActivity("start", `🚌 ${busId} started trip`);

    // Redis dedup key — survives restarts, expires after START_COOLDOWN_SEC
    const dedupeKey = `notif:start:${busId}:${today}`;
    const alreadySent = await redis.get(dedupeKey);

    if (!alreadySent) {
      // Set BEFORE sending — prevents duplicate if loop fires again during send
      await redis.setEx(dedupeKey, START_COOLDOWN_SEC, "1");

      const busUsers = students.filter((s) => s.busId === busId && s.fcmToken);
      let sent = 0;
      for (const u of busUsers) {
        try {
          await admin.messaging().send({
            token: u.fcmToken,
            notification: {
              title: "🚌 Bus Started",
              body:  `${busId} has started its trip. Be ready!`,
            },
            data: { type: "bus_started", busId },
            android: { priority: "high", notification: { channelId: "bus_channel" } },
          });
          sent++;
        } catch (e) {
          // Expired / invalid token — prune it
          if (e.code === "messaging/registration-token-not-registered" || e.code === "messaging/invalid-registration-token") {
            _pruneInvalidToken(u.fcmToken, u.studentId, "students");
          }
          console.log(`FCM start skip (${u.studentId}): ${e.message}`);
        }
      }
      console.log(`🟢 Start notifications sent for ${busId} → ${sent} users`);
    }
  }

  // ── Persist current tripActive to Redis so restart knows the last state ───
  const newState = { ...prev, tripActive: bus.tripActive };
  busState[busId] = newState;
  // Only write to Redis when state actually changed to avoid hammering it
  if (prev.tripActive !== bus.tripActive) {
    await redis.setEx(`busState:${busId}`, 86400, newState);
  }

  // ── Nearby notifications: per-user, fully Redis-deduped ──────────────────
  // Fire whenever the bus is moving (speed >= 5) regardless of tripActive flag,
  // because tripActive may not be set yet on very early GPS fixes.
  if (bus.speed >= 5) {
    const busUsers = students.filter((s) => {
      if (!s.fcmToken) return false;
      // Normalise stored busId to "BUS-X" format before comparing
      const storedBus = String(s.busId || "").trim().toUpperCase().replace(/\s+/g, "-");
      const liveBus   = String(busId     || "").trim().toUpperCase().replace(/\s+/g, "-");
      return storedBus === liveBus;
    });

    if (busUsers.length > 0) {
      // ── BATCH: Pre-fetch all student locations concurrently ──────────────
      const userLocs = await Promise.all(
        busUsers.map((u) => u.studentId ? getStudentLocation(u.studentId) : null)
      );

      for (let i = 0; i < busUsers.length; i++) {
        const user = busUsers[i];
        if (!user.fcmToken || !user.studentId) continue;

        const loc = userLocs[i];
        if (!loc?.lat || !loc?.lng) continue;

      if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lng) ||
          !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;

      const dist = calculateDistance(bus.lat, bus.lng, loc.lat, loc.lng);
      if (!Number.isFinite(dist)) continue;

      const nearbyKey = `notif:nearby:${user.studentId}:${busId}:${today}`;

      if (dist > 8) {
        // Bus moved away — delete dedup flag so it can fire again next approach.
        // redis.del is a no-op when the key doesn't exist, so no extra exists() check.
        await redis.del(nearbyKey);
        continue;
      }

      if (dist <= 5 && dist > 0.1) {
        const alreadySent = await redis.get(nearbyKey);
        if (!alreadySent) {
          // Set BEFORE sending to prevent race-condition duplicates
          await redis.setEx(nearbyKey, 4 * 3600, "1"); // TTL 4h resets daily

          try {
            await admin.messaging().send({
              token: user.fcmToken,
              notification: {
                title: "🚌 Bus is Nearby!",
                body:  `${busId} is within 5 km — get ready to board.`,
              },
              data: {
                type:      "bus_nearby",
                busId,
                studentId: user.studentId,
                distance:  dist.toFixed(1),
              },
              android: { priority: "high", notification: { channelId: "bus_channel" } },
            });
            console.log(`✅ Nearby → ${user.studentId} (${dist.toFixed(1)} km)`);
          } catch (e) {
            if (e.code === "messaging/registration-token-not-registered" || e.code === "messaging/invalid-registration-token") {
              _pruneInvalidToken(user.fcmToken, user.studentId, "students");
            }
            console.log(`❌ FCM nearby skip (${user.studentId}): ${e.message}`);
          }
        }
      }
    }
    } // close if (busUsers.length > 0)
  }
}
/* =========================
   USERS CACHE — Firestore onSnapshot Incremental Listeners
   Replaces polling with realtime listeners for 99.97% Firestore read reduction.
========================= */
let studentCache = [];
let _snapshotListenersAttached = false;
const _studentMap = new Map();
const _parentMap  = new Map();
const _facultyMap = new Map();

function _rebuildStudentCache() {
  studentCache = [..._studentMap.values(), ..._parentMap.values(), ..._facultyMap.values()];
}

function _extractFields(doc, idField) {
  const d = doc.data();
  return {
    [idField]: doc.id, uid: d.uid || "", institution: d.institution || "college",
    busId: d.busId || "", fcmToken: d.fcmToken || "", role: d.role || "",
    name: d.name || "", mobile: d.mobile || "", studentType: d.studentType || "",
    course: d.course || "", branch: d.branch || "", city: d.city || "",
    year: d.year || d.academicYear || "", academicYear: d.academicYear || d.year || "",
    email: d.email || "",
  };
}

function _attachSnapshotListeners() {
  if (_snapshotListenersAttached) return;
  _snapshotListenersAttached = true;
  admin.firestore().collection("students").onSnapshot((snap) => {
    snap.docChanges().forEach((c) => { c.type === "removed" ? _studentMap.delete(c.doc.id) : _studentMap.set(c.doc.id, _extractFields(c.doc, "studentId")); });
    _rebuildStudentCache();
  }, (err) => { console.log("[CACHE] Students listener error:", err.message); _snapshotListenersAttached = false; });
  admin.firestore().collection("parents").onSnapshot((snap) => {
    snap.docChanges().forEach((c) => { c.type === "removed" ? _parentMap.delete(c.doc.id) : _parentMap.set(c.doc.id, _extractFields(c.doc, "studentId")); });
    _rebuildStudentCache();
  }, (err) => { console.log("[CACHE] Parents listener error:", err.message); });
  admin.firestore().collection("faculty").onSnapshot((snap) => {
    snap.docChanges().forEach((c) => { c.type === "removed" ? _facultyMap.delete(c.doc.id) : _facultyMap.set(c.doc.id, _extractFields(c.doc, "studentId")); });
    _rebuildStudentCache();
  }, (err) => { console.log("[CACHE] Faculty listener error:", err.message); });
  console.log("[CACHE] Firestore onSnapshot listeners attached");
}

async function getStudentsCached() {
  if (!_snapshotListenersAttached) {
    _attachSnapshotListeners();
    await new Promise((r) => setTimeout(r, 2000)); // Wait for initial snapshot
  }
  return studentCache;
}
/* =========================
   BROADCAST — Institution-Filtered
   Each WebSocket client declares its institution on first message.
   Broadcasts only send buses matching that client's institution.
   Clients that don't declare an institution receive ALL buses (backward compat).
========================= */
function broadcast(data) {
  const T0 = Date.now();

  // Pre-filter by institution once (single pass)
  let collegeBuses, schoolBuses;
  if (data.length <= 20) {
    // Small array — direct filter is fine
    collegeBuses = data.filter(b => (b.routeType || "college") === "college");
    schoolBuses = data.filter(b => (b.routeType || "college") === "school");
  } else {
    // Larger array — single pass partition
    collegeBuses = [];
    schoolBuses = [];
    for (let i = 0; i < data.length; i++) {
      const rt = data[i].routeType || "college";
      if (rt === "college") collegeBuses.push(data[i]);
      else schoolBuses.push(data[i]);
    }
  }

  // Lazy JSON serialization — only create payloads that have recipients
  let collegePayload = null;
  let schoolPayload = null;
  let allPayload = null;
  let collegeClients = 0, schoolClients = 0, allClients = 0, skippedClients = 0;

  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    const inst = client._institution;
    if (inst === "college") collegeClients++;
    else if (inst === "school") schoolClients++;
    else if (inst === "all") allClients++;  // superadmin
    else skippedClients++; // No institution declared → receives NOTHING
  });

  // Only serialize what's needed
  if (collegeClients > 0 && collegeBuses.length) collegePayload = JSON.stringify({ type: "update", data: collegeBuses });
  if (schoolClients > 0 && schoolBuses.length) schoolPayload = JSON.stringify({ type: "update", data: schoolBuses });
  if (allClients > 0 && data.length) allPayload = JSON.stringify({ type: "update", data });

  const T_serial = Date.now();

  // Send — ONLY to clients with a declared institution. No fallback.
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    try {
      const inst = client._institution;
      if (inst === "college" && collegePayload) client.send(collegePayload);
      else if (inst === "school" && schoolPayload) client.send(schoolPayload);
      else if (inst === "all" && allPayload) client.send(allPayload);
      // else: no institution → intentionally skip (zero data leak)
    } catch (_) {}
  });

  const T_send = Date.now();
  const payloadKB = ((collegePayload?.length || 0) + (schoolPayload?.length || 0) + (allPayload?.length || 0)) / 1024;
  console.log(`[GPS PERF] broadcast: serial=${T_serial-T0}ms send=${T_send-T_serial}ms total=${T_send-T0}ms payload=${payloadKB.toFixed(1)}KB college=${collegeClients} school=${schoolClients} all=${allClients} skipped=${skippedClients}`);
}
// Retains the last known data for every bus ever seen. When a GPS source
// fails intermittently (SML API timeout), buses don't vanish from broadcasts.
// A bus is only removed from the cache after 5 minutes of absence.
const _lastKnownBuses = {}; // busId → { data, lastSeen: timestamp }
const _BUS_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Merge fresh bus data with the last-known cache.
 * - Fresh buses update the cache.
 * - Stale buses (not in fresh data but in cache) are kept with a "stale" flag
 *   until they exceed the timeout.
 * Returns the merged array (fresh + recently-stale).
 */
function mergeBusCache(freshBuses) {
  const T0 = Date.now();
  const now = T0;
  const freshIds = new Set();

  // Update cache with fresh data
  for (const bus of freshBuses) {
    if (!bus || !bus.busId) continue;
    freshIds.add(bus.busId);
    _lastKnownBuses[bus.busId] = { data: bus, lastSeen: now };
  }

  // Build merged list: fresh + recently-stale
  const merged = [...freshBuses];
  for (const [busId, entry] of Object.entries(_lastKnownBuses)) {
    if (freshIds.has(busId)) continue;
    const age = now - entry.lastSeen;
    if (age > _BUS_STALE_TIMEOUT_MS) {
      delete _lastKnownBuses[busId];
      continue;
    }
    merged.push({
      ...entry.data,
      speed: 0,
      tripActive: false,
      status: "Offline",
      gpsState: GPS_STATE.OFFLINE,
      gpsAgeSeconds: Math.round(age / 1000),
      _stale: true,
    });
  }

  const T1 = Date.now();
  if (T1 - T0 > 5) console.log(`[GPS PERF] mergeBusCache: ${T1-T0}ms fresh=${freshBuses.length} merged=${merged.length}`);
  return merged;
}

/* =========================
   LATENCY INSTRUMENTATION
   Logs a structured timing report every loop iteration so each stage's
   delay contribution can be measured and compared over time.
========================= */

/**
 * Compute average GPS age from a bus list.
 * gpsTime is the timestamp string from the provider (item.time).
 * Returns null if no valid timestamps are present.
 */
function _computeAvgGpsAge(buses) {
  const now = Date.now();
  const ages = buses
    .map((b) => {
      if (!b.gpsTime) return null;
      const t = new Date(b.gpsTime).getTime();
      return Number.isFinite(t) ? now - t : null;
    })
    .filter((a) => a !== null && a > 0);
  if (!ages.length) return null;
  return Math.round(ages.reduce((s, a) => s + a, 0) / ages.length);
}

/* =========================
   MAIN LOOP — PRIORITY EMIT ARCHITECTURE
   ─────────────────────────────────────────────────────────────────────────
   Key design principles:
   1. NEVER wait for both APIs before emitting — emit the first result immediately
   2. NEVER let offline/stale buses delay active bus broadcasts
   3. Side-effects (attendance, notifications) are ALWAYS fire-and-forget
   4. Loop restarts immediately after emit — no artificial 2s delay
   5. The isFetching guard prevents overlapping API calls (not overlapping emits)

   Timeline (old):
     T+0s: start loop → T+15s: both APIs done → T+15.1s: emit → T+17.1s: next loop
     Result: 15s between updates minimum, 17s between loop starts

   Timeline (new):
     T+0s: start loop → T+5s: Voltysoft done → T+5.05s: EMIT → T+15s: SML done → T+15.05s: EMIT
     → T+15.1s: next loop starts immediately (0ms delay, not 2s)
     Result: Active buses emitted as soon as their GPS provider responds
========================= */
let isFetching = false;
const LOOP_INTERVAL_MS = 100; // Minimal gap — isFetching guard prevents overlap

async function loop() {
  if (isFetching) return;
  isFetching = true;

  const T_loop_start = Date.now();

  try {
    // ── PRIORITY EMIT: each API emits independently ───────────────────────
    const { allBuses, firstEmitAt, firstEmitted } = await getAllDataWithPriorityEmit();
    const T_all_done = Date.now();

    // ── Latency report ────────────────────────────────────────────────────
    const firstEmitMs = firstEmitted ? (firstEmitAt - T_loop_start) : 0;
    const totalMs     = T_all_done - T_loop_start;
    const avgGpsAgeMs = _computeAvgGpsAge(allBuses);
    const gpsAgeLabel = avgGpsAgeMs != null
      ? `${(avgGpsAgeMs / 1000).toFixed(1)}s`
      : "unknown";

    console.log(
      `[LAT] first_emit: ${(firstEmitMs / 1000).toFixed(1)}s | ` +
      `total: ${(totalMs / 1000).toFixed(1)}s | ` +
      `gps_age: ${gpsAgeLabel} | buses: ${allBuses.length} | ` +
      `ist_cache: ${_istCacheSize}`
    );

    // ── Side-effects: concurrent, non-blocking ────────────────────────────
    const sideEffectStart = Date.now();
    getStudentsCached()
      .then((students) =>
        Promise.all(
          allBuses.map((bus) =>
            Promise.all([
              handleBus(bus, students).catch((e) =>
                console.log(`[ERR] handleBus ${bus.busId}: ${e.message}`)),
              handleAttendance(bus, students).catch((e) =>
                console.log(`[ERR] handleAttendance ${bus.busId}: ${e.message}`)),
              trackBusDistance(bus).catch((e) =>
                console.log(`[ERR] trackBusDistance ${bus.busId}: ${e.message}`)),
            ])
          )
        ).then(() => {
          const sideMs = Date.now() - sideEffectStart;
          if (sideMs > 3000) {
            console.log(`[LAT] side-effects: ${sideMs}ms`);
          }
        })
      )
      .catch((e) => console.log("[ERR] side-effect chain:", e.message));

  } catch (e) {
    console.log("[ERR] loop:", e.message);
  } finally {
    isFetching = false;
  }

  // Start next loop immediately with minimal delay
  // The GPS providers take 10-15s to respond anyway, so there's no CPU
  // spinning risk — the event loop is idle during await.
  setTimeout(loop, LOOP_INTERVAL_MS);
}

loop();

/* =========================
   GPS HEALTH MONITOR — prints one summary every 60 seconds
   No API changes. No Flutter changes. Backend monitoring only.
========================= */
// Counters are derived from latestBuses state at report time (zero-overhead)

setInterval(() => {
  const mem = process.memoryUsage();
  const buses = latestBuses || [];
  const totalBuses = buses.length;

  // Count states
  let live = 0, updating = 0, offline = 0, unknownState = 0;
  let totalAge = 0, ageCount = 0;
  let duplicates = 0, invalidTs = 0;

  for (const bus of buses) {
    switch (bus.gpsState) {
      case "LIVE": live++; break;
      case "UPDATING": updating++; break;
      case "OFFLINE": offline++; break;
      default: unknownState++; break;
    }
    if (typeof bus.gpsAgeSeconds === "number" && bus.gpsAgeSeconds >= 0) {
      totalAge += bus.gpsAgeSeconds;
      ageCount++;
    }
    if (bus.gpsAgeSeconds === -1) invalidTs++;
    if (bus._stale) duplicates++;
  }

  const avgAge = ageCount > 0 ? Math.round(totalAge / ageCount) : -1;
  const wsClients = typeof wss !== "undefined" ? wss.clients.size : 0;

  // Redis latency (quick ping)
  const redisStart = Date.now();
  const redisLatency = redisReady ? "ok" : "disconnected";

  console.log(
    `[GPS HEALTH] ` +
    `buses=${totalBuses} | ` +
    `LIVE=${live} UPDATING=${updating} OFFLINE=${offline} | ` +
    `avgAge=${avgAge}s | ` +
    `invalidTs=${invalidTs} staleCached=${duplicates} | ` +
    `ws=${wsClients} | ` +
    `mem=${Math.round(mem.heapUsed / 1048576)}MB/${Math.round(mem.rss / 1048576)}MB | ` +
    `redis=${redisLatency}`
  );

  // Warnings
  if (avgAge > 120) {
    console.log(`[GPS WARNING] Average GPS age ${avgAge}s > 120s threshold`);
  }
  if (offline > 5) {
    console.log(`[GPS WARNING] ${offline} buses OFFLINE (>5 threshold)`);
  }
  if (duplicates > 3) {
    console.log(`[GPS WARNING] ${duplicates} stale-cached buses in broadcast`);
  }
  if (invalidTs > 2) {
    console.log(`[GPS WARNING] ${invalidTs} buses with invalid timestamps`);
  }
  if (totalBuses === 0) {
    console.log(`[GPS WARNING] No buses in latestBuses — possible provider failure`);
  }
  if (wsClients === 0) {
    console.log(`[GPS WARNING] No WebSocket clients connected`);
  }
}, 60000); // Every 60 seconds

/* =========================
   WS CONNECTION
========================= */

/* =========================
   WS CONNECTION
========================= */
wss.on("connection", (ws, req) => {
  // ── WebSocket Authentication (optional token in query string) ────────────
  // Mobile apps send: wss://domain/ws?token=<firebase_id_token>
  // If no token provided, allow connection (backward compat) but mark as unauthenticated
  ws._authenticated = false;
  ws._firebaseUid = null;
  ws._isAdmin = false;
  const url = new URL(req.url, "http://localhost");
  const wsToken = url.searchParams.get("token");
  if (wsToken) {
    try {
      // Accept admin JWT
      const decoded = jwt.verify(wsToken, process.env.JWT_SECRET);
      if (decoded.admin) { ws._authenticated = true; ws._isAdmin = true; }
      else if (decoded.uid) { ws._authenticated = true; ws._firebaseUid = decoded.uid; }
    } catch (_) {
      // Not a JWT — try Firebase ID token (verified async)
      admin.auth().verifyIdToken(wsToken).then((decoded) => {
        ws._authenticated = true;
        ws._firebaseUid = decoded.uid;
      }).catch(() => {});
    }
  }

  console.log("🟢 Client Connected (auth:", ws._authenticated, ")");

  ws.isAlive = true;
  ws._institution = null;

  // heartbeat response
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Handle incoming messages (institution declaration)
  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      // Client declares its institution: { type: "join", institution: "school"|"college"|"all" }
      if (parsed.type === "join" && parsed.institution) {
        const declared = parsed.institution.toLowerCase();
        if (["college", "school", "all"].includes(declared)) {
          ws._institution = declared;
          console.log(`🏷️ Client joined institution: ${ws._institution}`);
          // Send filtered init payload
          let filtered;
          if (declared === "all") {
            filtered = latestBuses; // superadmin sees everything
          } else {
            filtered = latestBuses.filter(b => (b.routeType || "college") === declared);
          }
          if (filtered.length > 0) {
            ws.send(JSON.stringify({ type: "init", data: filtered }));
          }
        }
      }
    } catch (_) {}
  });

  // ── NO bus data sent on connect — wait for client to send "join" first ──
  // This prevents cross-institution data leaks.

  ws.send(
    JSON.stringify({
      type: "connected",
    }),
  );

  // heartbeat check
  const interval = setInterval(() => {
    if (ws.isAlive === false) {
      console.log("⚠️ No pong received");

      clearInterval(interval);

      ws.close();

      return;
    }

    ws.isAlive = false;

    ws.ping();
  }, 30000);
  // cleanup
  ws.on("close", (code, reason) => {
    ws.isAlive = false;
    console.log("❌ Client Disconnected", code, reason.toString());

    clearInterval(interval);
  });

  ws.on("error", (err) => {
    console.log("WS Error:", err.message);
    clearInterval(interval);

    ws.terminate();
  });
});

app.get("/admin/attendance-history", adminAuth, async (req, res) => {
  try {
    const months = Number(req.query.months || 6);

    const fromDate = new Date();

    fromDate.setMonth(fromDate.getMonth() - months);

    const snap = await admin
      .firestore()
      .collection("attendance")
      .where("boardingTime", ">=", fromDate)
      .orderBy("boardingTime", "desc")
      .get();

    const data = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({
      success: true,
      total: data.length,
      data,
    });
  } catch (e) {
    console.log(e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

app.get("/admin/attendance", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    const today = new Date().toISOString().split("T")[0];
    const date = req.query.date || today;
    const busId = req.query.busId;

    let query = admin.firestore().collection("attendance");
    if (date) query = query.where("date", "==", date);
    if (busId) query = query.where("busId", "==", busId);

    const snap = await query.get();
    let data = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Filter by institution if not superadmin
    if (inst) {
      // Get student IDs for this institution
      const studentsSnap = await admin.firestore().collection("students")
        .where("institution", "==", inst).get();
      const instStudentIds = new Set(studentsSnap.docs.map(d => d.id));
      data = data.filter(a => instStudentIds.has(a.studentId));
    }

    const busWise = {};
    data.forEach((item) => {
      if (item.present) busWise[item.busId] = (busWise[item.busId] || 0) + 1;
    });

    return res.json({ success: true, total: data.length, busWise, data });
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/admin/attendance-month", adminAuth, async (req, res) => {
  try {
    const monthKey = req.query.monthKey || getMonthKey();

    const snap = await admin
      .firestore()
      .collection("attendance")
      .where("monthKey", "==", monthKey)
      .get();

    const data = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const grouped = {};

    data.forEach((item) => {
      if (!grouped[item.day]) {
        grouped[item.day] = [];
      }

      grouped[item.day].push(item);
    });

    return res.json({
      success: true,
      monthKey,
      grouped,
    });
  } catch (e) {
    console.log(e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

// ── Update bus driver/route info → Firebase buses/{busId} ─────────────────
app.put("/admin/bus/:busId", adminAuth, async (req, res) => {
  try {
    const { busId } = req.params;
    const { driverName, driverMobile, route } = req.body;

    if (!busId) {
      return res.status(400).json({ success: false, error: "busId required" });
    }

    const update = {};
    if (driverName  !== undefined) update.driverName   = driverName;
    if (driverMobile !== undefined) update.driverMobile = driverMobile;
    if (route        !== undefined) update.route        = route;

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: "No fields to update" });
    }

    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await admin.firestore()
      .collection("buses")
      .doc(busId)
      .set(update, { merge: true });

    return res.json({ success: true, busId, updated: update });
  } catch (e) {
    console.log("BUS UPDATE ERROR:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/admin/bus-km-history", adminAuth, async (req, res) => {
  try {
    let query = admin.firestore().collection("bus_km_history");

    if (req.query.monthKey) {
      query = query.where("monthKey", "==", req.query.monthKey);
    } else {
      const days = Number(req.query.days || 7);

      query = query.orderBy("date", "desc").limit(days * 20);
    }

    const snap = await query.get();

    const data = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({
      success: true,
      data,
    });
  } catch (e) {
    console.log(e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

app.get("/admin/date-report", adminAuth, async (req, res) => {
  try {
    const date = req.query.date;

    if (!date) {
      return res.status(400).json({
        error: "Date required",
      });
    }

    // attendance
    const attendanceSnap = await admin
      .firestore()
      .collection("attendance")
      .where("date", "==", date)
      .get();

    // km
    const kmSnap = await admin
      .firestore()
      .collection("bus_km_history")
      .where("date", "==", date)
      .get();

    const attendance = {};
    const kmData = {};

    attendanceSnap.forEach((doc) => {
      const d = doc.data();

      if (d.present === true) {
        attendance[d.busId] = (attendance[d.busId] || 0) + 1;
      }
    });

    kmSnap.forEach((doc) => {
      const d = doc.data();

      kmData[d.busId] = d.totalKm;
    });

    return res.json({
      success: true,
      date,
      attendance,
      kmData,
    });
  } catch (e) {
    console.log(e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

app.get("/admin/dashboard", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);

    // ── Short-lived Redis cache (15s) to avoid repeated full scans ──────────
    const dashCacheKey = `dash:${inst || "all"}`;
    if (redisReady) {
      const cached = await redis.get(dashCacheKey);
      if (cached && typeof cached === "object") {
        return res.json(cached);
      }
    }

    const today = new Date().toISOString().split("T")[0];

    // Students filtered by institution
    let studentsQuery = admin.firestore().collection("students");
    if (inst) studentsQuery = studentsQuery.where("institution", "==", inst);
    const studentsSnap = await studentsQuery.get();

    // Faculty filtered by institution
    let facultyQuery = admin.firestore().collection("faculty");
    if (inst) facultyQuery = facultyQuery.where("institution", "==", inst);
    const facultySnap = await facultyQuery.get();

    // Parents filtered by institution
    let parentsQuery = admin.firestore().collection("parents");
    if (inst) parentsQuery = parentsQuery.where("institution", "==", inst);
    const parentsSnap = await parentsQuery.get();

    const totalUsers = studentsSnap.size + facultySnap.size + parentsSnap.size;

    // Attendance for today
    const attendanceSnap = await admin.firestore().collection("attendance")
      .where("date", "==", today).get();

    // Filter attendance by institution's students
    const studentIds = new Set(studentsSnap.docs.map(d => d.id));
    const instAttendance = attendanceSnap.docs.filter(d => studentIds.has(d.data().studentId));

    const presentCount = instAttendance.filter(d => d.data().present === true).length;

    let onboarded = 0, present = 0;
    studentsSnap.forEach((doc) => {
      const d = doc.data();
      if (d.liveStatus?.onboarded && !d.liveStatus?.present) onboarded++;
      if (d.liveStatus?.present) present++;
    });

    const totalStudents = studentsSnap.size;
    const absentToday = totalStudents - presentCount;

    const busWiseAttendance = {};
    instAttendance.forEach((doc) => {
      const d = doc.data();
      if (d.busId && d.present === true) {
        busWiseAttendance[d.busId] = (busWiseAttendance[d.busId] || 0) + 1;
      }
    });

    const busWiseUsers = {};
    studentsSnap.forEach((doc) => {
      const d = doc.data();
      if (d.busId) busWiseUsers[d.busId] = (busWiseUsers[d.busId] || 0) + 1;
    });
    facultySnap.forEach((doc) => {
      const d = doc.data();
      if (d.busId) busWiseUsers[d.busId] = (busWiseUsers[d.busId] || 0) + 1;
    });

    // Filter buses by institution (only buses that have routes for this institution)
    const filteredBuses = inst
      ? latestBuses.filter(b => (b.routeType || "college") === inst)
      : latestBuses;

    const dashResponse = {
      totalUsers,
      totalStudents,
      presentToday: presentCount,
      absentToday,
      activeBuses: filteredBuses.length,
      onboarded,
      presentLive: present,
      buses: filteredBuses,
      busWiseUsers,
      busWiseAttendance,
      activities: recentActivities,
    };

    // Cache for 15 seconds (transparent to frontend)
    if (redisReady) {
      redis.setEx(dashCacheKey, 15, dashResponse).catch(() => {});
    }

    return res.json(dashResponse);
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: "Dashboard error" });
  }
});

app.get("/test-students", adminAuth, async (req, res) => {
  try {
    const studentsData = await getStudentsCached();

    return res.json({
      count: studentsData.length,
      studentsData,
    });
  } catch (e) {
    console.log(e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

app.post("/admin/send-notification", adminAuth, async (req, res) => {
  try {
    const { busId, title, message } = req.body;

    if (!busId || !title || !message) {
      return res.status(400).json({
        error: "Missing fields",
      });
    }

    // Institution isolation: only send to students of admin's own institution
    const inst = resolveInstitutionFilter(req);
    let query = admin.firestore().collection("students").where("busId", "==", busId);
    if (inst) query = query.where("institution", "==", inst);
    const snap = await query.get();

    const students = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const tokens = students.map((s) => s.fcmToken).filter(Boolean);

    if (!tokens.length) {
      return res.json({
        success: false,
        message: "No FCM tokens found",
      });
    }

    // send notification
    const response = await admin.messaging().sendEachForMulticast({
      tokens,

      notification: {
        title,
        body: message,
      },

      data: {
        type: "admin_notification",
        busId,
      },
    });

    console.log("✅ Notification sent:", response.successCount);

    return res.json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount,
      message: `Notification sent to ${response.successCount} users`,
    });
  } catch (e) {
    console.log("NOTIFICATION ERROR:", e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

/* =========================
   ROUTE CLONE / IMPORT
   POST /admin/routes/clone
   Body: { routeId, targetRouteType }
   
   Clones a route from one institution to another.
   - routeId: the source route document ID
   - targetRouteType: "college" | "school" (the destination)
   Returns the new route's ID.
========================= */
app.post("/admin/routes/clone", adminAuth, async (req, res) => {
  try {
    const { routeId, targetRouteType } = req.body;

    if (!routeId || !targetRouteType) {
      return res.status(400).json({ error: "routeId and targetRouteType required" });
    }
    if (!["college", "school"].includes(targetRouteType.toLowerCase())) {
      return res.status(400).json({ error: 'targetRouteType must be "college" or "school"' });
    }

    // Fetch source route
    const sourceDoc = await admin.firestore().collection("routes").doc(routeId).get();
    if (!sourceDoc.exists) {
      return res.status(404).json({ error: "Source route not found" });
    }

    const sourceData = sourceDoc.data();

    // Clone with new routeType and append "(Imported)" to name
    const cloneData = {
      routeName: (sourceData.routeName || "") + " (Imported)",
      busId: sourceData.busId || "",
      cities: sourceData.cities || [],
      startPoint: sourceData.startPoint || null,
      endPoint: sourceData.endPoint || null,
      status: sourceData.status || "Active",
      routeType: targetRouteType.toLowerCase(),
      sourceRouteId: routeId, // reference to original
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const newDoc = await admin.firestore().collection("routes").add(cloneData);

    return res.json({
      success: true,
      message: `Route cloned to ${targetRouteType}`,
      newRouteId: newDoc.id,
      routeName: cloneData.routeName,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   BUS-TARGETED NOTIFICATION
   POST /admin/send-notification-bus
   Body: { busId (optional), title, message, institution, audienceType }
   
   audienceType: "ALL" | "BUS"
   - ALL: send to all users of the institution
   - BUS: send only to users assigned to specific busId
========================= */
app.post("/admin/send-notification-bus", adminAuth, async (req, res) => {
  try {
    const { busId, title, message, institution, audienceType } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: "title and message required" });
    }

    // RBAC: regular admin forced to their institution
    let inst;
    if (req.adminRole === "superadmin") {
      inst = (institution || "all").toLowerCase();
    } else {
      inst = req.adminInstitution;
    }

    const audience = (audienceType || "ALL").toUpperCase();

    // Build queries based on audience type
    let allDocs = [];

    if (audience === "BUS" && busId) {
      // Send only to users with matching busId
      const normalizedBus = busId.startsWith("BUS-") ? busId : `BUS-${busId}`;
      
      const queries = ["students", "parents", "faculty"].map(col => {
        let q = admin.firestore().collection(col).where("busId", "==", normalizedBus);
        if (inst !== "all") q = q.where("institution", "==", inst);
        return q.get();
      });

      const [s, p, f] = await Promise.all(queries);
      allDocs = [...s.docs.map(d => d.data()), ...p.docs.map(d => d.data()), ...f.docs.map(d => d.data())];
    } else {
      // Send to ALL users of the institution
      if (inst === "all") {
        const [s, p, f] = await Promise.all([
          admin.firestore().collection("students").get(),
          admin.firestore().collection("parents").get(),
          admin.firestore().collection("faculty").get(),
        ]);
        allDocs = [...s.docs.map(d => d.data()), ...p.docs.map(d => d.data()), ...f.docs.map(d => d.data())];
      } else {
        const [s, p, f] = await Promise.all([
          admin.firestore().collection("students").where("institution", "==", inst).get(),
          admin.firestore().collection("parents").where("institution", "==", inst).get(),
          admin.firestore().collection("faculty").where("institution", "==", inst).get(),
        ]);
        allDocs = [...s.docs.map(d => d.data()), ...p.docs.map(d => d.data()), ...f.docs.map(d => d.data())];
      }
    }

    const tokens = allDocs.map(u => u.fcmToken).filter(t => t && t.length > 10);

    if (!tokens.length) {
      return res.json({ success: false, message: "No FCM tokens found", totalUsers: allDocs.length });
    }

    // Send in batches of 500
    let totalSuccess = 0, totalFail = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const response = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: { title, body: message },
        data: { type: "admin_notification", institution: inst, busId: busId || "", audienceType: audience },
      });
      totalSuccess += response.successCount;
      totalFail += response.failureCount;
    }

    // Save to history
    await admin.firestore().collection("admin_notifications").add({
      institution: inst,
      busId: busId || null,
      audienceType: audience,
      title, message,
      sentTo: tokens.length,
      successCount: totalSuccess,
      failureCount: totalFail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      audienceType: audience,
      busId: busId || "all",
      institution: inst,
      totalUsers: allDocs.length,
      tokensSent: tokens.length,
      successCount: totalSuccess,
      failureCount: totalFail,
    });
  } catch (e) {
    console.log("❌ BUS NOTIFICATION ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   NOTIFICATION HISTORY
   GET /admin/notifications-history?institution=college|school
========================= */
app.get("/admin/notifications-history", adminAuth, async (req, res) => {
  try {
    let inst = resolveInstitutionFilter(req, req.query.institution);
    let query = admin.firestore().collection("admin_notifications").orderBy("createdAt", "desc").limit(50);
    if (inst) query = query.where("institution", "==", inst);
    const snap = await query.get();
    const notifications = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, notifications });
  } catch (e) {
    // Fallback: if compound index missing, fetch all and filter in memory
    try {
      const snap = await admin.firestore().collection("admin_notifications").orderBy("createdAt", "desc").limit(50).get();
      const inst = resolveInstitutionFilter(req, req.query.institution);
      const notifications = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(n => !inst || n.institution === inst);
      return res.json({ success: true, notifications });
    } catch (e2) {
      return res.status(500).json({ error: e2.message });
    }
  }
});

/* =========================
   INSTITUTION-FILTERED NOTIFICATION (RBAC-aware)
   ─────────────────────────────────
   POST /admin/send-notification-institution
   Body: { institution: "college"|"school"|"all", title, message }
   
   - Regular admin: MUST match their JWT institution (body.institution ignored if different)
   - Super admin: can send to "college", "school", or "all"
   
   Strict filtering — no cross-delivery between college and school.
========================= */
app.post("/admin/send-notification-institution", adminAuth, async (req, res) => {
  try {
    const { institution, title, message } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: "Missing fields: title, message" });
    }

    // RBAC enforcement: regular admin can only send to their own institution
    let targetInst;
    if (req.adminRole === "superadmin") {
      // Superadmin can send to "college", "school", or "all"
      targetInst = (institution || "all").toLowerCase();
      if (!["college", "school", "all"].includes(targetInst)) {
        return res.status(400).json({ error: 'institution must be "college", "school", or "all"' });
      }
    } else {
      // Regular admin: forced to their JWT institution regardless of body
      targetInst = req.adminInstitution;
      if (!["college", "school"].includes(targetInst)) {
        return res.status(403).json({ error: "Invalid admin institution" });
      }
    }

    // Query collections — if "all", get everything; else filter
    let studentsSnap, parentsSnap, facultySnap;
    if (targetInst === "all") {
      [studentsSnap, parentsSnap, facultySnap] = await Promise.all([
        admin.firestore().collection("students").get(),
        admin.firestore().collection("parents").get(),
        admin.firestore().collection("faculty").get(),
      ]);
    } else {
      [studentsSnap, parentsSnap, facultySnap] = await Promise.all([
        admin.firestore().collection("students").where("institution", "==", targetInst).get(),
        admin.firestore().collection("parents").where("institution", "==", targetInst).get(),
        admin.firestore().collection("faculty").where("institution", "==", targetInst).get(),
      ]);
    }

    const inst = targetInst; // for backward compat with rest of function

    const allDocs = [
      ...studentsSnap.docs.map(d => d.data()),
      ...parentsSnap.docs.map(d => d.data()),
      ...facultySnap.docs.map(d => d.data()),
    ];

    const tokens = allDocs
      .map(u => u.fcmToken)
      .filter(t => t && t.length > 10); // filter empty/invalid tokens

    if (!tokens.length) {
      return res.json({
        success: false,
        message: `No FCM tokens found for institution=${inst}`,
        totalUsers: allDocs.length,
      });
    }

    // Send in batches of 500 (FCM multicast limit)
    let totalSuccess = 0;
    let totalFail = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const response = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: { title, body: message },
        data: {
          type: "admin_notification",
          institution: inst,
        },
      });
      totalSuccess += response.successCount;
      totalFail    += response.failureCount;
    }

    // Save notification to Firestore for history
    await admin.firestore().collection("admin_notifications").add({
      institution: inst,
      title,
      message,
      sentTo: tokens.length,
      successCount: totalSuccess,
      failureCount: totalFail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Institution notification [${inst}]: ${totalSuccess} sent, ${totalFail} failed`);

    return res.json({
      success: true,
      institution: inst,
      totalUsers: allDocs.length,
      tokensSent: tokens.length,
      successCount: totalSuccess,
      failureCount: totalFail,
    });
  } catch (e) {
    console.log("❌ INSTITUTION NOTIFICATION ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   ADMIN USERS API — INSTITUTION FILTERED (RBAC-aware)
   GET /admin/users-by-institution?institution=college|school
   - Regular admin: forced to their JWT institution
   - Super admin: can query any or all
========================= */
app.get("/admin/users-by-institution", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);

    // If inst is null (superadmin requesting all) → return everything
    if (!inst) {
      const [studentsSnap, parentsSnap, facultySnap] = await Promise.all([
        admin.firestore().collection("students").get(),
        admin.firestore().collection("parents").get(),
        admin.firestore().collection("faculty").get(),
      ]);
      const students = studentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const parents  = parentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const faculty  = facultySnap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, institution: "all", students, parents, faculty,
        counts: { students: students.length, parents: parents.length, faculty: faculty.length, total: students.length + parents.length + faculty.length } });
    }

    // Regular admin: filtered query
    if (!["college", "school"].includes(inst)) {
      return res.status(400).json({ error: 'institution must be "college" or "school"' });
    }

    const [studentsSnap, parentsSnap, facultySnap] = await Promise.all([
      admin.firestore().collection("students")
        .where("institution", "==", inst).get(),
      admin.firestore().collection("parents")
        .where("institution", "==", inst).get(),
      admin.firestore().collection("faculty")
        .where("institution", "==", inst).get(),
    ]);

    const students = studentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const parents  = parentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const faculty  = facultySnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      success: true,
      institution: inst,
      students,
      parents,
      faculty,
      counts: {
        students: students.length,
        parents: parents.length,
        faculty: faculty.length,
        total: students.length + parents.length + faculty.length,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   ADMIN ATTENDANCE — INSTITUTION FILTERED
   GET /admin/attendance-by-institution?institution=college|school&date=YYYY-MM-DD
========================= */
app.get("/admin/attendance-by-institution", adminAuth, async (req, res) => {
  try {
    const inst = (req.query.institution || "").toLowerCase();
    const date = req.query.date || new Date().toISOString().split("T")[0];

    if (!["college", "school"].includes(inst)) {
      return res.status(400).json({ error: 'institution required' });
    }

    // Get students for this institution to know which attendance docs are relevant
    const studentsSnap = await admin.firestore().collection("students")
      .where("institution", "==", inst).get();
    const studentIds = studentsSnap.docs.map(d => d.id);

    // Get attendance docs for today matching these students
    const attendanceSnap = await admin.firestore().collection("attendance")
      .where("date", "==", date).get();

    const records = attendanceSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(a => studentIds.includes(a.studentId));

    return res.json({
      success: true,
      institution: inst,
      date,
      totalStudents: studentIds.length,
      attendanceRecords: records.length,
      boarded: records.filter(r => r.present !== undefined).length,
      present: records.filter(r => r.present === true).length,
      exited:  records.filter(r => r.exited === true).length,
      records,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   ADMIN ROUTES — INSTITUTION FILTERED
   GET /admin/routes-by-institution?institution=college|school
========================= */
app.get("/admin/routes-by-institution", adminAuth, async (req, res) => {
  try {
    const inst = (req.query.institution || "").toLowerCase();
    if (!["college", "school"].includes(inst)) {
      return res.status(400).json({ error: 'institution required' });
    }

    const snap = await admin.firestore().collection("routes")
      .where("routeType", "==", inst)
      .where("status", "==", "Active")
      .get();

    const routes = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      success: true,
      institution: inst,
      routes,
      count: routes.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------------------------
// COMPLETE USER CLEANUP � removes ALL related resources
// ------------------------------------------------------------------------------
async function cleanupUser(collectionName, docId) {
  const log = (msg) => console.log(`[CLEANUP ${docId}] ${msg}`);
  const results = { doc: false, storage: false, busTokens: false, redis: false, attendance: false };

  try {
    // 1. Read user data before deletion
    const userDocRef = admin.firestore().collection(collectionName).doc(docId);
    const userSnap = await userDocRef.get();
    if (!userSnap.exists) { log("Document not found � skipping"); return results; }
    const data = userSnap.data();
    const uid = data.uid || "";
    const fcmToken = data.fcmToken || null;
    const busId = data.busId || null;
    const passPhotoPath = data.passPhotoPath || null;

    // 2. Delete Firebase Storage photo
    if (passPhotoPath) {
      try {
        const bucket = admin.storage().bucket("scep-bus.firebasestorage.app");
        await bucket.file(passPhotoPath).delete();
        results.storage = true;
        log("Storage photo deleted: " + passPhotoPath);
      } catch (e) { log("Storage delete skipped (may not exist): " + e.message); }
    } else if (uid) {
      // Try default path even if passPhotoPath not stored
      try {
        const bucket = admin.storage().bucket("scep-bus.firebasestorage.app");
        await bucket.file(`bus-pass-photos/${uid}/profile.jpg`).delete();
        results.storage = true;
        log("Storage photo deleted (default path)");
      } catch (_) { log("No storage photo found"); }
    }

    // 3. Remove FCM token from bus_tokens
    if (fcmToken && busId) {
      try {
        await admin.firestore().collection("bus_tokens").doc(busId).update({
          tokens: admin.firestore.FieldValue.arrayRemove(fcmToken),
        });
        results.busTokens = true;
        log("FCM token removed from bus_tokens/" + busId);
      } catch (_) { log("bus_tokens cleanup skipped"); }
    }

    // 4. Delete Redis location key
    try {
      await redis.del(`student:${docId}`);
      results.redis = true;
      log("Redis key deleted");
    } catch (_) { log("Redis cleanup skipped"); }

    // 5. Delete attendance records for this student
    try {
      const attSnap = await admin.firestore().collection("attendance")
        .where("studentId", "==", docId).get();
      if (!attSnap.empty) {
        const batch = admin.firestore().batch();
        attSnap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        results.attendance = true;
        log(`Deleted ${attSnap.size} attendance records`);
      }
    } catch (_) { log("Attendance cleanup skipped"); }

    // 6. Delete the user document itself (LAST)
    await userDocRef.delete();
    results.doc = true;
    log("User document deleted");

    log("? Cleanup complete");
    return results;
  } catch (e) {
    log("? Cleanup error: " + e.message);
    throw e;
  }
}
app.delete("/admin/delete-user/:type/:id", adminAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const validCollections = ["student", "parent", "faculty"];
    if (!validCollections.includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid user type" });
    }
    const collectionName = type === "student" ? "students" : type === "parent" ? "parents" : "faculty";
    // Complete cleanup: document + storage + tokens + redis + attendance
    await cleanupUser(collectionName, id);
    return res.json({ success: true, message: "User and all related data deleted" });
  } catch (e) {
    console.log("DELETE USER ERROR:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/debug/redis", adminAuth, async (req, res) => {
  try {
    const keys = [];
    let cursor = "0";

    do {
      const result = await redis.scan(cursor, "student:*", 100);

      cursor = result.cursor || "0";
      const foundKeys = result.keys || [];

      keys.push(...foundKeys);
    } while (cursor !== "0");

    const data = await Promise.all(keys.map((k) => redis.get(k)));

    return res.json({ keys, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    // Server-side institution filtering via RBAC
    const inst = resolveInstitutionFilter(req, req.query.institution);

    let studentsQuery = admin.firestore().collection("students");
    let parentsQuery = admin.firestore().collection("parents");
    let facultyQuery = admin.firestore().collection("faculty");

    if (inst) {
      studentsQuery = studentsQuery.where("institution", "==", inst);
      parentsQuery = parentsQuery.where("institution", "==", inst);
      facultyQuery = facultyQuery.where("institution", "==", inst);
    }

    const [studentsSnap, parentsSnap, facultySnap] = await Promise.all([
      studentsQuery.get(),
      parentsQuery.get(),
      facultyQuery.get(),
    ]);

    // =========================
    // CONVERT TO ARRAY
    // =========================

    const students = studentsSnap.docs.map((doc) => ({
      id: doc.id,
      userType: "student",
      ...doc.data(),
    }));

    const parents = parentsSnap.docs.map((doc) => ({
      id: doc.id,
      userType: "parent",
      ...doc.data(),
    }));

    const faculty = facultySnap.docs.map((doc) => ({
      id: doc.id,
      userType: "faculty",
      ...doc.data(),
    }));

    // =========================
    // MERGE USERS
    // =========================

    const allUsers = [...students, ...parents, ...faculty];

    // =========================
    // ANALYTICS OBJECTS
    // =========================

    const branchWise = {};
    const yearWise = {};
    const classWise = {};
    const busWise = {};
    const facultyTypeWise = {};
    const studentTypeWise = {};

    // =========================
    // PROCESS USERS
    // =========================

    allUsers.forEach((user) => {
      // ===== BUS =====
      if (user.busId) {
        busWise[user.busId] = (busWise[user.busId] || 0) + 1;
      }

      // ===== BRANCH =====
      if (user.branch) {
        branchWise[user.branch] = (branchWise[user.branch] || 0) + 1;
      }

      // ===== YEAR =====
      if (user.year) {
        yearWise[user.year] = (yearWise[user.year] || 0) + 1;
      }

      // ===== CLASS =====
      if (user.class) {
        classWise[user.class] = (classWise[user.class] || 0) + 1;
      }

      // ===== FACULTY TYPE =====
      if (user.facultyType) {
        facultyTypeWise[user.facultyType] =
          (facultyTypeWise[user.facultyType] || 0) + 1;
      }

      // ===== STUDENT TYPE =====
      if (user.studentType) {
        studentTypeWise[user.studentType] =
          (studentTypeWise[user.studentType] || 0) + 1;
      }
    });

    // =========================
    // RESPONSE
    // =========================

    return res.json({
      // totals
      totalStudents: students.length,
      totalParents: parents.length,
      totalFaculty: faculty.length,
      totalUsers: allUsers.length,

      // analytics
      branchWise,
      yearWise,
      classWise,
      busWise,
      facultyTypeWise,
      studentTypeWise,

      // full data
      students,
      parents,
      faculty,
      allUsers,
    });
  } catch (e) {
    console.log("ADMIN USERS API ERROR:", e);

    return res.status(500).json({
      error: e.message,
    });
  }
});

app.get("/trip-status", async (req, res) => {
  try {
    const { busId } = req.query;

    if (!busId) {
      return res.status(400).json({
        success: false,
        error: "busId required",
      });
    }

    const bus = latestBuses.find((b) => b.busId === busId);

    if (!bus) {
      return res.status(404).json({
        success: false,
        error: "Bus not found",
      });
    }

    return res.json({
      success: true,
      busId,
      tripActive: bus.tripActive || false,
      status: bus.status || "Unknown",
      speed: bus.speed || 0,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.post("/complaint", authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId, role, complaint } = req.body;

    if (!userId || !role || !complaint) {
      return res.status(400).json({ success: false, error: "userId, role, and complaint required" });
    }

    // ── Ownership verification: Firebase UID must match the user document ──
    const collections = { student: "students", parent: "parents", faculty: "faculty" };
    const col = collections[role];
    if (!col) return res.status(400).json({ success: false, error: "Invalid role" });

    const snap = await admin.firestore().collection(col).doc(userId).get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const userDoc = snap.data();

    // Verify authenticated user owns this document
    const docUid = userDoc.uid || "";
    if (docUid !== req.firebaseUid) {
      const uidSnap = await admin.firestore().collection(col)
        .where("uid", "==", req.firebaseUid).limit(1).get();
      if (uidSnap.empty || uidSnap.docs[0].id !== userId) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
    }

    // Sanitize complaint text
    const cleanComplaint = sanitize(complaint);

    await admin.firestore().collection("complaints").add({
      userId,
      role,
      institution: userDoc.institution || "college",
      name: userDoc.name || "",
      email: userDoc.email || "",
      mobile: userDoc.mobile || "",
      busId: userDoc.busId || "",
      branch: userDoc.branch || "",
      course: userDoc.course || "",
      year: userDoc.year || "",
      class: userDoc.class || "",
      studentType: userDoc.studentType || "",
      facultyType: userDoc.facultyType || "",
      complaint: cleanComplaint,
      status: "pending",
      createdAt: new Date(),
    });

    res.json({ success: true, message: "Complaint submitted" });
  } catch (e) {
    console.log("COMPLAINT ERROR:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/debug/students", adminAuth, async (req, res) => {
  const snap = await admin.firestore().collection("students").get();

  const data = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  res.json(data);
});
app.get("/admin/complaint", adminAuth, async (req, res) => {
  try {
    // Server-side institution filtering
    const inst = resolveInstitutionFilter(req, req.query.institution);
    let query = admin.firestore().collection("complaints").orderBy("createdAt", "desc");
    if (inst) {
      query = query.where("institution", "==", inst);
    }
    let complaints;
    try {
      const snap = await query.get();
      complaints = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    } catch (_) {
      // Compound index may not exist — fallback: fetch all and filter in memory
      const allSnap = await admin.firestore().collection("complaints").orderBy("createdAt", "desc").get();
      complaints = allSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (inst) complaints = complaints.filter(c => (c.institution || "college") === inst);
    }

    return res.json({
      success: true,
      total: complaints.length,
      complaints,
    });
  } catch (e) {
    console.log("GET COMPLAINTS ERROR:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});
app.delete("/admin/complaint/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    await admin.firestore().collection("complaints").doc(id).delete();

    return res.json({
      success: true,
      message: "Complaint deleted",
    });
  } catch (e) {
    console.log("DELETE COMPLAINT ERROR:", e);

    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});
app.patch("/admin/complaint-status/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Update complaint status
    await admin.firestore().collection("complaints").doc(id).update({
      status,
      resolvedAt: status === "resolved" ? admin.firestore.FieldValue.serverTimestamp() : null,
    });

    // ── Send notification to complaint creator when RESOLVED ──────────────
    if (status === "resolved") {
      try {
        // Fetch the complaint to get the creator's userId and role
        const complaintDoc = await admin.firestore().collection("complaints").doc(id).get();
        if (complaintDoc.exists) {
          const complaint = complaintDoc.data();
          const userId = complaint.userId;
          const role = complaint.role;

          // Map role to Firestore collection
          const collectionName = role === "student" ? "students"
            : role === "parent" ? "parents"
            : role === "faculty" ? "faculty"
            : null;

          if (collectionName && userId) {
            // Fetch user's FCM token
            const userDoc = await admin.firestore()
              .collection(collectionName)
              .doc(userId)
              .get();

            if (userDoc.exists) {
              const fcmToken = userDoc.data()?.fcmToken;
              if (fcmToken && fcmToken.length > 10) {
                await admin.messaging().send({
                  token: fcmToken,
                  notification: {
                    title: "Complaint Resolved",
                    body: "Your complaint has been resolved by the administration.",
                  },
                  data: {
                    type: "complaint_resolved",
                    complaintId: id,
                  },
                });
                console.log(`✅ Complaint resolved notification sent to ${userId} (${role})`);
              }
            }
          }
        }
      } catch (notifErr) {
        // Notification failure is non-fatal — complaint is already resolved
        console.log(`⚠️ Complaint resolve notification failed: ${notifErr.message}`);
      }
    }

    return res.json({
      success: true,
      message: "Status updated",
    });
  } catch (e) {
    console.log("STATUS UPDATE ERROR:", e);

    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   COMPLAINTS — INSTITUTION FILTERED
   GET /admin/complaints-by-institution?institution=college|school
========================= */
app.get("/admin/complaints-by-institution", adminAuth, async (req, res) => {
  try {
    const inst = (req.query.institution || "").toLowerCase();
    if (!["college", "school"].includes(inst)) {
      return res.status(400).json({ error: 'institution required: "college" or "school"' });
    }

    // Try Firestore query with institution filter
    let complaints = [];
    try {
      const snap = await admin.firestore().collection("complaints")
        .where("institution", "==", inst)
        .orderBy("createdAt", "desc")
        .get();
      complaints = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (_) {
      // Fallback: filter in memory if compound index doesn't exist yet
      const allSnap = await admin.firestore().collection("complaints")
        .orderBy("createdAt", "desc").get();
      complaints = allSnap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(c => (c.institution || "college").toLowerCase() === inst);
    }

    return res.json({
      success: true,
      institution: inst,
      total: complaints.length,
      complaints,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   SUPPORT TICKET CHAT SYSTEM — Real-time bidirectional messaging
   Collections: support_tickets, ticket_messages
═══════════════════════════════════════════════════════════════════════════════ */

// POST /api/tickets — Send a message (creates ticket if none exists, appends otherwise)
// ONE ACTIVE TICKET PER USER — never creates duplicates
app.post("/api/tickets", ticketLimiter, authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId, role, message } = req.body;
    // Validate
    if (!userId || typeof userId !== "string") return res.status(400).json({ success: false, error: "userId required" });
    if (!message || typeof message !== "string" || !message.trim()) return res.status(400).json({ success: false, error: "message required" });
    if (message.length > 2000) return res.status(400).json({ success: false, error: "message too long (max 2000)" });
    // Sanitize
    const cleanMessage = sanitize(message);
    console.log("[TICKET] Request:", { userId, role, messageLen: cleanMessage?.length });

    // Fetch user details
    let userDoc = null;
    const collections = { student: "students", parent: "parents", faculty: "faculty" };
    const col = collections[role] || "students";
    const snap = await admin.firestore().collection(col).doc(userId).get();
    if (snap.exists) userDoc = snap.data();
    if (!userDoc) {
      console.log("[TICKET] User NOT found:", col, "/", userId);
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Check if user already has an active ticket (open or pending)
    let ticketRef = null;
    let ticketId = null;
    let ticketNumber = null;
    let isNew = false;

    const existingSnap = await admin.firestore().collection("support_tickets")
      .where("userId", "==", userId)
      .where("status", "in", ["open", "pending"])
      .limit(1)
      .get();

    if (existingSnap.docs.length > 0) {
      // Append to existing active ticket
      ticketRef = existingSnap.docs[0].ref;
      ticketId = existingSnap.docs[0].id;
      ticketNumber = existingSnap.docs[0].data().ticketNumber;
      console.log("[TICKET] Appending to existing:", ticketNumber);
    } else {
      // Check if there's a closed ticket to reopen
      const closedSnap = await admin.firestore().collection("support_tickets")
        .where("userId", "==", userId)
        .where("status", "in", ["resolved", "closed"])
        .limit(5)
        .get();

      // Sort in memory to get most recent
      const closedDocs = closedSnap.docs
        .map(d => ({ ref: d.ref, id: d.id, data: d.data() }))
        .sort((a, b) => {
          const ta = a.data.updatedAt?._seconds || 0;
          const tb = b.data.updatedAt?._seconds || 0;
          return tb - ta;
        });

      if (closedDocs.length > 0) {
        // Reopen the most recent closed ticket
        ticketRef = closedDocs[0].ref;
        ticketId = closedDocs[0].id;
        ticketNumber = closedDocs[0].data.ticketNumber;
        await ticketRef.update({ status: "open" });
        console.log("[TICKET] Reopened:", ticketNumber);
      } else {
        // Create brand new ticket (atomic counter via transaction)
        const counterRef = admin.firestore().collection("system").doc("ticketCounter");
        ticketNumber = await admin.firestore().runTransaction(async (txn) => {
          const counterDoc = await txn.get(counterRef);
          const nextNum = (counterDoc.exists ? (counterDoc.data().count || 0) : 0) + 1;
          txn.set(counterRef, { count: nextNum }, { merge: true });
          return `TKT-${String(nextNum).padStart(5, "0")}`;
        });

        const newRef = await admin.firestore().collection("support_tickets").add({
          ticketNumber,
          userId,
          role: role || "student",
          institution: userDoc.institution || "college",
          userName: userDoc.name || "",
          userEmail: userDoc.email || "",
          userMobile: userDoc.mobile || "",
          userBusId: userDoc.busId || "",
          userCourse: userDoc.course || "",
          userBranch: userDoc.branch || "",
          userYear: userDoc.year || "",
          status: "open",
          messageCount: 0,
          unreadAdmin: 0,
          unreadUser: 0,
          lastMessage: "",
          lastMessageBy: "",
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        ticketRef = newRef;
        ticketId = newRef.id;
        isNew = true;
        console.log("[TICKET] Created new:", ticketNumber);
      }
    }

    // Add the message
    await admin.firestore().collection("ticket_messages").add({
      ticketId,
      senderType: "user",
      senderId: userId,
      senderName: sanitize(userDoc.name || ""),
      message: cleanMessage,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update ticket metadata
    await ticketRef.update({
      lastMessage: cleanMessage,
      lastMessageBy: "user",
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      messageCount: admin.firestore.FieldValue.increment(1),
      unreadAdmin: admin.firestore.FieldValue.increment(1),
      unreadUser: 0,
      status: "open",
    });

    // WebSocket broadcast
    try {
      const wsPayload = JSON.stringify({ type: "ticket_message", ticketId, senderType: "user" });
      wss.clients.forEach((c) => { if (c.readyState === 1) try { c.send(wsPayload); } catch (_) {} });
    } catch (_) {}

    return res.json({ success: true, ticketId, ticketNumber, isNew });
  } catch (e) {
    console.log("[TICKET] Error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tickets/user/:userId — List all tickets for a user
app.get("/api/tickets/user/:userId", authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId } = req.params;
    // Ownership check: userId param is Firestore doc ID, req.firebaseUid is Firebase Auth UID
    let isOwner = req.firebaseUid === userId;
    if (!isOwner) {
      // Check all user collections — the document at userId should have uid matching req.firebaseUid
      const cols = ["students", "parents", "faculty"];
      for (const col of cols) {
        const userDoc = await admin.firestore().collection(col).doc(userId).get();
        if (userDoc.exists) {
          const storedUid = userDoc.data().uid;
          if (storedUid === req.firebaseUid) { isOwner = true; break; }
          if (!storedUid) {
            // Legacy doc without uid field — reverse lookup
            const uidSnap = await admin.firestore().collection(col)
              .where("uid", "==", req.firebaseUid).limit(1).get();
            if (!uidSnap.empty && uidSnap.docs[0].id === userId) { isOwner = true; break; }
          }
        }
      }
    }
    if (!isOwner) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    // Query without orderBy to avoid composite index requirement
    const snap = await admin.firestore().collection("support_tickets")
      .where("userId", "==", userId)
      .get();
    // Sort in memory (user typically has 1-5 tickets)
    const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.updatedAt?._seconds || a.updatedAt?.seconds || 0;
        const tb = b.updatedAt?._seconds || b.updatedAt?.seconds || 0;
        return tb - ta; // DESC
      });
    return res.json({ success: true, tickets });
  } catch (e) {
    console.log("[TICKET LIST] Error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tickets/:ticketId/messages — Get all messages for a ticket
app.get("/api/tickets/:ticketId/messages", authenticateAny, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const ticketDoc = await admin.firestore().collection("support_tickets").doc(ticketId).get();
    if (!ticketDoc.exists) return res.status(404).json({ success: false, error: "Ticket not found" });
    const ticketData = ticketDoc.data();
    // Ownership check for users
    if (!req.isAdmin) {
      // ticketData.userId is the Firestore document ID (e.g. "student-001");
      // req.firebaseUid is the Firebase Auth UID (e.g. "xY7kP...").
      // They differ because the app uses sequential IDs for documents.
      // Strategy: check if the user document at that ID has a matching uid field,
      // OR query by uid to find the user's document ID.
      let isOwner = ticketData.userId === req.firebaseUid;
      if (!isOwner) {
        const role = ticketData.role || "student";
        const cols = { student: "students", parent: "parents", faculty: "faculty" };
        const col = cols[role] || "students";
        // Primary: look up user doc by ID, check uid field
        const userDoc = await admin.firestore().collection(col).doc(ticketData.userId).get();
        if (userDoc.exists) {
          const storedUid = userDoc.data().uid;
          if (storedUid === req.firebaseUid) {
            isOwner = true;
          } else if (!storedUid) {
            // Document exists but uid field is missing (legacy registration).
            // Reverse lookup: find user by Firebase UID in same collection.
            const uidSnap = await admin.firestore().collection(col)
              .where("uid", "==", req.firebaseUid).limit(1).get();
            if (!uidSnap.empty && uidSnap.docs[0].id === ticketData.userId) {
              isOwner = true;
            }
          }
        }
      }
      if (!isOwner) return res.status(403).json({ success: false, error: "Access denied" });
    } else {
      // Institution isolation for admins
      const inst = resolveInstitutionFilter(req);
      if (inst && ticketData.institution !== inst) return res.status(403).json({ success: false, error: "Access denied — wrong institution" });
    }
    // Query without orderBy to avoid composite index requirement
    const snap = await admin.firestore().collection("ticket_messages")
      .where("ticketId", "==", ticketId)
      .get();
    // Sort in memory (messages per ticket are typically <100)
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.createdAt?._seconds || a.createdAt?.seconds || 0;
        const tb = b.createdAt?._seconds || b.createdAt?.seconds || 0;
        return ta - tb;
      });
    return res.json({ success: true, messages });
  } catch (e) {
    console.log("[TICKET MSG] Error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tickets/:ticketId/messages — Send a message (user or admin)
app.post("/api/tickets/:ticketId/messages", ticketLimiter, authenticateAny, async (req, res) => {
  const _t0 = Date.now();
  try {
    const { ticketId } = req.params;
    const { senderId, senderType, senderName, message } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) return res.status(400).json({ success: false, error: "message required" });
    if (message.length > 2000) return res.status(400).json({ success: false, error: "message too long (max 2000)" });

    const _t1 = Date.now();
    const ticketRef = admin.firestore().collection("support_tickets").doc(ticketId);
    const ticketDoc = await ticketRef.get();
    const _t2 = Date.now();
    if (!ticketDoc.exists) return res.status(404).json({ success: false, error: "Ticket not found" });

    const ticketData = ticketDoc.data();

    // Ownership check: non-admin users can only message their own tickets
    if (!req.isAdmin) {
      let isOwner = ticketData.userId === req.firebaseUid;
      if (!isOwner) {
        const role = ticketData.role || "student";
        const cols = { student: "students", parent: "parents", faculty: "faculty" };
        const col = cols[role] || "students";
        const userDoc = await admin.firestore().collection(col).doc(ticketData.userId).get();
        if (userDoc.exists) {
          const storedUid = userDoc.data().uid;
          if (storedUid === req.firebaseUid) {
            isOwner = true;
          } else if (!storedUid) {
            const uidSnap = await admin.firestore().collection(col)
              .where("uid", "==", req.firebaseUid).limit(1).get();
            if (!uidSnap.empty && uidSnap.docs[0].id === ticketData.userId) {
              isOwner = true;
            }
          }
        }
      }
      if (!isOwner) return res.status(403).json({ success: false, error: "Access denied" });
    }
    // Institution isolation for admins
    if (req.isAdmin) {
      const inst = resolveInstitutionFilter(req);
      if (inst && ticketData.institution !== inst) {
        return res.status(403).json({ success: false, error: "Access denied — wrong institution" });
      }
    }

    if (ticketData.status === "closed") return res.status(400).json({ success: false, error: "Ticket is closed" });

    // Add message + update ticket metadata in parallel (independent operations)
    const cleanMsg = sanitize(message);
    const isAdmin = senderType === "admin";
    const _t3 = Date.now();
    const [msgRef] = await Promise.all([
      admin.firestore().collection("ticket_messages").add({
        ticketId,
        senderType: senderType || "user",
        senderId: senderId || "",
        senderName: sanitize(senderName || ""),
        message: cleanMsg,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      ticketRef.update({
        lastMessage: cleanMsg,
        lastMessageBy: senderType || "user",
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        messageCount: admin.firestore.FieldValue.increment(1),
        ...(isAdmin ? { unreadUser: admin.firestore.FieldValue.increment(1), unreadAdmin: 0, status: "pending" } :
                      { unreadAdmin: admin.firestore.FieldValue.increment(1), unreadUser: 0 }),
      }),
    ]);
    const _t4 = Date.now();

    // ── Broadcast ticket update via WebSocket for instant delivery ──
    const _t5 = Date.now();
    try {
      const wsPayload = JSON.stringify({
        type: "ticket_message",
        ticketId,
        senderType: senderType || "user",
        messageId: msgRef.id,
      });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try { client.send(wsPayload); } catch (_) {}
        }
      });
    } catch (_) {}
    const _t6 = Date.now();

    // ── Create notification for the recipient (fire-and-forget — don't block response) ──
    if (isAdmin) {
      createUserNotification(ticketData.userId, "ticket_reply",
        "Admin replied to your ticket",
        message.trim().substring(0, 100),
        { ticketId, ticketNumber: ticketData.ticketNumber || "" });

      // ── FCM Push notification for ticket reply ──────────────────────────
      // Look up the user's FCM token and send a real push so they get notified
      // even when the app is backgrounded/killed.
      (async () => {
        try {
          const role = ticketData.role || "student";
          const cols = { student: "students", parent: "parents", faculty: "faculty" };
          const col = cols[role] || "students";
          const userDoc = await admin.firestore().collection(col).doc(ticketData.userId).get();
          if (userDoc.exists) {
            const fcmToken = userDoc.data().fcmToken;
            if (fcmToken && fcmToken.length > 10) {
              await admin.messaging().send({
                token: fcmToken,
                notification: {
                  title: "Support Reply",
                  body: message.trim().substring(0, 100),
                },
                data: {
                  type: "ticket_reply",
                  ticketId: ticketId,
                  ticketNumber: ticketData.ticketNumber || "",
                },
              });
            }
          }
        } catch (_) { /* FCM failure is non-fatal */ }
      })();
    }

    const _t7 = Date.now();
    console.log(`[TICKET PERF] ticketRef.get: ${_t2-_t1}ms | write(add+update): ${_t4-_t3}ms | broadcast: ${_t6-_t5}ms | total: ${_t7-_t0}ms | ticketId: ${ticketId}`);

    return res.json({ success: true, messageId: msgRef.id });
  } catch (e) {
    console.log(`[TICKET PERF] ERROR after ${Date.now()-_t0}ms:`, e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});
// GET /admin/tickets — List all tickets (admin, institution-filtered)
app.get("/admin/tickets", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    let query = admin.firestore().collection("support_tickets");
    if (inst) query = query.where("institution", "==", inst);
    const snap = await query.get();
    // Sort in memory to avoid composite index requirement
    const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.updatedAt?._seconds || a.updatedAt?.seconds || 0;
        const tb = b.updatedAt?._seconds || b.updatedAt?.seconds || 0;
        return tb - ta;
      });
    return res.json({ success: true, tickets });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /admin/tickets/:ticketId/status — Update ticket status (admin)
app.patch("/admin/tickets/:ticketId/status", adminAuth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status } = req.body;
    if (!["open", "pending", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }
    // Institution isolation: admin can only modify tickets of their institution
    const ticketDoc = await admin.firestore().collection("support_tickets").doc(ticketId).get();
    if (!ticketDoc.exists) return res.status(404).json({ success: false, error: "Ticket not found" });
    const inst = resolveInstitutionFilter(req);
    if (inst && ticketDoc.data().institution !== inst) {
      return res.status(403).json({ success: false, error: "Access denied — wrong institution" });
    }
    await admin.firestore().collection("support_tickets").doc(ticketId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Broadcast status change via WebSocket to all connected clients
    try {
      const wsPayload = JSON.stringify({ type: "ticket:status", ticketId, status });
      wss.clients.forEach((c) => { if (c.readyState === 1) try { c.send(wsPayload); } catch (_) {} });
    } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /admin/tickets/:ticketId/read — Mark messages as read (admin)
app.post("/admin/tickets/:ticketId/read", adminAuth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    // Institution isolation: admin can only access tickets of their institution
    const ticketDoc = await admin.firestore().collection("support_tickets").doc(ticketId).get();
    if (!ticketDoc.exists) return res.status(404).json({ success: false, error: "Ticket not found" });
    const inst = resolveInstitutionFilter(req);
    if (inst && ticketDoc.data().institution !== inst) {
      return res.status(403).json({ success: false, error: "Access denied — wrong institution" });
    }
    // Mark all unread user messages as read
    const snap = await admin.firestore().collection("ticket_messages")
      .where("ticketId", "==", ticketId)
      .where("senderType", "==", "user")
      .where("isRead", "==", false)
      .get();
    const batch = admin.firestore().batch();
    snap.docs.forEach(d => batch.update(d.ref, { isRead: true }));
    await batch.commit();
    // Reset unread count on ticket
    await admin.firestore().collection("support_tickets").doc(ticketId).update({ unreadAdmin: 0 });
    return res.json({ success: true, markedRead: snap.docs.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /admin/tickets/user-history/:userId — All tickets for a user (admin view)
app.get("/admin/tickets/user-history/:userId", adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const inst = resolveInstitutionFilter(req);
    const snap = await admin.firestore().collection("support_tickets")
      .where("userId", "==", userId)
      .get();
    // Filter by institution in memory (userId query already narrows result set)
    const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(t => !inst || t.institution === inst)
      .sort((a, b) => {
        const ta = a.createdAt?._seconds || a.createdAt?.seconds || 0;
        const tb = b.createdAt?._seconds || b.createdAt?.seconds || 0;
        return tb - ta;
      });
    return res.json({ success: true, tickets });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   AUDIT LOGS — Track all admin actions
═══════════════════════════════════════════════════════════════════════════════ */

// Internal helper — call from any admin action to log it
async function logAuditEvent(action, adminRole, adminInst, details = {}) {
  try {
    await admin.firestore().collection("audit_logs").add({
      action,
      adminRole: adminRole || "unknown",
      adminInstitution: adminInst || "unknown",
      details,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {} // Best-effort — never crash the main flow
}

// GET /admin/audit-logs — View audit trail (superadmin only)
app.get("/admin/audit-logs", adminAuth, async (req, res) => {
  try {
    if (req.adminRole !== "superadmin") return res.status(403).json({ error: "Superadmin only" });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const snap = await admin.firestore().collection("audit_logs")
      .orderBy("timestamp", "desc").limit(limit).get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, logs });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   BULK NOTIFICATIONS — Send to multiple buses / all users at once
═══════════════════════════════════════════════════════════════════════════════ */

// POST /admin/bulk-notify — Send notification to multiple buses simultaneously
app.post("/admin/bulk-notify", adminAuth, async (req, res) => {
  try {
    const { busIds, title, message, institution } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, error: "title and message required" });
    if (!busIds || !Array.isArray(busIds) || busIds.length === 0) {
      return res.status(400).json({ success: false, error: "busIds array required" });
    }

    const inst = resolveInstitutionFilter(req, institution);
    let totalSent = 0;

    for (const busId of busIds) {
      const normalizedBusId = busId.startsWith("BUS-") ? busId : `BUS-${busId}`;
      // Get tokens for this bus
      const tokenDoc = await admin.firestore().collection("bus_tokens").doc(normalizedBusId).get();
      if (!tokenDoc.exists) continue;
      const tokens = tokenDoc.data().tokens || [];
      if (tokens.length === 0) continue;

      // Send via FCM
      const payload = { notification: { title: sanitize(title), body: sanitize(message) }, data: { type: "admin_notification", busId: normalizedBusId } };
      try {
        const response = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
        totalSent += response.successCount;
      } catch (_) {}
    }

    // Save to history
    await admin.firestore().collection("admin_notifications").add({
      title: sanitize(title), message: sanitize(message),
      busIds, institution: inst || "all", type: "bulk",
      sentAt: admin.firestore.FieldValue.serverTimestamp(), sentCount: totalSent,
    });

    await logAuditEvent("bulk_notify", req.adminRole, req.adminInstitution, { busIds, title, totalSent });
    return res.json({ success: true, totalSent, busCount: busIds.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   BULK ACTIONS — Mass operations on users/tickets
═══════════════════════════════════════════════════════════════════════════════ */

// POST /admin/bulk-ticket-status — Update status of multiple tickets at once
app.post("/admin/bulk-ticket-status", adminAuth, async (req, res) => {
  try {
    const { ticketIds, status } = req.body;
    if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
      return res.status(400).json({ success: false, error: "ticketIds array required" });
    }
    if (!["open", "pending", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }

    const inst = resolveInstitutionFilter(req);
    const batch = admin.firestore().batch();
    let updated = 0;
    for (const id of ticketIds.slice(0, 50)) { // Max 50 per batch
      const ref = admin.firestore().collection("support_tickets").doc(id);
      // Institution isolation: verify each ticket belongs to this admin's institution
      if (inst) {
        const doc = await ref.get();
        if (!doc.exists || doc.data().institution !== inst) continue; // skip foreign tickets
      }
      batch.update(ref, { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      updated++;
    }
    await batch.commit();

    await logAuditEvent("bulk_ticket_status", req.adminRole, req.adminInstitution, { ticketIds, status, updated });
    return res.json({ success: true, updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /admin/bulk-delete-users — Delete multiple users at once
app.post("/admin/bulk-delete-users", adminAuth, async (req, res) => {
  try {
    if (req.adminRole !== "superadmin") return res.status(403).json({ error: "Superadmin only" });
    const { users } = req.body; // [{type: "students", id: "student-001"}, ...]
    if (!users || !Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ success: false, error: "users array required" });
    }

    let deleted = 0;
    for (const { type, id } of users.slice(0, 20)) { // Max 20 per request
      if (!["students", "parents", "faculty"].includes(type) || !id) continue;
      await admin.firestore().collection(type).doc(id).delete();
      deleted++;
    }

    await logAuditEvent("bulk_delete_users", req.adminRole, req.adminInstitution, { count: deleted });
    return res.json({ success: true, deleted });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   REALTIME DASHBOARD — Live stats via WebSocket (zero polling)
═══════════════════════════════════════════════════════════════════════════════ */

// GET /admin/live-stats — One-time snapshot for initial load
app.get("/admin/live-stats", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    const [students, tickets] = await Promise.all([
      inst ? admin.firestore().collection("students").where("institution", "==", inst).get()
           : admin.firestore().collection("students").get(),
      admin.firestore().collection("support_tickets").where("status", "in", ["open", "pending"]).get(),
    ]);

    const onlineBuses = latestBuses.filter(b => b.lat && b.lng).length;

    return res.json({
      success: true,
      stats: {
        totalStudents: students.size,
        activeTickets: tickets.size,
        onlineBuses,
        serverUptime: Math.floor(process.uptime()),
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   NOTIFICATION CENTER — User-facing inbox with read/unread/delete
   Collection: user_notifications
   Types: ticket_reply, attendance, bus_pass, payment, admin_broadcast
═══════════════════════════════════════════════════════════════════════════════ */

// Internal helper — create a notification for a user
async function createUserNotification(userId, type, title, body, data = {}) {
  try {
    await admin.firestore().collection("user_notifications").add({
      userId,
      type, // ticket_reply | attendance | bus_pass | payment | admin_broadcast
      title: sanitize(title),
      body: sanitize(body),
      data,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}
}

// GET /api/notifications/:userId — Get user's notifications (paginated)
app.get("/api/notifications/:userId", authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    if (!userId) return res.status(400).json({ success: false, error: "userId required" });

    const snap = await admin.firestore().collection("user_notifications")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unreadCount = notifications.filter(n => !n.isRead).length;

    return res.json({ success: true, notifications, unreadCount, total: notifications.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/notifications/:userId/unread-count — Quick unread badge count
app.get("/api/notifications/:userId/unread-count", authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await admin.firestore().collection("user_notifications")
      .where("userId", "==", userId)
      .where("isRead", "==", false)
      .get();
    return res.json({ success: true, unreadCount: snap.size });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/notifications/:notificationId/read — Mark single as read
app.post("/api/notifications/:notificationId/read", authenticateFirebaseUser, async (req, res) => {
  try {
    const { notificationId } = req.params;
    await admin.firestore().collection("user_notifications").doc(notificationId).update({ isRead: true });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/notifications/:userId/read-all — Mark all as read
app.post("/api/notifications/:userId/read-all", authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await admin.firestore().collection("user_notifications")
      .where("userId", "==", userId)
      .where("isRead", "==", false)
      .get();
    if (snap.empty) return res.json({ success: true, marked: 0 });

    const batch = admin.firestore().batch();
    snap.docs.forEach(d => batch.update(d.ref, { isRead: true }));
    await batch.commit();
    return res.json({ success: true, marked: snap.size });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/notifications/:notificationId — Delete single notification
app.delete("/api/notifications/:notificationId", authenticateFirebaseUser, async (req, res) => {
  try {
    const { notificationId } = req.params;
    await admin.firestore().collection("user_notifications").doc(notificationId).delete();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/notifications/:userId/clear-all — Delete all notifications for user
app.delete("/api/notifications/:userId/clear-all", authenticateFirebaseUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await admin.firestore().collection("user_notifications")
      .where("userId", "==", userId)
      .get();
    if (snap.empty) return res.json({ success: true, deleted: 0 });

    const batch = admin.firestore().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    return res.json({ success: true, deleted: snap.size });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* =========================
   AUTO STUDENT PROMOTION
========================= */

// TESTING DATE
// Every day at 12:00 AM
// cron.schedule("* * * * *", async () => {

// REAL DATE
// Every year 1 August 12:00 AM
cron.schedule("0 0 1 8 *", async () => {
  console.log("🎓 AUTO PROMOTION STARTED");

  try {
    const studentsRef = admin.firestore().collection("students");

    const snap = await studentsRef.get();

    for (const doc of snap.docs) {
      const data = doc.data();

      // =========================
      // COLLEGE STUDENTS
      // =========================

      if (data.studentType === "college") {
        const year = Number(data.year || 0);

        // ---------- BTECH ----------
        if (data.course === "btech") {
          if (year >= 4) {
            await cleanupUser("students", doc.id);

            console.log("🗑 BTECH Deleted:", data.name);
          } else {
            await studentsRef.doc(doc.id).update({
              year: String(year + 1),
            });

            console.log(`⬆ BTECH Promoted ${data.name} -> ${year + 1}`);
          }
        }

        // ---------- POLY ----------
        else if (data.course === "poly") {
          if (year >= 3) {
            await cleanupUser("students", doc.id);

            console.log("🗑 POLY Deleted:", data.name);
          } else {
            await studentsRef.doc(doc.id).update({
              year: String(year + 1),
            });

            console.log(`⬆ POLY Promoted ${data.name} -> ${year + 1}`);
          }
        }
      }

      // =========================
      // SCHOOL STUDENTS
      // =========================
      else if (data.studentType === "school") {
        const currentClass = Number(data.class || 0);

        if (currentClass >= 12) {
          await cleanupUser("students", doc.id);

          console.log("🗑 SCHOOL Deleted:", data.name);
        } else {
          await studentsRef.doc(doc.id).update({
            class: String(currentClass + 1),
          });

          console.log(`⬆ SCHOOL Promoted ${data.name} -> ${currentClass + 1}`);
        }
      }
    }

    console.log("✅ PROMOTION COMPLETED");
  } catch (e) {
    console.log("❌ PROMOTION ERROR:", e);
  }
});

/* =========================
   ADMIN LOGIN — UNIFIED
   POST /admin/login  (handles college, school, AND super admin)
   POST /admin/college-login  (explicit college only)
   POST /admin/school-login   (explicit school only)
========================= */
app.post("/admin/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: "Missing credentials" });

  try {
    // Super Admin
    if (username === SUPER_ADMIN_USER && await bcrypt.compare(password, SUPER_ADMIN_PASS)) {
      const token = jwt.sign(
        { admin: true, role: "superadmin", institution: "all" },
        process.env.JWT_SECRET,
        { expiresIn: "4h" }
      );
      return res.json({ success: true, token, institution: "all", role: "superadmin" });
    }

    // College Admin
    if (username === ADMIN_USER && await bcrypt.compare(password, ADMIN_PASS)) {
      const token = jwt.sign(
        { admin: true, role: "admin", institution: "college" },
        process.env.JWT_SECRET,
        { expiresIn: "2h" }
      );
      return res.json({ success: true, token, institution: "college", role: "admin" });
    }

    // School Admin
    if (username === SCHOOL_ADMIN_USER && await bcrypt.compare(password, SCHOOL_ADMIN_PASS)) {
      const token = jwt.sign(
        { admin: true, role: "admin", institution: "school" },
        process.env.JWT_SECRET,
        { expiresIn: "2h" }
      );
      return res.json({ success: true, token, institution: "school", role: "admin" });
    }

    // Bus Pass Admin
    if (username === process.env.BUSPASS_USERNAME && await bcrypt.compare(password, process.env.BUSPASS_PASS_HASH)) {
      const token = jwt.sign(
        { admin: true, buspass: true, role: "bus_pass_admin", institution: "college" },
        process.env.JWT_SECRET,
        { expiresIn: "24h" }
      );
      return res.json({ success: true, token, institution: "buspass", role: "bus_pass_admin" });
    }

    return res.status(401).json({ success: false, error: "Invalid credentials" });
  } catch (e) {
    console.log("LOGIN ERROR:", e.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/admin/college-login", async (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && await bcrypt.compare(password, ADMIN_PASS)) {
    const token = jwt.sign(
      { admin: true, role: "admin", institution: "college" },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );
    return res.json({ success: true, token, institution: "college", role: "admin" });
  }
  return res.status(401).json({ success: false, error: "Invalid credentials" });
});

/* =========================
   ADMIN LOGIN — SCHOOL
========================= */
app.post("/admin/school-login", async (req, res) => {
  const { username, password } = req.body;
  if (username === SCHOOL_ADMIN_USER && await bcrypt.compare(password, SCHOOL_ADMIN_PASS)) {
    const token = jwt.sign(
      { admin: true, role: "admin", institution: "school" },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );
    return res.json({ success: true, token, institution: "school", role: "admin" });
  }
  return res.status(401).json({ success: false, error: "Invalid credentials" });
});

/* =========================
   SUPER ADMIN APIs — ALL DATA ACCESS
========================= */

// GET /admin/all-users — returns ALL users (school + college combined)
app.get("/admin/all-users", adminAuth, async (req, res) => {
  try {
    if (req.adminRole !== "superadmin") {
      return res.status(403).json({ error: "Superadmin access required" });
    }
    const [studentsSnap, parentsSnap, facultySnap] = await Promise.all([
      admin.firestore().collection("students").get(),
      admin.firestore().collection("parents").get(),
      admin.firestore().collection("faculty").get(),
    ]);
    const students = studentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const parents  = parentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const faculty  = facultySnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      success: true,
      students, parents, faculty,
      counts: {
        students: students.length,
        parents: parents.length,
        faculty: faculty.length,
        total: students.length + parents.length + faculty.length,
        college: students.filter(s => (s.institution||"college") === "college").length
                 + faculty.filter(f => (f.institution||"college") === "college").length,
        school: parents.filter(p => (p.institution||"college") === "school").length
                + faculty.filter(f => (f.institution||"college") === "school").length
                + students.filter(s => (s.institution||"college") === "school").length,
      },
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// GET /admin/all-routes — returns ALL routes unfiltered
app.get("/admin/all-routes", adminAuth, async (req, res) => {
  try {
    if (req.adminRole !== "superadmin") {
      return res.status(403).json({ error: "Superadmin access required" });
    }
    const snap = await admin.firestore().collection("routes").get();
    const routes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({
      success: true,
      routes,
      counts: {
        total: routes.length,
        college: routes.filter(r => (r.routeType||"college") === "college").length,
        school: routes.filter(r => (r.routeType||"college") === "school").length,
        active: routes.filter(r => r.status === "Active").length,
      },
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// GET /admin/system-stats — full system overview
app.get("/admin/system-stats", adminAuth, async (req, res) => {
  try {
    if (req.adminRole !== "superadmin") {
      return res.status(403).json({ error: "Superadmin access required" });
    }
    const [studentsSnap, parentsSnap, facultySnap, routesSnap, complaintsSnap] = await Promise.all([
      admin.firestore().collection("students").get(),
      admin.firestore().collection("parents").get(),
      admin.firestore().collection("faculty").get(),
      admin.firestore().collection("routes").get(),
      admin.firestore().collection("complaints").get(),
    ]);

    const students = studentsSnap.docs.map(d => d.data());
    const parents  = parentsSnap.docs.map(d => d.data());
    const faculty  = facultySnap.docs.map(d => d.data());

    return res.json({
      success: true,
      stats: {
        totalStudents: students.length,
        totalParents: parents.length,
        totalFaculty: faculty.length,
        totalUsers: students.length + parents.length + faculty.length,
        collegeUsers: students.filter(s => (s.institution||"college") === "college").length
                     + faculty.filter(f => (f.institution||"college") === "college").length,
        schoolUsers: parents.filter(p => (p.institution||"college") === "school").length
                    + faculty.filter(f => (f.institution||"college") === "school").length
                    + students.filter(s => (s.institution||"college") === "school").length,
        totalRoutes: routesSnap.size,
        activeRoutes: routesSnap.docs.filter(d => d.data().status === "Active").length,
        totalComplaints: complaintsSnap.size,
        pendingComplaints: complaintsSnap.docs.filter(d => d.data().status === "pending").length,
        activeBuses: 0, // updated via WS data below
      },
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete("/debug/delete-student/:id", adminAuth, async (req, res) => {
  try {
    await redis.del(`student:${req.params.id}`);

    res.json({
      success: true,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
    });
  }
});

app.delete("/debug/redis-clear", adminAuth, async (req, res) => {
  try {
    const allKeys = await redis.scanAll("student:*");

    if (allKeys.length > 0) {
      await redis.del(allKeys); // redis.del now accepts an array safely
    }

    return res.json({ success: true, deleted: allKeys.length, keys: allKeys });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   FIREBASE ↔ REDIS AUDIT
   GET /debug/redis-audit
   ─────────────────────────
   Scans all student:* Redis keys and cross-checks each entry against its
   Firestore document (students / parents / faculty).
   Reports:
     • mismatched busId between Redis and Firestore
     • Redis entries with no matching Firestore document (stale/orphan keys)
     • Redis entries missing required fields (lat/lng/lastUpdated)
     • Firestore documents with a uid field that differs from the stored key
========================= */
app.get("/debug/redis-audit", adminAuth, async (req, res) => {
  try {
    const allKeys = await redis.scanAll("student:*");
    const results = {
      total:    allKeys.length,
      ok:       [],
      mismatches: [],
      orphans:  [],
      stale:    [],
    };

    const staleThresholdMs = 6 * 3600 * 1000; // 6 h — same as key TTL
    const now = Date.now();

    await Promise.all(allKeys.map(async (key) => {
      const id      = key.replace("student:", "");
      const redisVal = await redis.get(key);

      if (!redisVal || typeof redisVal !== "object") {
        results.orphans.push({ key, reason: "empty or non-object value" });
        return;
      }

      // ── Check for stale entries ──────────────────────────────────────
      if (redisVal.lastUpdated && (now - redisVal.lastUpdated) > staleThresholdMs) {
        results.stale.push({
          key,
          id,
          lastUpdated: new Date(redisVal.lastUpdated).toISOString(),
          ageHours: ((now - redisVal.lastUpdated) / 3600000).toFixed(1),
        });
        // Continue — still check Firestore for this key
      }

      // ── Required fields check ────────────────────────────────────────
      const missingFields = [];
      if (redisVal.lat    == null) missingFields.push("lat");
      if (redisVal.lng    == null) missingFields.push("lng");
      if (!redisVal.busId)         missingFields.push("busId");
      if (!redisVal.lastUpdated)   missingFields.push("lastUpdated");
      if (missingFields.length) {
        results.mismatches.push({
          key, id,
          reason: "missing fields in Redis",
          missingFields,
          redisData: redisVal,
        });
      }

      // ── Firestore cross-check ─────────────────────────────────────────
      let fsDoc  = null;
      let fsCol  = null;
      for (const col of ["students", "parents", "faculty"]) {
        const snap = await admin.firestore().collection(col).doc(id).get();
        if (snap.exists) { fsDoc = snap.data(); fsCol = col; break; }
      }

      if (!fsDoc) {
        results.orphans.push({
          key, id,
          reason:   "no Firestore document with this ID",
          redisData: { busId: redisVal.busId, lat: redisVal.lat, lng: redisVal.lng },
        });
        return;
      }

      // ── busId match ───────────────────────────────────────────────────
      const fsBusId  = (fsDoc.busId  || "").toUpperCase().replace(/\s+/g, "-");
      const redisBus = (redisVal.busId || "").toUpperCase().replace(/\s+/g, "-");
      if (fsBusId && redisBus && fsBusId !== redisBus) {
        results.mismatches.push({
          key, id,
          collection:    fsCol,
          reason:        "busId mismatch",
          firestoreBusId: fsDoc.busId,
          redisBusId:     redisVal.busId,
        });
        return;
      }

      // ── uid consistency ────────────────────────────────────────────────
      // The Redis key uses the Firestore doc ID (student-001, parent-001, etc.)
      // The Firestore doc should have a uid field — just log if it's absent
      // (older docs may not have it yet).
      if (!fsDoc.uid) {
        results.mismatches.push({
          key, id,
          collection: fsCol,
          reason: "Firestore document missing uid field (created before uid was added)",
        });
        return;
      }

      results.ok.push({ key, id, collection: fsCol, busId: fsDoc.busId });
    }));

    console.log(`🔍 Redis Audit: ${results.ok.length} OK, ${results.mismatches.length} mismatches, ${results.orphans.length} orphans, ${results.stale.length} stale`);
    return res.json({
      auditTime:    new Date().toISOString(),
      summary: {
        total:      results.total,
        ok:         results.ok.length,
        mismatches: results.mismatches.length,
        orphans:    results.orphans.length,
        stale:      results.stale.length,
      },
      mismatches: results.mismatches,
      orphans:    results.orphans,
      stale:      results.stale,
    });
  } catch (e) {
    console.log("❌ AUDIT ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

/* ==========================================================================
   REPORT / MIS ANALYTICS APIs — Institution-Isolated
   All endpoints use resolveInstitutionFilter() for strict server-side filtering.
   Regular admin: forced to their JWT institution.
   Superadmin: can query any institution or all.
   ========================================================================== */

// ── GET /admin/report/students ───────────────────────────────────────────────
app.get("/admin/report/students", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    let query = admin.firestore().collection("students");
    if (inst) query = query.where("institution", "==", inst);
    const snap = await query.get();
    const students = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Aggregations
    const branchWise = {}, yearWise = {}, courseWise = {}, classWise = {}, busWise = {}, cityWise = {};
    students.forEach(s => {
      if (s.branch) branchWise[s.branch] = (branchWise[s.branch] || 0) + 1;
      if (s.year) yearWise[s.year] = (yearWise[s.year] || 0) + 1;
      if (s.course) courseWise[s.course] = (courseWise[s.course] || 0) + 1;
      if (s.class) classWise[s.class] = (classWise[s.class] || 0) + 1;
      if (s.busId) busWise[s.busId] = (busWise[s.busId] || 0) + 1;
      if (s.city) cityWise[s.city] = (cityWise[s.city] || 0) + 1;
    });

    return res.json({
      success: true, institution: inst || "all",
      total: students.length,
      branchWise, yearWise, courseWise, classWise, busWise, cityWise,
      students,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/report/faculty ────────────────────────────────────────────────
app.get("/admin/report/faculty", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    let query = admin.firestore().collection("faculty");
    if (inst) query = query.where("institution", "==", inst);
    const snap = await query.get();
    const faculty = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const departmentWise = {}, busWise = {}, cityWise = {};
    faculty.forEach(f => {
      const dept = f.department || f.branch || "General";
      departmentWise[dept] = (departmentWise[dept] || 0) + 1;
      if (f.busId) busWise[f.busId] = (busWise[f.busId] || 0) + 1;
      if (f.city) cityWise[f.city] = (cityWise[f.city] || 0) + 1;
    });

    return res.json({
      success: true, institution: inst || "all",
      total: faculty.length,
      departmentWise, busWise, cityWise,
      faculty,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/report/parents ────────────────────────────────────────────────
app.get("/admin/report/parents", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    let query = admin.firestore().collection("parents");
    if (inst) query = query.where("institution", "==", inst);
    const snap = await query.get();
    const parents = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const busWise = {}, cityWise = {};
    parents.forEach(p => {
      if (p.busId) busWise[p.busId] = (busWise[p.busId] || 0) + 1;
      if (p.city) cityWise[p.city] = (cityWise[p.city] || 0) + 1;
    });

    return res.json({
      success: true, institution: inst || "all",
      total: parents.length,
      busWise, cityWise,
      parents,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/report/attendance ─────────────────────────────────────────────
app.get("/admin/report/attendance", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);
    const { dateFrom, dateTo, busId, branch } = req.query;
    const today = new Date().toISOString().split("T")[0];

    // Get institution's student IDs for filtering
    let studentsQuery = admin.firestore().collection("students");
    if (inst) studentsQuery = studentsQuery.where("institution", "==", inst);
    const studentsSnap = await studentsQuery.get();
    const studentMap = {};
    studentsSnap.docs.forEach(d => { studentMap[d.id] = d.data(); });
    const studentIds = new Set(Object.keys(studentMap));

    // Get attendance records
    let attQuery = admin.firestore().collection("attendance");
    if (dateFrom) attQuery = attQuery.where("date", ">=", dateFrom);
    else attQuery = attQuery.where("date", "==", dateTo || today);
    if (dateTo && dateFrom) attQuery = attQuery.where("date", "<=", dateTo);
    const attSnap = await attQuery.get();

    let records = attSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Filter by institution's students
    if (inst) records = records.filter(r => studentIds.has(r.studentId));
    // Optional filters
    if (busId) records = records.filter(r => r.busId === busId);
    if (branch) records = records.filter(r => studentMap[r.studentId]?.branch === branch);

    // Aggregations
    const total = records.length;
    const present = records.filter(r => r.present === true).length;
    const boarded = records.filter(r => r.present !== undefined).length;
    const exited = records.filter(r => r.exited === true).length;
    const pct = studentIds.size > 0 ? Math.round((present / studentIds.size) * 100) : 0;

    const busWise = {}, dayWise = {}, branchWise = {};
    records.forEach(r => {
      if (r.busId) busWise[r.busId] = (busWise[r.busId] || 0) + (r.present ? 1 : 0);
      if (r.date) dayWise[r.date] = (dayWise[r.date] || 0) + (r.present ? 1 : 0);
      const sBranch = studentMap[r.studentId]?.branch || "Unknown";
      branchWise[sBranch] = (branchWise[sBranch] || 0) + (r.present ? 1 : 0);
    });

    return res.json({
      success: true, institution: inst || "all",
      totalStudents: studentIds.size,
      totalRecords: total, boarded, present, exited,
      attendancePercent: pct,
      busWise, dayWise, branchWise,
      records,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/report/buses ──────────────────────────────────────────────────
app.get("/admin/report/buses", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);

    // Routes for this institution
    let routesQuery = admin.firestore().collection("routes").where("status", "==", "Active");
    if (inst) routesQuery = routesQuery.where("routeType", "==", inst);
    const routesSnap = await routesQuery.get();
    const routes = routesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Users assigned to buses
    let studentsQuery = admin.firestore().collection("students");
    if (inst) studentsQuery = studentsQuery.where("institution", "==", inst);
    const studentsSnap = await studentsQuery.get();

    let facultyQuery = admin.firestore().collection("faculty");
    if (inst) facultyQuery = facultyQuery.where("institution", "==", inst);
    const facultySnap = await facultyQuery.get();

    const busUserCount = {};
    [...studentsSnap.docs, ...facultySnap.docs].forEach(d => {
      const busId = d.data().busId;
      if (busId) busUserCount[busId] = (busUserCount[busId] || 0) + 1;
    });

    // KM history (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const kmSnap = await admin.firestore().collection("bus_km_history")
      .where("date", ">=", thirtyDaysAgo.toISOString().split("T")[0])
      .get();
    const kmData = kmSnap.docs.map(d => d.data());

    // Filter KM by institution's buses
    const instBusIds = new Set(routes.map(r => r.busId));
    const filteredKm = inst ? kmData.filter(k => instBusIds.has(k.busId)) : kmData;

    // Per-bus aggregation
    const busReport = {};
    routes.forEach(r => {
      if (!busReport[r.busId]) {
        busReport[r.busId] = {
          busId: r.busId, routeName: r.routeName, cities: (r.cities || []).map(c => c.name),
          totalStops: (r.cities || []).length, usersAssigned: busUserCount[r.busId] || 0,
          totalKm30d: 0, avgKmPerDay: 0, daysActive: 0,
        };
      }
    });
    filteredKm.forEach(k => {
      if (busReport[k.busId]) {
        busReport[k.busId].totalKm30d += Number(k.totalKm || 0);
        busReport[k.busId].daysActive++;
      }
    });
    Object.values(busReport).forEach(b => {
      b.avgKmPerDay = b.daysActive > 0 ? Math.round(b.totalKm30d / b.daysActive) : 0;
      b.totalKm30d = Math.round(b.totalKm30d);
    });

    // City-wise distribution
    const cityWise = {};
    routes.forEach(r => {
      (r.cities || []).forEach(c => {
        if (c.name) cityWise[c.name] = (cityWise[c.name] || 0) + 1;
      });
    });

    return res.json({
      success: true, institution: inst || "all",
      totalRoutes: routes.length,
      totalBuses: Object.keys(busReport).length,
      busReport: Object.values(busReport),
      cityWise,
      kmHistory: filteredKm,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/report/analytics (combined overview) ──────────────────────────
app.get("/admin/report/analytics", adminAuth, async (req, res) => {
  try {
    const inst = resolveInstitutionFilter(req, req.query.institution);

    // Parallel queries
    let sQ = admin.firestore().collection("students");
    let fQ = admin.firestore().collection("faculty");
    let pQ = admin.firestore().collection("parents");
    let rQ = admin.firestore().collection("routes").where("status", "==", "Active");
    if (inst) {
      sQ = sQ.where("institution", "==", inst);
      fQ = fQ.where("institution", "==", inst);
      pQ = pQ.where("institution", "==", inst);
      rQ = rQ.where("routeType", "==", inst);
    }

    const [sSnap, fSnap, pSnap, rSnap] = await Promise.all([sQ.get(), fQ.get(), pQ.get(), rQ.get()]);

    const today = new Date().toISOString().split("T")[0];
    const attSnap = await admin.firestore().collection("attendance").where("date", "==", today).get();
    const studentIds = new Set(sSnap.docs.map(d => d.id));
    const todayAtt = attSnap.docs.filter(d => studentIds.has(d.data().studentId));
    const presentToday = todayAtt.filter(d => d.data().present === true).length;

    return res.json({
      success: true, institution: inst || "all",
      overview: {
        totalStudents: sSnap.size,
        totalFaculty: fSnap.size,
        totalParents: pSnap.size,
        totalRoutes: rSnap.size,
        totalBuses: new Set(rSnap.docs.map(d => d.data().busId)).size,
        presentToday,
        attendancePercent: sSnap.size > 0 ? Math.round((presentToday / sSnap.size) * 100) : 0,
      },
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});


/* ==========================================================================
   BUS PASS MANAGEMENT APIs
   ========================================================================== */

function busPassAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.buspass && decoded.role !== "bus_pass_admin") throw new Error();
    req.buspassOperator = decoded.operator || decoded.role || "admin";
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/api/bus-pass/students", busPassAuth, async (req, res) => {
  try {
    const snap = await admin.firestore().collection("students").where("studentType", "==", "college").get();
    const students = snap.docs.map(d => {
      const data = d.data();
      let status = "pending";
      if (data.verifiedForBusPass === true) {
        if (data.busPassExpiry && new Date(data.busPassExpiry) < new Date()) status = "expired";
        else status = "verified";
      }
      return { id: d.id, name: data.name||"", rollNumber: data.rollNumber||"", branch: data.branch||"", course: data.course||"", year: data.year||data.academicYear||"", busId: data.busId||"", busPassId: data.busPassId||null, verifiedForBusPass: data.verifiedForBusPass||false, verifiedAt: data.verifiedAt||null, busPassExpiry: data.busPassExpiry||null, session: data.session||"", status };
    });
    return res.json({ success: true, total: students.length, verified: students.filter(s=>s.status==="verified").length, pending: students.filter(s=>s.status==="pending").length, expired: students.filter(s=>s.status==="expired").length, students });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/api/bus-pass/verify/:studentId", busPassAuth, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { expiryDate, session } = req.body;
    const studentRef = admin.firestore().collection("students").doc(studentId);
    const studentDoc = await studentRef.get();
    if (!studentDoc.exists) return res.status(404).json({ error: "Student not found" });
    const studentData = studentDoc.data();
    let passId = studentData.busPassId;
    if (!passId) {
      const counterRef = admin.firestore().collection("settings").doc("passCounter");
      const counterDoc = await counterRef.get();
      let lastNumber = counterDoc.exists ? (counterDoc.data().lastNumber || 0) : 0;
      lastNumber++;
      await counterRef.set({ lastNumber }, { merge: true });
      passId = "SCEP-" + String(lastNumber).padStart(4, "0");
    }
    const expiry = expiryDate || (() => { const now = new Date(); const aug1 = new Date(now.getFullYear(), 7, 1); return (now < aug1 ? aug1 : new Date(now.getFullYear() + 1, 7, 1)).toISOString().split("T")[0]; })();
    await studentRef.update({ verifiedForBusPass: true, busPassId: passId, verifiedAt: admin.firestore.FieldValue.serverTimestamp(), verifiedBy: req.buspassOperator, busPassExpiry: expiry, session: session || studentData.session || "" });
    // Notify student
    await createUserNotification(req.params.studentId, "bus_pass", "Bus Pass Verified!", "Your bus pass has been verified and is now active.", { passId, expiry });
    return res.json({ success: true, passId, expiry, message: "Student verified" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/api/bus-pass/renew/:studentId", busPassAuth, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { expiryDate } = req.body;
    const expiry = expiryDate || (() => { const now = new Date(); const aug1 = new Date(now.getFullYear(), 7, 1); return (now < aug1 ? aug1 : new Date(now.getFullYear() + 1, 7, 1)).toISOString().split("T")[0]; })();
    await admin.firestore().collection("students").doc(studentId).update({ verifiedForBusPass: true, busPassExpiry: expiry, verifiedAt: admin.firestore.FieldValue.serverTimestamp(), verifiedBy: req.buspassOperator });
    return res.json({ success: true, expiry, message: "Pass renewed" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/api/bus-pass/revoke/:studentId", busPassAuth, async (req, res) => {
  try {
    await admin.firestore().collection("students").doc(req.params.studentId).update({ verifiedForBusPass: false });
    return res.json({ success: true, message: "Pass revoked" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   BUS PASS — PDF Data, Download Token, Expiry Reminder, Anti-Sharing
═══════════════════════════════════════════════════════════════════════════════ */

// GET /api/bus-pass/pdf-data/:studentId — Returns structured pass data for PDF generation
// Client generates PDF locally using this data (no server-side PDF rendering needed)
app.get("/api/bus-pass/pdf-data/:studentId", authenticateFirebaseUser, async (req, res) => {
  try {
    const { studentId } = req.params;
    const doc = await admin.firestore().collection("students").doc(studentId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Student not found" });
    const d = doc.data();
    if (d.uid !== req.firebaseUid) return res.status(403).json({ success: false, error: "Access denied" });
    if (!d.verifiedForBusPass) return res.status(400).json({ success: false, error: "Pass not verified" });

    // Generate a one-time download token (prevents screenshot sharing — token is unique per request)
    const downloadToken = crypto.randomBytes(16).toString("hex");
    const tokenExpiry = Date.now() + 5 * 60 * 1000; // Valid for 5 minutes

    // Store token temporarily in Redis
    if (redisReady) {
      await redis.setEx(`pass_download:${downloadToken}`, 300, JSON.stringify({ studentId, uid: req.firebaseUid }));
    }

    return res.json({
      success: true,
      pass: {
        studentName: d.name || "",
        rollNumber: d.rollNumber || "",
        course: (d.course || "").toUpperCase(),
        branch: d.branch || "",
        year: d.year || "",
        busId: d.busId || "",
        city: d.city || "",
        busPassId: d.busPassId || "",
        busPassExpiry: d.busPassExpiry || "",
        session: d.session || "",
        institution: d.institution || "college",
        passPhotoUrl: d.passPhotoUrl || null,
        verifiedAt: d.verifiedAt || null,
      },
      downloadToken,
      tokenExpiry,
      // Anti-sharing: embed user-specific watermark text in the PDF
      watermarkText: `${d.name} | ${d.rollNumber} | ${d.busPassId}`,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/bus-pass/verify-download — Verify a download token is valid (anti-sharing)
app.post("/api/bus-pass/verify-download", authenticateFirebaseUser, async (req, res) => {
  try {
    const { downloadToken } = req.body;
    if (!downloadToken) return res.status(400).json({ success: false, error: "Token required" });

    if (!redisReady) return res.json({ success: true, valid: true }); // Skip if Redis unavailable

    const cached = await redis.get(`pass_download:${downloadToken}`);
    if (!cached) return res.json({ success: false, valid: false, error: "Token expired or invalid" });

    const { uid } = cached;
    if (uid !== req.firebaseUid) return res.status(403).json({ success: false, error: "Token belongs to another user" });

    // Delete token after use (one-time use)
    await redis.del(`pass_download:${downloadToken}`);
    return res.json({ success: true, valid: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/bus-pass/expiry-check/:studentId — Check if pass is expiring soon
app.get("/api/bus-pass/expiry-check/:studentId", authenticateFirebaseUser, async (req, res) => {
  try {
    const { studentId } = req.params;
    const doc = await admin.firestore().collection("students").doc(studentId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Not found" });
    const d = doc.data();
    if (d.uid !== req.firebaseUid) return res.status(403).json({ success: false, error: "Access denied" });

    if (!d.busPassExpiry) return res.json({ success: true, expiring: false, expired: false });

    const expiryDate = new Date(d.busPassExpiry);
    const now = new Date();
    const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

    return res.json({
      success: true,
      busPassExpiry: d.busPassExpiry,
      daysLeft,
      expired: daysLeft <= 0,
      expiring: daysLeft > 0 && daysLeft <= 30, // Warning if within 30 days
      status: daysLeft <= 0 ? "expired" : daysLeft <= 30 ? "expiring_soon" : "active",
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Cron: Daily expiry reminder (8 AM) ──────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  try {
    console.log("[CRON] Checking bus pass expiry reminders...");
    const snap = await admin.firestore().collection("students")
      .where("verifiedForBusPass", "==", true)
      .get();

    let reminded = 0;
    const now = new Date();

    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.busPassExpiry) continue;
      const expiryDate = new Date(d.busPassExpiry);
      const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

      // Send reminders at 30, 15, 7, 3, 1 days before expiry
      if ([30, 15, 7, 3, 1].includes(daysLeft)) {
        await createUserNotification(doc.id, "bus_pass",
          "Bus Pass Expiring Soon",
          `Your bus pass expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Contact administration for renewal.`,
          { daysLeft, expiry: d.busPassExpiry });
        reminded++;
      }

      // Mark as expired if past date
      if (daysLeft <= 0 && d.verifiedForBusPass) {
        await doc.ref.update({ verifiedForBusPass: false });
      }
    }

    if (reminded > 0) console.log(`[CRON] Sent ${reminded} expiry reminders`);
  } catch (e) {
    console.log("[CRON] Expiry check error:", e.message);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   LIVE TRACKING — Route Polyline, Replay, Speed Warning, Bus Offline Detection
═══════════════════════════════════════════════════════════════════════════════ */

// GET /api/tracking/route-polyline/:busId — Get route stops as polyline coordinates
app.get("/api/tracking/route-polyline/:busId", async (req, res) => {
  try {
    const { busId } = req.params;
    const normalizedBusId = busId.startsWith("BUS-") ? busId : `BUS-${busId}`;

    // Fetch from route cache or Firestore
    const snap = await admin.firestore().collection("routes")
      .where("busId", "==", normalizedBusId)
      .where("status", "==", "Active")
      .limit(1)
      .get();

    if (snap.empty) return res.json({ success: true, polyline: [], stops: [] });

    const route = snap.docs[0].data();
    const cities = route.cities || [];
    const stops = cities.map(c => ({
      name: c.name || "",
      lat: parseFloat(c.lat) || 0,
      lng: parseFloat(c.lng) || 0,
    })).filter(s => s.lat !== 0 && s.lng !== 0);

    // Polyline is the ordered lat/lng array
    const polyline = stops.map(s => ({ lat: s.lat, lng: s.lng }));

    return res.json({
      success: true,
      routeName: route.routeName || "",
      busId: normalizedBusId,
      polyline,
      stops,
      totalStops: stops.length,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tracking/replay/:busId — Get GPS history for trip replay (last trip)
app.get("/api/tracking/replay/:busId", async (req, res) => {
  try {
    const { busId } = req.params;
    const normalizedBusId = busId.startsWith("BUS-") ? busId : `BUS-${busId}`;

    // Fetch GPS history from Redis (stored during active tracking)
    if (!redisReady) return res.json({ success: true, points: [], message: "Replay unavailable (cache offline)" });

    const cached = await redis.get(`lastBusGps:${normalizedBusId}`);
    if (!cached) return res.json({ success: true, points: [], message: "No GPS history available" });

    const history = Array.isArray(cached) ? cached : [];

    return res.json({
      success: true,
      busId: normalizedBusId,
      points: history, // Array of {lat, lng, speed, timestamp}
      totalPoints: history.length,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tracking/speed-status/:busId — Current speed + warning if excessive
app.get("/api/tracking/speed-status/:busId", async (req, res) => {
  try {
    const { busId } = req.params;
    const normalizedBusId = busId.startsWith("BUS-") ? busId : `BUS-${busId}`;

    // Find current bus data from in-memory latestBuses
    const bus = latestBuses.find(b => (b.busId || "") === normalizedBusId);
    if (!bus) return res.json({ success: true, speed: 0, warning: false, status: "offline" });

    const speed = parseFloat(bus.speed) || 0;
    const SPEED_LIMIT = 60; // km/h — configurable

    return res.json({
      success: true,
      busId: normalizedBusId,
      speed: Math.round(speed * 10) / 10,
      speedLimit: SPEED_LIMIT,
      warning: speed > SPEED_LIMIT,
      status: speed > 0 ? "moving" : "stopped",
      lastUpdate: bus.lastUpdate || bus.timestamp || null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tracking/bus-status — All buses with online/offline detection
app.get("/api/tracking/bus-status", async (req, res) => {
  try {
    const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without update = offline
    const now = Date.now();

    const statuses = latestBuses.map(bus => {
      const lastUpdateMs = bus.timestamp ? new Date(bus.timestamp).getTime() :
                           bus.lastUpdate ? new Date(bus.lastUpdate).getTime() : 0;
      const msSinceUpdate = lastUpdateMs > 0 ? now - lastUpdateMs : Infinity;
      const isOnline = msSinceUpdate < OFFLINE_THRESHOLD_MS;
      const speed = parseFloat(bus.speed) || 0;

      return {
        busId: bus.busId || "",
        lat: bus.lat || 0,
        lng: bus.lng || 0,
        speed: Math.round(speed * 10) / 10,
        isOnline,
        isMoving: speed > 2,
        lastUpdateMs,
        offlineFor: isOnline ? 0 : Math.floor(msSinceUpdate / 1000), // seconds offline
        routeType: bus.routeType || "college",
      };
    });

    const online = statuses.filter(s => s.isOnline).length;
    const offline = statuses.filter(s => !s.isOnline).length;

    return res.json({
      success: true,
      buses: statuses,
      summary: { total: statuses.length, online, offline },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/tracking/reconnect-info — WebSocket reconnection guidance
app.get("/api/tracking/reconnect-info", (req, res) => {
  return res.json({
    success: true,
    wsUrl: "wss://bustracker.satpudaengineeringcollege.com/ws",
    reconnectStrategy: {
      initialDelay: 1000,
      maxDelay: 30000,
      multiplier: 2,
      maxRetries: 10,
    },
    heartbeatInterval: 30000,
  });
});

// ------------------------------------------------------------------------------
// FIREBASE ID TOKEN MIDDLEWARE (reusable — verifies token, attaches req.firebaseUid)
// ------------------------------------------------------------------------------
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
    console.log("[AUTH] ❌ Token verification failed:", e.message);
    return res.status(401).json({ error: "Invalid or expired authentication token" });
  }
}

// HYBRID AUTH MIDDLEWARE — Accepts Firebase Token OR Admin JWT
// Used by endpoints that both Flutter users AND admin panel access
// --------------------------------------------------------------------------
async function authenticateAny(req, res, next) {
  const authHeader = req.headers.authorization || "";
  // Try Admin JWT first (no "Bearer " prefix)
  if (authHeader && !authHeader.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(authHeader, process.env.JWT_SECRET);
      if (decoded.admin) { req.isAdmin = true; req.adminRole = decoded.role || "admin"; return next(); }
    } catch (_) {}
  }
  // Try Firebase ID Token
  if (authHeader.startsWith("Bearer ")) {
    try {
      const idToken = authHeader.slice(7);
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.firebaseUid = decoded.uid;
      req.isAdmin = false;
      return next();
    } catch (_) {}
  }
  return res.status(401).json({ error: "Authentication required" });
}

// -- GET /api/bus-pass/student/:studentId � secured with Firebase ID Token ----
app.get("/api/bus-pass/student/:studentId", authenticateFirebaseUser, async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId || !studentId.startsWith("student-")) {
      return res.status(400).json({ error: "Invalid student ID format" });
    }
    const doc = await admin.firestore().collection("students").doc(studentId).get();
    if (!doc.exists) return res.status(404).json({ error: "Student not found" });
    const d = doc.data();
    // Ownership: verified UID must match document UID
    if (d.uid !== req.firebaseUid) {
      return res.status(403).json({ error: "Access denied � you can only view your own pass" });
    }
    let status = "pending";
    if (d.verifiedForBusPass === true) {
      status = (d.busPassExpiry && new Date(d.busPassExpiry) < new Date()) ? "expired" : "verified";
    }
    return res.json({ success: true, pass: {
      name: d.name||"", rollNumber: d.rollNumber||"", branch: d.branch||"",
      course: d.course||"", year: d.year||d.academicYear||"", busId: d.busId||"",
      city: d.city||"", busPassId: d.busPassId||null, verifiedForBusPass: d.verifiedForBusPass||false,
      busPassExpiry: d.busPassExpiry||null, session: d.session||"", status,
      passPhotoUrl: d.passPhotoUrl||null, photoChangeCount: d.photoChangeCount||0, photoChangeLimit: 3,
    }});
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ------------------------------------------------------------------------------
// SECURE PHOTO UPLOAD � Firebase Token + Server-enforced limit + Admin SDK Storage
// ------------------------------------------------------------------------------
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const ALLOWED_IMG_EXT = [".jpg",".jpeg",".png",".webp",".heic",".heif",".gif",".bmp",".tif",".tiff",".avif"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB raw (will be compressed before saving)
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    console.log(`[PHOTO] name=${file.originalname} mime=${file.mimetype} ext=${ext} size=${file.size||"pending"}`);
    if (ALLOWED_IMG_EXT.includes(ext)) return cb(null, true);
    // Fallback: no extension but mime starts with image/ � accept
    if (!ext && file.mimetype && file.mimetype.startsWith("image/")) return cb(null, true);
    // Fallback: common Android issue � octet-stream with no ext � accept anyway
    if (file.mimetype === "application/octet-stream") return cb(null, true);
    return cb(new Error("Unsupported image format: " + (ext || file.mimetype || "unknown")), false);
  },
});

app.post("/api/bus-pass/photo-upload", upload.single("photo"), authenticateFirebaseUser, async (req, res) => {
  try {
    console.log("[BACKEND UPLOAD] ═══ REQUEST RECEIVED ═══");
    console.log("[BACKEND 1] uid:", req.firebaseUid);
    console.log("[BACKEND 2] req.file exists:", !!req.file);
    if (!req.file) return res.status(400).json({ error: "No photo file provided" });
    console.log("[BACKEND 3] originalname:", req.file.originalname);
    console.log("[BACKEND 3] mimetype:", req.file.mimetype);
    console.log("[BACKEND 3] size:", req.file.size);
    console.log("[BACKEND 3] buffer.length:", req.file.buffer?.length);
    console.log("[BACKEND 3] encoding:", req.file.encoding);
    console.log("[BACKEND 3] fieldname:", req.file.fieldname);
    // Find student by VERIFIED UID (from middleware — cannot be forged)
    const snap = await admin.firestore().collection("students")
      .where("uid", "==", req.firebaseUid).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: "Student not found for this account" });
    const studentDoc = snap.docs[0];
    const studentId = studentDoc.id;
    const d = studentDoc.data();
    // SERVER-SIDE limit enforcement: hard limit of 3 photo uploads
    const currentYear = new Date().getFullYear();
    let count = d.photoChangeCount || 0;
    if ((d.photoChangeResetYear || 0) < currentYear) count = 0;
    console.log("[BACKEND 4] studentId:", studentId, "count:", count, "limit: 3");
    if (count >= 3) {
      console.log("[BACKEND 4] ❌ LIMIT REACHED. count >= 3");
      return res.status(429).json({
        error: "Maximum 3 photo uploads allowed",
        photoChangeCount: count,
        photoChangeLimit: 3,
      });
    }
    // Upload via Admin SDK ONLY (client has zero Storage access)
    const bucket = admin.storage().bucket("scep-bus.firebasestorage.app");
    const filePath = `bus-pass-photos/${req.firebaseUid}/profile.jpg`;
    const file = bucket.file(filePath);
    console.log("[BACKEND 5] bucket:", bucket.name, "path:", filePath);
    // Compress image with Sharp before saving (resize, quality, strip metadata)
    console.log("[BACKEND 6] Starting sharp compression... buffer.length:", req.file.buffer.length);
    const compressed = await sharp(req.file.buffer)
      .rotate() // auto-rotate based on EXIF
      .resize({ width: 1080, withoutEnlargement: true }) // max 1080px wide
      .jpeg({ quality: 80 }) // convert to JPEG, quality 80
      .toBuffer();
    console.log(`[BACKEND 7] ✅ Sharp success. ${req.file.buffer.length} → ${compressed.length} bytes`);
    console.log("[BACKEND 8] Uploading to Firebase Storage...");
    await file.save(compressed, { metadata: { contentType: "image/jpeg" }, public: false });
    console.log("[BACKEND 8] ✅ Storage upload complete");
    // Generate signed URL (7 days — refreshed via /photo-url endpoint)
    console.log("[BACKEND 9] Generating signed URL...");
    const [signedUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 7*24*60*60*1000 });
    console.log("[BACKEND 9] ✅ Signed URL generated");
    // Upload succeeded — increment photoChangeCount
    count++;
    const updateData = {
      passPhotoUrl: signedUrl,
      passPhotoPath: filePath,
      photoChangeCount: count,
      photoChangeResetYear: currentYear,
      photoUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    console.log("[BACKEND 10] Updating Firestore... photoChangeCount:", count);
    await admin.firestore().collection("students").doc(studentId).update(updateData);
    console.log("[BACKEND 10] ✅ Firestore updated");
    console.log(`[BACKEND 11] ✅ SUCCESS. studentId=${studentId} count=${count}/3`);
    return res.json({
      success: true,
      photoUrl: signedUrl,
      photoChangeCount: count,
      photoChangeLimit: 3,
    });
  } catch (e) {
    console.log("[BACKEND] ❌ EXCEPTION:", e.message);
    console.log("[BACKEND] ❌ STACK:", e.stack);
    if (req.file) {
      console.log("[BACKEND] ❌ File context: name=", req.file.originalname, "mime=", req.file.mimetype, "size=", req.file.size, "bufferLen=", req.file.buffer?.length);
    }
    return res.status(500).json({ error: e.message });
  }
});

// -- GET /api/bus-pass/photo-url/:studentId � refresh signed URL ---------------
// Owner (Firebase Token) OR Admin (JWT) can request
app.get("/api/bus-pass/photo-url/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    const doc = await admin.firestore().collection("students").doc(studentId).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });
    const d = doc.data();
    // Auth: Firebase Token for students, JWT for admins
    let authorized = false;
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        if (decoded.uid === d.uid) authorized = true;
      } catch (_) {}
    }
    if (!authorized) {
      // Try admin JWT
      try { const decoded = jwt.verify(authHeader, process.env.JWT_SECRET); if (decoded.admin) authorized = true; } catch(_){}
    }
    if (!authorized) return res.status(403).json({ error: "Access denied" });
    if (!d.passPhotoPath) return res.json({ success: true, photoUrl: null });
    const bucket = admin.storage().bucket("scep-bus.firebasestorage.app");
    const [exists] = await bucket.file(d.passPhotoPath).exists();
    if (!exists) return res.json({ success: true, photoUrl: null });
    const [url] = await bucket.file(d.passPhotoPath).getSignedUrl({ action: "read", expires: Date.now() + 7*24*60*60*1000 });
    return res.json({ success: true, photoUrl: url });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});


// Multer / upload error handler � returns JSON instead of HTML
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "File too large (max 2MB)" });
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err && err.message) return res.status(400).json({ success: false, error: err.message });
  next(err);
});
/* =========================
   PROCESS CRASH SAFETY & GRACEFUL SHUTDOWN
========================= */

// ── Error Classification ────────────────────────────────────────────────────
function classifyError(err) {
  if (!err) return "UNKNOWN";
  const msg = (err.message || "").toLowerCase();
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("etimedout")) return "NETWORK";
  if (msg.includes("firebase") || msg.includes("firestore")) return "FIREBASE";
  if (msg.includes("redis") || msg.includes("econnreset")) return "REDIS";
  if (msg.includes("jwt") || msg.includes("token")) return "AUTH";
  if (msg.includes("enomem") || msg.includes("heap")) return "MEMORY";
  return "APPLICATION";
}

// ── Memory Leak Detection ───────────────────────────────────────────────────
const HEAP_THRESHOLD_MB = 450; // warn if heap exceeds this (512M max_memory_restart in PM2)
let consecutiveHighHeap = 0;
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1048576);
  if (heapMB > HEAP_THRESHOLD_MB) {
    consecutiveHighHeap++;
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "WARN", type: "MEMORY", heapMB, consecutive: consecutiveHighHeap }));
    if (consecutiveHighHeap >= 5) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "CRITICAL", type: "MEMORY_LEAK", heapMB, msg: "Possible memory leak — 5 consecutive high heap readings" }));
      // Force GC if available (node --expose-gc)
      if (global.gc) global.gc();
    }
  } else {
    consecutiveHighHeap = 0;
  }
}, 30000); // every 30s

process.on("unhandledRejection", (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "ERROR", type: classifyError(err), event: "unhandledRejection", message: err.message, stack: err.stack }));
});
process.on("uncaughtException", (err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "FATAL", type: classifyError(err), event: "uncaughtException", message: err.message, stack: err.stack }));
  // Give logs time to flush, then exit (PM2 will restart)
  setTimeout(() => process.exit(1), 1000);
});

// ── Graceful Shutdown ───────────────────────────────────────────────────────
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "INFO", event: "shutdown", signal }));
  
  // Stop accepting new connections
  server.close(() => { console.log("HTTP server closed"); });
  
  // Close WebSocket server
  wss.clients.forEach((client) => { try { client.close(1001, "Server shutting down"); } catch (_) {} });
  wss.close();
  
  // Close Redis
  redis.client.quit().catch(() => {});
  
  // Exit after 5s max (matches PM2 kill_timeout)
  setTimeout(() => { console.log("Forced exit after timeout"); process.exit(0); }, 5000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

/* =========================
   SERVER
========================= */
const server = app.listen(3000, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "INFO", event: "startup", port: 3000, node: process.version, pid: process.pid }));
  preWarmRouteCache().catch((e) => console.log("Route pre-warm error:", e.message));
});
