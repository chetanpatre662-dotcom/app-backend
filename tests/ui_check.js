/**
 * Drives the REAL admin login page (adminpanel/admin/index.html) and app-usage.html in headless Chrome (CDP)
 * against tests/dev_server.js (in-memory data).
 *   node tests/dev_server.js   (other terminal)
 *   node tests/ui_check.js
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(fs.existsSync);
const PORT = 3199, DBG = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LOGIN = `${ORIGIN}/admin/`;
const USAGE = `${ORIGIN}/admin/app/app-usage.html`;
const NEW_PW = "Str0ngPassw0rd!";
const creds = () => getJson(`http://127.0.0.1:${PORT - 1}/__creds`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));

let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures++; console.log(cond ? "  ok:" : "  FAIL:", msg); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "appusage-ui-"));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${DBG}`, "--headless=new", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${DBG}/json`); break; } catch (_) { await sleep(250); } }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => ws.on("open", r));
    let id = 0; const pending = new Map(); const errors = [];
    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description || ""));
    });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr.slice(0, 60) + " -> " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result.result.value; };
    await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
    const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(100); } return false; };
    const nav = async (url) => { await send("Page.navigate", { url }); await sleep(300); await waitFor("document.readyState==='complete'"); };
    const url = () => ev("location.href");
    const setVal = (id, v) => ev(`(()=>{const e=document.getElementById('${id}');e.value=${JSON.stringify(v)};e.dispatchEvent(new Event(e.tagName==='INPUT'&&e.type!=='date'?'input':'change',{bubbles:true}));})()`);
    const login = async (u, p) => { await nav(LOGIN); await setVal("username", u); await setVal("password", p); await ev("login()"); };
    const cookies = async () => (await send("Network.getAllCookies")).result.cookies;
    const tableReady = () => waitFor(`document.getElementById('tblWrap') && !document.getElementById('tblWrap').classList.contains('loading') && document.querySelectorAll('#cards .stat-value').length===8 && document.querySelector('#cards .stat-value').textContent!=='-'`);
    const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(__dirname, "..", "..", ".tmp_" + name + ".png"), Buffer.from(r.result.data, "base64")); };

    console.log("Direct access without login");
    await nav(USAGE);
    ok(await waitFor("location.pathname==='/admin/index.html' || location.pathname==='/admin/'"), "app-usage.html redirects to the shared admin login (" + (await url()) + ")");
    ok(await ev("!!document.getElementById('username') && !!document.getElementById('password')"), "the existing SCEP BUS ADMIN form is shown");
    ok(await ev("document.body.innerText.includes('SCEP BUS ADMIN')"), "existing login UI title unchanged");

    console.log("Wrong credentials (normal + Appcount)");
    await login("admin", "wrong");
    ok(await waitFor("document.getElementById('msg').innerText.length>0 && !document.getElementById('msg').innerText.includes('Checking')"), "error shown: " + (await ev("document.getElementById('msg').innerText")));
    await login("Appcount", "wrong");
    ok(await waitFor("document.getElementById('msg').innerText.includes('Invalid')"), "wrong Appcount password -> same existing error");
    ok((await cookies()).length === 0, "no session cookie after failed logins");
    ok((await creds()).count === 0, "record absent + wrong credentials: no credential record created");

    console.log("Normal admin login (unchanged)");
    await login("admin", "adminpass");
    ok(await waitFor("location.pathname==='/admin/app/dashboard.html'", 6000), "admin redirected to existing dashboard (" + (await url()) + ")");
    ok(await ev("localStorage.getItem('role')==='superadmin' && localStorage.getItem('token').split('.').length===3"), "admin token/role stored as before");
    ok((await cookies()).length === 0, "admin gets no Appcount cookie");
    await nav(USAGE);
    ok(await waitFor("getComputedStyle(document.getElementById('appWrap')).display==='block'"), "super-admin can open App Usage Analytics");
    ok(await ev("document.getElementById('navDashboard').style.display!=='none' && document.getElementById('navPw').style.display==='none'"), "super-admin sees Dashboard link, no Appcount password item");
    await ev("localStorage.clear()");

    console.log("Appcount initial login -> straight to analytics, forced password change");
    await login("Appcount", "Appcount");
    ok(await waitFor("location.pathname==='/admin/app/app-usage.html'", 6000), "Appcount redirected to App Usage Analytics (" + (await url()) + ")");
    ok(await waitFor("getComputedStyle(document.getElementById('pwForm')).display!=='none'"), "dashboard ACCEPTED the session (no loop): password change screen shown, no second login form");
    { const r = await creds(); ok(r.count === 1 && r.mustChangePassword === true && r.tokenVersion === 1 && r.hashed, "first login created exactly one record (bcrypt hash, mustChangePassword, v1)"); }
    ok(await ev("!document.getElementById('lgUser') && !document.getElementById('loginForm')"), "separate Appcount login form removed");
    ok(await ev("getComputedStyle(document.getElementById('appWrap')).display==='none'"), "analytics hidden until password changed");
    const ck = (await cookies()).find((c) => c.name === "scep_appusage");
    ok(ck && ck.httpOnly && ck.sameSite === "Strict" && ck.path === "/api/app-usage", "HttpOnly SameSite=Strict cookie, path /api/app-usage");
    ok(await ev("!document.cookie.includes('scep_appusage') && !localStorage.getItem('token') && Object.keys(sessionStorage).length===0"), "no session secret/password reachable from JS or browser storage");
    ok((await ev("fetch('/api/admin/buses',{headers:{Authorization:''}}).then(r=>r.status)")) === 401, "Appcount session cannot call normal admin API");
    ok((await ev("fetch('/api/app-usage/admin/report').then(r=>r.status)")) === 403, "report API refuses the password-change session");

    await setVal("pwCur", "Appcount"); await setVal("pwNew", "weak"); await setVal("pwNew2", "weak");
    await ev("document.getElementById('pwForm').requestSubmit()");
    ok(await waitFor("document.getElementById('authMsg').textContent.includes('10+')"), "weak password rejected");
    await setVal("pwNew", NEW_PW); await setVal("pwNew2", NEW_PW);
    await ev("document.getElementById('pwForm').requestSubmit()");
    ok(await waitFor("getComputedStyle(document.getElementById('appWrap')).display==='block'"), "analytics opens after the password change");
    ok(await tableReady(), "default TODAY cards + table loaded");
    { const r = await creds(); ok(r.count === 1 && r.mustChangePassword === false && r.tokenVersion === 2, "password change stored (still one record, flag cleared, v2)"); }
    ok((await ev("document.getElementById('fPeriod').value")) === "today", "period defaults to Today");
    ok(await ev("document.getElementById('navDashboard').style.display==='none'"), "Appcount sidebar has no admin Dashboard link");
    await shot("appcount_dashboard");

    console.log("Filters, month aggregation, pagination, CSV");
    const card = (k) => ev(`(()=>{const v=document.querySelector('[data-card="${k}"]');return {text:v.textContent.replace(/\\s+/g,' ').trim(),sub:v.parentElement.querySelector('.au-card-sub').textContent,label:v.parentElement.querySelector('.stat-label').textContent}})()`);
    const ratio = (t) => t.split("/").map((x) => Number(x.replace(/[^0-9]/g, "")));
    {
      const users = await card("users"), col = await card("college"), sch = await card("school"), avg = await card("avg");
      console.log("   cards:", JSON.stringify([users.text, col.text, sch.text, (await card("student")).text, (await card("faculty")).text, (await card("parent")).text, avg.text]));
      const [a, t] = ratio(users.text);
      ok(users.label === "App Users" && /^\d[\d,]* \/ \d[\d,]*$/.test(users.text) && t === 100 && a > 0 && a <= t, "App Users shows Active / Registered (" + users.text + ")");
      ok(users.sub === `${a} Active · ${t} Registered`, "supporting text: " + users.sub);
      ok(ratio(col.text)[1] + ratio(sch.text)[1] === t, "college + school registered = all registered");
      const s = ratio((await card("student")).text)[1] + ratio((await card("faculty")).text)[1] + ratio((await card("parent")).text)[1];
      ok(s === t, "student + faculty + parent registered = all registered");
      const opens = Number((await card("totalOpens")).text.replace(/,/g, ""));
      ok(avg.text === (opens / t).toFixed(2), `Avg = total opens / registered (${opens} / ${t} = ${avg.text})`);
      ok(await ev("[...document.querySelectorAll('#cards .stat-value')].every(e=>e.scrollWidth<=e.clientWidth+1)"), "no card value overflows (desktop)");
    }
    {
      console.log("Ad impressions");
      const heads = await ev("[...document.querySelectorAll('.au-table thead th')].map(t=>t.textContent.replace(/\\s+/g,' ').trim())");
      const want = ["Banner impressions", "Interstitial impressions", "Rewarded impressions", "Total ad impressions"];
      ok(want.every((w) => heads.includes(w)) && heads.indexOf("Banner impressions") === heads.findIndex((h) => h.startsWith("App opens")) + 1, "4 impression columns right after App opens: " + heads.join(" | "));
      const api = await ev("fetch(API_BASE+'/app-usage/admin/report'+queryString({pageSize:100})).then(r=>r.json())");
      const sums = api.rows.reduce((a, r) => { a.b += r.adBanner; a.i += r.adInterstitial; a.r += r.adRewarded; a.t += r.adTotal; a.u += r.adTotal > 0 ? 1 : 0; if (r.adTotal !== r.adBanner + r.adInterstitial + r.adRewarded) a.bad++; return a; }, { b: 0, i: 0, r: 0, t: 0, u: 0, bad: 0 });
      ok(sums.bad === 0, "every row: total = banner + interstitial + rewarded");
      ok(api.summary.ads.total === sums.t && api.summary.ads.banner === sums.b && api.summary.ads.interstitial === sums.i && api.summary.ads.rewarded === sums.r && api.summary.ads.usersWithImpressions === sums.u, `summary = table totals (${JSON.stringify(api.summary.ads)})`);
      const shown = await ev("Object.fromEntries([...document.querySelectorAll('[data-adcard]')].map(e=>[e.dataset.adcard,Number(e.textContent.replace(/,/g,''))]))");
      ok(shown.total === sums.t && shown.banner === sums.b && shown.interstitial === sums.i && shown.rewarded === sums.r && shown.usersWithImpressions === sums.u, "summary cards show the same numbers: " + JSON.stringify(shown));
      ok(api.rows.some((r) => r.adTotal === 0) && api.rows.length === api.total, "zero-impression users still listed (" + api.rows.filter((r) => r.adTotal === 0).length + " of " + api.total + ")");
      const first = await ev("(()=>{const tr=document.querySelector('#tbody tr');return ['adBanner','adInterstitial','adRewarded','adTotal'].map(k=>Number(tr.querySelector('[data-col='+k+']').textContent.replace(/,/g,'')))})()");
      const r0 = api.rows[0];
      ok(JSON.stringify(first) === JSON.stringify([r0.adBanner, r0.adInterstitial, r0.adRewarded, r0.adTotal]), "first table row shows its own impression counts " + JSON.stringify(first));
      ok(await ev("[...document.querySelectorAll('#adCards .stat-value')].every(e=>e.scrollWidth<=e.clientWidth+1)"), "no ad card overflow");
    }
    await setVal("fInstitution", "school"); await sleep(500); await tableReady();
    ok((await card("college")).text === "0 / 0", "institution=school: College card 0 / 0");
    {
      const api = await ev("fetch(API_BASE+'/app-usage/admin/report'+queryString({pageSize:100})).then(r=>r.json())");
      ok(api.rows.every((r) => r.institution === "school") && api.summary.ads.total === api.rows.reduce((a, r) => a + r.adTotal, 0), "institution filter applies to impressions (" + api.summary.ads.total + ")");
    }
    ok(ratio((await card("school")).text)[1] === ratio((await card("users")).text)[1], "institution=school: School registered = App Users registered");
    await setVal("fInstitution", "all");
    await setVal("fPeriod", "date"); await setVal("fDate", "2020-01-01"); await sleep(600); await tableReady();
    { const u = ratio((await card("users")).text); ok(u[0] === 0 && u[1] === 100, "date with no opens: 0 active, registered unchanged (" + u.join(" / ") + ")"); }
    await setVal("fPeriod", "today"); await sleep(500); await tableReady();
    await setVal("fPeriod", "month"); await sleep(500); await tableReady();
    const tot = Number((await ev("document.querySelector('#cards .stat-value').textContent")).replace(/,/g, ""));
    const users = Number((await ev("document.getElementById('countBadge').textContent")).replace(/,/g, ""));
    ok(tot > users && users > 0, `month aggregates opens across days (${tot} opens / ${users} users)`);
    await setVal("fPageSize", "10"); await sleep(500); await tableReady();
    await ev("document.querySelector('#pager a[data-page=\"2\"]').click()"); await sleep(500); await tableReady();
    ok((await ev("document.querySelector('#tbody tr td').textContent")) === "11", "pagination page 2 starts at 11");
    const csv = await ev("fetch(API_BASE+'/app-usage/admin/export'+queryString()).then(async r=>({s:r.status,t:await r.text()}))");
    ok(csv.s === 200 && csv.t.includes("App Open Count"), "CSV export works with the cookie session");
    ok(/Summary,Active Users,Registered Users\r\nApp Users,\d+,100\r\n/.test(csv.t), "CSV contains active / registered summary");
    {
      const api = await ev("fetch(API_BASE+'/app-usage/admin/report'+queryString({pageSize:100,page:1})).then(r=>r.json())");
      const rows = csv.t.replace("\uFEFF", "").split("\r\n\r\n")[0].trim().split("\r\n").slice(1);
      const csvTotal = rows.reduce((a, l) => a + Number(l.split(",")[11]), 0);
      const m = csv.t.match(/Total Ad Impressions,(\d+)\r\n/);
      ok(rows.length === api.total && m && Number(m[1]) === csvTotal && csvTotal === api.summary.ads.total, `CSV impression rows/summary match the filtered table (${rows.length} rows, ${csvTotal} impressions)`);
    }

    console.log("Sign out, direct access, old password, new password");
    await ev("signOut()");
    ok(await waitFor("location.pathname==='/admin/index.html' || location.pathname==='/admin/'"), "sign out returns to the shared login");
    ok(!(await cookies()).some((c) => c.name === "scep_appusage"), "cookie cleared");
    await nav(USAGE);
    ok(await waitFor("location.pathname==='/admin/index.html'"), "dashboard URL blocked after logout");
    await login("Appcount", "Appcount");
    ok(await waitFor("document.getElementById('msg').innerText.includes('Invalid')"), "initial password rejected after change");
    await login("Appcount", NEW_PW);
    ok(await waitFor("location.pathname==='/admin/app/app-usage.html'"), "new password signs in");
    ok(await waitFor("getComputedStyle(document.getElementById('appWrap')).display==='block'") && await tableReady(), "goes straight to analytics (no forced change)");

    console.log("Expired / removed session");
    await send("Network.clearBrowserCookies");
    await ev("load()");
    ok(await waitFor("location.pathname==='/admin/index.html'"), "expired session sends the user back to login");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await login("Appcount", NEW_PW); await waitFor("location.pathname==='/admin/app/app-usage.html'"); await tableReady();
    ok(await ev("[...document.querySelectorAll('#cards .stat-value')].every(e=>e.scrollWidth<=e.clientWidth+1) && document.documentElement.scrollWidth<=window.innerWidth+4"), "no card overflow on a 390px phone");
    await shot("cards_mobile");
    await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(400); await shot("cards_desktop");
    ok(errors.length === 0, "no uncaught JS exceptions " + JSON.stringify(errors));
    ws.close();
  } catch (e) { failures++; console.log("ERROR", e.message); }
  finally { chrome.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
