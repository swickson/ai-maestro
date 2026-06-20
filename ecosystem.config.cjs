const fs = require('fs')
const path = require('path')

// Read .env.local for secrets (API keys, etc.)
// .env.local is gitignored — never commit secrets to the repo
const envLocal = {}
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf-8')
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      envLocal[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  }
} catch {
  // .env.local is optional
}

module.exports = {
  apps: [{
    name: 'ai-maestro',
    script: 'scripts/start-with-ssh.sh',
    // Resolve cwd to the directory of THIS ecosystem file (host-agnostic). A
    // hardcoded absolute path is per-host (the dev host/the laptop/the prod host differ) and
    // breaks `pm2 restart ecosystem.config.cjs` on any host where it's wrong —
    // the pm2-status-lies class (pm2 reports online from a dead cwd). See #188.
    cwd: __dirname,
    env: {
      MAESTRO_MODE: 'full',
      NODE_ENV: 'production',
      ...envLocal,
    }
  }]
}
