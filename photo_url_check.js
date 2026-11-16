// Re-runnable check for GET /api/bus-pass/photo-url/:studentId in the
// PRODUCTION backend source (default D:\backend\index.js; override with
// BACKEND_INDEX).
//
//   node bus-tracking/photo_url_check.js
//
// Extracts the REAL route source from that file and runs it in express with a
// mocked firebase-admin (no network, no real accounts, no Storage access).
const fs = require("fs");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const FILE = process.env.BACKEND_INDEX || "D:\\backend\\index.js";
const SRC = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const between = (a, b) => {
  const s = SRC.indexOf(a); if (s < 0) throw new Error("missing: " + a);
  const e = SRC.indexOf(b, s); if (e < 0) throw new Error("missing: " + b);
  return SRC.slice(s, e);
};
const routeSrc = between("// -- GET /api/bus-pass/photo-url/:studentId", "// Multer / upload error handler");
const uploadSrc = between('app.post("/api/bus-pass/photo-upload"', "// -- GET /api/bus-pass/photo-url/:studentId");

const SECRET = "test-secret";
process.env.JWT_SECRET = SECRET;
const tokens = { "tok-stud": "uid-stud", "tok-fac": "uid-fac", "tok-par": "uid-par", "tok-legacy": "uid-legacy", "tok-nophoto": "uid-nophoto", "tok-gone": "uid-gone", "tok-stranger": "uid-stranger", "tok-evil": "uid-evil" };
const P = (uid) => `bus-pass-photos/${uid}/profile.jpg`;
const db = {
  students: [
    { id: "student-001", uid: "uid-stud", passPhotoPath: P("uid-stud"), passPhotoUrl: "https://expired/stud" },
    { id: "student-002", uid: "uid-nophoto" },
    { id: "student-003", uid: "uid-gone", passPhotoPath: P("uid-gone"), passPhotoUrl: "https://expired/gone" },
    { id: "student-004", uid: "uid-evil", passPhotoPath: "../secrets/serviceAccountKey.json" },
  ],
  faculty: [{ id: "faculty-001", uid: "uid-fac", passPhotoPath: P("uid-fac"), passPhotoUrl: "https://expired/fac" }],
  parents: [
    { id: "parent-001", uid: "uid-par", passPhotoPath: P("uid-par"), passPhotoUrl: "https://expired/par" },
    { id: "parent-002", uid: "uid-legacy", passPhotoUrl: "https://expired/legacy" }, // no passPhotoPath
  ],
};
const storage = new Set([P("uid-stud"), P("uid-fac"), P("uid-par"), P("uid-legacy")]);
let buspassStatus = "verified";
let writes = 0;
let signCalls = 0;
let failStorage = false;
const docRef = (col, id) => ({
  get: async () => {
    const d = db[col].find((x) => x.id === id);
    return { exists: !!d, id, data: () => (d ? { ...d } : undefined) };
  },
  update: async () => { writes++; },
  set: async () => { writes++; },
});
const admin = {
  auth: () => ({ verifyIdToken: async (t) => { if (!tokens[t]) throw new Error("bad token"); return { uid: tokens[t] }; } }),
  firestore: Object.assign(() => ({
    collection: (col) => ({
      doc: (id) => (col === "buspass_admin_accounts"
        ? { get: async () => ({ exists: true, data: () => ({ verificationStatus: buspassStatus }) }) }
        : docRef(col, id)),
      where: (field, _op, val) => ({
        limit: () => ({
          get: async () => {
            const hit = db[col].filter((d) => d[field] === val).slice(0, 1);
            return { empty: hit.length === 0, docs: hit.map((d) => ({ id: d.id, data: () => ({ ...d }), ref: docRef(col, d.id) })) };
          },
        }),
      }),
    }),
  }), { FieldValue: { serverTimestamp: () => "TS" } }),
  storage: () => ({
    bucket: (name) => ({
      name,
      file: (path) => ({
        exists: async () => { if (failStorage) throw new Error("storage down"); return [storage.has(path)]; },
        getSignedUrl: async ({ action, expires }) => { signCalls++; return [`https://signed/${path}?action=${action}&exp=${expires}&n=${signCalls}`]; },
        save: async () => {},
      }),
    }),
  }),
};

