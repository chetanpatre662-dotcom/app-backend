# Production Checklist

## Security
- [x] Helmet HTTP security headers
- [x] CORS restricted to known origins
- [x] XSS input sanitization
- [x] Rate limiting (login, payment, upload, API, tickets)
- [x] bcrypt password hashing (admin credentials)
- [x] JWT authentication with RBAC
- [x] Firebase Auth middleware for user-facing endpoints
- [x] Environment variable validation on startup
- [x] Request body size limit (1MB)
- [x] Multer file size limit (2MB)
- [x] WebSocket authentication (optional token)
- [x] Coordinate validation on location endpoints
- [x] Message length validation (2000 chars)

## Performance
- [x] Compression middleware (gzip, threshold 1024 bytes)
- [x] Redis caching layer (routes, attendance, GPS)
- [x] In-memory route cache with TTL
- [x] Route pre-warming on startup
- [x] Memory leak detection (30s interval, 450MB threshold)
- [x] PM2 max_memory_restart (512MB)

## Reliability
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] Unhandled rejection handler
- [x] Uncaught exception handler (exits after logging)
- [x] PM2 autorestart with exponential backoff
- [x] Kill timeout (5s) matches PM2 config
- [x] Duplicate shutdown prevention (isShuttingDown flag)
- [x] Redis reconnection on startup

## Observability
- [x] Structured JSON logging (timestamp, request ID, method, path, status, latency)
- [x] Request ID middleware (X-Request-ID header)
- [x] Health endpoint (/health) — uptime, redis status, memory
- [x] Metrics endpoint (/metrics) — authenticated, full system stats
- [x] Error classification (NETWORK, FIREBASE, REDIS, AUTH, PAYMENT, MEMORY, APPLICATION)
- [x] Slow request detection (>1000ms flagged)
- [x] Memory usage in health response
- [x] Request counters (total, success, clientError, serverError)

## Configuration
- [x] Trust proxy (Nginx)
- [x] PM2 ecosystem.config.js
- [x] Log rotation ready (pm2-logrotate compatible)
- [x] TZ set to Asia/Kolkata
- [x] Node max-old-space-size aligned to PM2 limit
- [x] Environment validation (fails fast on missing vars)

## Infrastructure
- [x] Nginx reverse proxy (domain/api → localhost:3000)
- [x] HTTPS via Nginx
- [x] WebSocket via Nginx (wss://)
- [x] PM2 process management
- [x] Redis for session/cache state
