/**
 * Backend tests for src/appUsage.js. Run:  node --test tests/
 * Uses an in-memory Firestore fake (optimistic-concurrency transactions) so no production data is touched.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const admin = require("firebase-admin");
const mod = require("../src/appUsage");

const Timestamp = admin.firestore.Timestamp;

const { FakeDb } = require("./fake_firestore");

// ───────────────────────── harness ─────────────────────────
const DAY = 86400000;
// 2026-11-20 10:00 IST = 04:30 UTC
const T0 = Date.UTC(2026, 10, 20, 4, 30, 0);

async function setup(opts = {}) {
  const db = opts.db || new FakeDb();
  const clock = opts.clock || { t: T0 };
  const env = opts.env || { APP_USAGE_ADMIN_USERNAME: "Appcount", APP_USAGE_ADMIN_PASSWORD: "Appcount" };
  if (!opts.db) {
  await db.collection("students").doc("student-001").set({ uid: "u-stud", name: "RAHUL SHARMA", mobile: "9876543210", institution: "college", course: "btech", year: "2", studentType: "college" });
  await db.collection("students").doc("student-002").set({ uid: "u-poly", name: "Amit Verma", mobile: "9000000001", institution: "college", course: "poly", year: "1" });
  await db.collection("faculty").doc("faculty-001").set({ uid: "u-fac", name: "Dr Mehta", mobile: "9111111111", institution: "college", facultyType: "College" });
  await db.collection("faculty").doc("faculty-002").set({ uid: "u-sfac", name: "Mrs Rao", mobile: "9222222222", institution: "school", facultyType: "School" });
  await db.collection("parents").doc("parent-001").set({ uid: "u-par", name: "Sunita Devi", mobile: "9333333333", institution: "school" });
  }
  const router = mod.createAppUsageRouter({
    admin,
    jwt,
    bcrypt,
    express,
    db,
    jwtSecret: "test-secret",
    env,
    now: () => clock.t,
    verifyIdToken: async (t) => {
      if (t.startsWith("good-")) return { uid: t.slice(5) };
      throw new Error("bad token");
    },
    log: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use("/app-usage", router);
  app.post("/admin/login", router.loginInterceptor);
  // Stand-in for the untouched existing admin login / admin API (the real ones are exercised in the guarded index.js run).
  app.post("/admin/login", (req, res) => {
    const { username, password } = req.body || {};
    if (username === "admin" && password === "adminpass") return res.json({ success: true, token: jwt.sign({ admin: true, role: "admin", institution: "college" }, "test-secret"), institution: "college", role: "admin" });
    return res.status(401).json({ success: false, error: "Invalid username or password" });
  });
  app.get("/admin/buses", (req, res) => {
    try { const d = jwt.verify(req.headers.authorization || "", "test-secret"); if (!d.admin) throw new Error("x"); res.json({ success: true }); } catch (_) { res.status(401).json({ error: "Invalid token" }); }
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const base = root + "/app-usage";
  // token: for /admin/* paths it is the Appcount SESSION COOKIE value; for /open it is the Firebase bearer token.
  const call = async (method, path, { token, body, rootPath, rawAuth, noCsrf, headers: extra } = {}) => {
    const isAdmin = path.startsWith("/admin");
    const headers = { "Content-Type": "application/json", ...(extra || {}) };
    if (token && isAdmin) { headers.Cookie = `scep_appusage=${token}`; if (method !== "GET" && !noCsrf) headers["X-App-Usage"] = "1"; }
    else if (token) headers.Authorization = `Bearer ${token}`;
    if (rawAuth) headers.Authorization = rawAuth;
    const res = await fetch((rootPath ? root : base) + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    const setCookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])[0] || null;
    const cookie = setCookie ? setCookie.split(";")[0].split("=").slice(1).join("=") : null;
    return { status: res.status, json, text, headers: res.headers, setCookie, cookie };
  };
  let n = 0;
  const eid = () => `evt_${String(++n).padStart(6, "0")}_abcdefghij`;
  const open = (uid, extra = {}, tokenOverride) => call("POST", "/open", { token: tokenOverride || `good-${uid}`, body: { eventId: eid(), ...extra } });
  return { db, clock, call, open, eid, port: server.address().port, close: () => server.close(), router };
}

const dailyDoc = (db, uid, key) => (db.docs.get(`appUsageDaily/${uid}_${key}`) || {}).data;

// ───────────────────────── pure helpers ─────────────────────────
test("IST date key crosses midnight at 18:30 UTC", () => {
  assert.equal(mod.istDateKey(Date.UTC(2026, 10, 20, 18, 29, 59)), "2026-11-20");
  assert.equal(mod.istDateKey(Date.UTC(2026, 10, 20, 18, 30, 0)), "2026-11-21");
  assert.equal(mod.istDateKey(Date.UTC(2026, 11, 31, 18, 30, 0)), "2027-01-01");
  assert.equal(mod.istDateKey(Date.UTC(2026, 10, 20, 0, 0, 0)), "2026-11-20");
});

test("date validation + weekday", () => {
  assert.ok(mod.isValidDateKey("2026-02-28"));
  assert.ok(!mod.isValidDateKey("2026-02-30"));
  assert.ok(!mod.isValidDateKey("2026-2-3"));
  assert.equal(mod.weekdayOfDateKey("2026-11-20"), 5); // Friday
});

test("labels and password policy", () => {
  assert.equal(mod.yearLabel("1"), "1st Year");
  assert.equal(mod.yearLabel("2"), "2nd Year");
  assert.equal(mod.yearLabel("3"), "3rd Year");
  assert.equal(mod.yearLabel("4"), "4th Year");
  assert.equal(mod.courseLabel("btech"), "BTech");
  assert.ok(mod.validateNewPassword("short1A", "x"));
  assert.ok(mod.validateNewPassword("Appcount12345", "x"));
  assert.ok(mod.validateNewPassword("alllowercase123", "x"));
  assert.equal(mod.validateNewPassword("Str0ngPassw0rd!", "x"), null);
});

test("CSV escapes quotes/commas and neutralises formulas", () => {
  assert.equal(mod.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(mod.csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(mod.csvCell("+91"), "'+91");
});

// ───────────────────────── POST /open ─────────────────────────
test("open: missing token -> 401, invalid token -> 401, nothing written", async () => {
  const s = await setup();
  try {
    let r = await s.call("POST", "/open", { body: { eventId: s.eid() } });
    assert.equal(r.status, 401);
    r = await s.open("u-stud", {}, "garbage");
    assert.equal(r.status, 401);
    assert.equal([...s.db.docs.keys()].filter((k) => k.startsWith("appUsageDaily")).length, 0);
  } finally {
    s.close();
  }
});

test("open: client-supplied uid that differs from token uid is rejected (403)", async () => {
  const s = await setup();
  try {
    const r = await s.open("u-stud", { uid: "someone-else" });
    assert.equal(r.status, 403);
    assert.equal(dailyDoc(s.db, "someone-else", "2026-11-20"), undefined);
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20"), undefined);
  } finally {
    s.close();
  }
});

test("open: validation of eventId / occurredAt / body", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/open", { token: "good-u-stud", body: {} })).status, 400);
    assert.equal((await s.call("POST", "/open", { token: "good-u-stud", body: { eventId: "short" } })).status, 400);
    assert.equal((await s.call("POST", "/open", { token: "good-u-stud", body: { eventId: "bad id with spaces!!!!" } })).status, 400);
    assert.equal((await s.call("POST", "/open", { token: "good-u-stud", body: { eventId: s.eid(), occurredAt: "x" } })).status, 400);
    assert.equal((await s.call("POST", "/open", { token: "good-u-stud", body: [1, 2] })).status, 400);
  } finally {
    s.close();
  }
});

test("open: extra client fields (role/institution/course) are ignored; stored data is the trusted profile", async () => {
  const s = await setup();
  try {
    const r = await s.open("u-stud", { role: "parent", institution: "school", course: "evil" });
    assert.equal(r.status, 200);
    const d = dailyDoc(s.db, "u-stud", "2026-11-20");
    assert.deepEqual([d.userType, d.institution, d.course], ["student", "college", "btech"]);
  } finally {
    s.close();
  }
});

test("open: role hint only orders the lookup; stored fields come from the profile", async () => {
  const s = await setup();
  try {
    const r = await s.open("u-stud", { role: "parent" }); // wrong hint
    assert.equal(r.status, 200);
    const d = dailyDoc(s.db, "u-stud", "2026-11-20");
    assert.equal(d.userType, "student");
    assert.equal(d.institution, "college");
    assert.equal(d.course, "btech");
    assert.equal(d.year, "2");
    assert.equal(d.userName, "RAHUL SHARMA");
    assert.equal(d.mobile, "9876543210");
    assert.equal(d.openCount, 1);
    assert.equal(r.json.counted, true);
  } finally {
    s.close();
  }
});

test("open: faculty, school faculty and parent are recognised", async () => {
  const s = await setup();
  try {
    await s.open("u-fac", { role: "faculty" });
    await s.open("u-sfac", { role: "faculty" });
    await s.open("u-par", { role: "parent" });
    const f = dailyDoc(s.db, "u-fac", "2026-11-20");
    assert.deepEqual([f.userType, f.institution, f.course, f.year], ["faculty", "college", "", ""]);
    const sf = dailyDoc(s.db, "u-sfac", "2026-11-20");
    assert.deepEqual([sf.userType, sf.institution], ["faculty", "school"]);
    const p = dailyDoc(s.db, "u-par", "2026-11-20");
    assert.deepEqual([p.userType, p.institution], ["parent", "school"]);
  } finally {
    s.close();
  }
});

test("open: unknown account (no profile) -> 404 and no record", async () => {
  const s = await setup();
  try {
    const r = await s.open("u-nobody");
    assert.equal(r.status, 404);
    assert.equal(dailyDoc(s.db, "u-nobody", "2026-11-20"), undefined);
  } finally {
    s.close();
  }
});

test("open: multiple opens same day increment ONE document; next day creates another", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++) {
      s.clock.t += 60000;
      const r = await s.open("u-stud");
      assert.equal(r.json.openCount, i + 1);
    }
    const d = dailyDoc(s.db, "u-stud", "2026-11-20");
    assert.equal(d.openCount, 5);
    assert.ok(d.firstOpenedAt.toMillis() < d.lastOpenedAt.toMillis());
    s.clock.t += DAY;
    const r = await s.open("u-stud");
    assert.equal(r.json.dateKey, "2026-11-21");
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-21").openCount, 1);
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").openCount, 5);
    const keys = [...s.db.docs.keys()].filter((k) => k.startsWith("appUsageDaily/"));
    assert.equal(keys.length, 2);
  } finally {
    s.close();
  }
});

test("open: idempotency - same eventId retried is counted once", async () => {
  const s = await setup();
  try {
    const eventId = s.eid();
    const a = await s.call("POST", "/open", { token: "good-u-stud", body: { eventId } });
    const b = await s.call("POST", "/open", { token: "good-u-stud", body: { eventId } });
    const c = await s.call("POST", "/open", { token: "good-u-stud", body: { eventId } });
    assert.equal(a.json.counted, true);
    assert.equal(b.json.duplicate, true);
    assert.equal(c.json.duplicate, true);
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").openCount, 1);
  } finally {
    s.close();
  }
});

test("open: concurrent increments are all counted exactly once", async () => {
  const s = await setup();
  try {
    await s.open("u-stud"); // creates doc, warms profile cache
    const results = await Promise.all(Array.from({ length: 20 }, () => s.open("u-stud")));
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").openCount, 21);
  } finally {
    s.close();
  }
});

test("open: concurrent FIRST opens (doc not yet created) do not lose counts", async () => {
  const s = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => s.open("u-fac")));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(dailyDoc(s.db, "u-fac", "2026-11-20").openCount, 8);
  } finally {
    s.close();
  }
});

test("open: offline retry keeps its real (earlier) IST day; implausible times use server time", async () => {
  const s = await setup();
  try {
    const r = await s.open("u-stud", { occurredAt: T0 - 30 * 3600 * 1000 }); // Nov 19 04:00 IST
    assert.equal(r.json.dateKey, "2026-11-19");
    const r2 = await s.open("u-stud", { occurredAt: T0 - 10 * 3600 * 1000 }); // Nov 20 00:00 IST
    assert.equal(r2.json.dateKey, "2026-11-20");
    const r3 = await s.open("u-stud", { occurredAt: T0 - 5 * DAY }); // older than 48h
    assert.equal(r3.json.dateKey, "2026-11-20");
    const r4 = await s.open("u-stud", { occurredAt: T0 + 3 * DAY }); // future
    assert.equal(r4.json.dateKey, "2026-11-20");
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-19").openCount, 1);
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").openCount, 3);
  } finally {
    s.close();
  }
});
test("open: late-evening UTC event lands on next IST date", async () => {
  const s = await setup();
  try {
    s.clock.t = Date.UTC(2026, 10, 20, 19, 0, 0); // 00:30 IST on 21st
    const r = await s.open("u-stud");
    assert.equal(r.json.dateKey, "2026-11-21");
  } finally {
    s.close();
  }
});

test("open: per-user rate limit returns 429 and stops counting", async () => {
  const s = await setup();
  try {
    let last;
    for (let i = 0; i < 35; i++) last = await s.open("u-stud");
    assert.equal(last.status, 429);
    assert.ok(last.headers.get("retry-after"));
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").openCount, 30);
    // another user unaffected
    assert.equal((await s.open("u-fac")).status, 200);
  } finally {
    s.close();
  }
});

test("open: Firestore cost - repeat opens need no profile reads (1 tx read + 1 write)", async () => {
  const s = await setup();
  try {
    await s.open("u-stud"); // first open: doc read + profile lookups + write
    s.db.reads = 0;
    s.db.writes = 0;
    await s.open("u-stud");
    assert.equal(s.db.reads, 1);
    assert.equal(s.db.writes, 1);
  } finally {
    s.close();
  }
});

// ───────────────────────── Appcount auth ─────────────────────────
const NEW_PW = "Br1ghtSession!42";

// Appcount signs in through the SHARED POST /admin/login (interceptor in front of the existing handler).
async function loginInitial(s, password = "Appcount", username = "Appcount") {
  return s.call("POST", "/admin/login", { rootPath: true, body: { username, password } });
}

test("shared login: normal admin credentials pass through the interceptor untouched", async () => {
  const s = await setup();
  try {
    const ok = await s.call("POST", "/admin/login", { rootPath: true, body: { username: "admin", password: "adminpass" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.role, "admin");
    assert.ok(ok.json.token && !ok.setCookie, "admin gets its normal token and no Appcount cookie");
    const bad = await s.call("POST", "/admin/login", { rootPath: true, body: { username: "admin", password: "nope" } });
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.json, { success: false, error: "Invalid username or password" });
    assert.equal((await s.call("GET", "/admin/buses", { rootPath: true, rawAuth: ok.json.token })).status, 200);
    // missing / non-string credentials also fall through
    assert.equal((await s.call("POST", "/admin/login", { rootPath: true, body: { username: ["Appcount"], password: {} } })).status, 401);
  } finally {
    s.close();
  }
});

test("shared login: Appcount initial login -> session cookie only, forced password change, analytics blocked", async () => {
  const s = await setup();
  try {
    const r = await loginInitial(s);
    assert.equal(r.status, 200);
    assert.equal(r.json.appUsage, true);
    assert.equal(r.json.mustChangePassword, true);
    assert.equal(r.json.token, undefined, "no token in the body");
    assert.match(r.setCookie, /HttpOnly/i);
    assert.match(r.setCookie, /SameSite=Strict/i);
    // public browser path (Nginx strips /api, so it must NOT be derived from the server-side URL)
    assert.match(r.setCookie, /Path=\/api\/app-usage(;|$)/);
    const sess = await s.call("GET", "/admin/session", { token: r.cookie });
    assert.deepEqual([sess.status, sess.json.role, sess.json.mustChangePassword], [200, "appcount", true]);
    assert.equal((await s.call("GET", "/admin/report", { token: r.cookie })).status, 403);
    assert.equal((await s.call("GET", "/admin/export", { token: r.cookie })).status, 403);
    // first successful login initialised the record: hash only, forced change, version 1
    const doc = s.db.docs.get("appUsageAdmin/credentials").data;
    assert.ok(doc.passwordHash.startsWith("$2"));
    assert.equal(doc.mustChangePassword, true);
    assert.equal(doc.tokenVersion, 1);
    assert.equal(doc.password, undefined);
    assert.ok(!r.text.includes("$2"), "hash never in a response");
  } finally {
    s.close();
  }
});

test("shared login: wrong Appcount password / other names get the normal error and no cookie", async () => {
  const s = await setup();
  try {
    const wrong = await loginInitial(s, "nope");
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { success: false, error: "Invalid username or password" });
    assert.equal(wrong.setCookie, null);
    assert.equal((await loginInitial(s, "Appcount", "root")).status, 401);
    // case-insensitive username match, password stays exact
    assert.equal((await loginInitial(s, "Appcount", "appcount")).status, 200);
    assert.equal((await loginInitial(s, "appcount")).status, 401);
  } finally {
    s.close();
  }
});

test("shared login: Appcount disabled when the env username is empty (no hardcoded fallback)", async () => {
  const s = await setup({ env: { APP_USAGE_ADMIN_USERNAME: "", APP_USAGE_ADMIN_PASSWORD: "Appcount" } });
  try {
    assert.equal((await loginInitial(s)).status, 401);
  } finally {
    s.close();
  }
  const s2 = await setup({ env: { APP_USAGE_ADMIN_USERNAME: "Appcount" } }); // no password configured
  try {
    assert.equal((await loginInitial(s2)).status, 401);
    assert.equal((await loginInitial(s2, "")).status, 401);
  } finally {
    s2.close();
  }
});

test("authorization: unauthenticated, tampered, foreign tokens are rejected; Appcount cannot reach admin APIs", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("GET", "/admin/report")).status, 401);
    assert.equal((await s.call("GET", "/admin/session")).status, 401);
    assert.equal((await s.call("GET", "/admin/report", { token: "abc.def.ghi" })).status, 401);
    assert.equal((await s.call("GET", "/admin/report", { token: "good-u-stud" })).status, 401);
    const adminJwt = jwt.sign({ admin: true, role: "admin", institution: "college" }, "test-secret");
    const superJwt = jwt.sign({ admin: true, role: "superadmin", institution: "all" }, "test-secret");
    // a main-admin JWT placed in the Appcount cookie is not an Appcount session
    assert.equal((await s.call("GET", "/admin/report", { token: superJwt })).status, 401);
    // a normal (college/school) admin never becomes an Appcount session; only an explicit super-admin may read reports
    assert.equal((await s.call("GET", "/admin/report", { rawAuth: adminJwt })).status, 401);
    assert.equal((await s.call("GET", "/admin/report", { rawAuth: superJwt })).status, 200);
    assert.equal((await s.call("GET", "/admin/session", { rawAuth: superJwt })).json.role, "superadmin");
    // super-admin cannot change the Appcount password or use its logout
    assert.equal((await s.call("POST", "/admin/change-password", { rawAuth: superJwt, body: { currentPassword: "x", newPassword: NEW_PW } })).status, 401);
    // the Appcount cookie does not unlock a normal admin API
    const c = await authed(s);
    assert.equal((await s.call("GET", "/admin/report", { token: c })).status, 200);
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/buses`, { headers: { Cookie: `scep_appusage=${c}`, Authorization: c } });
    assert.equal(res.status, 401);
    // Firebase user routes are not an admin route either
    assert.equal((await s.call("GET", "/admin/buses", { rootPath: true, rawAuth: `Bearer ${c}` })).status, 401);
  } finally {
    s.close();
  }
});

test("login brute force: Appcount lockout after 5 failures; even the right password is refused meanwhile", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++) await loginInitial(s, "bad" + i);
    const r = await loginInitial(s);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
    assert.equal(r.setCookie, null);
  } finally {
    s.close();
  }
});

test("password change: mandatory, CSRF-protected, policy enforced, stored only as bcrypt hash", async () => {
  const s = await setup();
  try {
    const l = await loginInitial(s);
    const tok = l.cookie;
    const body = (cur, nw) => ({ currentPassword: cur, newPassword: nw });
    // CSRF: cookie session without the custom header is refused
    assert.equal((await s.call("POST", "/admin/change-password", { token: tok, noCsrf: true, body: body("Appcount", NEW_PW) })).status, 403);
    for (const bad of ["short", "alllowercase12345", "Appcount12345", "NoDigitsHereAtAll"]) {
      assert.equal((await s.call("POST", "/admin/change-password", { token: tok, body: body("Appcount", bad) })).status, 400, bad);
    }
    assert.equal((await s.call("POST", "/admin/change-password", { token: tok, body: body("WRONG", NEW_PW) })).status, 400);
    const ok = await s.call("POST", "/admin/change-password", { token: tok, body: body("Appcount", NEW_PW) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.mustChangePassword, false);
    assert.equal(ok.json.token, undefined);
    assert.ok(ok.cookie && ok.cookie !== tok, "a fresh session cookie is issued (no session fixation)");
    const doc = s.db.docs.get("appUsageAdmin/credentials").data;
    assert.ok(doc.passwordHash.startsWith("$2"), "bcrypt hash stored");
    assert.ok(!JSON.stringify(doc).includes(NEW_PW), "plaintext password never stored");
    assert.equal(doc.password, undefined);
    // old (pre-change) session dead, new session alive
    assert.equal((await s.call("GET", "/admin/report", { token: tok })).status, 401);
    assert.equal((await s.call("GET", "/admin/report", { token: ok.cookie })).status, 200);
    // initial password no longer works, new one does and is not forced to change again
    const old = await loginInitial(s, "Appcount");
    assert.equal(old.status, 401);
    assert.equal(old.setCookie, null);
    const fresh = await loginInitial(s, NEW_PW);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.mustChangePassword, false);
    assert.equal((await s.call("GET", "/admin/report", { token: fresh.cookie })).status, 200);
    assert.notEqual(fresh.cookie, ok.cookie);
  } finally {
    s.close();
  }
});

test("password change survives a backend restart (stored in Firestore) and the .env password stays dead", async () => {
  const s = await setup();
  const db = s.db, clock = s.clock;
  try {
    await authed(s);
  } finally {
    s.close();
  }
  const s2 = await setup({ db, clock }); // "restart": new process state, same Firestore, same .env
  try {
    assert.equal((await loginInitial(s2, "Appcount")).status, 401);
    assert.equal((await loginInitial(s2, NEW_PW)).status, 200);
  } finally {
    s2.close();
  }
  // operator reset: deleting the credential document re-enables the .env password with a forced change
  db.docs.delete("appUsageAdmin/credentials");
  const s3 = await setup({ db, clock });
  try {
    const r = await loginInitial(s3, "Appcount");
    assert.equal(r.status, 200);
    assert.equal(r.json.mustChangePassword, true);
  } finally {
    s3.close();
  }
});

test("session: logout invalidates + clears cookie, expired cookie rejected", async () => {
  const s = await setup();
  try {
    const tok = await authed(s);
    assert.equal((await s.call("GET", "/admin/report", { token: tok })).status, 200);
    assert.equal((await s.call("POST", "/admin/logout", { token: tok, noCsrf: true })).status, 403);
    const out = await s.call("POST", "/admin/logout", { token: tok });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /scep_appusage=;/);
    assert.equal((await s.call("GET", "/admin/report", { token: tok })).status, 401);
    const secret = require("crypto").createHash("sha256").update("test-secret::app-usage-session").digest("hex");
    const expired = jwt.sign({ sub: "appcount", scope: "full", tv: 1 }, secret, { audience: "app-usage-admin", expiresIn: -10 });
    assert.equal((await s.call("GET", "/admin/report", { token: expired })).status, 401);
  } finally {
    s.close();
  }
});


// ───────────────────────── reporting ─────────────────────────
async function seedUsage(s) {
  // Nov 18: stud 5, Nov 19: stud 3, Nov 20: stud 7 (monthly total 15) + others
  const plan = [
    ["u-stud", "2026-11-18", 5],
    ["u-stud", "2026-11-19", 3],
    ["u-stud", "2026-11-20", 7],
    ["u-poly", "2026-11-20", 2],
    ["u-fac", "2026-11-20", 4],
    ["u-sfac", "2026-11-19", 1],
    ["u-par", "2026-11-20", 6],
    ["u-par", "2026-10-31", 9],
  ];
  const prof = { "u-stud": ["RAHUL SHARMA", "9876543210", "college", "student", "btech", "2"], "u-poly": ["Amit Verma", "9000000001", "college", "student", "poly", "1"], "u-fac": ["Dr Mehta", "9111111111", "college", "faculty", "", ""], "u-sfac": ["Mrs Rao", "9222222222", "school", "faculty", "", ""], "u-par": ["Sunita Devi", "9333333333", "school", "parent", "", ""] };
  for (const [uid, dk, n] of plan) {
    const [userName, mobile, institution, userType, course, year] = prof[uid];
    const base = Date.UTC(+dk.slice(0, 4), +dk.slice(5, 7) - 1, +dk.slice(8, 10), 3, 0, 0);
    await s.db.collection("appUsageDaily").doc(`${uid}_${dk}`).set({
      uid, userName, mobile, institution, userType, course, year, dateKey: dk, openCount: n,
      firstOpenedAt: Timestamp.fromMillis(base), lastOpenedAt: Timestamp.fromMillis(base + 3600000), recentEventIds: [],
    });
  }
}

async function authed(s) {
  const l = await loginInitial(s);
  const ok = await s.call("POST", "/admin/change-password", { token: l.cookie, body: { currentPassword: "Appcount", newPassword: NEW_PW } });
  return ok.cookie;
}
const q = (o) => "?" + new URLSearchParams(o).toString();

test("report: default is TODAY and summary cards are computed from records", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    const t = await authed(s);
    const r = await s.call("GET", "/admin/report", { token: t });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.query, { from: "2026-11-20", to: "2026-11-20" });
    // all original summary fields unchanged; `ads` is an additive field (0 here: no impressions seeded)
    assert.deepEqual(r.json.summary, {
      totalOpens: 7 + 2 + 4 + 6, uniqueUsers: 4, avgOpensPerUser: 4.75,
      collegeUsers: 3, schoolUsers: 1, studentUsers: 2, facultyUsers: 1, parentUsers: 1,
      ads: { total: 0, banner: 0, interstitial: 0, rewarded: 0, usersWithImpressions: 0 },
    });
    assert.equal(r.json.rows[0].userName, "RAHUL SHARMA"); // highest opens first
    assert.equal(r.json.rows[0].date, "2026-11-20");
  } finally {
    s.close();
  }
});

test("report: yesterday / custom date / date range", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    const t = await authed(s);
    let r = await s.call("GET", "/admin/report" + q({ from: "2026-11-19", to: "2026-11-19" }), { token: t });
    assert.equal(r.json.summary.totalOpens, 4);
    r = await s.call("GET", "/admin/report" + q({ from: "2026-11-18", to: "2026-11-20" }), { token: t });
    assert.equal(r.json.summary.totalOpens, 5 + 3 + 7 + 2 + 4 + 1 + 6);
    const stud = r.json.rows.find((x) => x.uid === "u-stud");
    assert.equal(stud.openCount, 15); // aggregated, not latest day
    assert.equal(stud.date, "2026-11-18 to 2026-11-20");
    assert.equal(stud.activeDays, 3);
  } finally {
    s.close();
  }
});

test("report: monthly aggregation = sum of all daily docs in the month", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    const t = await authed(s);
    const nov = await s.call("GET", "/admin/report" + q({ from: "2026-11-01", to: "2026-11-30" }), { token: t });
    assert.equal(nov.json.rows.find((x) => x.uid === "u-stud").openCount, 15);
    assert.equal(nov.json.rows.find((x) => x.uid === "u-par").openCount, 6); // Oct 31 excluded
    const oct = await s.call("GET", "/admin/report" + q({ from: "2026-10-01", to: "2026-10-31" }), { token: t });
    assert.equal(oct.json.summary.totalOpens, 9);
  } finally {
    s.close();
  }
});

test("report: filters combine (institution, userType, course, year, weekday)", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    const t = await authed(s);
    const base = { from: "2026-11-01", to: "2026-11-30" };
    const get = async (extra) => (await s.call("GET", "/admin/report" + q({ ...base, ...extra }), { token: t })).json;
    assert.equal((await get({ institution: "school" })).summary.uniqueUsers, 2);
    assert.equal((await get({ institution: "college", userType: "student" })).summary.uniqueUsers, 2);
    assert.equal((await get({ userType: "parent" })).summary.totalOpens, 6);
    assert.equal((await get({ course: "poly" })).summary.uniqueUsers, 1);
    assert.equal((await get({ course: "btech", year: "2" })).summary.totalOpens, 15);
    assert.equal((await get({ course: "btech", year: "3" })).summary.totalOpens, 0);
    assert.equal((await get({ institution: "school", course: "btech" })).rows.length, 0);
    // Nov 18 is Wednesday, Nov 19 Thursday, Nov 20 Friday
    assert.equal((await get({ weekday: "wednesday" })).summary.totalOpens, 5);
    assert.equal((await get({ weekday: "friday", userType: "student" })).rows.find((x) => x.uid === "u-stud").openCount, 7);
    assert.equal((await get({ weekday: "monday" })).rows.length, 0);
    // dropdown options are dynamic and not collapsed by the course filter
    const j = await get({ course: "poly" });
    assert.deepEqual(j.options.courses.map((c) => c.value), ["btech", "poly"]);
    assert.ok(j.options.years.map((y) => y.value).includes("4"));
  } finally {
    s.close();
  }
});

test("report: search by name/mobile, sorting, pagination", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    const t = await authed(s);
    const base = { from: "2026-11-20", to: "2026-11-20" };
    const get = async (extra) => (await s.call("GET", "/admin/report" + q({ ...base, ...extra }), { token: t })).json;
    assert.equal((await get({ search: "rahul" })).rows.length, 1);
    assert.equal((await get({ search: "98765" })).rows[0].uid, "u-stud");
    assert.equal((await get({ search: "zzz" })).rows.length, 0);
    assert.deepEqual((await get({ sort: "opens_asc" })).rows.map((r) => r.openCount), [2, 4, 6, 7]);
    assert.deepEqual((await get({ sort: "opens_desc" })).rows.map((r) => r.openCount), [7, 6, 4, 2]);
    assert.deepEqual((await get({ sort: "name_asc" })).rows.map((r) => r.userName), ["Amit Verma", "Dr Mehta", "RAHUL SHARMA", "Sunita Devi"]);
    assert.deepEqual((await get({ sort: "name_desc" })).rows.map((r) => r.userName)[0], "Sunita Devi");
    const p1 = await get({ pageSize: 5, page: 1 });
    assert.equal(p1.rows.length, 4);
    assert.equal(p1.totalPages, 1);
    // summary ignores search; table honours it
    const srch = await get({ search: "rahul" });
    assert.equal(srch.summary.uniqueUsers, 4);
    assert.equal(srch.total, 1);
    // serial numbers continue across pages
    for (let i = 0; i < 12; i++) {
      await s.db.collection("appUsageDaily").doc(`x${i}_2026-11-20`).set({ uid: "x" + i, userName: "User " + String(i).padStart(2, "0"), mobile: "", institution: "college", userType: "student", course: "btech", year: "1", dateKey: "2026-11-20", openCount: 1, firstOpenedAt: Timestamp.fromMillis(T0), lastOpenedAt: Timestamp.fromMillis(T0) });
    }
    s.router._internals.rangeCache.clear();
    const pg2 = await get({ pageSize: 5, page: 2, sort: "name_asc" });
    assert.equal(pg2.total, 16);
    assert.equal(pg2.rows[0].serial, 6);
    assert.equal(pg2.rows.length, 5);
    assert.equal(pg2.totalPages, 4);
  } finally {
    s.close();
  }
});

test("report: validation errors and empty results", async () => {
  const s = await setup();
  try {
    const t = await authed(s);
    const get = (o) => s.call("GET", "/admin/report" + q(o), { token: t });
    assert.equal((await get({ from: "2026-13-01" })).status, 400);
    assert.equal((await get({ from: "2026-11-20", to: "2026-11-01" })).status, 400);
    assert.equal((await get({ from: "2020-01-01", to: "2026-11-01" })).status, 400);
    assert.equal((await get({ institution: "mars" })).status, 400);
    assert.equal((await get({ weekday: "funday" })).status, 400);
    const empty = await get({ from: "2026-01-01", to: "2026-01-31" });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.rows.length, 0);
    assert.equal(empty.json.summary.uniqueUsers, 0);
    assert.equal(empty.json.summary.avgOpensPerUser, 0);
  } finally {
    s.close();
  }
});

test("report: range cache avoids re-reading Firestore when only filters change", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    const t = await authed(s);
    const base = { from: "2026-11-01", to: "2026-11-30" };
    await s.call("GET", "/admin/report" + q(base), { token: t });
    const readsAfterFirst = s.db.reads;
    await s.call("GET", "/admin/report" + q({ ...base, institution: "school" }), { token: t });
    await s.call("GET", "/admin/report" + q({ ...base, userType: "student", page: 2 }), { token: t });
    assert.equal(s.db.reads, readsAfterFirst);
  } finally {
    s.close();
  }
});

test("export: CSV with BOM, aggregated totals, honours filters, protected", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    assert.equal((await s.call("GET", "/admin/export")).status, 401);
    const t = await authed(s);
    const r = await s.call("GET", "/admin/export" + q({ from: "2026-11-01", to: "2026-11-30", userType: "student" }), { token: t });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/csv/);
    assert.match(r.headers.get("content-disposition"), /app-usage_2026-11-01_2026-11-30\.csv/);
    assert.ok(r.text.startsWith("\uFEFF"));
    const lines = r.text.replace("\uFEFF", "").split("\r\n\r\n")[0].trim().split("\r\n"); // user table part
    // original columns unchanged and in the same order; the 4 impression columns follow App Open Count
    assert.equal(lines[0], "S.No,User Name,Mobile,Institution,User Type,Course,Academic Year,App Open Count,Banner Impressions,Interstitial Impressions,Rewarded Impressions,Total Ad Impressions,First Opened (IST),Last Opened (IST),Date");
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^1,RAHUL SHARMA,9876543210,college,student,BTech,2nd Year,15,0,0,0,0,/);
    assert.match(lines[1], /2026-11-18 to 2026-11-20$/);
  } finally {
    s.close();
  }
});

test("profileSnapshot legacy docs (no institution)", () => {
  assert.equal(mod.profileSnapshot("students", { name: "A", uid: "u" }).institution, "college");
  assert.equal(mod.profileSnapshot("faculty", { name: "A", facultyType: "School" }).institution, "school");
  assert.equal(mod.profileSnapshot("parents", { name: "A" }).institution, "unknown");
});

// ───────────────────────── credential bootstrap + session loop regression ─────────────────────────
test("bootstrap: record absent + WRONG password creates nothing; unknown names create nothing", async () => {
  const s = await setup();
  try {
    assert.equal((await loginInitial(s, "wrong")).status, 401);
    assert.equal((await loginInitial(s, "Appcount", "someone")).status, 401);
    assert.equal((await s.call("GET", "/admin/session")).status, 401);
    assert.equal(s.db.docs.has("appUsageAdmin/credentials"), false);
  } finally {
    s.close();
  }
});

test("bootstrap: record absent + correct .env password -> exactly one record, session accepted, forced change", async () => {
  const s = await setup();
  try {
    const r = await loginInitial(s);
    assert.equal(r.status, 200);
    assert.equal(r.json.mustChangePassword, true);
    const keys = [...s.db.docs.keys()].filter((k) => k.startsWith("appUsageAdmin/"));
    assert.deepEqual(keys, ["appUsageAdmin/credentials"]);
    // the regression: the dashboard's session check must accept the cookie from login
    const sess = await s.call("GET", "/admin/session", { token: r.cookie });
    assert.equal(sess.status, 200);
    assert.equal(sess.json.mustChangePassword, true);
    // logging in again with the initial password reuses the record (no second write, still forced change)
    const before = JSON.stringify(s.db.docs.get("appUsageAdmin/credentials").data);
    const again = await loginInitial(s);
    assert.equal(again.status, 200);
    assert.equal(again.json.mustChangePassword, true);
    assert.equal(JSON.stringify(s.db.docs.get("appUsageAdmin/credentials").data), before);
  } finally {
    s.close();
  }
});

test("bootstrap: concurrent first logins create ONE record and all get valid sessions", async () => {
  const s = await setup();
  try {
    const rs = await Promise.all([1, 2, 3, 4].map(() => loginInitial(s)));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
    assert.equal([...s.db.docs.keys()].filter((k) => k.startsWith("appUsageAdmin/")).length, 1);
    for (const r of rs) assert.equal((await s.call("GET", "/admin/session", { token: r.cookie })).status, 200);
  } finally {
    s.close();
  }
});

test("bootstrap: an existing record is never overwritten and wins over the .env password", async () => {
  const s = await setup();
  try {
    const hash = await bcrypt.hash("Existing9Password", 4);
    const existing = { username: "Appcount", passwordHash: hash, mustChangePassword: false, tokenVersion: 7 };
    await s.db.collection("appUsageAdmin").doc("credentials").set(existing);
    assert.equal((await loginInitial(s, "Appcount")).status, 401);
    assert.deepEqual(s.db.docs.get("appUsageAdmin/credentials").data, existing);
    const ok = await loginInitial(s, "Existing9Password");
    assert.equal(ok.status, 200);
    assert.equal(ok.json.mustChangePassword, false);
    assert.equal((await s.call("GET", "/admin/report", { token: ok.cookie })).status, 200);
  } finally {
    s.close();
  }
});

test("full first-login flow: bootstrap -> change -> logout -> old dead, new works, survives restart", async () => {
  const s = await setup();
  const db = s.db, clock = s.clock;
  try {
    const first = await loginInitial(s);
    const ch = await s.call("POST", "/admin/change-password", { token: first.cookie, body: { currentPassword: "Appcount", newPassword: NEW_PW } });
    assert.equal(ch.status, 200);
    const doc = db.docs.get("appUsageAdmin/credentials").data;
    assert.deepEqual([doc.mustChangePassword, doc.tokenVersion], [false, 2]);
    assert.ok(doc.createdAt, "createdAt preserved on change");
    assert.equal((await s.call("GET", "/admin/session", { token: first.cookie })).status, 401, "pre-change session invalidated");
    assert.equal((await s.call("POST", "/admin/logout", { token: ch.cookie })).status, 200);
    assert.equal((await loginInitial(s, "Appcount")).status, 401);
    assert.equal((await loginInitial(s, NEW_PW)).status, 200);
  } finally {
    s.close();
  }
  const s2 = await setup({ db, clock });
  try {
    assert.equal((await loginInitial(s2, "Appcount")).status, 401);
    const r = await loginInitial(s2, NEW_PW);
    assert.equal(r.status, 200);
    assert.equal((await s2.call("GET", "/admin/report", { token: r.cookie })).status, 200);
  } finally {
    s2.close();
  }
});

test("cookie path override (APP_USAGE_COOKIE_PATH) and invalid override falls back", async () => {
  const s = await setup({ env: { APP_USAGE_ADMIN_USERNAME: "Appcount", APP_USAGE_ADMIN_PASSWORD: "Appcount", APP_USAGE_COOKIE_PATH: "/svc/app-usage" } });
  try {
    assert.match((await loginInitial(s)).setCookie, /Path=\/svc\/app-usage(;|$)/);
  } finally {
    s.close();
  }
  const s2 = await setup({ env: { APP_USAGE_ADMIN_USERNAME: "Appcount", APP_USAGE_ADMIN_PASSWORD: "Appcount", APP_USAGE_COOKIE_PATH: "javascript:x" } });
  try {
    assert.match((await loginInitial(s2)).setCookie, /Path=\/api\/app-usage(;|$)/);
  } finally {
    s2.close();
  }
});

// ───────────────────────── active / registered cards ─────────────────────────
// Registered profiles from setup(): u-stud (college student btech 2), u-poly (college student poly 1),
// u-fac (college faculty), u-sfac (school faculty), u-par (school parent). Added here:
//   u-never  college student btech 2, registered but never opened the app
//   (no uid) a student profile without uid -> not counted
//   u-gone   has app opens but no profile any more (deleted account) -> never counted as active
async function seedCardsScenario(s) {
  await seedUsage(s);
  await s.db.collection("students").doc("student-003").set({ uid: "u-never", name: "Never Opened", institution: "college", course: "btech", year: "2" });
  await s.db.collection("students").doc("student-004").set({ uid: "", name: "Broken Registration", institution: "college", course: "btech", year: "1" });
  await s.db.collection("appUsageDaily").doc("u-gone_2026-11-20").set({
    uid: "u-gone", userName: "Deleted", mobile: "", institution: "college", userType: "student", course: "btech", year: "2",
    dateKey: "2026-11-20", openCount: 4, firstOpenedAt: Timestamp.fromMillis(T0), lastOpenedAt: Timestamp.fromMillis(T0), recentEventIds: [],
  });
}

test("cards: today = active/registered per category, never-opened users in totals, avg over registered", async () => {
  const s = await setup();
  try {
    await seedCardsScenario(s);
    const t = await authed(s);
    const j = (await s.call("GET", "/admin/report", { token: t })).json;
    const c = j.cards;
    // today (2026-11-20) openers: u-stud 7, u-poly 2, u-fac 4, u-par 6, u-gone 4 (unregistered)
    assert.deepEqual(c.registered, { users: 6, college: 4, school: 2, student: 3, faculty: 2, parent: 1 });
    assert.deepEqual(c.active, { users: 4, college: 3, school: 1, student: 2, faculty: 1, parent: 1 });
    assert.equal(j.summary.totalOpens, 7 + 2 + 4 + 6 + 4); // card 1 unchanged: every recorded open
    assert.equal(c.avgOpensPerRegisteredUser, Math.round((23 / 6) * 100) / 100);
    assert.equal(c.excludedProfilesWithoutUid, 1);
    for (const k of Object.keys(c.active)) assert.ok(c.active[k] <= c.registered[k], k);
    // college + school and student + faculty + parent partition the registered users (no double counting)
    assert.equal(c.registered.college + c.registered.school, c.registered.users);
    assert.equal(c.registered.student + c.registered.faculty + c.registered.parent, c.registered.users);
  } finally {
    s.close();
  }
});

test("cards: a user with many opens on many days is ONE active user; date range does not change registered", async () => {
  const s = await setup();
  try {
    await seedCardsScenario(s);
    const t = await authed(s);
    const get = async (o) => (await s.call("GET", "/admin/report" + q(o), { token: t })).json.cards;
    const month = await get({ from: "2026-11-01", to: "2026-11-30" });
    // November openers: u-stud (3 days), u-poly, u-fac, u-sfac, u-par -> 5 distinct registered users
    assert.equal(month.active.users, 5);
    assert.equal(month.active.student, 2);
    assert.equal(month.registered.users, 6);
    const empty = await get({ from: "2026-01-01", to: "2026-01-31" });
    assert.deepEqual(empty.active, { users: 0, college: 0, school: 0, student: 0, faculty: 0, parent: 0 });
    assert.equal(empty.registered.users, 6, "registered total is independent of the date filter");
    assert.equal(empty.avgOpensPerRegisteredUser, 0);
    const wed = await get({ from: "2026-11-01", to: "2026-11-30", weekday: "wednesday" }); // Nov 18: only u-stud
    assert.equal(wed.active.users, 1);
    assert.equal(wed.registered.users, 6);
  } finally {
    s.close();
  }
});

test("cards: institution / user type / course / year filters apply to BOTH active and registered; search does not", async () => {
  const s = await setup();
  try {
    await seedCardsScenario(s);
    const t = await authed(s);
    const get = async (o) => (await s.call("GET", "/admin/report" + q({ from: "2026-11-01", to: "2026-11-30", ...o }), { token: t })).json;
    let c = (await get({ institution: "school" })).cards;
    assert.deepEqual([c.active.users, c.registered.users, c.registered.college, c.registered.school], [2, 2, 0, 2]);
    c = (await get({ userType: "student" })).cards;
    assert.deepEqual([c.active.student, c.registered.student, c.registered.faculty], [2, 3, 0]);
    c = (await get({ course: "btech", year: "2" })).cards; // u-stud + u-never
    assert.deepEqual([c.active.users, c.registered.users], [1, 2]);
    c = (await get({ institution: "school", userType: "student" })).cards;
    assert.deepEqual([c.active.users, c.registered.users], [0, 0]);
    assert.equal(c.avgOpensPerRegisteredUser, 0, "division by zero handled");
    const srch = await get({ search: "rahul" });
    assert.equal(srch.total, 1, "table honours search");
    assert.deepEqual([srch.cards.active.users, srch.cards.registered.users], [5, 6], "cards ignore search");
    const sorted = await get({ sort: "name_desc" });
    assert.deepEqual(sorted.cards, (await get({})).cards, "sort does not change cards");
  } finally {
    s.close();
  }
});

test("cards: registered population is cached (no profile re-read per request) and dropdowns include registered courses", async () => {
  const s = await setup();
  try {
    await seedCardsScenario(s);
    await s.db.collection("students").doc("student-005").set({ uid: "u-iti", name: "Iti Never", institution: "college", course: "iti", year: "2" });
    const t = await authed(s);
    const j = (await s.call("GET", "/admin/report" + q({ from: "2026-11-20", to: "2026-11-20" }), { token: t })).json;
    assert.ok(j.options.courses.some((o) => o.value === "iti"), "course of a never-active user is selectable");
    const reads = s.db.reads;
    await s.call("GET", "/admin/report" + q({ from: "2026-11-20", to: "2026-11-20", institution: "college" }), { token: t });
    await s.call("GET", "/admin/report" + q({ from: "2026-11-20", to: "2026-11-20", userType: "faculty" }), { token: t });
    assert.equal(s.db.reads, reads, "filter changes reuse cached usage rows AND cached population");
  } finally {
    s.close();
  }
});

test("cards: CSV export appends active / registered summary after the unchanged user table", async () => {
  const s = await setup();
  try {
    await seedCardsScenario(s);
    const t = await authed(s);
    const r = await s.call("GET", "/admin/export" + q({ from: "2026-11-20", to: "2026-11-20" }), { token: t });
    const [table, summary] = r.text.replace("\uFEFF", "").split("\r\n\r\n");
    assert.match(table.split("\r\n")[0], /^S\.No,User Name/);
    const lines = summary.trim().split("\r\n");
    assert.deepEqual(lines, [
      "Summary,Active Users,Registered Users",
      "App Users,4,6",
      "College Users,3,4",
      "School Users,1,2",
      "Student Users,2,3",
      "Faculty Users,1,2",
      "Parent Users,1,1",
      "Total App Opens,23,",
      "Avg Opens / Registered User,3.83,",
    ]);
  } finally {
    s.close();
  }
});

// ───────────────────────── ad impressions ─────────────────────────
let adSeq = 0;
const adEv = (format, extra = {}) => ({ eventId: `ad_${String(++adSeq).padStart(8, "0")}_xyzxyzxy`, format, ...extra });
const sendAds = (s, uid, events, token) => s.call("POST", "/ads", { token: token || `good-${uid}`, body: { events } });

test("ads: auth required, invalid token rejected, foreign uid rejected, nothing written", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/ads", { body: { events: [adEv("banner")] } })).status, 401);
    assert.equal((await sendAds(s, "u-stud", [adEv("banner")], "garbage")).status, 401);
    const r = await s.call("POST", "/ads", { token: "good-u-stud", body: { uid: "u-fac", events: [adEv("banner")] } });
    assert.equal(r.status, 403);
    assert.equal([...s.db.docs.keys()].filter((k) => k.startsWith("appUsageDaily/")).length, 0);
  } finally {
    s.close();
  }
});

test("ads: validation (format, eventId, batch size, extra fields, client totals ignored)", async () => {
  const s = await setup();
  try {
    assert.equal((await sendAds(s, "u-stud", [])).status, 400);
    assert.equal((await sendAds(s, "u-stud", [adEv("native")])).status, 400);
    assert.equal((await sendAds(s, "u-stud", [adEv("appOpen")])).status, 400);
    assert.equal((await sendAds(s, "u-stud", [{ eventId: "short", format: "banner" }])).status, 400);
    assert.equal((await sendAds(s, "u-stud", Array.from({ length: 51 }, () => adEv("banner")))).status, 400);
    assert.equal((await sendAds(s, "u-stud", [adEv("banner", { count: 999 })])).status, 400, "extra fields such as client totals are refused");
    assert.equal((await s.call("POST", "/ads", { token: "good-u-stud", body: { events: [adEv("banner")], totals: { banner: 50 } } })).status, 400);
    assert.equal((await sendAds(s, "u-stud", [adEv("banner", { occurredAt: "x" })])).status, 400);
  } finally {
    s.close();
  }
});

test("ads: each format counted exactly once into the user's daily doc; app opens untouched", async () => {
  const s = await setup();
  try {
    await s.open("u-stud");
    await s.open("u-stud");
    const r = await sendAds(s, "u-stud", [adEv("banner"), adEv("banner"), adEv("interstitial"), adEv("rewarded")]);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.counted, r.json.duplicates], [4, 0]);
    const d = dailyDoc(s.db, "u-stud", "2026-11-20");
    assert.deepEqual([d.openCount, d.adBanner, d.adInterstitial, d.adRewarded], [2, 2, 1, 1]);
    assert.equal(d.userType, "student");
    assert.ok(!("adNetwork" in d) && !("revenue" in d), "no network / revenue data stored");
    // a later open still increments the same doc normally
    await s.open("u-stud");
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").openCount, 3);
    assert.equal(dailyDoc(s.db, "u-stud", "2026-11-20").adBanner, 2);
  } finally {
    s.close();
  }
});

test("ads: retries and duplicate callbacks never double count (same eventId, same batch or later batch)", async () => {
  const s = await setup();
  try {
    const a = adEv("banner"), b = adEv("rewarded");
    const r1 = await sendAds(s, "u-stud", [a, a, b]); // duplicate inside the batch
    assert.deepEqual([r1.json.counted, r1.json.duplicates], [2, 1]);
    const r2 = await sendAds(s, "u-stud", [a, b]); // full retry of the batch
    assert.deepEqual([r2.json.counted, r2.json.duplicates], [0, 2]);
    const r3 = await sendAds(s, "u-stud", [a, adEv("interstitial")]); // partial retry + new
    assert.deepEqual([r3.json.counted, r3.json.duplicates], [1, 1]);
    const d = dailyDoc(s.db, "u-stud", "2026-11-20");
    assert.deepEqual([d.adBanner, d.adInterstitial, d.adRewarded], [1, 1, 1]);
  } finally {
    s.close();
  }
});

test("ads: concurrent batches are all counted (transactions), still no duplicates", async () => {
  const s = await setup();
  try {
    await s.open("u-fac");
    const batches = Array.from({ length: 8 }, () => [adEv("banner"), adEv("banner"), adEv("interstitial")]);
    const rs = await Promise.all(batches.map((b) => sendAds(s, "u-fac", b)));
    assert.ok(rs.every((r) => r.status === 200));
    await Promise.all(batches.map((b) => sendAds(s, "u-fac", b))); // concurrent retries
    const d = dailyDoc(s.db, "u-fac", "2026-11-20");
    assert.deepEqual([d.adBanner, d.adInterstitial], [16, 8]);
  } finally {
    s.close();
  }
});

test("ads: offline batch spanning midnight goes to each IST day; impressions without an open create a 0-open doc", async () => {
  const s = await setup();
  try {
    s.clock.t = Date.UTC(2026, 10, 20, 18, 40); // 00:10 IST on the 21st
    const r = await sendAds(s, "u-par", [
      adEv("banner", { occurredAt: Date.UTC(2026, 10, 20, 18, 20) }), // 23:50 IST on the 20th
      adEv("banner", { occurredAt: Date.UTC(2026, 10, 20, 18, 35) }), // 00:05 IST on the 21st
      adEv("rewarded", { occurredAt: Date.UTC(2026, 10, 17, 0, 0) }), // > 48h old -> server time (21st)
    ]);
    assert.equal(r.json.counted, 3);
    const d20 = dailyDoc(s.db, "u-par", "2026-11-20"), d21 = dailyDoc(s.db, "u-par", "2026-11-21");
    assert.deepEqual([d20.openCount, d20.adBanner], [0, 1]);
    assert.deepEqual([d21.openCount, d21.adBanner, d21.adRewarded], [0, 1, 1]);
    assert.equal(d21.userType, "parent"); // trusted profile, not client data
    // a later app open on the 21st sets first/last opened normally
    await s.open("u-par");
    const after = dailyDoc(s.db, "u-par", "2026-11-21");
    assert.equal(after.openCount, 1);
    assert.ok(after.firstOpenedAt && after.lastOpenedAt);
  } finally {
    s.close();
  }
});

test("ads: unknown account (no profile) -> 404; rate limit per user", async () => {
  const s = await setup();
  try {
    assert.equal((await sendAds(s, "u-nobody", [adEv("banner")])).status, 404);
    let last;
    for (let i = 0; i < 42; i++) last = await sendAds(s, "u-stud", [adEv("banner")]);
    assert.equal(last.status, 429);
    assert.equal((await sendAds(s, "u-fac", [adEv("banner")])).status, 200, "other users unaffected");
  } finally {
    s.close();
  }
});

test("ads report: per-user totals, users never mix, zero-impression users listed, filters apply, summary = table", async () => {
  const s = await setup();
  try {
    await seedUsage(s); // opens for 5 users across Nov 18-20 (+ Oct 31 parent)
    await sendAds(s, "u-stud", [adEv("banner"), adEv("banner"), adEv("banner"), adEv("interstitial")]);
    await sendAds(s, "u-fac", [adEv("rewarded"), adEv("banner")]);
    s.clock.t = T0 - 86400000; // Nov 19
    await sendAds(s, "u-stud", [adEv("rewarded")]);
    s.clock.t = T0;
    s.router._internals.rangeCache.clear();
    const t = await authed(s);
    const get = async (o) => (await s.call("GET", "/admin/report" + q(o), { token: t })).json;
    const today = await get({});
    const row = (j, uid) => j.rows.find((r) => r.uid === uid);
    assert.deepEqual([row(today, "u-stud").adBanner, row(today, "u-stud").adInterstitial, row(today, "u-stud").adRewarded, row(today, "u-stud").adTotal], [3, 1, 0, 4]);
    assert.deepEqual([row(today, "u-fac").adBanner, row(today, "u-fac").adRewarded, row(today, "u-fac").adTotal], [1, 1, 2]);
    assert.equal(row(today, "u-par").adTotal, 0, "zero-impression user still listed");
    assert.equal(row(today, "u-stud").openCount, 7, "app opens unchanged");
    assert.deepEqual(today.summary.ads, { total: 6, banner: 4, interstitial: 1, rewarded: 1, usersWithImpressions: 2 });
    const sum = today.rows.reduce((a, r) => a + r.adTotal, 0);
    assert.equal(sum, today.summary.ads.total, "summary equals table");
    // range aggregates both days for u-stud
    const nov = await get({ from: "2026-11-01", to: "2026-11-30" });
    assert.deepEqual([row(nov, "u-stud").adTotal, row(nov, "u-stud").adRewarded, row(nov, "u-stud").openCount], [5, 1, 15]);
    // filters apply to impressions
    assert.equal((await get({ userType: "faculty" })).summary.ads.total, 2);
    assert.equal((await get({ institution: "school" })).summary.ads.total, 0);
    assert.equal((await get({ from: "2026-11-01", to: "2026-11-30", weekday: "thursday" })).summary.ads.total, 1); // Nov 19
    assert.equal((await get({ course: "btech" })).summary.ads.total, 4);
    // search narrows table AND ad summary consistently
    const srch = await get({ search: "mehta" });
    assert.deepEqual([srch.rows.length, srch.summary.ads.total], [1, 2]);
    // registered/active cards unaffected by ad-only activity
    assert.equal(today.cards.active.users, 4);
  } finally {
    s.close();
  }
});

test("ads report: a user with only ad impressions (no open) appears with 0 opens and is not an active user", async () => {
  const s = await setup();
  try {
    await sendAds(s, "u-sfac", [adEv("banner")]);
    const t = await authed(s);
    const j = (await s.call("GET", "/admin/report", { token: t })).json;
    const r = j.rows.find((x) => x.uid === "u-sfac");
    assert.deepEqual([r.openCount, r.adTotal, r.activeDays, r.firstOpenedAt], [0, 1, 0, null]);
    assert.equal(j.cards.active.users, 0);
    assert.equal(j.summary.totalOpens, 0);
  } finally {
    s.close();
  }
});

test("ads CSV: impression columns per user + summary equal to the table rows", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    await sendAds(s, "u-stud", [adEv("banner"), adEv("interstitial"), adEv("rewarded"), adEv("rewarded")]);
    s.router._internals.rangeCache.clear();
    const t = await authed(s);
    const r = await s.call("GET", "/admin/export" + q({ from: "2026-11-20", to: "2026-11-20" }), { token: t });
    const [table, , ads] = r.text.replace("\uFEFF", "").split("\r\n\r\n");
    const lines = table.trim().split("\r\n");
    assert.equal(lines[0], "S.No,User Name,Mobile,Institution,User Type,Course,Academic Year,App Open Count,Banner Impressions,Interstitial Impressions,Rewarded Impressions,Total Ad Impressions,First Opened (IST),Last Opened (IST),Date");
    assert.match(lines[1], /^1,RAHUL SHARMA,9876543210,college,student,BTech,2nd Year,7,1,1,2,4,/);
    assert.ok(lines.slice(2).every((l) => /,0,0,0,0,/.test(l)), "other users 0 impressions");
    assert.deepEqual(ads.trim().split("\r\n"), [
      "Ad Impressions,Count",
      "Total Ad Impressions,4",
      "Banner Impressions,1",
      "Interstitial Impressions,1",
      "Rewarded Impressions,2",
      "Users with Ad Impressions,1",
    ]);
  } finally {
    s.close();
  }
});

test("account deletion helper removes all of a user's app usage docs (opens + impressions) only", async () => {
  const s = await setup();
  try {
    await seedUsage(s);
    await sendAds(s, "u-stud", [adEv("banner")]);
    s.db.batch = () => { const ops = []; return { delete: (ref) => ops.push(ref), commit: async () => { for (const r of ops) s.db.docs.delete(r._path); } }; };
    const n = await mod.deleteUserUsageRecords(s.db, "u-stud"); // seedUsage: Nov 18/19/20 (ads land in the Nov 20 doc)
    assert.equal(n, 3);
    assert.equal([...s.db.docs.keys()].filter((k) => k.startsWith("appUsageDaily/u-stud_")).length, 0);
    assert.ok([...s.db.docs.keys()].some((k) => k.startsWith("appUsageDaily/u-fac_")), "other users untouched");
    assert.equal(await mod.deleteUserUsageRecords(s.db, ""), 0);
  } finally {
    s.close();
  }
});
