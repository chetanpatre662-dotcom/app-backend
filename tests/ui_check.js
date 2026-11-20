/**
 * Drives the real app-usage.html in headless Chrome (CDP) against tests/dev_server.js.
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
const URL = `http://127.0.0.1:${PORT}/admin/app/app-usage.html?api=http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));

let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log("  FAIL:", msg); } else console.log("  ok:", msg); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "appusage-ui-"));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${DBG}`, "--headless=new", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${DBG}/json`); break; } catch (_) { await sleep(250); } }
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.on("open", r));
    let id = 0; const pending = new Map(); const consoleErrors = [];
    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description || ""));
    });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
    await send("Runtime.enable"); await send("Page.enable");
    const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } return false; };
    const setVal = (id, v) => ev(`(()=>{const e=document.getElementById('${id}');e.value=${JSON.stringify(v)};e.dispatchEvent(new Event(e.tagName==='INPUT'&&e.type!=='date'?'input':'change',{bubbles:true}));})()`);
    const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(__dirname, "..", "..", ".tmp_" + name + ".png"), Buffer.from(r.result.data, "base64")); };
    const tableReady = () => waitFor(`document.getElementById('tblWrap') && !document.getElementById('tblWrap').classList.contains('loading') && document.querySelectorAll('#cards .stat-value').length===8 && document.querySelector('#cards .stat-value').textContent!=='-'`);
    const cards = () => ev(`[...document.querySelectorAll('#cards .stat-card')].map(c=>[c.querySelector('.stat-label').textContent,c.querySelector('.stat-value').textContent])`);

    await send("Page.navigate", { url: URL });
    await waitFor("document.readyState==='complete'");

    console.log("Login screen");
    ok(await ev("getComputedStyle(document.getElementById('appWrap')).display==='none'"), "analytics hidden before login");
    ok(await ev("getComputedStyle(document.getElementById('loginForm')).display!=='none'"), "login form visible");
    ok(!(await ev("document.documentElement.outerHTML")).includes("passwordHash"), "no hash in page");

    console.log("Invalid credentials");
    await setVal("lgUser", "Appcount"); await setVal("lgPass", "wrong");
    await ev("document.getElementById('loginForm').requestSubmit()");
    ok(await waitFor("document.getElementById('authMsg').textContent.includes('Invalid')"), "shows invalid credentials message");

    console.log("Initial Appcount login -> forced password change");
    await setVal("lgPass", "Appcount");
    await ev("document.getElementById('loginForm').requestSubmit()");
    ok(await waitFor("getComputedStyle(document.getElementById('pwForm')).display!=='none'"), "password change form shown");
    ok(await ev("getComputedStyle(document.getElementById('appWrap')).display==='none'"), "analytics still hidden");
    ok(await ev("!document.getElementById('lgPass').value"), "password field cleared");
    ok(await ev("!Object.keys(localStorage).length && !JSON.stringify(sessionStorage).toLowerCase().includes('appcount\"')"), "no credentials in browser storage");
    // unauthorised report call with the password-change token is refused
    ok((await ev("fetch(API_BASE+'/app-usage/admin/report',{headers:{Authorization:'Bearer '+token}}).then(r=>r.status)")) === 403, "report API refuses password-change token (403)");

    await setVal("pwCur", "Appcount"); await setVal("pwNew", "weak"); await setVal("pwNew2", "weak");
    await ev("document.getElementById('pwForm').requestSubmit()");
    ok(await waitFor("document.getElementById('authMsg').textContent.length>0"), "weak password rejected client-side");
    await setVal("pwNew", "Str0ngPassw0rd!"); await setVal("pwNew2", "Different1Passw0rd");
    await ev("document.getElementById('pwForm').requestSubmit()");
    ok(await waitFor("document.getElementById('authMsg').textContent.includes('match')"), "mismatch rejected");
    await setVal("pwNew2", "Str0ngPassw0rd!");
    await ev("document.getElementById('pwForm').requestSubmit()");
    ok(await waitFor("getComputedStyle(document.getElementById('appWrap')).display==='block'"), "enters analytics after changing password");

    console.log("Default view = TODAY");
    ok(await tableReady(), "table + cards loaded");
    ok((await ev("document.getElementById('fPeriod').value")) === "today", "period defaults to today");
    const todayKey = await ev("istKey(new Date())");
    ok((await ev("document.getElementById('rangeNote').textContent")).includes("(IST)"), "range note shown");
    let c = await cards();
    console.log("   cards:", JSON.stringify(c));
    ok(c.length === 8 && Number(c[1][1].replace(/,/g, "")) > 0, "cards populated");
    ok((await ev("document.querySelectorAll('#tbody tr').length")) > 0, "rows rendered");
    ok((await ev("document.querySelector('#tbody tr td:last-child').textContent")).length > 0, "date column shown");
    await shot("today");

    console.log("Filters refresh without page reload");
    await ev("window.__marker = 12345");
    const total0 = await ev("document.getElementById('countBadge').textContent");
    await setVal("fInstitution", "school");
    await sleep(500); await tableReady();
    const totalSchool = await ev("document.getElementById('countBadge').textContent");
    ok(await ev("window.__marker===12345"), "no full page reload");
    ok(totalSchool !== total0 || total0 === "0", `institution filter changes list (${total0} -> ${totalSchool})`);
    c = await cards();
    ok(c[3][1] === "0", "college users = 0 when institution=school");
    await setVal("fInstitution", "all");
    await setVal("fUserType", "parent"); await sleep(500); await tableReady();
    ok((await cards())[5][1] === "0" && (await cards())[7][1] !== "0" || (await ev("document.getElementById('countBadge').textContent")) === "0", "parent filter -> only parents counted");
    await setVal("fUserType", "all");

    console.log("Month aggregation");
    await setVal("fPeriod", "month");
    ok(await ev("getComputedStyle(document.getElementById('boxMonth')).display!=='none'"), "month inputs shown");
    await sleep(500); await tableReady();
    const monthTotals = await ev("document.getElementById('countBadge').textContent");
    c = await cards();
    ok(Number(c[0][1].replace(/,/g, "")) > Number(monthTotals.replace(/,/g, "")), "month total opens exceed user count (aggregated)");
    const rowOpens = await ev("[...document.querySelectorAll('#tbody tr')].map(r=>Number(r.children[7].querySelector('.au-count').textContent.replace(/,/g,'')))");
    ok(rowOpens.length > 0 && rowOpens.every((v, i, a) => i === 0 || a[i - 1] >= v), "rows sorted by opens desc");
    ok((await ev("document.querySelector('#tbody tr td:last-child').textContent")).includes("-"), "date column shows a range for multi-day aggregates");
    await shot("month");

    console.log("Date range + day + course + year");
    await setVal("fPeriod", "range");
    await setVal("fFrom", await ev("addDays(istKey(new Date()),-13)")); await setVal("fTo", todayKey);
    await sleep(500); await tableReady();
    const rangeCount = await ev("document.getElementById('countBadge').textContent");
    await setVal("fWeekday", "monday"); await sleep(500); await tableReady();
    const monCount = await ev("document.getElementById('countBadge').textContent");
    ok(Number(rangeCount) >= Number(monCount), `weekday narrows (${rangeCount} -> ${monCount})`);
    await setVal("fWeekday", "all");
    ok((await ev("[...document.getElementById('fCourse').options].map(o=>o.value).join()")).includes("btech"), "course options dynamic");
    await setVal("fCourse", "btech"); await sleep(500); await tableReady();
    ok((await ev("[...document.querySelectorAll('#tbody tr')].every(r=>r.children[5].textContent==='BTech')")), "course filter applied to rows");
    await setVal("fYear", "2"); await sleep(500); await tableReady();
    ok((await ev("[...document.querySelectorAll('#tbody tr')].every(r=>r.children[6].textContent==='2nd Year')")), "year filter applied to rows");
    await setVal("fCourse", "all"); await setVal("fYear", "all");

    console.log("Invalid range, search, sort, pagination, empty state");
    await setVal("fFrom", todayKey); await setVal("fTo", await ev("addDays(istKey(new Date()),-3)"));
    await sleep(500);
    ok((await ev("document.getElementById('rangeNote').textContent")).includes("Start date"), "start>end shows validation message");
    await setVal("fTo", todayKey); await sleep(500); await tableReady();
    await setVal("fPageSize", "10"); await sleep(500); await tableReady();
    ok((await ev("document.querySelectorAll('#tbody tr').length")) === 10, "page size 10 respected");
    const first1 = await ev("document.querySelector('#tbody tr td').textContent");
    await ev("document.querySelector('#pager a[data-page=\"2\"]').click()");
    await sleep(500); await tableReady();
    ok((await ev("document.querySelector('#tbody tr td').textContent")) === "11" && first1 === "1", "pagination: page 2 starts at serial 11");
    await ev("document.querySelector('th[data-sort=name]').click()"); await sleep(500); await tableReady();
    const names = await ev("[...document.querySelectorAll('#tbody tr')].map(r=>r.children[1].textContent)");
    ok(names.length > 1 && names.every((v, i, a) => i === 0 || a[i - 1].localeCompare(v, 'en', { sensitivity: 'base' }) <= 0), "sort by name A-Z");
    await setVal("fSearch", "zzzzzz"); await sleep(900); await tableReady();
    ok(await ev("getComputedStyle(document.getElementById('tblState')).display!=='none' && document.getElementById('tblState').textContent.includes('No app opens')"), "empty state");
    await setVal("fSearch", "Sharma"); await sleep(900); await tableReady();
    ok((await ev("[...document.querySelectorAll('#tbody tr')].every(r=>r.children[1].textContent.includes('SHARMA'))")) && (await ev("document.querySelectorAll('#tbody tr').length"))>0, "name search");
    await setVal("fSearch", "");

    console.log("CSV export");
    const csv = await ev("fetch(API_BASE+'/app-usage/admin/export'+queryString(),{headers:{Authorization:'Bearer '+token}}).then(async r=>({s:r.status,t:await r.text(),ct:r.headers.get('content-type')}))");
    ok(csv.s === 200 && csv.ct.includes("text/csv") && csv.t.split("\r\n")[0].includes("App Open Count"), "export returns CSV");

    console.log("Error state (server down) and session expiry");
    await ev("window.__oldBase=API_BASE");
    const errShown = await ev("(async()=>{const f=window.fetch;window.fetch=()=>Promise.reject(new Error('x'));await load();window.fetch=f;return document.getElementById('tblState').textContent})()");
    ok(errShown.includes("Server not reachable"), "error state with retry shown when server unreachable");
    await ev("token='tampered.token.value'; load()");
    ok(await waitFor("getComputedStyle(document.getElementById('loginForm')).display!=='none'"), "invalid/expired session returns to login");
    ok((await ev("document.getElementById('authMsg').textContent")).includes("expired"), "expired message shown");

    console.log("Re-login with NEW password only");
    await setVal("lgUser", "Appcount"); await setVal("lgPass", "Appcount");
    await ev("document.getElementById('loginForm').requestSubmit()");
    ok(await waitFor("document.getElementById('authMsg').textContent.includes('Invalid')"), "old initial password no longer works");
    await setVal("lgPass", "Str0ngPassw0rd!");
    await ev("document.getElementById('loginForm').requestSubmit()");
    ok(await waitFor("getComputedStyle(document.getElementById('appWrap')).display==='block'"), "new password logs straight in (no forced change)");
    await tableReady();
    // responsive check (mobile viewport)
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(500); await shot("mobile");
    ok(await ev("document.documentElement.scrollWidth <= window.innerWidth + 4"), "no horizontal page overflow on mobile (table scrolls inside its container)");

    ok(consoleErrors.length === 0, "no uncaught JS exceptions " + JSON.stringify(consoleErrors));
    ws.close();
  } catch (e) { failures++; console.log("ERROR", e.message); }
  finally { chrome.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
