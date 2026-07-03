# Deployment Checklist

## Pre-Deployment

- [ ] Run `node -c index.js` — verify zero syntax errors
- [ ] Verify `.env` contains all required variables:
  - ADMIN_USER, ADMIN_PASS_HASH
  - SCHOOL_ADMIN_USER, SCHOOL_ADMIN_PASS_HASH
  - SUPER_ADMIN_USER, SUPER_ADMIN_PASS_HASH
  - JWT_SECRET
  - BUSPASS_USERNAME, BUSPASS_PASS_HASH
- [ ] Verify `serviceAccountKey.json` is present
- [ ] Verify Redis is running: `redis-cli ping`
- [ ] Verify `logs/` directory exists: `mkdir -p logs`
- [ ] Install dependencies: `npm install --production`
- [ ] Verify `compression` package installed: `node -e "require('compression')"`

## Deployment Steps

1. SSH into production server
2. Navigate to server directory: `cd /root/`
3. Pull latest code or SCP the updated files:
   - `index.js` → `/root/bus-server.js`
   - `package.json`
   - `ecosystem.config.js`
4. Install new dependencies: `npm install --production`
5. Verify syntax: `node -c bus-server.js`
6. Restart with PM2: `pm2 restart bus-server`
7. Watch logs: `pm2 logs bus-server --lines 20`
8. Verify health: `curl http://localhost:3000/health`

## Post-Deployment Verification

- [ ] Health endpoint returns `{"status":"ok"}`
- [ ] Redis connected (health shows `redis: true`)
- [ ] Flutter app connects successfully
- [ ] Admin panel loads and authenticates
- [ ] WebSocket connections establish
- [ ] GPS data flows (check PM2 logs for bus updates)
- [ ] No 500 errors in logs after 5 minutes

## Nginx Configuration (Reference)

```nginx
server {
    listen 443 ssl;
    server_name bustracker.satpudaengineeringcollege.com;

    location /api/ {
        proxy_pass http://localhost:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID $request_id;
    }

    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## PM2 Log Rotation Setup

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD
```

## Rollback

If issues arise after deployment:
```bash
pm2 stop bus-server
# Restore previous version
cp bus-server.js.bak bus-server.js
pm2 start bus-server
```
