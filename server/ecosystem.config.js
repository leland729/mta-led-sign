/**
 * PM2 ecosystem file optimized for Raspberry Pi 3 B+
 * 
 * This configuration ensures the Node.js server runs reliably
 * with memory constraints and automatic restart on failure.
 */

module.exports = {
  apps: [{
    name: 'subway-api',
    script: 'app.js',
    instances: 1,  // Single instance for Pi 3 B+
    exec_mode: 'fork',  // Fork mode uses less memory than cluster
    
    // Memory management
    max_memory_restart: '300M',  // Restart if memory exceeds 300MB
    node_args: '--max-old-space-size=384',  // Limit Node.js heap to 384MB
    
    // Auto-restart configuration
    autorestart: true,
    watch: false,  // Disable file watching to save CPU
    max_restarts: 5,
    min_uptime: '10s',
    
    // Logging (with rotation to prevent SD card wear)
    error_file: '/var/log/subway-api/err.log',
    out_file: '/var/log/subway-api/out.log',
    log_file: '/var/log/subway-api/combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    
    // Environment
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Health monitoring
    listen_timeout: 8000,
    kill_timeout: 5000,
    
    // Process management
    cron_restart: '0 3 * * *',  // Restart daily at 3 AM for maintenance
    
    // Advanced options for Pi 3 optimization
    treekill: true,
    pmx: false,  // Disable PMX monitoring to save memory
    
    // Health check
    health_check_grace_period: 10000
  }]
};
