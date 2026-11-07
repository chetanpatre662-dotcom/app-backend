// Re-runnable check for the two mobile-app auth routes added to the PRODUCTION
// backend source (default D:\backend\index.js; override with BACKEND_INDEX).
//
//   node bus-tracking/auth_routes_check.js
//
// It extracts the REAL route + middleware source from that file and runs it in
// express with a mocked firebase-admin (no network, no real accounts).
const fs = require("fs");
const http = require("http");
const express = require("express");
const rateLimit = require("express-rate-limit");

const FILE = process.env.BACKEND_INDEX || "D:\\backend\\index.js";
const SRC = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const between = (a, b) => {
  const s = SRC.indexOf(a); if (s < 0) throw new Error("missing: " + a);
  const e = SRC.indexOf(b, s); if (e < 0) throw new Error("missing: " + b);
  return SRC.slice(s, e);
};
const mwSrc = between("async function authenticateFirebaseUser(req, res, next) {", "// HYBRID AUTH MIDDLEWARE");
const routesSrc = between("// ── Mobile-app auth helpers", "// GET /admin/rto-mapping");

// ── mocked firebase-admin ──────────────────────────────────────────────────
const users = { "alice@scep.edu": "uid-alice", "stud@scep.edu": "uid-stud", "legacy@scep.edu": "uid-legacy", "plus+tag@scep.edu": "uid-plus", "ghost@scep.edu": "uid-ghost", "off@scep.edu": "uid-off" };
const tokens = { "tok-alice": "uid-alice", "tok-stud": "uid-stud", "tok-legacy": "uid-legacy", "tok-new": "uid-new", "tok-deleted": "uid-deleted", "tok-off": "uid-off" };
const disabled = new Set(["uid-off"]);
const emailOf = Object.fromEntries(Object.entries(users).map(([e, u]) => [u, e]));
const db = {
  faculty: [
    { id: "faculty-001", uid: "uid-alice", email: "alice@scep.edu", name: "Alice", mobile: "9876543210", busId: "BUS-7", city: "Balaghat", institution: "College", fcmToken: "SECRET-FCM" },
    { id: "faculty-050", email: "legacy@scep.edu", name: "Legacy", mobile: "9111111111", busId: "BUS-5", institution: "school" }, // no uid
  ],
  students: [{ id: "student-009", uid: "uid-stud", email: "stud@scep.edu", name: "Stud", mobile: "9000000009", busId: "BUS-2", institution: "college" }],
  parents: [],
};
let failAdmin = false;
const admin = {
  auth: () => ({
    getUserByEmail: async (email) => {
      if (failAdmin) { const e = new Error("backend down: secret-internal-detail"); e.code = "auth/internal-error"; throw e; }
      if (users[email]) return { uid: users[email] };
      const e = new Error("nf"); e.code = "auth/user-not-found"; throw e;
    },
    verifyIdToken: async (t) => { if (!tokens[t]) throw new Error("bad token"); return { uid: tokens[t] }; },
    getUser: async (uid) => {
      if (uid === "uid-deleted") { const e = new Error("nf"); e.code = "auth/user-not-found"; throw e; }
      return { uid, email: emailOf[uid] || "", disabled: disabled.has(uid) };
    },
  }),
  firestore: () => ({
    collection: (col) => ({
      where: (field, _op, val) => ({
        limit: () => ({
          get: async () => {
            const hit = db[col].filter((d) => d[field] === val).slice(0, 1);
            return { empty: hit.length === 0, docs: hit.map((d) => ({ id: d.id, data: () => ({ ...d }) })) };
          },
        }),
      }),
    }),
  }),
};

function makeApp() {
  const app = express();
  app.use(express.json());
  new Function("app", "admin", "rateLimit", "console", mwSrc + "\n" + routesSrc)(app, admin, rateLimit, { log: () => {} });
  return app;
}

function client(server) {
  const port = server.address().port;
  return (method, path, { body, token, raw, ctype } = {}) => new Promise((resolve) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const headers = { "Content-Type": ctype || "application/json" };
    if (token) headers.Authorization = token.startsWith("RAW:") ? token.slice(4) : "Bearer " + token;
    const r = http.request({ port, method, path, headers }, (res) => {
      let b = ""; res.on("data", (c) => b += c);
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, ctype: res.headers["content-type"] || "", json: j, raw: b }); });
    });
    if (data) r.write(data); r.end();
  });
}

