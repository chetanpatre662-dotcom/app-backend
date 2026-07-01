// ── Support Ticket Service (Business Logic) ─────────────────────────────────
const repo = require("./repository");
const { TICKET_STATUS, SENDER_TYPE } = require("./constants");

async function sendMessage(userId, role, message) {
  const user = await repo.findUser(userId, role);
  if (!user) return { error: "User not found", status: 404 };

  // Find or create ticket (one active per user)
  let ticket = await repo.findActiveTicketByUser(userId);
  let isNew = false;

  if (!ticket) {
    // Try to reopen closed ticket
    const closed = await repo.findClosedTicketByUser(userId);
    if (closed) {
      await repo.updateTicketMeta(closed.id, { status: TICKET_STATUS.OPEN });
      ticket = { id: closed.id, ticketNumber: closed.ticketNumber };
    } else {
      // Create new
      const created = await repo.createTicket({
        userId, role: role || "student",
        institution: user.institution || "college",
        userName: user.name || "", userEmail: user.email || "",
        userMobile: user.mobile || "", userBusId: user.busId || "",
        userCourse: user.course || "", userBranch: user.branch || "",
        userYear: user.year || "",
      });
      ticket = created;
      isNew = true;
    }
  }

  // Add message
  const msg = await repo.addMessage(ticket.id, {
    senderType: SENDER_TYPE.USER,
    senderId: userId,
    senderName: user.name || "",
    message: message.trim(),
    isRead: false,
  });

  // Update ticket metadata
  await repo.updateTicketMeta(ticket.id, {
    lastMessage: message.trim(),
    lastMessageBy: SENDER_TYPE.USER,
    lastMessageAt: repo.TS(),
    messageCount: repo.INC(1),
    unreadAdmin: repo.INC(1),
    unreadUser: 0,
    status: TICKET_STATUS.OPEN,
  });

  return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, messageId: msg.id, isNew };
}

async function adminReply(ticketId, senderId, senderName, message) {
  const ticket = await repo.getTicketById(ticketId);
  if (!ticket) return { error: "Ticket not found", status: 404 };
  if (ticket.status === TICKET_STATUS.CLOSED) return { error: "Ticket is closed", status: 400 };

  const msg = await repo.addMessage(ticketId, {
    senderType: SENDER_TYPE.ADMIN,
    senderId: senderId || "admin",
    senderName: senderName || "Admin",
    message: message.trim(),
    isRead: false,
  });

  await repo.updateTicketMeta(ticketId, {
    lastMessage: message.trim(),
    lastMessageBy: SENDER_TYPE.ADMIN,
    lastMessageAt: repo.TS(),
    messageCount: repo.INC(1),
    unreadUser: repo.INC(1),
    unreadAdmin: 0,
    status: TICKET_STATUS.PENDING,
  });

  // ── FCM push notification for ticket reply (fire-and-forget) ────────────
  try {
    const admin = require("firebase-admin");
    const role = ticket.role || "student";
    const cols = { student: "students", parent: "parents", faculty: "faculty" };
    const col = cols[role] || "students";
    const userDoc = await admin.firestore().collection(col).doc(ticket.userId).get();
    if (userDoc.exists) {
      const fcmToken = userDoc.data().fcmToken;
      if (fcmToken && fcmToken.length > 10) {
        await admin.messaging().send({
          token: fcmToken,
          notification: { title: "Support Reply", body: message.trim().substring(0, 100) },
          data: { type: "ticket_reply", ticketId, ticketNumber: ticket.ticketNumber || "" },
        });
      }
    }
  } catch (_) { /* Non-fatal */ }

  return { messageId: msg.id, userId: ticket.userId, ticketNumber: ticket.ticketNumber };
}

async function getMessages(ticketId) {
  return repo.getMessagesByTicket(ticketId);
}

async function getUserTickets(userId) {
  return repo.getTicketsByUser(userId);
}

async function getAdminTickets(institution) {
  return repo.getAllTickets(institution);
}

async function updateStatus(ticketId, status) {
  const ticket = await repo.getTicketById(ticketId);
  if (!ticket) return { error: "Ticket not found", status: 404 };
  await repo.updateTicketMeta(ticketId, { status });
  return { success: true };
}

async function updatePriority(ticketId, priority) {
  const ticket = await repo.getTicketById(ticketId);
  if (!ticket) return { error: "Ticket not found", status: 404 };
  await repo.updateTicketMeta(ticketId, { priority });
  return { success: true };
}

async function markRead(ticketId, readerType) {
  // readerType = "admin" → mark user messages as seen
  // readerType = "user" → mark admin messages as seen
  const targetSender = readerType === "admin" ? SENDER_TYPE.USER : SENDER_TYPE.ADMIN;
  const marked = await repo.markMessagesRead(ticketId, targetSender);
  const unreadField = readerType === "admin" ? { unreadAdmin: 0 } : { unreadUser: 0 };
  await repo.updateTicketMeta(ticketId, unreadField);
  return { marked };
}

async function getUserHistory(userId) {
  return repo.getTicketsByUser(userId);
}

module.exports = {
  sendMessage, adminReply, getMessages, getUserTickets,
  getAdminTickets, updateStatus, updatePriority, markRead, getUserHistory,
};
