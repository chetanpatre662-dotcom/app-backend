// ── Support Ticket Repository (Firestore) ───────────────────────────────────
const admin = require("firebase-admin");
const { COLLECTIONS, TICKET_STATUS } = require("./constants");

const db = () => admin.firestore();
const tickets = () => db().collection(COLLECTIONS.TICKETS);
const messages = () => db().collection(COLLECTIONS.MESSAGES);
const TS = () => admin.firestore.FieldValue.serverTimestamp();
const INC = (n) => admin.firestore.FieldValue.increment(n);

// ── Tickets ──────────────────────────────────────────────────────────────────
async function findActiveTicketByUser(userId) {
  const snap = await tickets()
    .where("userId", "==", userId)
    .where("status", "in", [TICKET_STATUS.OPEN, TICKET_STATUS.PENDING])
    .limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ref: snap.docs[0].ref, ...snap.docs[0].data() };
}

async function findClosedTicketByUser(userId) {
  const snap = await tickets()
    .where("userId", "==", userId)
    .where("status", "in", [TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED])
    .limit(5).get();
  if (snap.empty) return null;
  const sorted = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
    .sort((a, b) => (b.updatedAt?._seconds || 0) - (a.updatedAt?._seconds || 0));
  return sorted[0] || null;
}

async function createTicket(data) {
  // Generate ticket number
  const counterRef = db().collection(COLLECTIONS.COUNTER).doc("ticketCounter");
  const counterDoc = await counterRef.get();
  let nextNum = 1;
  if (counterDoc.exists) nextNum = (counterDoc.data().count || 0) + 1;
  await counterRef.set({ count: nextNum }, { merge: true });
  const ticketNumber = `TKT-${String(nextNum).padStart(5, "0")}`;

  const ref = await tickets().add({
    ticketNumber, ...data,
    status: TICKET_STATUS.OPEN,
    priority: "medium",
    messageCount: 0, unreadAdmin: 0, unreadUser: 0,
    lastMessage: "", lastMessageBy: "", lastMessageAt: TS(),
    isDeleted: false, assignedTo: null,
    createdAt: TS(), updatedAt: TS(),
  });
  return { id: ref.id, ticketNumber };
}

async function updateTicketMeta(ticketId, updates) {
  await tickets().doc(ticketId).update({ ...updates, updatedAt: TS() });
}

async function getTicketById(ticketId) {
  const doc = await tickets().doc(ticketId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function getTicketsByUser(userId) {
  const snap = await tickets().where("userId", "==", userId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(t => !t.isDeleted)
    .sort((a, b) => (b.updatedAt?._seconds || 0) - (a.updatedAt?._seconds || 0));
}

async function getAllTickets(institution) {
  let query = tickets();
  if (institution) query = query.where("institution", "==", institution);
  const snap = await query.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(t => !t.isDeleted)
    .sort((a, b) => (b.updatedAt?._seconds || 0) - (a.updatedAt?._seconds || 0));
}

// ── Messages ─────────────────────────────────────────────────────────────────
async function addMessage(ticketId, data) {
  const ref = await messages().add({
    ticketId, ...data,
    status: "sent",
    isDeleted: false,
    replyTo: data.replyTo || null,
    attachments: data.attachments || [],
    createdAt: TS(),
  });
  return { id: ref.id };
}

async function getMessagesByTicket(ticketId) {
  const snap = await messages().where("ticketId", "==", ticketId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(m => !m.isDeleted)
    .sort((a, b) => (a.createdAt?._seconds || 0) - (b.createdAt?._seconds || 0));
}

async function markMessagesRead(ticketId, senderType) {
  const snap = await messages()
    .where("ticketId", "==", ticketId)
    .where("senderType", "==", senderType)
    .where("status", "!=", "seen")
    .get();
  if (snap.empty) return 0;
  const batch = db().batch();
  snap.docs.forEach(d => batch.update(d.ref, { status: "seen", isRead: true }));
  await batch.commit();
  return snap.size;
}

async function updateMessageStatus(messageId, status) {
  await messages().doc(messageId).update({ status });
}

// ── User lookup ──────────────────────────────────────────────────────────────
async function findUser(userId, role) {
  const cols = { student: "students", parent: "parents", faculty: "faculty" };
  const col = cols[role] || "students";
  const doc = await db().collection(col).doc(userId).get();
  return doc.exists ? doc.data() : null;
}

module.exports = {
  findActiveTicketByUser, findClosedTicketByUser, createTicket,
  updateTicketMeta, getTicketById, getTicketsByUser, getAllTickets,
  addMessage, getMessagesByTicket, markMessagesRead, updateMessageStatus,
  findUser, TS, INC,
};
