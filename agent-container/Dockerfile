# AI Maestro Agent Container
#
# This container runs a single agent with:
# - tmux session
# - Claude Code CLI
# - WebSocket server for browser connections
#
# Can run locally or on AWS/cloud with same image

FROM debian:bookworm-slim

# Install base dependencies and build tools for node-pty
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    tmux \
    zsh \
    vim \
    nano \
    procps \
    ca-certificates \
    build-essential \
    python3 \
    jq \
    openssl \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Generate the en_US.UTF-8 locale. Without this, the LANG/LC_ALL envs set
# below are advisory only — the locale data isn't installed, so every shell
# start emits `bash: warning: setlocale: LC_ALL: cannot change locale`.
RUN sed -i 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Yarn globally
RUN npm install -g yarn

# Create non-root user
ARG USER_ID=1000
ARG GROUP_ID=1000
RUN groupadd -g ${GROUP_ID} claude && \
    useradd -m -u ${USER_ID} -g claude -s /bin/zsh claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Configure tmux for better UX
RUN mkdir -p /home/claude && \
    echo "set -g mouse on" >> /home/claude/.tmux.conf && \
    echo "set -g history-limit 50000" >> /home/claude/.tmux.conf && \
    echo "set -g status-bg colour235" >> /home/claude/.tmux.conf && \
    echo "set -g status-fg colour136" >> /home/claude/.tmux.conf && \
    chown -R claude:claude /home/claude

# Install Oh My Zsh for better shell experience
USER claude
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
USER root

# Create app directory for server code
WORKDIR /app

# Copy package.json and install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm install && npm cache clean --force

# Install agent runtime CLIs globally. The image is multi-runtime so the
# same `ai-maestro-agent:latest` can host Claude, Gemini, or Codex agents
# — which one launches at first start is determined by AI_TOOL (built from
# body.program in createDockerAgent). Without all three baked in, agents
# whose profile.runtime is anything other than `claude` silently fall back
# to a bare shell because tmux send-keys "${AI_TOOL}" hits command-not-found.
RUN npm install -g \
    @anthropic-ai/claude-code \
    @google/gemini-cli \
    @openai/codex

# Copy agent server code
COPY agent-server.js ./
RUN chmod +x agent-server.js

# Create workspace directory
RUN mkdir -p /workspace && \
    chown -R claude:claude /workspace

# Switch to non-root user
USER claude

# Set environment variables (can be overridden at runtime)
ENV AGENT_ID=agent-local
ENV TMUX_SESSION_NAME=agent-session
ENV WORKSPACE=/workspace
ENV AGENT_PORT=23000

# Locale — paired with the locale-gen step above. Setting these without
# generating the locale data is what produced the setlocale warnings on
# every Mason/Optic shell start before this bake.
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV LANGUAGE=en_US:en

# Terminal — 256-color + 24-bit color baseline so CLIs (Claude Code, less,
# vim, tmux, fzf) render rich output without runtime overrides.
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

# Login shell — matches the user's shell set on creation (-s /bin/zsh
# above). Tools that spawn subshells via $SHELL (git, tmux default-shell,
# less, $EDITOR openers) now stay consistent with what an interactive
# login gets.
ENV SHELL=/bin/zsh

# PATH — prepend the AMP CLI mount point so `which amp-send` resolves
# inside the container without the runtime -e PATH= override that
# createDockerAgent injects (v0.30.19). The runtime override still wins
# for operator-customized PATHs; this is the long-term default.
ENV PATH=/home/claude/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Git configuration (will use token at runtime)
# Note: GITHUB_TOKEN should be passed as environment variable at runtime, not baked into image
ENV GIT_USER_NAME="AI Maestro Agent"
ENV GIT_USER_EMAIL="agent@23blocks.com"

# Expose WebSocket port
EXPOSE 23000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:23000/health || exit 1

# Start agent server
CMD ["node", "/app/agent-server.js"]
