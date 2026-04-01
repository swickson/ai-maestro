module.exports = {
  apps: [{
    name: 'ai-maestro',
    script: 'scripts/start-with-ssh.sh',
    cwd: '/Users/shanewickson/Antigravity/ai-maestro',
    env: {
      MAESTRO_MODE: 'full',
      NODE_ENV: 'production'
    }
  }]
}
