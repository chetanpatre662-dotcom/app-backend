/**
 * LOCAL-ONLY dev server for manually / browser testing the App Usage Analytics page.
 * Uses the in-memory Firestore fake (no production data, no service account).
 *   node tests/dev_server.js          -> http://127.0.0.1:3199/admin/app/app-usage.html?api=http://127.0.0.1:3199
 */
"use strict";
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const admin = require("firebase-admin");
const { FakeDb } = require("./fake_firestore");
const { createAppUsageRouter, istDateKey } = require("../src/appUsage");

const PORT = Number(process.env.PORT || 3199);
const db = new FakeDb();
const Timestamp = admin.firestore.Timestamp;

(async () => {
  const COURSES = [["btech", ["1", "2", "3", "4"]], ["poly", ["1", "2", "3"]], ["iti", ["1", "2"]]];
  const today = Date.now();
  let n = 0;
  const put = async (uid, p, daysAgo, opens) => {
    const ms = today - daysAgo * 86400000;
    const dk = istDateKey(ms);
    const base = Date.parse(dk + "T03:30:00Z");
    await db.collection("appUsageDaily").doc(`${uid}_${dk}`).set({
      uid, ...p, dateKey: dk, openCount: opens,
      firstOpenedAt: Timestamp.fromMillis(base), lastOpenedAt: Timestamp.fromMillis(base + 5 * 3600000), recentEventIds: [],
    });
  };
  for (let i = 0; i < 60; i++) {
    const type = i % 7 === 0 ? "faculty" : i % 5 === 0 ? "parent" : "student";
    const inst = type === "parent" ? "school" : i % 11 === 0 ? "school" : "college";
    const [course, years] = COURSES[i % 3];
    const p = {
      userName: `${type === "faculty" ? "Prof" : "User"} ${String.fromCharCode(65 + (i % 26))}${i} ${["Sharma", "Verma", "Patel", "Khan"][i % 4]}`,
      mobile: "98" + String(10000000 + i * 137).slice(0, 8), institution: inst, userType: type,
      course: type === "student" ? course : "", year: type === "student" ? years[i % years.length] : "",
    };
    for (let d = 0; d < 40; d++) if ((i + d) % 3 !== 0) { await put(`dev-${i}`, p, d, 1 + ((i * 7 + d * 3) % 9)); n++; }
  }
  console.log("seeded", n, "daily docs");

  const app = express();
  app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "Content-Type, Authorization"); if (req.method === "OPTIONS") return res.sendStatus(204); next(); });
  app.use(express.json());
  app.use("/app-usage", createAppUsageRouter({
    admin, jwt, bcrypt, express, db, jwtSecret: "dev-secret",
    verifyIdToken: async (t) => { if (t.startsWith("good-")) return { uid: t.slice(5) }; throw new Error("bad"); },
  }));
  app.use(express.static(path.join(__dirname, "..", "..", "adminpanel")));
  app.listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}/admin/app/app-usage.html?api=http://127.0.0.1:${PORT}`));
})();