function makeApp() {
  const app = express();
  new Function("app", "admin", "jwt", "console", "process", routeSrc)(app, admin, jwt, { log: () => {} }, process);
  return app;
}
function client(server) {
  const port = server.address().port;
  return (path, auth) => new Promise((resolve) => {
    const headers = {};
    if (auth) headers.Authorization = auth;
    http.request({ port, method: "GET", path, headers }, (res) => {
      let b = ""; res.on("data", (c) => b += c);
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, cache: res.headers["cache-control"] }); });
    }).end();
  });
}
let pass = 0, fail = 0;
const check = (label, cond, info) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${info ? "  " + info : ""}`); cond ? pass++ : fail++; };
const adminJwt = (claims) => jwt.sign(claims, SECRET, { expiresIn: "1h" });

(async () => {
  // Static checks on the upload route: storage path + restrictions untouched.
  check("upload: still stores bus-pass-photos/<uid>/profile.jpg", uploadSrc.includes("`bus-pass-photos/${req.firebaseUid}/profile.jpg`"));
  check("upload: still writes passPhotoPath + passPhotoUrl + photoChangeCount", /passPhotoPath: filePath/.test(uploadSrc) && /passPhotoUrl: signedUrl/.test(uploadSrc) && /photoChangeCount: count/.test(uploadSrc));
  check("upload: still requires Firebase auth middleware", uploadSrc.startsWith('app.post("/api/bus-pass/photo-upload", upload.single("photo"), authenticateFirebaseUser'));

  const server = makeApp().listen(0);
  const call = client(server);
  const now = Date.now();

  let r = await call("/api/bus-pass/photo-url/me", "Bearer tok-stud");
  check("student 'me' -> fresh signed URL from passPhotoPath", r.status === 200 && r.json.success && r.json.photoUrl.startsWith(`https://signed/${P("uid-stud")}?action=read`));
  const exp = Number(new URL(r.json.photoUrl).searchParams.get("exp"));
  check("signed URL TTL is 7 days", Math.abs(exp - (now + 7 * 864e5)) < 60e3);
  check("expiresAt returned", typeof r.json.expiresAt === "string" && Math.abs(Date.parse(r.json.expiresAt) - exp) < 1000);
  check("response is Cache-Control: no-store", r.cache === "no-store");
  check("never returns the stale stored passPhotoUrl", !r.json.photoUrl.includes("expired"));
  const r2 = await call("/api/bus-pass/photo-url/me", "Bearer tok-stud");
  check("each request issues a new URL", r2.json.photoUrl !== r.json.photoUrl);

  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-fac");
  check("faculty 'me' -> URL from faculty collection", r.status === 200 && r.json.photoUrl.includes(P("uid-fac")));
  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-par");
  check("parent 'me' -> URL from parents collection", r.status === 200 && r.json.photoUrl.includes(P("uid-par")));
  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-legacy");
  check("legacy doc without passPhotoPath -> fallback to uid path", r.status === 200 && r.json.photoUrl.includes(P("uid-legacy")));

  r = await call("/api/bus-pass/photo-url/student-001", "Bearer tok-stud");
  check("owner by document id (students)", r.status === 200 && r.json.photoUrl.includes(P("uid-stud")));
  r = await call("/api/bus-pass/photo-url/faculty-001", "Bearer tok-fac");
  check("owner by document id (faculty)", r.status === 200 && r.json.photoUrl.includes(P("uid-fac")));
  r = await call("/api/bus-pass/photo-url/parent-001", "Bearer tok-par");
  check("owner by document id (parents)", r.status === 200 && r.json.photoUrl.includes(P("uid-par")));

  r = await call("/api/bus-pass/photo-url/student-001", "Bearer tok-fac");
  check("other user's document -> 403", r.status === 403 && r.json.success === false && !r.json.photoUrl);
  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-stranger");
  check("'me' with no profile doc -> 404", r.status === 404 && r.json.error === "USER_NOT_FOUND");
  r = await call("/api/bus-pass/photo-url/student-999", adminJwt({ admin: true, role: "admin", institution: "college" }));
  check("unknown document id -> 404", r.status === 404);
  r = await call("/api/bus-pass/photo-url/me");
  check("no Authorization header -> 401", r.status === 401);
  r = await call("/api/bus-pass/photo-url/me", "Bearer not-a-token");
  check("invalid Firebase token -> 401", r.status === 401);
  r = await call("/api/bus-pass/photo-url/student-001", "garbage.jwt.value");
  check("invalid admin JWT -> 401", r.status === 401);
  r = await call("/api/bus-pass/photo-url/student-001", adminJwt({ role: "driver" }));
  check("JWT without admin claim -> 403", r.status === 403);
  r = await call("/api/bus-pass/photo-url/me", adminJwt({ admin: true, role: "admin" }));
  check("admin JWT with 'me' -> 400", r.status === 400);
  r = await call("/api/bus-pass/photo-url/" + encodeURIComponent("a/../b"), adminJwt({ admin: true, role: "admin" }));
  check("malformed id -> 400 or 404 (never 200)", r.status === 400 || r.status === 404);

  r = await call("/api/bus-pass/photo-url/student-001", adminJwt({ admin: true, role: "admin", institution: "college" }));
  check("college admin JWT -> URL", r.status === 200 && r.json.photoUrl.includes(P("uid-stud")));
  r = await call("/api/bus-pass/photo-url/faculty-001", adminJwt({ admin: true, role: "superadmin", institution: "all" }));
  check("superadmin JWT -> faculty photo URL", r.status === 200 && r.json.photoUrl.includes(P("uid-fac")));
  const bp = adminJwt({ admin: true, buspass: true, role: "bus_pass_admin", institution: "college", verified: true });
  r = await call("/api/bus-pass/photo-url/student-001", bp);
  check("verified bus-pass admin JWT -> URL", r.status === 200 && !!r.json.photoUrl);
  buspassStatus = "revoked";
  r = await call("/api/bus-pass/photo-url/student-001", bp);
  check("revoked bus-pass admin JWT -> 403", r.status === 403);
  buspassStatus = "verified";

  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-nophoto");
  check("no photo -> 200 photoUrl:null NO_PHOTO", r.status === 200 && r.json.success && r.json.photoUrl === null && r.json.reason === "NO_PHOTO");
  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-gone");
  check("file missing in Storage -> 200 photoUrl:null FILE_MISSING", r.status === 200 && r.json.photoUrl === null && r.json.reason === "FILE_MISSING");
  const signsBefore = signCalls;
  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-evil");
  check("unsafe passPhotoPath -> not signed, INVALID_PATH", r.status === 200 && r.json.photoUrl === null && r.json.reason === "INVALID_PATH" && signCalls === signsBefore);
  failStorage = true;
  r = await call("/api/bus-pass/photo-url/me", "Bearer tok-stud");
  check("storage error -> 500 without leaking details", r.status === 500 && r.json.error === "PHOTO_URL_FAILED" && !JSON.stringify(r.json).includes("storage down"));
  failStorage = false;

  check("refresh never writes to Firestore", writes === 0);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
