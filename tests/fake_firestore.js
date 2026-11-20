"use strict";
// In-memory Firestore stand-in (optimistic-concurrency transactions) for tests and the local dev server.
class FakeDb {
  constructor() {
    this.docs = new Map(); // "col/id" -> {data, v}
    this.reads = 0;
    this.writes = 0;
  }
  collection(name) {
    const db = this;
    const mkSnap = (id, rec) => ({ id, exists: !!rec, data: () => (rec ? structuredCloneKeepTs(rec.data) : undefined) });
    const ref = (id) => ({
      _path: `${name}/${id}`,
      id,
      async get() {
        db.reads++;
        return mkSnap(id, db.docs.get(`${name}/${id}`));
      },
      async set(data) {
        db.writes++;
        const cur = db.docs.get(`${name}/${id}`);
        db.docs.set(`${name}/${id}`, { data, v: (cur ? cur.v : 0) + 1 });
      },
      async create(data) {
        if (db.docs.has(`${name}/${id}`)) throw new Error("ALREADY_EXISTS");
        return this.set(data);
      },
      async update(data) {
        const cur = db.docs.get(`${name}/${id}`);
        if (!cur) throw new Error("NOT_FOUND");
        db.writes++;
        db.docs.set(`${name}/${id}`, { data: { ...cur.data, ...data }, v: cur.v + 1 });
      },
    });
    const query = (filters) => ({
      where: (f, op, v) => query([...filters, [f, op, v]]),
      limit: () => query(filters),
      select: () => query(filters),
      async get() {
        const docs = [];
        for (const [k, rec] of db.docs) {
          if (!k.startsWith(name + "/")) continue;
          const ok = filters.every(([f, op, v]) => {
            const x = rec.data[f];
            if (op === "==") return x === v;
            if (op === ">=") return x >= v;
            if (op === "<=") return x <= v;
            return false;
          });
          if (ok) docs.push(mkSnap(k.slice(name.length + 1), rec));
        }
        db.reads += docs.length || 1;
        return { empty: docs.length === 0, docs };
      },
    });
    return { doc: ref, where: (f, op, v) => query([[f, op, v]]) };
  }
  async runTransaction(fn) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const readV = new Map();
      const pending = [];
      const tx = {
        get: async (r) => {
          const rec = this.docs.get(r._path);
          readV.set(r._path, rec ? rec.v : 0);
          this.reads++;
          await new Promise((res) => setImmediate(res)); // allow interleaving
          return { exists: !!rec, data: () => (rec ? structuredCloneKeepTs(rec.data) : undefined) };
        },
        set: (r, d) => pending.push(["set", r, d]),
        update: (r, d) => pending.push(["update", r, d]),
        create: (r, d) => pending.push(["create", r, d]),
      };
      const result = await fn(tx);
      let conflict = false;
      for (const [p, v] of readV) if ((this.docs.get(p) ? this.docs.get(p).v : 0) !== v) conflict = true;
      if (conflict) continue;
      for (const [kind, r, d] of pending) await r[kind](d);
      return result;
    }
    throw new Error("tx aborted");
  }
}
function structuredCloneKeepTs(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}


module.exports = { FakeDb };
