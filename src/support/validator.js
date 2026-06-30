// ── Support Ticket Validators ────────────────────────────────────────────────
const { MAX_MESSAGE_LENGTH } = require("./constants");

function validateCreateTicket(body) {
  const errors = [];
  if (!body.userId || typeof body.userId !== "string") errors.push("userId is required");
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) errors.push("message is required");
  if (body.message && body.message.length > MAX_MESSAGE_LENGTH) errors.push(`message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  if (body.role && !["student", "parent", "faculty"].includes(body.role)) errors.push("invalid role");
  return errors.length ? errors : null;
}

function validateSendMessage(body) {
  const errors = [];
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) errors.push("message is required");
  if (body.message && body.message.length > MAX_MESSAGE_LENGTH) errors.push(`message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  if (body.senderType && !["user", "admin"].includes(body.senderType)) errors.push("invalid senderType");
  return errors.length ? errors : null;
}

function validateStatusUpdate(body) {
  const valid = ["open", "pending", "resolved", "closed"];
  if (!body.status || !valid.includes(body.status)) return ["status must be: " + valid.join(", ")];
  return null;
}

function validatePriorityUpdate(body) {
  const valid = ["low", "medium", "high", "urgent"];
  if (!body.priority || !valid.includes(body.priority)) return ["priority must be: " + valid.join(", ")];
  return null;
}

module.exports = { validateCreateTicket, validateSendMessage, validateStatusUpdate, validatePriorityUpdate };
