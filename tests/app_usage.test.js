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
  const db = new FakeDb();
  const clock = { t: T0 };
  await db.collection("students").doc("student-001").set({ uid: "u-stud", name: "RAHUL SHARMA", mobile: "9876543210", institution: "college", course: "btech", year: "2", studentType: "college" });
  await db.collection("students").doc("student-002").set({ uid: "u-poly", name: "Amit Verma", mobile: "9000000001", institution: "college", course: "poly", year: "1" });
  await db.collection("faculty").doc("faculty-001").set({ uid: "u-fac", name: "Dr Mehta", mobile: "9111111111", institution: "college", facultyType: "College" });
  await db.collection("faculty").doc("faculty-002").set({ uid: "u-sfac", name: "Mrs Rao", mobile: "9222222222", institution: "school", facultyType: "School" });
  await db.collection("parents").doc("parent-001").set({ uid: "u-par", name: "Sunita Devi", mobile: "9333333333", institution: "school" });
  const router = mod.createAppUsageRouter({
    admin,
    jwt,
    bcrypt,
    express,
    db,
    jwtSecret: "test-secret",
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
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/app-usage`;
  const call = async (method, path, { token, body, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, json, text, headers: res.headers };
  };
  let n = 0;
  const eid = () => `evt_${String(++n).padStart(6, "0")}_abcdefghij`;
  const open = (uid, extra = {}, tokenOverride) => call("POST", "/open", { token: tokenOverride || `good-${uid}`, body: { eventId: eid(), ...extra } });
  return { db, clock, call, open, eid, close: () => server.close(), router };
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

async function loginInitial(s) {
  return s.call("POST", "/admin/login", { body: { username: "Appcount", password: "Appcount" } });
}

test("admin: initial login works but only yields a password-change token; analytics blocked", async () => {
  const s = await setup();
  try {
    const r = await loginInitial(s);
    assert.equal(r.status, 200);
    assert.equal(r.json.mustChangePassword, true);
    // hash stored, never plain text
    const stored = s.db.docs.get("appUsageAdmin/credentials").data;
    assert.ok(stored.passwordHash.startsWith("$2"));
    assert.notEqual(stored.passwordHash, "Appcount");
    const rep = await s.call("GET", "/admin/report", { token: r.json.token });
    assert.equal(rep.status, 403);
    const exp = await s.call("GET", "/admin/export", { token: r.json.token });
    assert.equal(exp.status, 403);
  } finally {
    s.close();
  }
});

test("admin: wrong creds, unknown user and unauthenticated access", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/admin/login", { body: { username: "Appcount", password: "nope" } })).status, 401);
    assert.equal((await s.call("POST", "/admin/login", { body: { username: "root", password: "Appcount" } })).status, 401);
    assert.equal((await s.call("POST", "/admin/login", { body: { username: 5, password: 1 } })).status, 400);
    assert.equal((await s.call("GET", "/admin/report")).status, 401);
    assert.equal((await s.call("GET", "/admin/report", { token: "abc.def.ghi" })).status, 401);
    // a main-admin style JWT (different secret/audience) must not work
    const mainAdminJwt = jwt.sign({ admin: true, role: "superadmin", institution: "all" }, "test-secret");
    assert.equal((await s.call("GET", "/admin/report", { token: mainAdminJwt })).status, 401);
    // Firebase user token is not an Appcount token
    assert.equal((await s.call("GET", "/admin/report", { token: "good-u-stud" })).status, 401);
  } finally {
    s.close();
  }
});

test("admin: login lockout after repeated failures (429), correct password also blocked during lockout", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++) await s.call("POST", "/admin/login", { body: { username: "Appcount", password: "bad" + i } });
    const r = await loginInitial(s);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
  } finally {
    s.close();
  }
});

test("admin: mandatory password change, policy, old password dead, session survives properly", async () => {
  const s = await setup();
  try {
    const l = await loginInitial(s);
    const tok = l.json.token;
    // policy failures
    for (const bad of ["short", "alllowercase12345", "Appcount12345", "NoDigitsHereAtAll"]) {
      const r = await s.call("POST", "/admin/change-password", { token: tok, body: { currentPassword: "Appcount", newPassword: bad } });
      assert.equal(r.status, 400, bad);
    }
    // wrong current password
    assert.equal((await s.call("POST", "/admin/change-password", { token: tok, body: { currentPassword: "WRONG", newPassword: NEW_PW } })).status, 400);
    // success
    const ok = await s.call("POST", "/admin/change-password", { token: tok, body: { currentPassword: "Appcount", newPassword: NEW_PW } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.mustChangePassword, false);
    // old pwchange token is now invalid; new token works on reports
    assert.equal((await s.call("GET", "/admin/report", { token: tok })).status, 401);
    assert.equal((await s.call("GET", "/admin/report", { token: ok.json.token })).status, 200);
    // old password no longer logs in, new does and is NOT forced to change again
    const old = await s.call("POST", "/admin/login", { body: { username: "Appcount", password: "Appcount" } });
    assert.equal(old.status, 401);
    const fresh = await s.call("POST", "/admin/login", { body: { username: "appcount", password: NEW_PW } });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.mustChangePassword, false);
    // credentials never leak in responses
    assert.ok(!ok.text.includes(NEW_PW) && !fresh.text.includes("passwordHash"));
  } finally {
    s.close();
  }
});

test("admin: session expiry and logout revoke the token", async () => {
  const s = await setup();
  try {
    const l = await loginInitial(s);
    const ok = await s.call("POST", "/admin/change-password", { token: l.json.token, body: { currentPassword: "Appcount", newPassword: NEW_PW } });
    const tok = ok.json.token;
    assert.equal((await s.call("GET", "/admin/report", { token: tok })).status, 200);
    assert.equal((await s.call("POST", "/admin/logout", { token: tok })).status, 200);
    assert.equal((await s.call("GET", "/admin/report", { token: tok })).status, 401);
    // expired token
    const expired = jwt.sign({ sub: "appcount", scope: "full", tv: 2 }, require("crypto").createHash("sha256").update("test-secret::app-usage-session").digest("hex"), { audience: "app-usage-admin", expiresIn: -10 });
    const r = await s.call("GET", "/admin/report", { token: expired });
    assert.equal(r.status, 401);
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
  const ok = await s.call("POST", "/admin/change-password", { token: l.json.token, body: { currentPassword: "Appcount", newPassword: NEW_PW } });
  return ok.json.token;
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
    assert.deepEqual(r.json.summary, {
      totalOpens: 7 + 2 + 4 + 6, uniqueUsers: 4, avgOpensPerUser: 4.75,
      collegeUsers: 3, schoolUsers: 1, studentUsers: 2, facultyUsers: 1, parentUsers: 1,
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
    const lines = r.text.replace("\uFEFF", "").trim().split("\r\n");
    assert.equal(lines[0], "S.No,User Name,Mobile,Institution,User Type,Course,Academic Year,App Open Count,First Opened (IST),Last Opened (IST),Date");
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^1,RAHUL SHARMA,9876543210,college,student,BTech,2nd Year,15,/);
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
