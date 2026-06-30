// ── Input Sanitization ───────────────────────────────────────────────────────
const xss = require("xss");

function sanitize(str) {
  if (!str || typeof str !== "string") return str;
  return xss(str.trim());
}

module.exports = { sanitize };
