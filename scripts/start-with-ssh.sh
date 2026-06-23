#!/bin/bash

# AI Maestro - Startup script with SSH configuration
# This script ensures SSH agent works in tmux sessions before starting the server

# Step 0: Pin PATH so the server is launched with a known-good toolchain
# regardless of who restarts pm2 (interactive shell, cron, launchd, a
# background agent shell). Two failure modes this prevents:
#   - tmux not found -> session discovery returns zero agents (everything
#     shows offline). tmux lives in Homebrew's bin on macOS.
#   - wrong node ABI -> native modules (node-pty, better-sqlite3) are built
#     for the runtime node; /usr/local/bin/node (v24) must win over Homebrew
#     node (v25) so the prebuilt .node files load.
# /usr/local/bin first keeps node at the ABI the native addons were built
# against; /opt/homebrew/bin right after makes tmux (and other brew tools)
# discoverable.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

echo "[AI Maestro] Starting up..."

# Step 1: Update SSH agent symlink if needed
if [ -S "$SSH_AUTH_SOCK" ] && [ ! -h "$SSH_AUTH_SOCK" ]; then
    echo "[AI Maestro] Creating SSH agent symlink..."
    mkdir -p ~/.ssh
    ln -sf "$SSH_AUTH_SOCK" ~/.ssh/ssh_auth_sock
    echo "[AI Maestro] ✓ SSH symlink created: ~/.ssh/ssh_auth_sock"
else
    echo "[AI Maestro] ✓ SSH symlink already exists"
fi

# Step 2: Pre-flight tmux check
if ! command -v tmux &>/dev/null; then
    echo "[AI Maestro] ✗ WARNING: tmux is not installed — agents will not be able to run"
    echo "[AI Maestro]   Install with: brew install tmux"
fi

# Step 3: Update tmux global environment (if tmux server is running)
if tmux info &>/dev/null; then
    echo "[AI Maestro] Updating tmux SSH environment..."
    tmux setenv -g SSH_AUTH_SOCK ~/.ssh/ssh_auth_sock
    echo "[AI Maestro] ✓ Tmux SSH_AUTH_SOCK updated"
else
    echo "[AI Maestro] ℹ Tmux server not running (will use correct config when started)"
fi

# Step 4: Start the actual server
echo "[AI Maestro] Starting server..."
exec ./node_modules/.bin/tsx server.mjs
