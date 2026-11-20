/**
 * SCEP App Usage Analytics (independent module)
 *
 * Mounted from bus-tracking/index.js (before the existing POST /admin/login route):
 *     const appUsage = require("./src/appUsage").createAppUsageRouter({ admin, jwt, bcrypt, express });
 *     app.use("/app-usage", appUsage);
 *     app.post("/admin/login", appUsage.loginInterceptor);   // falls through to the untouched admin login
 * (the existing "/api" prefix rewrite in index.js maps /api/app-usage/* to /app-usage/*).
 *
 * Nothing here touches GPS / WebSocket / bus-tracking code paths.
 *
 * Collections written (Admin SDK only; the Firestore catch-all rule already denies all client access):
 *   appUsageDaily/{uid}_{YYYY-MM-DD}   one aggregate per user per IST day
 *   appUsageAdmin/credentials          created on the first successful initial login, updated on password change (bcrypt hash only)
 *
 * Public (Firebase-token) endpoint:   POST /app-usage/open
 * Appcount (shared admin login, HttpOnly cookie session):
 *   POST /admin/login (interceptor)  GET /app-usage/admin/session  POST /app-usage/admin/change-password
 *   POST /app-usage/admin/logout     GET /app-usage/admin/report   GET /app-usage/admin/export
 */
"use strict";

const crypto = require("crypto");

// ─────────────────────────────── constants ────────────────────────────────
const COLLECTION = "appUsageDaily";
const ADMIN_COLLECTION = "appUsageAdmin";
const ADMIN_DOC = "credentials";
const IST_OFFSET_MS = 330 * 60 * 1000; // Asia/Kolkata, no DST
const MAX_DAILY_OPENS = 500; // per user per day; anything above is ignored (abuse guard)
const MAX_RECENT_EVENT_IDS = 50; // idempotency keys kept inside the daily doc
const AD_FORMATS = ["banner", "interstitial", "rewarded"];
const AD_EVENT_KEYS = ["eventId", "format", "occurredAt"];
const MAX_AD_BATCH = 50; // impressions per request
const MAX_AD_EVENT_IDS = 400; // ad idempotency keys kept per daily doc (~10 KB)
const MAX_DAILY_AD_IMPRESSIONS = 2000; // per user per day; above this is ignored (abuse guard)
const MAX_EVENT_AGE_MS = 48 * 3600 * 1000; // offline retries older than this use server time
const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;
const PROFILE_TTL_MS = 12 * 3600 * 1000;
const PROFILE_CACHE_MAX = 6000;
const MAX_RANGE_DAYS = 366;
const SESSION_TTL_SECONDS = 60 * 60; // Appcount session length
const COOKIE_NAME = "scep_appusage";
const EVENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PROFILE_SOURCES = {
  students: "student",
  faculty: "faculty",
  parents: "parent",
};
const HINT_TO_COLLECTION = { student: "students", faculty: "faculty", parent: "parents" };

const COURSE_LABELS = { btech: "BTech", poly: "Polytechnic", iti: "ITI", bed: "B.Ed", deled: "D.El.Ed" };

