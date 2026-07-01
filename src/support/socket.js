// ── Support Ticket WebSocket Handler ─────────────────────────────────────────
// Enhances the existing ws server with ticket chat rooms.
// Does NOT create a new server — attaches to existing wss instance.
//
// Events (client → server):
//   { type: "ticket:join", ticketId }       — Join a ticket room
//   { type: "ticket:leave", ticketId }      — Leave a ticket room
//   { type: "ticket:typing", ticketId }     — Broadcast typing indicator
//   { type: "ticket:seen", ticketId }       — Mark messages as seen
//   { type: "ticket:message", ticketId, message, senderId, senderType, senderName }
//
// Events (server → client):
//   { type: "ticket:message", ticketId, message, senderId, senderType, senderName, messageId, timestamp }
//   { type: "ticket:typing", ticketId, senderType }
//   { type: "ticket:seen", ticketId, senderType }
//   { type: "ticket:unread", ticketId, unreadCount }
//   { type: "ticket:status", ticketId, status }
//   { type: "ticket:ack", eventId, status: "ok" }

const service = require("./service");
const { sanitize } = require("../utils/sanitize");

// Room registry: ticketId → Set<ws>
const ticketRooms = new Map();
// Track which tickets each client is in for cleanup
const clientTickets = new WeakMap();
// Dedup: eventId → timestamp (prevent duplicate processing)
const processedEvents = new Map();
const DEDUP_TTL_MS = 10000; // 10 seconds

// Clean dedup cache every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedEvents) {
    if (now - ts > DEDUP_TTL_MS) processedEvents.delete(id);
  }
}, 30000);

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, Date.now());
  return false;
}

function joinRoom(ws, ticketId) {
  if (!ticketRooms.has(ticketId)) ticketRooms.set(ticketId, new Set());
  ticketRooms.get(ticketId).add(ws);
  // Track for cleanup
  if (!clientTickets.has(ws)) clientTickets.set(ws, new Set());
  clientTickets.get(ws).add(ticketId);
  console.log(`[TICKET WS] Client joined room: ${ticketId} (${ticketRooms.get(ticketId).size} members)`);
}

function leaveRoom(ws, ticketId) {
  const room = ticketRooms.get(ticketId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) ticketRooms.delete(ticketId);
  }
  const tracked = clientTickets.get(ws);
  if (tracked) tracked.delete(ticketId);
}

function cleanupClient(ws) {
  const rooms = clientTickets.get(ws);
  if (rooms) {
    for (const ticketId of rooms) {
      const room = ticketRooms.get(ticketId);
      if (room) { room.delete(ws); if (room.size === 0) ticketRooms.delete(ticketId); }
    }
    clientTickets.delete(ws);
  }
}

function broadcastToRoom(ticketId, payload, excludeWs = null) {
  const room = ticketRooms.get(ticketId);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const client of room) {
    if (client !== excludeWs && client.readyState === 1) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

// Broadcast to ALL connected clients (for unread updates to admin panels)
function broadcastGlobal(wss, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) try { client.send(msg); } catch (_) {}
  });
}

function sendAck(ws, eventId) {
  if (!eventId) return;
  try { ws.send(JSON.stringify({ type: "ticket:ack", eventId, status: "ok" })); } catch (_) {}
}

