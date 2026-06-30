// ── Support Ticket Controller (HTTP handlers) ───────────────────────────────
const service = require("./service");
const { validateCreateTicket, validateSendMessage, validateStatusUpdate, validatePriorityUpdate } = require("./validator");
const { sanitize } = require("../utils/sanitize");

function respond(res, data, status = 200) {
  return res.status(status).json({ success: true, ...data });
}
function fail(res, error, status = 500) {
  return res.status(status).json({ success: false, error });
}

// POST /api/tickets — User sends a message (creates/reuses ticket)
async function createOrAppend(req, res) {
  const errors = validateCreateTicket(req.body);
  if (errors) return fail(res, errors.join("; "), 400);

  const { userId, role, message } = req.body;
  const result = await service.sendMessage(userId, role, sanitize(message));
  if (result.error) return fail(res, result.error, result.status);
  return respond(res, { ticketId: result.ticketId, ticketNumber: result.ticketNumber, messageId: result.messageId, isNew: result.isNew });
}

// GET /api/tickets/user/:userId
async function listUserTickets(req, res) {
  const tickets = await service.getUserTickets(req.params.userId);
  return respond(res, { tickets });
}

// GET /api/tickets/:ticketId/messages
async function listMessages(req, res) {
  const messages = await service.getMessages(req.params.ticketId);
  return respond(res, { messages });
}

// POST /api/tickets/:ticketId/messages — Send message (user or admin)
async function sendMessage(req, res) {
  const errors = validateSendMessage(req.body);
  if (errors) return fail(res, errors.join("; "), 400);

  const { ticketId } = req.params;
  const { senderId, senderType, senderName, message } = req.body;

  let result;
  if (senderType === "admin") {
    result = await service.adminReply(ticketId, senderId, senderName, sanitize(message));
  } else {
    // User replying to existing ticket
    const { senderId: uid, senderName: name } = req.body;
    const repo = require("./repository");
    const ticket = await repo.getTicketById(ticketId);
    if (!ticket) return fail(res, "Ticket not found", 404);
    if (ticket.status === "closed") return fail(res, "Ticket is closed", 400);

    const msg = await repo.addMessage(ticketId, {
      senderType: "user", senderId: uid || "", senderName: name || "",
      message: sanitize(message).trim(), isRead: false,
    });
    await repo.updateTicketMeta(ticketId, {
      lastMessage: sanitize(message).trim(), lastMessageBy: "user",
      lastMessageAt: repo.TS(), messageCount: repo.INC(1),
      unreadAdmin: repo.INC(1), unreadUser: 0,
    });
    result = { messageId: msg.id };
  }

  if (result.error) return fail(res, result.error, result.status);
  return respond(res, { messageId: result.messageId });
}

// GET /admin/tickets
async function listAdminTickets(req, res) {
  const { resolveInstitutionFilter } = require("../middleware/auth");
  const inst = resolveInstitutionFilter(req, req.query.institution);
  const tickets = await service.getAdminTickets(inst);
  return respond(res, { tickets });
}

// PATCH /admin/tickets/:ticketId/status
async function changeStatus(req, res) {
  const errors = validateStatusUpdate(req.body);
  if (errors) return fail(res, errors.join("; "), 400);
  const result = await service.updateStatus(req.params.ticketId, req.body.status);
  if (result.error) return fail(res, result.error, result.status);
  return respond(res, { message: "Status updated" });
}

// PATCH /admin/tickets/:ticketId/priority
async function changePriority(req, res) {
  const errors = validatePriorityUpdate(req.body);
  if (errors) return fail(res, errors.join("; "), 400);
  const result = await service.updatePriority(req.params.ticketId, req.body.priority);
  if (result.error) return fail(res, result.error, result.status);
  return respond(res, { message: "Priority updated" });
}

// POST /admin/tickets/:ticketId/read
async function markAsRead(req, res) {
  const result = await service.markRead(req.params.ticketId, "admin");
  return respond(res, { marked: result.marked });
}

// GET /admin/tickets/user-history/:userId
async function userHistory(req, res) {
  const tickets = await service.getUserHistory(req.params.userId);
  return respond(res, { tickets });
}

module.exports = {
  createOrAppend, listUserTickets, listMessages, sendMessage,
  listAdminTickets, changeStatus, changePriority, markAsRead, userHistory,
};
