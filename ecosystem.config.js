// PM2 Ecosystem Configuration — Production
module.exports = {
  apps: [{
    name: "bus-server",
    script: "./index.js",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    node_args: "--max-old-space-size=480",
    env: {
      NODE_ENV: "production",
      TZ: "Asia/Kolkata",
    },
    // Logging (pm2-logrotate handles rotation)
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    merge_logs: true,
    log_type: "json",
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 3000,
    shutdown_with_message: true,
    // Restart policy
    max_restarts: 10,
    restart_delay: 1000,
    exp_backoff_restart_delay: 100,
    // Health monitoring
    min_uptime: "10s",
  }],
};
