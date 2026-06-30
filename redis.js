const { createClient } = require("redis");

const client = createClient({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  password: process.env.REDIS_PASSWORD || undefined,
});

client.on("error",   (err) => console.log("❌ Redis Error:", err.message));
client.on("connect", ()    => console.log("🟢 Redis Connected"));

let isRedisConnecting = false;

async function connectRedis() {
  if (client.isOpen || isRedisConnecting) return;
  isRedisConnecting = true;
  try {
    await client.connect();
  } finally {
    isRedisConnecting = false;
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function toStr(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function fromStr(value) {
  if (!value) return null;
  try   { return JSON.parse(value); }
  catch { return value; }
}

/* ── SET ──────────────────────────────────────────────────────────────────── */

async function set(key, value, options = null) {
  await connectRedis();
  if (options?.EX) {
    // Atomic set + expire in one command
    return client.set(key, toStr(value), { EX: options.EX });
  }
  return client.set(key, toStr(value));
}

/* ── SET with expiry (atomic, single command) ─────────────────────────────── */

async function setEx(key, seconds, value) {
  await connectRedis();
  return client.set(key, toStr(value), { EX: seconds });
}

/* ── GET ──────────────────────────────────────────────────────────────────── */

async function get(key) {
  await connectRedis();
  return fromStr(await client.get(key));
}

/* ── DELETE one or many keys ─────────────────────────────────────────────── */

async function del(...keys) {
  await connectRedis();
  const flat = keys.flat();          // accept both del(k) and del([k1,k2])
  if (!flat.length) return 0;
  return client.del(flat);           // node-redis v4 accepts an array
}

/* ── EXISTS ───────────────────────────────────────────────────────────────── */

async function exists(key) {
  await connectRedis();
  return client.exists(key);
}

/* ── EXPIRE ───────────────────────────────────────────────────────────────── */

async function expire(key, seconds) {
  await connectRedis();
  return client.expire(key, seconds);
}

/* ── KEYS (not recommended for prod, use scan instead) ──────────────────── */

async function keys(pattern) {
  await connectRedis();
  return client.keys(pattern);
}

/* ── SCAN (cursor-based, safe for large keyspaces) ──────────────────────── */

async function scan(cursor = "0", match = "*", count = 100) {
  await connectRedis();
  const result = await client.scan(cursor.toString(), {
    MATCH: match,
    COUNT: count,
  });

  // node-redis v4 returns { cursor, keys }
  // older versions return [cursor, keys[]]
  if (Array.isArray(result)) {
    const [nextCursor, foundKeys] = result;
    return { cursor: nextCursor, keys: foundKeys || [] };
  }
  return {
    cursor: result.cursor  ?? "0",
    keys:   result.keys    ?? [],
  };
}

/* ── Scan ALL keys matching a pattern (wraps scan in a loop) ─────────────── */

async function scanAll(match = "*") {
  const allKeys = [];
  let cursor = "0";
  do {
    const res = await scan(cursor, match, 200);
    cursor = String(res.cursor);
    allKeys.push(...res.keys);
  } while (cursor !== "0");
  return allKeys;
}

module.exports = {
  client,
  connectRedis,
  set,
  setEx,
  get,
  del,
  exists,
  expire,
  keys,
  scan,
  scanAll,
};
