# Recovery Checklist

## Immediate Response (< 5 minutes)

### Server Down
1. Check PM2 status: `pm2 status`
2. Check logs: `pm2 logs bus-server --lines 50`
3. Restart: `pm2 restart bus-server`
4. Verify: `curl http://localhost:3000/health`

### High Memory / OOM
1. PM2 auto-restarts at 512MB — check if restart occurred: `pm2 show bus-server`
2. If stuck: `pm2 restart bus-server`
3. Check for memory leak pattern in logs: `grep MEMORY_LEAK logs/error.log`
4. Monitor: `pm2 monit`

### Redis Down
1. Check status: `systemctl status redis`
2. Restart: `systemctl restart redis`
3. Server continues with degraded caching (graceful fallback to Firestore)
4. Verify reconnect: `curl http://localhost:3000/health` — check `redis: true`

### Nginx Down
1. Check: `systemctl status nginx`
2. Restart: `systemctl restart nginx`
3. Verify: `curl -I https://bustracker.satpudaengineeringcollege.com/api/health`

## Diagnosis Guide

### Error Classification (from structured logs)
| Type | Meaning | Action |
|------|---------|--------|
| NETWORK | External API unreachable | Check internet, Voltysoft/SML API status |
| FIREBASE | Firestore/Auth error | Check Firebase console, quota |
| REDIS | Cache layer failure | Restart Redis, check memory |
| AUTH | JWT/token issues | Check JWT_SECRET, clock sync |
| MEMORY | Heap pressure | Restart server, investigate leak |
| APPLICATION | Code bug | Check stack trace, fix and redeploy |

### Common Scenarios

#### GPS Data Not Updating
1. Check Voltysoft API: `curl "http://india.voltysoft.com/api/v12/vehicles/SatpudaValley?key=ZSC6ieTmLhVtQZU"`
2. Check SML API login token in logs
3. Verify bus map IMEIs match actual device IMEIs
4. Check for "ABNORMAL DELAY" warnings in logs

#### Flutter App Can't Connect
1. Verify Nginx is proxying: `curl https://bustracker.satpudaengineeringcollege.com/api/health`
2. Check SSL certificate: `certbot certificates`
3. Verify CORS allows mobile origin (no-origin requests pass)
4. Check rate limiting hasn't blocked the IP

#### Admin Panel Auth Fails
1. Verify JWT_SECRET matches between .env and admin-common.js
2. Check bcrypt hash validity: `node -e "const b=require('bcrypt');b.compare('pass','hash').then(console.log)"`
3. Check token expiry (24h default)
4. Verify login rate limiter hasn't blocked (15 min window, 10 attempts)

#### Support Tickets Not Loading
1. Check Firestore `support_tickets` collection exists
2. Verify Firebase Auth token in request headers
3. Check for composite index errors in PM2 logs
4. Verify user has the correct `uid` field

## Preventive Measures

- Monitor `/metrics` endpoint periodically
- Set up PM2 alerting: `pm2 set pm2-health-check:port 3000`
- Review error logs daily: `grep '"level":"ERROR"' logs/out.log | tail -20`
- Check memory trend: `grep MEMORY logs/out.log`
- Rotate logs weekly (pm2-logrotate handles this)

## Escalation Path

1. Auto-recovery: PM2 restarts (covers 90% of issues)
2. Manual restart: `pm2 restart bus-server`
3. Full restart: `pm2 kill && pm2 start ecosystem.config.js`
4. System reboot: `reboot` (Redis + PM2 auto-start via systemd)
5. Code rollback: restore previous `bus-server.js` backup
