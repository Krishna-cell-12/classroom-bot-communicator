module.exports = {
  apps: [
    // ── Server 1: Communicator (Baileys / WhatsApp gateway) ─────────────────
    {
      name:          'communicator',
      script:        'communicator.js',
      cwd:           '/home/ubuntu/classroom-bot',
      watch:         false,
      autorestart:   true,
      restart_delay: 10000,
      max_restarts:  15,
      env: {
        NODE_ENV: 'production',
        PORT:     3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file:   '/home/ubuntu/classroom-bot/logs/communicator-out.log',
      error_file: '/home/ubuntu/classroom-bot/logs/communicator-err.log',
      merge_logs: true,
    },

    // ── Server 2: Brain (Google Classroom logic + OAuth) ────────────────────
    {
      name:          'brain',
      script:        'index.js',
      cwd:           '/home/ubuntu/classroom-bot',
      watch:         false,
      autorestart:   true,
      restart_delay: 5000,
      max_restarts:  15,
      env: {
        NODE_ENV: 'production',
        PORT:     3001,          // Brain runs on 3001; Communicator on 3000
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file:   '/home/ubuntu/classroom-bot/logs/brain-out.log',
      error_file: '/home/ubuntu/classroom-bot/logs/brain-err.log',
      merge_logs: true,
    },
  ],
};
