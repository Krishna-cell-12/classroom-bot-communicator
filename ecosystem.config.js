module.exports = {
  apps: [
    {
      name: 'classroom-bot',
      script: 'index.js',
      cwd: '/home/krishna/classroom-bot',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/home/krishna/classroom-bot/logs/out.log',
      error_file: '/home/krishna/classroom-bot/logs/error.log',
      merge_logs: true,
    },
  ],
};
