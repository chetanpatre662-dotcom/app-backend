# Testing Checklist

## Backend API Tests

### Health & Metrics
- [ ] `GET /health` → 200, returns status/uptime/redis/memory
- [ ] `GET /metrics` (without auth) → 401
- [ ] `GET /metrics` (with admin JWT) → 200, returns full stats
- [ ] Response includes `X-Request-ID` header

### Authentication
- [ ] `POST /admin/login` with correct credentials → 200 + JWT
- [ ] `POST /admin/login` with wrong password → 401
- [ ] `POST /admin/login` 11 times rapidly → 429 (rate limited)
- [ ] Admin endpoints without token → 401
- [ ] Admin endpoints with expired token → 401

### Bus Tracking
- [ ] `POST /student-location` with valid coordinates → 200
- [ ] `POST /student-location` with invalid lat/lng → 400
- [ ] `GET /api/tracking/route-polyline/:busId` → 200 with polyline data
- [ ] `GET /api/tracking/replay/:busId` → 200 with history
- [ ] `GET /api/tracking/speed-status/:busId` → 200
- [ ] `GET /api/tracking/bus-status` → 200 with all bus statuses

### Support Tickets
- [ ] `POST /api/tickets` (Firebase auth) → creates ticket
- [ ] `POST /api/tickets` duplicate → appends to existing
- [ ] `GET /api/tickets/user/:userId` → returns user tickets
- [ ] `GET /api/tickets/:ticketId/messages` → returns messages
- [ ] `POST /api/tickets/:ticketId/messages` → adds message
- [ ] Message > 2000 chars → 400 validation error

### Bus Pass
- [ ] `GET /api/bus-pass/pdf-data/:studentId` → structured pass data
- [ ] `GET /api/bus-pass/expiry-check/:studentId` → expiry status
- [ ] Photo upload (1st/2nd) → free
- [ ] Photo upload (3rd) → requires ₹10 payment
- [ ] Photo upload (4th) → blocked (limit: 3)

### Notifications
- [ ] `GET /api/notifications/:userId` → list
- [ ] `GET /api/notifications/:userId/unread-count` → number
- [ ] `POST /api/notifications/:notificationId/read` → marks read
- [ ] `POST /api/notifications/:userId/read-all` → marks all read
- [ ] `DELETE /api/notifications/:notificationId` → deletes

## Security Tests

- [ ] Request without origin header → allowed (mobile app)
- [ ] Request from unknown origin → allowed (mobile-friendly CORS)
- [ ] XSS payload in input fields → sanitized
- [ ] JSON body > 1MB → 413
- [ ] File upload > 2MB → 413
- [ ] SQL/NoSQL injection in query params → no effect
- [ ] Missing env var on startup → process exits with error

## Performance Tests

- [ ] Health endpoint responds < 50ms
- [ ] Compression active: response has `Content-Encoding: gzip` for large responses
- [ ] Rate limiter returns 429 after threshold
- [ ] Slow requests (>1s) flagged in logs with `"slow": true`
- [ ] Memory stays under 450MB under normal load

## WebSocket Tests

- [ ] Client connects to ws://localhost:8080 → success
- [ ] Bus location broadcast reaches all connected clients
- [ ] Client disconnect is handled cleanly (no errors)
- [ ] Reconnection after disconnect works

## Production Readiness Tests

- [ ] `node -c index.js` → no syntax errors
- [ ] `pm2 start ecosystem.config.js` → starts successfully
- [ ] `kill -SIGTERM <pid>` → graceful shutdown logged
- [ ] Server restarts after uncaught exception (PM2)
- [ ] Logs are structured JSON (parseable by `jq`)
- [ ] X-Request-ID propagates through request lifecycle
- [ ] Trust proxy: `req.ip` shows real client IP (not 127.0.0.1)

## Flutter Integration Tests

- [ ] App launches and loads dashboard from cache
- [ ] Bus pass card renders with all fields
- [ ] Support chat sends and receives messages
- [ ] Notifications list loads with unread count
- [ ] Bus tracking map shows live positions
- [ ] Back button navigation works correctly
- [ ] Offline mode shows cached data gracefully