// ─────────────────────────────── pure helpers ─────────────────────────────
/** YYYY-MM-DD for the given epoch ms in Asia/Kolkata. */
function istDateKey(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

function isValidDateKey(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dateKeyToUtcMs(s) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 0 = Sunday ... 6 = Saturday (calendar weekday of the IST date key). */
function weekdayOfDateKey(s) {
  return new Date(dateKeyToUtcMs(s)).getUTCDay();
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function yearLabel(y) {
  const s = String(y || "").trim();
  if (!s) return "";
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return s;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix} Year`;
}

function courseLabel(c) {
  const k = String(c || "").trim();
  if (!k) return "";
  return COURSE_LABELS[k.toLowerCase()] || k.toUpperCase();
}

function cleanStr(v, max = 120) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/** Maps a raw Firestore profile document into the trusted analytics snapshot. */
function profileSnapshot(collection, data) {
  const userType = PROFILE_SOURCES[collection];
  let institution = cleanStr(data.institution, 20).toLowerCase();
  if (institution !== "college" && institution !== "school") {
    const ft = cleanStr(data.facultyType, 20).toLowerCase();
    if (ft === "college" || ft === "school") institution = ft;
    else if (collection === "students") institution = "college"; // only college students exist
    else institution = "unknown";
  }
  return {
    userName: cleanStr(data.name || data.userName, 80),
    mobile: cleanStr(data.mobile, 20),
    institution,
    userType,
    course: userType === "student" ? cleanStr(data.course, 30).toLowerCase() : "",
    year: userType === "student" ? cleanStr(data.year, 10) : "",
  };
}

// ─────────────────────────────── small in-memory limiters ─────────────────
function createSlidingLimiter(max, windowMs) {
  const hits = new Map(); // key -> [timestamps]
  return {
    /** returns 0 if allowed, otherwise retry-after seconds */
    hit(key, now = Date.now()) {
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
      }
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > 20000) {
        for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
      return 0;
    },
    peek(key, now = Date.now()) {
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      return arr.length >= max ? Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) : 0;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// ─────────────────────────────── password policy ──────────────────────────
function validateNewPassword(pw, currentPw) {
  if (typeof pw !== "string") return "New password is required";
  if (pw.length < 10) return "New password must be at least 10 characters";
  if (pw.length > 128) return "New password is too long";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
    return "New password must contain upper-case, lower-case letters and a digit";
  }
  if (pw.toLowerCase().includes("appcount")) return "New password must not contain the username";
  if (pw === currentPw) return "New password must differ from the current password";
  return null;
}

// ─────────────────────────────── report / filter logic ────────────────────
function parseReportQuery(q, todayKey) {
  const err = (m) => ({ error: m });
  const from = String(q.from || todayKey);
  const to = String(q.to || from);
  if (!isValidDateKey(from) || !isValidDateKey(to)) return err("Invalid date. Use YYYY-MM-DD");
  if (from > to) return err("Start date must not be after end date");
  const days = (dateKeyToUtcMs(to) - dateKeyToUtcMs(from)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) return err(`Date range too large (max ${MAX_RANGE_DAYS} days)`);

  const institution = String(q.institution || "all").toLowerCase();
  if (!["all", "college", "school"].includes(institution)) return err("Invalid institution");
  const userType = String(q.userType || "all").toLowerCase();
  if (!["all", "student", "faculty", "parent"].includes(userType)) return err("Invalid userType");
  const weekday = String(q.weekday || "all").toLowerCase();
  if (weekday !== "all" && !WEEKDAYS.includes(weekday)) return err("Invalid weekday");
  const sort = String(q.sort || "opens_desc");
  if (!["opens_desc", "opens_asc", "name_asc", "name_desc"].includes(sort)) return err("Invalid sort");
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  let pageSize = parseInt(q.pageSize, 10) || 25;
  pageSize = Math.min(100, Math.max(5, pageSize));

  return {
    from,
    to,
    institution,
    userType,
    course: cleanStr(q.course || "all", 30).toLowerCase() || "all",
    year: cleanStr(q.year || "all", 10).toLowerCase() || "all",
    weekday,
    search: cleanStr(q.search, 60).toLowerCase(),
    sort,
    page,
    pageSize,
  };
}

/** Daily rows -> filtered daily rows (everything except text search). */
function applyFilters(rows, f) {
  const wd = f.weekday === "all" ? -1 : WEEKDAYS.indexOf(f.weekday);
  return rows.filter((r) => {
    if (f.institution !== "all" && r.institution !== f.institution) return false;
    if (f.userType !== "all" && r.userType !== f.userType) return false;
    if (f.course !== "all" && r.course !== f.course) return false;
    if (f.year !== "all" && String(r.year).toLowerCase() !== f.year) return false;
    if (wd >= 0 && weekdayOfDateKey(r.dateKey) !== wd) return false;
    return true;
  });
}

/** Filtered daily rows -> one row per user (sums opens across all matching days). */
function aggregateByUser(rows) {
  const map = new Map();
  for (const r of rows) {
    let a = map.get(r.uid);
    if (!a) {
      a = {
        uid: r.uid,
        userName: r.userName,
        mobile: r.mobile,
        institution: r.institution,
        userType: r.userType,
        course: r.course,
        year: r.year,
        openCount: 0,
        adBanner: 0,
        adInterstitial: 0,
        adRewarded: 0,
        firstOpenedAt: r.firstOpenedAt,
        lastOpenedAt: r.lastOpenedAt,
        minDate: r.dateKey,
        maxDate: r.dateKey,
        activeDays: 0,
        _profileDate: r.dateKey,
      };
      map.set(r.uid, a);
    }
    a.openCount += r.openCount;
    a.adBanner += r.adBanner || 0;
    a.adInterstitial += r.adInterstitial || 0;
    a.adRewarded += r.adRewarded || 0;
    if (r.openCount > 0) a.activeDays += 1; // a day with only ad impressions is not an "active day"
    if (r.firstOpenedAt && (!a.firstOpenedAt || r.firstOpenedAt < a.firstOpenedAt)) a.firstOpenedAt = r.firstOpenedAt;
    if (r.lastOpenedAt && (!a.lastOpenedAt || r.lastOpenedAt > a.lastOpenedAt)) a.lastOpenedAt = r.lastOpenedAt;
    if (r.dateKey < a.minDate) a.minDate = r.dateKey;
    if (r.dateKey > a.maxDate) a.maxDate = r.dateKey;
    if (r.dateKey > a._profileDate) {
      // newest day's profile snapshot wins
      a._profileDate = r.dateKey;
      a.userName = r.userName;
      a.mobile = r.mobile;
      a.institution = r.institution;
      a.userType = r.userType;
      a.course = r.course;
      a.year = r.year;
    }
  }
  return [...map.values()];
}

function summarize(users) {
  const s = {
    totalOpens: 0,
    uniqueUsers: users.length,
    avgOpensPerUser: 0,
    collegeUsers: 0,
    schoolUsers: 0,
    studentUsers: 0,
    facultyUsers: 0,
    parentUsers: 0,
  };
  s.ads = { total: 0, banner: 0, interstitial: 0, rewarded: 0, usersWithImpressions: 0 };
  for (const u of users) {
    const adTotal = (u.adBanner || 0) + (u.adInterstitial || 0) + (u.adRewarded || 0);
    s.ads.banner += u.adBanner || 0;
    s.ads.interstitial += u.adInterstitial || 0;
    s.ads.rewarded += u.adRewarded || 0;
    s.ads.total += adTotal;
    if (adTotal > 0) s.ads.usersWithImpressions++;
    s.totalOpens += u.openCount;
    if (u.institution === "college") s.collegeUsers++;
    else if (u.institution === "school") s.schoolUsers++;
    if (u.userType === "student") s.studentUsers++;
    else if (u.userType === "faculty") s.facultyUsers++;
    else if (u.userType === "parent") s.parentUsers++;
  }
  s.avgOpensPerUser = users.length ? Math.round((s.totalOpens / users.length) * 100) / 100 : 0;
  return s;
}

/**
 * Card figures: "active / registered" per category.
 *   population   registered users [{uid, institution, userType, course, year}] (current profiles)
 *   activeUids   Set of uids with at least one app open in the selected dates (+ weekday)
 *   totalOpens   the "Total App Opens" card value (unchanged metric)
 * Registered totals ignore date/weekday/search (a registered user stays registered) but respect
 * institution, user type, course and year. Active users are taken from that same registered set, so
 * active <= registered always holds and each person is counted once per category.
 */
function computeCards(population, activeUids, f, totalOpens) {
  const keys = ["users", "college", "school", "student", "faculty", "parent"];
  const registered = Object.fromEntries(keys.map((k) => [k, 0]));
  const active = Object.fromEntries(keys.map((k) => [k, 0]));
  let unclassified = 0;
  for (const p of population) {
    if (f.institution !== "all" && p.institution !== f.institution) continue;
    if (f.userType !== "all" && p.userType !== f.userType) continue;
    if (f.course !== "all" && p.course !== f.course) continue;
    if (f.year !== "all" && String(p.year).toLowerCase() !== f.year) continue;
    const isActive = activeUids.has(p.uid);
    const bump = (k) => {
      registered[k]++;
      if (isActive) active[k]++;
    };
    bump("users");
    if (p.institution === "college" || p.institution === "school") bump(p.institution);
    else unclassified++;
    if (p.userType === "student" || p.userType === "faculty" || p.userType === "parent") bump(p.userType);
  }
  const avgOpensPerRegisteredUser = registered.users ? Math.round((totalOpens / registered.users) * 100) / 100 : 0;
  return { registered, active, avgOpensPerRegisteredUser, unclassifiedInstitution: unclassified };
}

function searchUsers(users, term) {
  if (!term) return users;
  const digits = term.replace(/\D/g, "");
  return users.filter(
    (u) =>
      u.userName.toLowerCase().includes(term) ||
      (digits.length >= 3 && u.mobile.replace(/\D/g, "").includes(digits))
  );
}

function sortUsers(users, sort) {
  const byName = (a, b) => a.userName.localeCompare(b.userName, "en", { sensitivity: "base" }) || a.uid.localeCompare(b.uid);
  const arr = [...users];
  switch (sort) {
    case "opens_asc":
      return arr.sort((a, b) => a.openCount - b.openCount || byName(a, b));
    case "name_asc":
      return arr.sort(byName);
    case "name_desc":
      return arr.sort((a, b) => byName(b, a));
    default:
      return arr.sort((a, b) => b.openCount - a.openCount || byName(a, b));
  }
}

function publicRow(u, index) {
  return {
    serial: index,
    uid: u.uid,
    userName: u.userName,
    mobile: u.mobile,
    institution: u.institution,
    userType: u.userType,
    course: u.course,
    courseLabel: courseLabel(u.course),
    year: u.year,
    yearLabel: yearLabel(u.year),
    openCount: u.openCount,
    adBanner: u.adBanner || 0,
    adInterstitial: u.adInterstitial || 0,
    adRewarded: u.adRewarded || 0,
    adTotal: (u.adBanner || 0) + (u.adInterstitial || 0) + (u.adRewarded || 0),
    firstOpenedAt: u.firstOpenedAt ? new Date(u.firstOpenedAt).toISOString() : null,
    lastOpenedAt: u.lastOpenedAt ? new Date(u.lastOpenedAt).toISOString() : null,
    date: u.minDate === u.maxDate ? u.minDate : `${u.minDate} to ${u.maxDate}`,
    activeDays: u.activeDays,
  };
}

function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function formatIst(iso) {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

function toCsv(rows, cards, totalOpens, ads) {
  const head = [
    "S.No",
    "User Name",
    "Mobile",
    "Institution",
    "User Type",
    "Course",
    "Academic Year",
    "App Open Count",
    "Banner Impressions",
    "Interstitial Impressions",
    "Rewarded Impressions",
    "Total Ad Impressions",
    "First Opened (IST)",
    "Last Opened (IST)",
    "Date",
  ];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.serial,
        r.userName,
        r.mobile,
        r.institution,
        r.userType,
        r.courseLabel,
        r.yearLabel,
        r.openCount,
        r.adBanner,
        r.adInterstitial,
        r.adRewarded,
        r.adTotal,
        formatIst(r.firstOpenedAt),
        formatIst(r.lastOpenedAt),
        r.date,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  if (cards) {
    const a = cards.active, g = cards.registered;
    lines.push("", ["Summary", "Active Users", "Registered Users"].map(csvCell).join(","));
    for (const [label, k] of [["App Users", "users"], ["College Users", "college"], ["School Users", "school"], ["Student Users", "student"], ["Faculty Users", "faculty"], ["Parent Users", "parent"]]) {
      lines.push([label, a[k], g[k]].map(csvCell).join(","));
    }
    lines.push(["Total App Opens", totalOpens, ""].map(csvCell).join(","));
    lines.push(["Avg Opens / Registered User", cards.avgOpensPerRegisteredUser.toFixed(2), ""].map(csvCell).join(","));
  }
  if (ads) {
    lines.push("", ["Ad Impressions", "Count"].map(csvCell).join(","));
    for (const [label, v] of [["Total Ad Impressions", ads.total], ["Banner Impressions", ads.banner], ["Interstitial Impressions", ads.interstitial], ["Rewarded Impressions", ads.rewarded], ["Users with Ad Impressions", ads.usersWithImpressions]]) {
      lines.push([label, v].map(csvCell).join(","));
    }
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// ─────────────────────────────── module factory ───────────────────────────
function createAppUsageRouter(deps) {
  const { admin, jwt, bcrypt, express } = deps;
  const db = deps.db || admin.firestore();
  const Timestamp = admin.firestore.Timestamp;
  const verifyIdToken = deps.verifyIdToken || ((t) => admin.auth().verifyIdToken(t));
  const now = deps.now || (() => Date.now());
  const jwtBase = deps.jwtSecret || process.env.JWT_SECRET;
  if (!jwtBase) throw new Error("appUsage: JWT_SECRET is required");
  // Separate signing key so a main-admin JWT can never be a valid Appcount token (and vice versa).
  const SESSION_SECRET = crypto.createHash("sha256").update(`${jwtBase}::app-usage-session`).digest("hex");
  const AUDIENCE = "app-usage-admin";
  const BCRYPT_ROUNDS = 12;
  const log = deps.log || ((...a) => console.log("[app-usage]", ...a));

  const openLimiter = createSlidingLimiter(30, 10 * 60 * 1000); // per uid
  const adLimiter = createSlidingLimiter(40, 10 * 60 * 1000); // ad batches per uid
  const badTokenLimiter = createSlidingLimiter(40, 15 * 60 * 1000); // per IP (failed token checks)
  const loginIpLimiter = createSlidingLimiter(10, 15 * 60 * 1000); // failed logins per IP
  const loginUserLimiter = createSlidingLimiter(5, 15 * 60 * 1000); // failed logins per username
  const pwChangeLimiter = createSlidingLimiter(8, 15 * 60 * 1000);
  const reportLimiter = createSlidingLimiter(120, 60 * 1000);
  const revoked = new Map(); // jti -> exp(ms)

  const profileCache = new Map(); // uid -> {profile, at}
  const rangeCache = new Map(); // "from|to" -> {rows, at, ttl}
  const inflight = new Map();
  let credCache = null; // {data, at}
  const CRED_TTL_MS = 60 * 1000;

  const router = express.Router();

  // ───────────────────────── profile lookup (trusted) ─────────────────────
  function cacheProfile(uid, profile) {
    if (profileCache.size >= PROFILE_CACHE_MAX) {
      const oldest = profileCache.keys().next().value;
      profileCache.delete(oldest);
    }
    profileCache.set(uid, { profile, at: now() });
  }

  async function resolveProfile(uid, hintRole) {
    const hit = profileCache.get(uid);
    if (hit && now() - hit.at < PROFILE_TTL_MS) return hit.profile;
    const hinted = HINT_TO_COLLECTION[hintRole];
    const order = ["students", "faculty", "parents"];
    if (hinted) order.splice(order.indexOf(hinted), 1), order.unshift(hinted);
    for (const col of order) {
      const snap = await db.collection(col).where("uid", "==", uid).limit(1).get();
      if (!snap.empty) {
        const data = snap.docs[0].data();
        if (data.uid !== uid) continue; // defence in depth
        const profile = profileSnapshot(col, data);
        cacheProfile(uid, profile);
        return profile;
      }
    }
    return null;
  }

  // ───────────────────────── POST /open ───────────────────────────────────
  function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || "unknown";
  }

  router.post("/open", async (req, res) => {
    const ip = clientIp(req);
    try {
      const authHeader = String(req.headers.authorization || "");
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }
      const blocked = badTokenLimiter.peek(ip);
      if (blocked) {
        res.set("Retry-After", String(blocked));
        return res.status(429).json({ success: false, error: "Too many invalid requests" });
      }

      // Validate body (cheap) before spending a token verification.
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
      if (!body) return res.status(400).json({ success: false, error: "Invalid body" });
      if (Object.keys(body).length > 6) return res.status(400).json({ success: false, error: "Too many fields" });
      const eventId = body.eventId;
      if (typeof eventId !== "string" || !EVENT_ID_RE.test(eventId)) {
        return res.status(400).json({ success: false, error: "eventId must be 16-64 chars [A-Za-z0-9_-]" });
      }
      let occurredAt = now();
      if (body.occurredAt !== undefined && body.occurredAt !== null) {
        if (!Number.isFinite(body.occurredAt) || body.occurredAt <= 0) {
          return res.status(400).json({ success: false, error: "Invalid occurredAt" });
        }
        const t = Math.floor(body.occurredAt);
        // Offline retries keep their real time; implausible values fall back to server time.
        if (t <= now() + MAX_EVENT_FUTURE_MS && now() - t <= MAX_EVENT_AGE_MS) occurredAt = Math.min(t, now());
      }
      const hintRole = typeof body.role === "string" ? body.role.toLowerCase().slice(0, 12) : "";

      // Verify Firebase ID token (identity comes ONLY from the token).
      let uid;
      try {
        const decoded = await verifyIdToken(authHeader.slice(7));
        uid = decoded && decoded.uid;
        if (!uid) throw new Error("no uid");
      } catch (_) {
        badTokenLimiter.hit(ip);
        return res.status(401).json({ success: false, error: "Invalid or expired authentication token" });
      }
      if (body.uid !== undefined && body.uid !== uid) {
        badTokenLimiter.hit(ip);
        return res.status(403).json({ success: false, error: "uid does not match authenticated user" });
      }

      const wait = openLimiter.hit(uid);
      if (wait) {
        res.set("Retry-After", String(wait));
        return res.status(429).json({ success: false, error: "Too many app-open events" });
      }

      const dateKey = istDateKey(occurredAt);
      const ref = db.collection(COLLECTION).doc(`${uid}_${dateKey}`);
      const evTs = Timestamp.fromMillis(occurredAt);

      const attempt = async (profile) =>
        db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists) {
            const d = snap.data();
            const ids = Array.isArray(d.recentEventIds) ? d.recentEventIds : [];
            if (ids.includes(eventId)) return { duplicate: true, openCount: d.openCount || 0 };
            if ((d.openCount || 0) >= MAX_DAILY_OPENS) return { capped: true, openCount: d.openCount || 0 };
            const upd = {
              openCount: (d.openCount || 0) + 1,
              recentEventIds: [...ids, eventId].slice(-MAX_RECENT_EVENT_IDS),
            };
            const last = d.lastOpenedAt && d.lastOpenedAt.toMillis ? d.lastOpenedAt.toMillis() : 0;
            const first = d.firstOpenedAt && d.firstOpenedAt.toMillis ? d.firstOpenedAt.toMillis() : Infinity;
            if (occurredAt >= last) upd.lastOpenedAt = evTs;
            if (occurredAt < first) upd.firstOpenedAt = evTs;
            tx.update(ref, upd);
            return { openCount: upd.openCount };
          }
          if (!profile) return { needProfile: true };
          tx.set(ref, {
            uid,
            userName: profile.userName,
            mobile: profile.mobile,
            institution: profile.institution,
            userType: profile.userType,
            course: profile.course,
            year: profile.year,
            dateKey,
            openCount: 1,
            firstOpenedAt: evTs,
            lastOpenedAt: evTs,
            recentEventIds: [eventId],
          });
          return { openCount: 1, created: true };
        });

      const cached = profileCache.get(uid);
      let result = await attempt(cached && now() - cached.at < PROFILE_TTL_MS ? cached.profile : null);
      if (result.needProfile) {
        const profile = await resolveProfile(uid, hintRole);
        if (!profile) {
          return res.status(404).json({ success: false, error: "No user profile found for this account" });
        }
        result = await attempt(profile);
        if (result.needProfile) return res.status(503).json({ success: false, error: "Please retry" });
      }
      return res.json({
        success: true,
        counted: !result.duplicate && !result.capped,
        duplicate: !!result.duplicate,
        capped: !!result.capped,
        dateKey,
        openCount: result.openCount,
      });
    } catch (e) {
      log("open error:", e && e.message);
      return res.status(500).json({ success: false, error: "Could not record app open" });
    }
  });

  // ───────────────────────── POST /ads (ad impressions) ───────────────────
  // Body: { events: [{ eventId, format: "banner"|"interstitial"|"rewarded", occurredAt? }] } (1..50 events)
  // Each event = one impression reported by the ad SDK's onAdImpression callback on the device.
  // Counts are added to the SAME appUsageDaily/{uid}_{IST date} document as the app opens (fields
  // adBanner / adInterstitial / adRewarded), so the dashboard needs no extra reads. Identity comes only
  // from the Firebase ID token; client totals are never accepted, the server counts events itself.
  // Retries are de-duplicated by eventId (last MAX_AD_EVENT_IDS ids kept per daily doc).
  router.post("/ads", async (req, res) => {
    const ip = clientIp(req);
    try {
      const authHeader = String(req.headers.authorization || "");
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, error: "Authentication required" });
      }
      const blocked = badTokenLimiter.peek(ip);
      if (blocked) {
        res.set("Retry-After", String(blocked));
        return res.status(429).json({ success: false, error: "Too many invalid requests" });
      }
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
      const events = body && Array.isArray(body.events) ? body.events : null;
      if (!events || events.length < 1 || events.length > MAX_AD_BATCH || Object.keys(body).some((k) => k !== "events" && k !== "uid")) {
        return res.status(400).json({ success: false, error: `events must be an array of 1-${MAX_AD_BATCH} items` });
      }
      const t0 = now();
      const parsed = [];
      const seenInBatch = new Set();
      for (const ev of events) {
        if (!ev || typeof ev !== "object" || Array.isArray(ev) || Object.keys(ev).some((k) => !AD_EVENT_KEYS.includes(k))) {
          return res.status(400).json({ success: false, error: "Invalid event" }); // e.g. client-supplied counts are refused
        }
        if (typeof ev.eventId !== "string" || !EVENT_ID_RE.test(ev.eventId)) {
          return res.status(400).json({ success: false, error: "eventId must be 16-64 chars [A-Za-z0-9_-]" });
        }
        if (!AD_FORMATS.includes(ev.format)) return res.status(400).json({ success: false, error: "Invalid format" });
        let at = t0;
        if (ev.occurredAt !== undefined && ev.occurredAt !== null) {
          if (!Number.isFinite(ev.occurredAt) || ev.occurredAt <= 0) return res.status(400).json({ success: false, error: "Invalid occurredAt" });
          const t = Math.floor(ev.occurredAt);
          if (t <= t0 + MAX_EVENT_FUTURE_MS && t0 - t <= MAX_EVENT_AGE_MS) at = Math.min(t, t0);
        }
        if (seenInBatch.has(ev.eventId)) continue; // duplicate inside the same batch
        seenInBatch.add(ev.eventId);
        parsed.push({ id: ev.eventId, format: ev.format, at });
      }

      let uid;
      try {
        const decoded = await verifyIdToken(authHeader.slice(7));
        uid = decoded && decoded.uid;
        if (!uid) throw new Error("no uid");
      } catch (_) {
        badTokenLimiter.hit(ip);
        return res.status(401).json({ success: false, error: "Invalid or expired authentication token" });
      }
      if (body.uid !== undefined && body.uid !== uid) {
        badTokenLimiter.hit(ip);
        return res.status(403).json({ success: false, error: "uid does not match authenticated user" });
      }
      const wait = adLimiter.hit(uid);
      if (wait) {
        res.set("Retry-After", String(wait));
        return res.status(429).json({ success: false, error: "Too many ad events" });
      }

      // group by IST day -> one transaction per day (normally exactly one)
      const byDay = new Map();
      for (const p of parsed) {
        const dk = istDateKey(p.at);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk).push(p);
      }
      let counted = 0, duplicates = 0, capped = 0;
      for (const [dateKey, list] of byDay) {
        const ref = db.collection(COLLECTION).doc(`${uid}_${dateKey}`);
        const attempt = (profile) =>
          db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            if (!d && !profile) return { needProfile: true };
            const ids = d && Array.isArray(d.adEventIds) ? d.adEventIds : [];
            const known = new Set(ids);
            const inc = { banner: 0, interstitial: 0, rewarded: 0 };
            let dayTotal = d ? (d.adBanner || 0) + (d.adInterstitial || 0) + (d.adRewarded || 0) : 0;
            const newIds = [];
            let dup = 0, cap = 0;
            for (const p of list) {
              if (known.has(p.id)) { dup++; continue; }
              if (dayTotal >= MAX_DAILY_AD_IMPRESSIONS) { cap++; continue; }
              known.add(p.id);
              newIds.push(p.id);
              inc[p.format]++;
              dayTotal++;
            }
            const n = newIds.length;
            if (!n) return { counted: 0, dup, cap };
            const adEventIds = [...ids, ...newIds].slice(-MAX_AD_EVENT_IDS);
            if (d) {
              tx.update(ref, {
                adBanner: (d.adBanner || 0) + inc.banner,
                adInterstitial: (d.adInterstitial || 0) + inc.interstitial,
                adRewarded: (d.adRewarded || 0) + inc.rewarded,
                adEventIds,
              });
            } else {
              // impressions without an app open that day (e.g. past midnight): openCount stays 0
              tx.set(ref, {
                uid,
                userName: profile.userName,
                mobile: profile.mobile,
                institution: profile.institution,
                userType: profile.userType,
                course: profile.course,
                year: profile.year,
                dateKey,
                openCount: 0,
                firstOpenedAt: null,
                lastOpenedAt: null,
                recentEventIds: [],
                adBanner: inc.banner,
                adInterstitial: inc.interstitial,
                adRewarded: inc.rewarded,
                adEventIds,
              });
            }
            return { counted: n, dup, cap };
          });
        const cached = profileCache.get(uid);
        let r = await attempt(cached && now() - cached.at < PROFILE_TTL_MS ? cached.profile : null);
        if (r.needProfile) {
          const profile = await resolveProfile(uid, "");
          if (!profile) return res.status(404).json({ success: false, error: "No user profile found for this account" });
          r = await attempt(profile);
          if (r.needProfile) return res.status(503).json({ success: false, error: "Please retry" });
        }
        counted += r.counted;
        duplicates += r.dup;
        capped += r.cap;
      }
      return res.json({ success: true, received: events.length, counted, duplicates: duplicates + (events.length - parsed.length), capped });
    } catch (e) {
      log("ads error:", e && e.message);
      return res.status(500).json({ success: false, error: "Could not record ad impressions" });
    }
  });

  // ───────────────────────── Appcount account (shared admin login) ─────────
  // The Appcount account signs in through the EXISTING admin login form (POST /admin/login).
  // loginInterceptor() runs before that route: only the configured Appcount username is handled here;
  // anything else (including a wrong Appcount password) falls through to the untouched admin flow.
  //
  // Credential source
  //   * username + INITIAL password: backend environment (APP_USAGE_ADMIN_USERNAME / APP_USAGE_ADMIN_PASSWORD)
  //   * record missing: the first SUCCESSFUL login with the initial password creates
  //     appUsageAdmin/credentials (bcrypt hash of it, mustChangePassword: true) in a transaction.
  //   * after the mandatory change the record holds the new bcrypt hash and the environment password is
  //     ignored for good (the .env file is never rewritten at runtime).
  //   * deleting that Firestore document re-enables the environment password (+ forced change again).
  const cfg = () => {
    const env = deps.env || process.env;
    const username = String(env.APP_USAGE_ADMIN_USERNAME || "").trim();
    const password = String(env.APP_USAGE_ADMIN_PASSWORD || "");
    return { username, password, enabled: !!username };
  };
  const credRef = () => db.collection(ADMIN_COLLECTION).doc(ADMIN_DOC);

  async function loadCreds(force = false) {
    if (!force && credCache && now() - credCache.at < CRED_TTL_MS) return credCache.data;
    const snap = await credRef().get();
    const data = snap.exists ? snap.data() : null;
    credCache = { data, at: now() };
    return data;
  }

  /** Constant-time string comparison (hash both sides so length does not leak). */
  function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  /** Checks a password against whichever credential is currently authoritative. */
  async function verifyPassword(password, doc) {
    if (typeof password !== "string" || !password || password.length > 128) return false;
    if (doc && doc.passwordHash) return bcrypt.compare(password, doc.passwordHash);
    const c = cfg();
    return !!c.password && safeEqual(password, c.password);
  }

  const stateOf = (doc) => ({ mustChange: doc ? !!doc.mustChangePassword : true, tv: doc ? doc.tokenVersion || 1 : 0 });

  function issueToken(state, scope) {
    const ttl = scope === "pwchange" ? 15 * 60 : SESSION_TTL_SECONDS;
    const token = jwt.sign({ sub: "appcount", scope, tv: state.tv }, SESSION_SECRET, {
      audience: AUDIENCE,
      expiresIn: ttl,
      jwtid: crypto.randomUUID(), // fresh id on every login: no session fixation
    });
    return { token, ttl };
  }

  // Cookie path = the path the BROWSER uses for the App Usage API (API base ".../api" + "/app-usage").
  // It must NOT be derived from req.originalUrl: Nginx strips the "/api" prefix before Express sees
  // the request, so the server-side URL is "/admin/login" while the browser calls "/api/app-usage/...".
  // (Deriving it produced "Path=/app-usage", the browser never sent the cookie back -> login loop.)
  // Override with APP_USAGE_COOKIE_PATH only if the public API prefix ever changes.
  function cookiePath() {
    const p = String((deps.env || process.env).APP_USAGE_COOKIE_PATH || "").trim();
    return /^\/[A-Za-z0-9/_-]*$/.test(p) ? p : "/api/app-usage";
  }
  function cookieOptions(req, maxAgeMs) {
    return {
      httpOnly: true,
      sameSite: "strict",
      secure: !!req.secure || (deps.env || process.env).NODE_ENV === "production",
      path: cookiePath(),
      maxAge: maxAgeMs,
    };
  }

  /**
   * First successful login with the .env initial password while appUsageAdmin/credentials is missing:
   * create the record (bcrypt hash of the initial password, mustChangePassword: true, tokenVersion: 1)
   * inside a transaction. Never overwrites: if another request created it first, that record is returned
   * and the caller re-verifies the password against it.
   */
  async function bootstrapCreds(c) {
    const passwordHash = await bcrypt.hash(c.password, BCRYPT_ROUNDS);
    const ts = Timestamp.fromMillis(now());
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(credRef());
      if (snap.exists) return { data: snap.data(), created: false };
      const rec = { username: c.username, passwordHash, mustChangePassword: true, tokenVersion: 1, createdAt: ts, updatedAt: ts };
      tx.create(credRef(), rec);
      return { data: rec, created: true };
    });
    credCache = { data: out.data, at: now() };
    if (out.created) log("Appcount credential record initialised (password change required)");
    return out;
  }
  function parseCookies(header) {
    const out = {};
    for (const part of String(header || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  /** Shared /admin/login hook. Calls next() for every non-Appcount request, untouched. */
  async function loginInterceptor(req, res, next) {
    try {
      const c = cfg();
      const body = req.body;
      if (!c.enabled || !body || typeof body.username !== "string" || typeof body.password !== "string") return next();
      const uKey = body.username.trim().toLowerCase();
      if (uKey !== c.username.toLowerCase()) return next();

      const ip = clientIp(req);
      const wait = Math.max(loginIpLimiter.peek(ip), loginUserLimiter.peek(uKey));
      if (wait) {
        res.set("Retry-After", String(wait));
        return res.status(429).json({ success: false, error: "Too many login attempts. Try again after 15 minutes." });
      }
      let doc = await loadCreds(true); // always fresh at login (record may have been deleted/changed)
      const fail = () => {
        loginIpLimiter.hit(ip);
        loginUserLimiter.hit(uKey);
        return next(); // existing admin flow answers with its normal error
      };
      if (!(await verifyPassword(body.password, doc))) return fail();
      if (!doc) {
        // Password matched the .env initial password and no record exists yet: initialise it.
        let boot;
        try {
          boot = await bootstrapCreds(c);
        } catch (e) {
          log("appcount bootstrap error:", e && e.message);
          return res.status(503).json({ success: false, error: "Could not initialise the App Usage account. Try again." });
        }
        doc = boot.data;
        // Lost a race: someone else created the record; it is authoritative now.
        if (!boot.created && !(await verifyPassword(body.password, doc))) return fail();
      }
      loginIpLimiter.reset(ip);
      loginUserLimiter.reset(uKey);
      const st = stateOf(doc);
      const { token, ttl } = issueToken(st, st.mustChange ? "pwchange" : "full");
      res.cookie(COOKIE_NAME, token, cookieOptions(req, ttl * 1000));
      // No token in the body: the browser never sees the session secret and gets no admin token.
      return res.json({ success: true, appUsage: true, mustChangePassword: st.mustChange, redirect: "app/app-usage.html" });
    } catch (e) {
      log("appcount login error:", e && e.message);
      return next(); // fail open to the normal flow, never block admins
    }
  }

  /**
   * Session guard. Accepts the Appcount cookie, or (allowMainAdmin) a main-admin JWT whose role is "superadmin".
   * An Appcount cookie never satisfies the main admin APIs and a normal admin JWT never becomes an Appcount session.
   */
  function sessionAuth(scopes, { allowMainAdmin = false } = {}) {
    return async (req, res, next) => {
      try {
        const cookieTok = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (cookieTok) {
          let payload;
          try {
            payload = jwt.verify(cookieTok, SESSION_SECRET, { audience: AUDIENCE });
          } catch (_) {
            return res.status(401).json({ success: false, error: "Session expired. Please log in again." });
          }
          if (req.method !== "GET" && req.headers["x-app-usage"] !== "1") {
            return res.status(403).json({ success: false, error: "Missing CSRF header" });
          }
          const exp = revoked.get(payload.jti);
          if (exp && exp > now()) return res.status(401).json({ success: false, error: "Session ended. Please log in again." });
          const doc = await loadCreds();
          if (payload.tv !== stateOf(doc).tv) {
            return res.status(401).json({ success: false, error: "Session expired. Please log in again." });
          }
          if (!scopes.includes(payload.scope)) {
            return res.status(403).json({ success: false, error: "Password change required before accessing analytics" });
          }
          req.appcount = { role: "appcount", jti: payload.jti, exp: payload.exp, scope: payload.scope };
          return next();
        }
        const h = String(req.headers.authorization || "");
        if (allowMainAdmin && h && !h.startsWith("Bearer ") && scopes.includes("full")) {
          try {
            const d = jwt.verify(h, jwtBase);
            if (d && d.admin && d.role === "superadmin") {
              req.appcount = { role: "superadmin", scope: "full" };
              return next();
            }
          } catch (_) {
            /* fall through */
          }
        }
        return res.status(401).json({ success: false, error: "Authentication required" });
      } catch (e) {
        log("session error:", e && e.message);
        return res.status(500).json({ success: false, error: "Server error" });
      }
    };
  }

  router.get("/admin/session", sessionAuth(["pwchange", "full"], { allowMainAdmin: true }), (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, role: req.appcount.role, mustChangePassword: req.appcount.scope === "pwchange" });
  });

  router.post("/admin/change-password", sessionAuth(["pwchange", "full"]), async (req, res) => {
    try {
      const cpIp = clientIp(req);
      const wait = pwChangeLimiter.peek(cpIp);
      if (wait) {
        res.set("Retry-After", String(wait));
        return res.status(429).json({ success: false, error: "Too many attempts. Try again later." });
      }
      const { currentPassword, newPassword } = req.body || {};
      if (typeof currentPassword !== "string" || currentPassword.length > 128) {
        return res.status(400).json({ success: false, error: "Current password is required" });
      }
      const problem = validateNewPassword(newPassword, currentPassword);
      if (problem) {
        pwChangeLimiter.hit(cpIp);
        return res.status(400).json({ success: false, error: problem });
      }
      const doc = await loadCreds(true);
      if (!(await verifyPassword(currentPassword, doc))) {
        pwChangeLimiter.hit(cpIp);
        // 400 (not 401) so the page does not treat it as an expired session.
        return res.status(400).json({ success: false, error: "Current password is incorrect" });
      }
      const c = cfg();
      if (c.password && safeEqual(newPassword, c.password)) {
        return res.status(400).json({ success: false, error: "New password must differ from the initial password" });
      }
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const seenTv = doc ? doc.tokenVersion || 1 : 0;
      const ts = Timestamp.fromMillis(now());
      const changed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(credRef());
        const cur = snap.exists ? snap.data() : null;
        if ((cur ? cur.tokenVersion || 1 : 0) !== seenTv) return false; // changed concurrently
        const rec = { username: c.username, passwordHash, mustChangePassword: false, tokenVersion: seenTv + 1, updatedAt: ts };
        if (cur) tx.update(credRef(), rec); // keeps createdAt
        else tx.set(credRef(), { ...rec, createdAt: ts });
        return true;
      });
      credCache = null;
      if (!changed) return res.status(409).json({ success: false, error: "The password was changed in the meantime. Please log in again." });
      const fresh = await loadCreds(true);
      const { token, ttl } = issueToken(stateOf(fresh), "full");
      res.cookie(COOKIE_NAME, token, cookieOptions(req, ttl * 1000));
      return res.json({ success: true, mustChangePassword: false });
    } catch (e) {
      log("change-password error:", e && e.message);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });

  router.post("/admin/logout", sessionAuth(["pwchange", "full"]), (req, res) => {
    revoked.set(req.appcount.jti, req.appcount.exp * 1000);
    for (const [k, v] of revoked) if (v <= now()) revoked.delete(k);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: undefined });
    res.json({ success: true });
  });

  // ───────────────────────── reporting ────────────────────────────────────
  function fromDoc(doc) {
    const d = doc.data();
    return {
      uid: d.uid,
      userName: d.userName || "",
      mobile: d.mobile || "",
      institution: d.institution || "unknown",
      userType: d.userType || "",
      course: d.course || "",
      year: d.year === undefined || d.year === null ? "" : String(d.year),
      dateKey: d.dateKey,
      openCount: Number(d.openCount) || 0,
      adBanner: Number(d.adBanner) || 0,
      adInterstitial: Number(d.adInterstitial) || 0,
      adRewarded: Number(d.adRewarded) || 0,
      firstOpenedAt: d.firstOpenedAt && d.firstOpenedAt.toMillis ? d.firstOpenedAt.toMillis() : 0,
      lastOpenedAt: d.lastOpenedAt && d.lastOpenedAt.toMillis ? d.lastOpenedAt.toMillis() : 0,
    };
  }

  async function loadRange(from, to) {
    const key = `${from}|${to}`;
    const hit = rangeCache.get(key);
    if (hit && now() - hit.at < hit.ttl) return { rows: hit.rows, cached: true };
    if (inflight.has(key)) return { rows: await inflight.get(key), cached: true };
    const p = (async () => {
      const snap = await db
        .collection(COLLECTION)
        .where("dateKey", ">=", from)
        .where("dateKey", "<=", to)
        .select("uid", "userName", "mobile", "institution", "userType", "course", "year", "dateKey", "openCount", "firstOpenedAt", "lastOpenedAt", "adBanner", "adInterstitial", "adRewarded")
        .get();
      const rows = snap.docs.map(fromDoc);
      // Ranges that include today change as users open the app: short TTL. Past ranges: longer.
      const ttl = to >= istDateKey(now()) ? 45 * 1000 : 10 * 60 * 1000;
      if (rangeCache.size >= 24) rangeCache.delete(rangeCache.keys().next().value);
      rangeCache.set(key, { rows, at: now(), ttl });
      return rows;
    })();
    inflight.set(key, p);
    try {
      return { rows: await p, cached: false };
    } finally {
      inflight.delete(key);
    }
  }

  // Registered population for the "x / total" cards: students, faculty, parents (the real profile
  // collections). Field mask keeps documents small; one read per profile document per refresh,
  // shared by all dashboard requests for POPULATION_TTL_MS. Profiles without a uid cannot sign in
  // or be tracked and are not counted; the same uid in two collections is counted once.
  const POPULATION_TTL_MS = 10 * 60 * 1000;
  let populationCache = null; // {list, excludedNoUid, duplicates, at}
  let populationInflight = null;
  async function loadPopulation() {
    if (populationCache && now() - populationCache.at < POPULATION_TTL_MS) return populationCache;
    if (populationInflight) return populationInflight;
    populationInflight = (async () => {
      const seen = new Set();
      const list = [];
      let excludedNoUid = 0, duplicates = 0;
      for (const col of ["students", "faculty", "parents"]) {
        const snap = await db.collection(col).select("uid", "institution", "facultyType", "course", "year").get();
        for (const d of snap.docs) {
          const data = d.data();
          const uid = typeof data.uid === "string" ? data.uid.trim() : "";
          if (!uid) { excludedNoUid++; continue; }
          if (seen.has(uid)) { duplicates++; continue; }
          seen.add(uid);
          const p = profileSnapshot(col, data);
          list.push({ uid, institution: p.institution, userType: p.userType, course: p.course, year: p.year });
        }
      }
      populationCache = { list, excludedNoUid, duplicates, at: now() };
      return populationCache;
    })();
    try {
      return await populationInflight;
    } finally {
      populationInflight = null;
    }
  }

  async function buildReport(f) {
    const [{ rows, cached }, pop] = await Promise.all([loadRange(f.from, f.to), loadPopulation()]);
    // Dropdown options: whole range + registered users, so selecting one course doesn't hide the others.
    const courses = [...new Set([...rows.map((r) => r.course), ...pop.list.map((p) => p.course)].filter(Boolean))].sort();
    const years = [...new Set(["1", "2", "3", "4", ...rows.map((r) => String(r.year)), ...pop.list.map((p) => String(p.year))].filter(Boolean))].sort(
      (a, b) => Number(a) - Number(b) || a.localeCompare(b)
    );
    const filtered = applyFilters(rows, f);
    const users = aggregateByUser(filtered);
    const summary = summarize(users);
    // Active = opened the app in the selected dates (+ weekday); classified by the CURRENT profile.
    const wd = f.weekday === "all" ? -1 : WEEKDAYS.indexOf(f.weekday);
    const activeUids = new Set(rows.filter((r) => r.openCount > 0 && (wd < 0 || weekdayOfDateKey(r.dateKey) === wd)).map((r) => r.uid));
    const cards = computeCards(pop.list, activeUids, f, summary.totalOpens);
    cards.excludedProfilesWithoutUid = pop.excludedNoUid;
    cards.duplicateProfiles = pop.duplicates;
    cards.registeredAsOf = new Date(pop.at).toISOString();
    const matched = sortUsers(searchUsers(users, f.search), f.sort);
    // Ad summary = totals of exactly the table rows (all pages, search applied).
    summary.ads = summarize(matched).ads;
    return { cached, courses, years, summary, cards, matched };
  }

  function reportGuard(req, res) {
    const wait = reportLimiter.hit("global");
    if (wait) {
      res.set("Retry-After", String(wait));
      res.status(429).json({ success: false, error: "Too many requests" });
      return null;
    }
    const f = parseReportQuery(req.query || {}, istDateKey(now()));
    if (f.error) {
      res.status(400).json({ success: false, error: f.error });
      return null;
    }
    return f;
  }

  router.get("/admin/report", sessionAuth(["full"], { allowMainAdmin: true }), async (req, res) => {
    try {
      const f = reportGuard(req, res);
      if (!f) return;
      const r = await buildReport(f);
      const total = r.matched.length;
      const totalPages = Math.max(1, Math.ceil(total / f.pageSize));
      const page = Math.min(f.page, totalPages);
      const start = (page - 1) * f.pageSize;
      const rows = r.matched.slice(start, start + f.pageSize).map((u, i) => publicRow(u, start + i + 1));
      res.set("Cache-Control", "no-store");
      return res.json({
        success: true,
        query: { from: f.from, to: f.to },
        summary: r.summary,
        cards: r.cards,
        rows,
        total,
        page,
        pageSize: f.pageSize,
        totalPages,
        options: { courses: r.courses.map((c) => ({ value: c, label: courseLabel(c) })), years: r.years.map((y) => ({ value: y, label: yearLabel(y) })) },
        cached: r.cached,
        generatedAt: new Date(now()).toISOString(),
      });
    } catch (e) {
      log("report error:", e && e.message);
      return res.status(500).json({ success: false, error: "Could not load analytics" });
    }
  });

  router.get("/admin/export", sessionAuth(["full"], { allowMainAdmin: true }), async (req, res) => {
    try {
      const f = reportGuard(req, res);
      if (!f) return;
      const r = await buildReport(f);
      const rows = r.matched.map((u, i) => publicRow(u, i + 1));
      res.set("Cache-Control", "no-store");
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="app-usage_${f.from}_${f.to}.csv"`);
      // Ad totals of exactly the exported rows (search applied), so the CSV summary equals the CSV table.
      const ads = rows.reduce((a, x) => ({ total: a.total + x.adTotal, banner: a.banner + x.adBanner, interstitial: a.interstitial + x.adInterstitial, rewarded: a.rewarded + x.adRewarded, usersWithImpressions: a.usersWithImpressions + (x.adTotal > 0 ? 1 : 0) }), { total: 0, banner: 0, interstitial: 0, rewarded: 0, usersWithImpressions: 0 });
      return res.send(toCsv(rows, r.cards, r.summary.totalOpens, ads));
    } catch (e) {
      log("export error:", e && e.message);
      return res.status(500).json({ success: false, error: "Could not export analytics" });
    }
  });

  router.loginInterceptor = loginInterceptor;
  router._internals = { profileCache, rangeCache, openLimiter };
  return router;
}

/**
 * Account deletion: removes every appUsageDaily document (app opens + ad impressions) of one user.
 * Called from cleanupUser() in index.js. Deletes in chunks of 400 (Firestore batch limit 500).
 */
async function deleteUserUsageRecords(db, uid) {
  if (typeof uid !== "string" || !uid.trim()) return 0;
  let deleted = 0;
  for (;;) {
    const snap = await db.collection(COLLECTION).where("uid", "==", uid).limit(400).get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.length;
    if (snap.docs.length < 400) return deleted;
  }
}

module.exports = {
  createAppUsageRouter,
  deleteUserUsageRecords,
  // exported for tests
  istDateKey,
  isValidDateKey,
  weekdayOfDateKey,
  parseReportQuery,
  applyFilters,
  aggregateByUser,
  summarize,
  computeCards,
  sortUsers,
  searchUsers,
  profileSnapshot,
  validateNewPassword,
  toCsv,
  csvCell,
  yearLabel,
  courseLabel,
  COLLECTION,
};
