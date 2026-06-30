// ── Support Ticket Routes ────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const ctrl = require("./controller");
const { adminAuth } = require("../middleware/auth");

// User-facing (no auth — backward compatible with current Flutter)
router.post("/api/tickets", ctrl.createOrAppend);
router.get("/api/tickets/user/:userId", ctrl.listUserTickets);
router.get("/api/tickets/:ticketId/messages", ctrl.listMessages);
router.post("/api/tickets/:ticketId/messages", ctrl.sendMessage);

// Admin-facing
router.get("/admin/tickets", adminAuth, ctrl.listAdminTickets);
router.patch("/admin/tickets/:ticketId/status", adminAuth, ctrl.changeStatus);
router.patch("/admin/tickets/:ticketId/priority", adminAuth, ctrl.changePriority);
router.post("/admin/tickets/:ticketId/read", adminAuth, ctrl.markAsRead);
router.get("/admin/tickets/user-history/:userId", adminAuth, ctrl.userHistory);

module.exports = router;