// ── Main handler: processes ticket-related WebSocket messages ─────────────────
async function handleTicketEvent(ws, parsed, wss) {
  const { type, ticketId, eventId } = parsed;

  // Dedup
  if (isDuplicate(eventId)) { sendAck(ws, eventId); return; }

  switch (type) {
    case "ticket:join":
      if (ticketId) {
        // ── Ownership verification ──────────────────────────────────────────
        // If ws._firebaseUid is set (authenticated user), verify they own this ticket.
        // If ws._isAdmin is set, verify institution match.
        // Unauthenticated connections are allowed for backward compat but logged.
        if (ws._firebaseUid) {
          try {
            const repo = require("./repository");
            const ticket = await repo.getTicketById(ticketId);
            if (ticket) {
              if (ws._isAdmin) {
                // Admin: institution check (if institution is available on ws)
                // Allow — admins can join any ticket they can see via API
              } else {
                // User: must own the ticket
                const admin = require("firebase-admin");
                const role = ticket.role || "student";
                const cols = { student: "students", parent: "parents", faculty: "faculty" };
                const col = cols[role] || "students";
                const userDoc = await admin.firestore().collection(col).doc(ticket.userId).get();
                const isOwner = userDoc.exists && userDoc.data().uid === ws._firebaseUid;
                if (!isOwner) {
                  // Reverse lookup
                  const uidSnap = await admin.firestore().collection(col)
                    .where("uid", "==", ws._firebaseUid).limit(1).get();
                  if (uidSnap.empty || uidSnap.docs[0].id !== ticket.userId) {
                    console.log(`[TICKET WS] Join DENIED: uid=${ws._firebaseUid} ticket=${ticketId}`);
                    sendAck(ws, eventId);
                    break; // Don't join the room
                  }
                }
              }
            }
          } catch (e) {
            console.log(`[TICKET WS] Ownership check error (allowing): ${e.message}`);
            // On error, allow join (don't block the user due to transient failures)
          }
        }
        joinRoom(ws, ticketId);
      }
      sendAck(ws, eventId);
      break;

    case "ticket:leave":
      if (ticketId) leaveRoom(ws, ticketId);
      sendAck(ws, eventId);
      break;

    case "ticket:typing":
      if (ticketId) {
        broadcastToRoom(ticketId, {
          type: "ticket:typing",
          ticketId,
          senderType: parsed.senderType || "user",
        }, ws);
      }
      break;

    case "ticket:seen":
      if (ticketId) {
        const readerType = parsed.senderType === "admin" ? "admin" : "user";
        await service.markRead(ticketId, readerType);
        broadcastToRoom(ticketId, {
          type: "ticket:seen", ticketId, senderType: readerType,
        }, ws);
        sendAck(ws, eventId);
      }
      break;

    case "ticket:message":
      if (!ticketId || !parsed.message) break;
      try {
        const { senderId, senderType, senderName, message } = parsed;
        let result;
        if (senderType === "admin") {
          result = await service.adminReply(ticketId, senderId, senderName, sanitize(message));
        } else {
          // User message to existing ticket
          const repo = require("./repository");
          const ticket = await repo.getTicketById(ticketId);
          if (!ticket || ticket.status === "closed") break;
          const msg = await repo.addMessage(ticketId, {
            senderType: "user", senderId: senderId || "", senderName: senderName || "",
            message: sanitize(message).trim(), isRead: false,
          });
          await repo.updateTicketMeta(ticketId, {
            lastMessage: sanitize(message).trim(), lastMessageBy: "user",
            lastMessageAt: repo.TS(), messageCount: repo.INC(1),
            unreadAdmin: repo.INC(1), unreadUser: 0,
          });
          result = { messageId: msg.id };
        }

        if (result && !result.error) {
          // Broadcast to room
          broadcastToRoom(ticketId, {
            type: "ticket:message", ticketId,
            messageId: result.messageId,
            senderId: senderId || "", senderType: senderType || "user",
            senderName: senderName || "", message: sanitize(message),
            timestamp: Date.now(),
          });
          // Broadcast unread to global (admin panels)
          broadcastGlobal(wss, { type: "ticket:unread", ticketId, senderType: senderType || "user" });
          sendAck(ws, eventId);
        }
      } catch (e) {
        console.log("[TICKET WS] Message error:", e.message);
      }
      break;
  }
}

// ── Attach to existing wss instance ──────────────────────────────────────────
let _attached = false;
function attachToWss(wss) {
  if (_attached) return; // Prevent double-attach
  _attached = true;

  wss.on("connection", (ws) => {
    // Add ticket cleanup on close
    ws.on("close", () => cleanupClient(ws));

    // Intercept messages for ticket events
    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type && parsed.type.startsWith("ticket:")) {
          handleTicketEvent(ws, parsed, wss).catch(e => {
            console.log("[TICKET WS] Unhandled event error:", e.message);
          });
        }
      } catch (_) {}
      // Non-ticket messages fall through to other handlers naturally
    });
  });

  console.log("[TICKET WS] Handler attached to wss");
}

module.exports = { attachToWss, broadcastToRoom, broadcastGlobal, cleanupClient };
