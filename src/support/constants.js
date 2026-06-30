// ── Support Ticket Constants ─────────────────────────────────────────────────
module.exports = {
  TICKET_STATUS: { OPEN: "open", PENDING: "pending", RESOLVED: "resolved", CLOSED: "closed" },
  TICKET_PRIORITY: { LOW: "low", MEDIUM: "medium", HIGH: "high", URGENT: "urgent" },
  MESSAGE_STATUS: { SENT: "sent", DELIVERED: "delivered", SEEN: "seen" },
  SENDER_TYPE: { USER: "user", ADMIN: "admin", SYSTEM: "system" },
  COLLECTIONS: { TICKETS: "support_tickets", MESSAGES: "ticket_messages", COUNTER: "system" },
  MAX_MESSAGE_LENGTH: 2000,
  MAX_TICKETS_PER_PAGE: 50,
  MAX_MESSAGES_PER_PAGE: 100,
};
