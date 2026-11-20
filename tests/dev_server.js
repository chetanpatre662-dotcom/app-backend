/**
 * LOCAL-ONLY dev server for browser-testing the shared admin login + App Usage Analytics page.
 * Uses the in-memory Firestore fake (no production data, no service account, nothing written to Firebase).
 *
 * Reproduces the production topology:
 *   front  :3199  = "Nginx": serves adminpanel/ statically and proxies /api/* to the backend with the
 *                   /api prefix STRIPPED, exactly like `location /api/ { proxy_pass http://127.0.0.1:3000/; }`
 *                   (bus-tracking/docs/DEPLOYMENT_CHECKLIST.md, docs/DEPLOYMENT_GUIDE.md).
 *   backend :3198 = Express with routes at /app-usage/* and /admin/login, as production Express sees them.
 * The admin HTML's production API URL is rewritten to http://127.0.0.1:3199/api (same origin, like production).
 *
 *   node tests/dev_server.js                                  ->  http://127.0.0.1:3199/admin/
 *   APP_USAGE_COOKIE_PATH=/app-usage node tests/dev_server.js ->  reproduces the old login loop
 * Test-only admin account (stand-in for the untouched real admin login): admin / adminpass (super-admin).
 */
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const admin = require("firebase-admin");
const { FakeDb } = require("./fake_firestore");
const { createAppUsageRouter, istDateKey } = require("../src/appUsage");

const PORT = Number(process.env.PORT || 3199);
const BACKEND = PORT - 1;
const SECRET = "dev-secret";
const PROD_API = "https://bustracker.satpudaengineeringcollege.com/api";
const ROOT = path.join(__dirname, "..", "..", "adminpanel");
const db = new FakeDb();
const Timestamp = admin.firestore.Timestamp;

(async () => {
  const COURSES = [["btech", ["1", "2", "3", "4"]], ["poly", ["1", "2", "3"]], ["iti", ["1", "2"]]];
  const today = Date.now();
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const type = i % 7 === 0 ? "faculty" : i % 5 === 0 ? "parent" : "student";
    const inst = type === "parent" ? "school" : i % 11 === 0 ? "school" : "college";
    const [course, years] = COURSES[i % 3];
    const p = {
      userName: `${type === "faculty" ? "Prof" : "User"} ${String.fromCharCode(65 + (i % 26))}${i} ${["Sharma", "Verma", "Patel", "Khan"][i % 4]}`,
      mobile: "98" + String(10000000 + i * 137).slice(0, 8), institution: inst, userType: type,
      course: type === "student" ? course : "", year: type === "student" ? years[i % years.length] : "",
    };
    for (let d = 0; d < 40; d++) {
      if ((i + d) % 3 === 0) continue;
      const dk = istDateKey(today - d * 86400000);
      const base = Date.parse(dk + "T03:30:00Z");
      await db.collection("appUsageDaily").doc(`dev-${i}_${dk}`).set({ uid: `dev-${i}`, ...p, dateKey: dk, openCount: 1 + ((i * 7 + d * 3) % 9),
        firstOpenedAt: Timestamp.fromMillis(base), lastOpenedAt: Timestamp.fromMillis(base + 5 * 3600000), recentEventIds: [] });
      n++;
    }
  }
  console.log("seeded", n, "daily docs; credential record absent (fresh bootstrap)");

  // ── backend (what production Express sees: no /api prefix) ──
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  const env = { APP_USAGE_ADMIN_USERNAME: "Appcount", APP_USAGE_ADMIN_PASSWORD: "Appcount" };
  if (process.env.APP_USAGE_COOKIE_PATH) env.APP_USAGE_COOKIE_PATH = process.env.APP_USAGE_COOKIE_PATH;
  const router = createAppUsageRouter({
    admin, jwt, bcrypt, express, db, jwtSecret: SECRET, env,
    verifyIdToken: async (t) => { if (t.startsWith("good-")) return { uid: t.slice(5) }; throw new Error("bad"); },
  });
  app.use("/app-usage", router);
  app.post("/admin/login", router.loginInterceptor);
  app.post("/admin/login", (req, res) => { // stand-in for the existing admin login
    const { username, password } = req.body || {};
    if (username === "admin" && password === "adminpass") {
      return res.json({ success: true, token: jwt.sign({ admin: true, role: "superadmin", institution: "all" }, SECRET, { expiresIn: "1h" }), institution: "all", role: "superadmin" });
    }
    return res.json({ success: false, error: "Invalid credentials" });
  });
  app.get("/admin/buses", (req, res) => {
    try { if (!jwt.verify(req.headers.authorization || "", SECRET).admin) throw 0; res.json({ success: true, buses: [] }); }
    catch (_) { res.status(401).json({ error: "Invalid token" }); }
  });
  app.get("/__creds", (req, res) => { // test probe: record count + flags only, never the hash
    const d = (db.docs.get("appUsageAdmin/credentials") || {}).data;
    res.json({ count: [...db.docs.keys()].filter((k) => k.startsWith("appUsageAdmin/")).length, mustChangePassword: d ? d.mustChangePassword : null, tokenVersion: d ? d.tokenVersion : null, hashed: d ? /^\$2/.test(d.passwordHash) : null });
  });
  app.listen(BACKEND, "127.0.0.1");

  // ── front ("Nginx") ──
  http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      const up = http.request({ host: "127.0.0.1", port: BACKEND, method: req.method, path: req.url.slice(4), // strip "/api"
        headers: { ...req.headers, host: `127.0.0.1:${BACKEND}`, "x-real-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", () => { res.writeHead(502); res.end("bad gateway"); });
      return req.pipe(up);
    }
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(file);
    const type = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    if (ext === ".html" || ext === ".js") return res.end(fs.readFileSync(file, "utf8").split(PROD_API).join(`http://127.0.0.1:${PORT}/api`));
    return fs.createReadStream(file).pipe(res);
  }).listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}/admin/  (backend :${BACKEND}, /api stripped by front proxy)`));
})();