let pass = 0, fail = 0;
const check = (label, cond, info) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${info ? "  " + info : ""}`); cond ? pass++ : fail++; };
const SENSITIVE = /password|hash|salt|fcmToken|SECRET|idToken|refresh|secret-internal-detail/i;

(async () => {
  // ───────── main app (functional checks) ─────────
  const s1 = makeApp().listen(0);
  const call = client(s1);

  // account-status
  let r = await call("POST", "/auth/account-status", { body: { email: "alice@scep.edu" } });
  check("account-status: registered -> exists:true", r.status === 200 && r.json.success === true && r.json.exists === true);
  r = await call("POST", "/auth/account-status", { body: { email: "  ALICE@SCEP.EDU  " } });
  check("account-status: trimmed + case-insensitive", r.json.exists === true);
  r = await call("POST", "/auth/account-status", { body: { email: "Plus+Tag@SCEP.edu" } });
  check("account-status: '+' addresses normalised and found", r.json.exists === true);
  r = await call("POST", "/auth/account-status", { body: { email: "nobody@scep.edu" } });
  check("account-status: unregistered -> exists:false", r.status === 200 && r.json.exists === false);
  check("account-status: response only has success/exists (no PII/uid/tokens)", Object.keys(r.json).sort().join() === "exists,success" && !SENSITIVE.test(r.raw));
  for (const bad of [undefined, "", "not-an-email", "a@b", 123, null, ["a@b.co"], { e: 1 }, "x".repeat(250) + "@a.com"]) {
    r = await call("POST", "/auth/account-status", { body: { email: bad } });
    check(`account-status: invalid email ${JSON.stringify(bad === undefined ? "(missing)" : bad).slice(0, 18)} -> 400`, r.status === 400 && r.json.success === false);
  }
  r = await call("POST", "/auth/account-status", { raw: "not json", ctype: "application/json" });
  check("account-status: malformed JSON body -> 4xx (no crash)", r.status >= 400 && r.status < 500);
  r = await call("POST", "/auth/account-status", { raw: "email=alice@scep.edu", ctype: "text/plain" });
  check("account-status: non-JSON content type -> 400", r.status === 400);
  r = await call("GET", "/auth/account-status");
  check("account-status: GET not allowed (404)", r.status === 404);
  failAdmin = true;
  r = await call("POST", "/auth/account-status", { body: { email: "alice@scep.edu" } });
  check("account-status: Firebase failure -> 500 JSON without internals", r.status === 500 && r.json.error === "Could not check account" && !SENSITIVE.test(r.raw));
  failAdmin = false;

  // /auth/me
  r = await call("GET", "/auth/me"); check("me: no token -> 401", r.status === 401);
  r = await call("GET", "/auth/me", { token: "garbage" }); check("me: invalid token -> 401", r.status === 401);
  r = await call("GET", "/auth/me", { token: "RAW:Basic abc" }); check("me: non-Bearer scheme -> 401", r.status === 401);
  r = await call("GET", "/auth/me", { token: "RAW:some.admin.jwt" }); check("me: admin-style raw JWT is not accepted -> 401", r.status === 401);
  r = await call("GET", "/auth/me", { token: "tok-alice" });
  check("me: faculty (college) by uid", r.status === 200 && r.json.registered && r.json.role === "faculty" && r.json.profile.id === "faculty-001" && r.json.profile.institution === "college");
  check("me: profile exposes only id/name/mobile/busId/city/institution", Object.keys(r.json.profile).sort().join() === "busId,city,id,institution,mobile,name" && !SENSITIVE.test(r.raw));
  r = await call("GET", "/auth/me", { token: "tok-stud" });
  check("me: student -> role student", r.json.role === "student" && r.json.roles.join() === "student");
  r = await call("GET", "/auth/me", { token: "tok-legacy" });
  check("me: legacy doc (no uid) found via verified email; school institution returned", r.json.registered && r.json.role === "faculty" && r.json.profile.institution === "school");
  r = await call("GET", "/auth/me", { token: "tok-new" });
  check("me: authenticated, no profile yet -> registered:false, role null", r.status === 200 && r.json.registered === false && r.json.role === null);
  r = await call("GET", "/auth/me?uid=uid-alice&role=faculty", { token: "tok-new" });
  check("me: client-supplied uid/role query is ignored", r.json.registered === false);
  r = await call("GET", "/auth/me", { token: "tok-off" });
  check("me: DISABLED account with a still-valid token -> 403", r.status === 403 && r.json.success === false);
  r = await call("GET", "/auth/me", { token: "tok-deleted" });
  check("me: DELETED account with a still-valid token -> 401", r.status === 401 && r.json.success === false);
  check("me: error bodies leak nothing", !SENSITIVE.test(r.raw));
  s1.close();

  // ───────── fresh instance: exact rate-limit boundary ─────────
  const s2 = makeApp().listen(0);
  const call2 = client(s2);
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await call2("POST", "/auth/account-status", { body: { email: "alice@scep.edu" } })).status);
  check("rate limit: requests 1-20 allowed", codes.slice(0, 20).every((c) => c === 200));
  check("rate limit: request 21 onward -> 429", codes.slice(20).every((c) => c === 429), `statuses[18..24]=${codes.slice(18).join(",")}`);
  const lim = await call2("POST", "/auth/account-status", { body: { email: "alice@scep.edu" } });
  check("rate limit: 429 body is JSON and leaks nothing", lim.status === 429 && lim.ctype.includes("json") && lim.json.success === false && !SENSITIVE.test(lim.raw));
  const meAfter = await call2("GET", "/auth/me", { token: "tok-alice" });
  check("rate limit: /auth/me is NOT affected by the account-status limiter", meAfter.status === 200);
  s2.close();

  console.log(`\nTOTAL: ${pass + fail}  PASSED: ${pass}  FAILED: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
