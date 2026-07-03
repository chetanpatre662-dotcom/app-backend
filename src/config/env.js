// ── Environment Configuration & Validation ──────────────────────────────────
require("dotenv").config();
process.env.TZ = "Asia/Kolkata";

const REQUIRED_ENV = [
  "ADMIN_USER", "ADMIN_PASS_HASH", "SCHOOL_ADMIN_USER", "SCHOOL_ADMIN_PASS_HASH",
  "SUPER_ADMIN_USER", "SUPER_ADMIN_PASS_HASH", "JWT_SECRET", "BUSPASS_USERNAME",
  "BUSPASS_PASS_HASH"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ FATAL: Missing env variable: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  ADMIN_USER: process.env.ADMIN_USER,
  ADMIN_PASS_HASH: process.env.ADMIN_PASS_HASH,
  SCHOOL_ADMIN_USER: process.env.SCHOOL_ADMIN_USER,
  SCHOOL_ADMIN_PASS_HASH: process.env.SCHOOL_ADMIN_PASS_HASH,
  SUPER_ADMIN_USER: process.env.SUPER_ADMIN_USER,
  SUPER_ADMIN_PASS_HASH: process.env.SUPER_ADMIN_PASS_HASH,
  JWT_SECRET: process.env.JWT_SECRET,
  BUSPASS_USERNAME: process.env.BUSPASS_USERNAME,
  BUSPASS_PASS_HASH: process.env.BUSPASS_PASS_HASH,
  REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  PORT: parseInt(process.env.PORT) || 3000,
  WS_PORT: parseInt(process.env.WS_PORT) || 8080,
  COLLEGE_LAT: 21.825334035623513,
  COLLEGE_LNG: 80.1513767355824,
  COLLEGE_RADIUS_KM: 0.4,
};
