/**
 * LOCAL-ONLY dev server for browser-testing the shared admin login + App Usage Analytics page.
 * Uses the in-memory Firestore fake (no production data, no service account).
 * The admin HTML is served from ../adminpanel with the production API URL rewritten to this server,
 * so page and API share one origin exactly like production (/admin/* + /api/*).
 *   node tests/dev_server.js   ->  http://127.0.0.1:3199/admin/
 * Test-only admin account (stand-in for the untouched real admin login): admin / adminpass (super-admin).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const admin = require("firebase-admin");
const { FakeDb } = require("./fake_firestore");
const { createAppUsageRouter, istDateKey } = require("../src/appUsage");

const PORT = Number(process.env.PORT || 3199);
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
  console.log("seeded", n, "daily docs");

  const app = express();
  app.use(express.json());
  const router = createAppUsageRouter({
    admin, jwt, bcrypt, express, db, jwtSecret: SECRET,
    env: { APP_USAGE_ADMIN_USERNAME: "Appcount", APP_USAGE_ADMIN_PASSWORD: "Appcount" },
    verifyIdToken: async (t) => { if (t.startsWith("good-")) return { uid: t.slice(5) }; throw new Error("bad"); },
  });
  app.use("/api/app-usage", router);
  app.post("/api/admin/login", router.loginInterceptor);
  // stand-in for the existing admin login + one admin API
  app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body || {};
    if (username === "admin" && password === "adminpass") {
      return res.json({ success: true, token: jwt.sign({ admin: true, role: "superadmin", institution: "all" }, SECRET, { expiresIn: "1h" }), institution: "all", role: "superadmin" });
    }
    return res.json({ success: false, error: "Invalid credentials" });
  });
  app.get("/api/admin/buses", (req, res) => {
    try { if (!jwt.verify(req.headers.authorization || "", SECRET).admin) throw 0; res.json({ success: true, buses: [] }); }
    catch (_) { res.status(401).json({ error: "Invalid token" }); }
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "not in dev server" }));
  // static admin panel with the production API URL rewritten to this origin
  app.use((req, res, next) => {
    let p = decodeURIComponent(req.path);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
    if (/\.(html|js)$/.test(file)) {
      res.type(path.extname(file));
      return res.send(fs.readFileSync(file, "utf8").split(PROD_API).join(`http://127.0.0.1:${PORT}/api`));
    }
    return res.sendFile(file);
  });
  app.listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}/admin/`));
})();
