#!/usr/bin/env node
/**
 * AI Maestro Agent Hook
 *
 * Universal hook for AI coding agents (Claude Code, Codex CLI, Gemini CLI).
 * Captures agent events, writes state for the Chat interface, and injects
 * AMP inbox notifications via each agent's native context injection.
 *
 * Supported agents and their event mappings:
 *   Claude Code: Stop, Notification(idle_prompt), SessionStart
 *   Codex CLI:   Stop, SessionStart
 *   Gemini CLI:  AfterAgent, Notification, SessionStart
 *
 * State is written to: ~/.aimaestro/chat-state/<cwd-hash>.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Maestro host URL — resolves to http://host.docker.internal:23000 inside
// cloud-agent containers (env-injected at agent provision time) and falls
// back to http://localhost:23000 for host-local agents (where the maestro
// server is on the same loopback). Hardcoding "http://localhost:23000" was
// a silent-no-op for cloud agents — every fetch from inside the container
// hit the container's own loopback, not the host's maestro server, and the
// drain/notify paths returned null in catch. Six sites used to hardcode it
// (kanban filed by KAI in Iron Syndicate 2026-05-05 follow-up meeting).
const MAESTRO_HOST_URL = process.env.AIMAESTRO_HOST_URL
    || process.env.AMP_MAESTRO_URL
    || 'http://localhost:23000';

// Read stdin as JSON
async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                resolve({ raw: data });
            }
        });
        process.stdin.on('error', reject);

        // Timeout after 5 seconds
        setTimeout(() => resolve({ timeout: true }), 5000);
    });
}

// Hash the working directory to create a unique state file
function hashCwd(cwd) {
    return crypto.createHash('md5').update(cwd || '').digest('hex').substring(0, 16);
}

// Broadcast status update via WebSocket (non-blocking)
async function broadcastStatusUpdate(cwd, state) {
    try {
        const agentsResponse = await fetch(`${MAESTRO_HOST_URL}/api/agents`);
        if (!agentsResponse.ok) return;

        const agentsData = await agentsResponse.json();
        const agent = resolveAgent(cwd, agentsData.agents || []);

        if (!agent) return;

        const sessionName = agent.name || agent.alias || agent.session?.tmuxSessionName;
        if (!sessionName) return;

        // Build hookState payload for events that produce meaningful state
        // (permission requests + notifications). Consumed by the activity/update
        // route → broadcastActivityUpdate(sessionName, status, hookStatus,
        // notificationType, agentId, hookState).
        const hookStateData = (state.status === 'permission_request' || state.status === 'question_prompt' || state.notificationType)
            ? {
                status: state.status,
                toolName: state.toolName,
                toolInput: state.toolInput,
                description: state.description,
                options: state.options,
                // AskUserQuestion payload (question_prompt) — the interactive
                // questions/options Claude is blocked on. Carried so the Chat
                // view can render them inline instead of a blank spinner.
                questions: state.questions,
                message: state.message,
                notificationType: state.notificationType,
              }
            : undefined;

        // Broadcast the status update
        await fetch(`${MAESTRO_HOST_URL}/api/sessions/activity/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionName,
                agentId: agent.id,
                status: state.status,
                hookStatus: state.status,
                notificationType: state.notificationType,
                ...(hookStateData && { hookState: hookStateData })
            })
        });

        // Also send heartbeat so standalone agents appear in dashboard
        if (agent.id) {
            await fetch(`${MAESTRO_HOST_URL}/api/agents/${encodeURIComponent(agent.id)}/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: state.status })
            }).catch(() => {});
        }

        debugLog({ event: 'status_broadcast', sessionName, agentId: agent.id, status: state.status });
    } catch (err) {
        debugLog({ event: 'status_broadcast_error', error: err.message });
    }
}

// Write state to file
function writeState(cwd, state) {
    const stateDir = path.join(os.homedir(), '.aimaestro', 'chat-state');
    fs.mkdirSync(stateDir, { recursive: true });

    const cwdHash = hashCwd(cwd);
    const stateFile = path.join(stateDir, `${cwdHash}.json`);

    const fullState = {
        ...state,
        cwd,
        cwdHash,
        updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(stateFile, JSON.stringify(fullState, null, 2));

    // Also write to a "by-cwd" index for easy lookup
    const indexFile = path.join(stateDir, 'index.json');
    let index = {};
    try {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (e) {}
    index[cwd] = cwdHash;
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    // Broadcast status update via WebSocket (fire and forget)
    broadcastStatusUpdate(cwd, state).catch(() => {});
}

// Log to debug file
function debugLog(data) {
    const debugFile = path.join(os.homedir(), '.aimaestro', 'chat-state', 'hook-debug.log');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${JSON.stringify(data)}\n`;
    fs.appendFileSync(debugFile, line);
}

// Detect which AI agent is calling this hook
function detectAgent(input) {
    // Gemini CLI sets GEMINI_SESSION_ID or has gemini-specific fields
    if (process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR) return 'gemini';
    // Codex CLI sets model field with gpt- prefix or has turn_id
    if (input.model && input.model.startsWith('gpt-')) return 'codex';
    if (input.turn_id !== undefined) return 'codex';
    // Default to Claude Code
    return 'claude';
}

// Normalize event names across agents to our internal names
function normalizeEvent(hookEvent, agent) {
    // Gemini's AfterAgent = Claude/Codex's Stop
    if (agent === 'gemini' && hookEvent === 'AfterAgent') return 'Stop';
    return hookEvent;
}

// Build the context injection response in the correct format for each agent
function buildContextResponse(agent, hookEvent, message) {
    if (!message) return {};

    switch (agent) {
        case 'codex':
            // Codex CLI uses systemMessage field
            return { systemMessage: message };
        case 'gemini':
            // Gemini CLI uses systemMessage or additionalContext
            return { systemMessage: message };
        case 'claude':
        default:
            // Claude Code uses hookSpecificOutput.additionalContext
            return {
                hookSpecificOutput: {
                    hookEventName: hookEvent,
                    additionalContext: message
                }
            };
    }
}

// Check for unread messages using AMP CLI (standalone — no AI Maestro needed)
async function checkUnreadMessagesStandalone() {
    const { execSync } = require('child_process');
    try {
        const output = execSync('amp-inbox.sh --count 2>/dev/null', {
            encoding: 'utf8',
            timeout: 3000,
            env: { ...process.env, PATH: process.env.PATH }
        }).trim();

        // amp-inbox.sh --count returns a number
        const count = parseInt(output, 10);
        if (isNaN(count) || count === 0) return null;

        return `You have ${count} unread message${count === 1 ? '' : 's'} in your AMP inbox. Check them with: amp-inbox.sh`;
    } catch (err) {
        debugLog({ event: 'standalone_inbox_check_failed', error: err.message });
        return null;
    }
}

// Resolve the agent for this hook invocation.
// Priority: AIM_AGENT_ID / CLAUDE_AGENT_ID env (exact) → AIM_AGENT_NAME /
// CLAUDE_AGENT_NAME / AGENT_ID env (exact) → cwd exact match.
//
// AIM_AGENT_ID/AIM_AGENT_NAME are set by lib/agent-runtime.ts via
// `tmux set-environment` on every HOST agent session and propagate to child
// processes (Claude + its hooks). CLOUD agent containers receive a different
// env-var convention at provision time (CLAUDE_AGENT_ID, CLAUDE_AGENT_NAME,
// AGENT_ID — see services/agents-docker-service.ts container-env baking),
// so the hook accepts EITHER set. Without this, cloud-agent hooks fall back
// to cwd-match against /workspace, which never matches the host-path-keyed
// registry → resolveAgent returns null → drainMeetingInjectQueue bails →
// queued additionalContext is silently lost.
//
// Cwd fallback only fires for non-tmux launches, and uses exact equality
// to avoid the collision/startsWith bug where multiple agents share a
// working directory.
function resolveAgent(cwd, agents) {
    const envId = process.env.AIM_AGENT_ID || process.env.CLAUDE_AGENT_ID;
    if (envId) {
        const byId = agents.find(a => a.id === envId);
        if (byId) {
            debugLog({ event: 'resolved_agent_from_env', source: 'id', value: envId });
            return byId;
        }
    }
    const envName = process.env.AIM_AGENT_NAME || process.env.CLAUDE_AGENT_NAME || process.env.AGENT_ID;
    if (envName) {
        const byName = agents.find(a => a.name === envName);
        if (byName) {
            debugLog({ event: 'resolved_agent_from_env', source: 'name', value: envName });
            return byName;
        }
    }
    return agents.find(a => {
        const agentWd = a.workingDirectory || a.session?.workingDirectory;
        return agentWd && agentWd === cwd;
    }) || null;
}

// Drain any queued meeting messages for the agent bound to this hook invocation.
// Returns a formatted context string (joined by blank lines) or null if empty.
// Uses the session name as the queue key — matches how the meeting server
// keys injections. See lib/meeting-inject-queue.ts.
async function drainMeetingInjectQueue(cwd) {
    try {
        const agentsResponse = await fetch(`${MAESTRO_HOST_URL}/api/agents`);
        if (!agentsResponse.ok) return null;

        const agentsData = await agentsResponse.json();
        const agent = resolveAgent(cwd, agentsData.agents || []);
        if (!agent) return null;

        const sessionName = agent.name || agent.alias || agent.session?.tmuxSessionName;
        if (!sessionName) return null;

        const drainResponse = await fetch(
            `${MAESTRO_HOST_URL}/api/meetings/inject-queue?session=${encodeURIComponent(sessionName)}`
        );
        if (!drainResponse.ok) return null;

        const data = await drainResponse.json();
        const messages = data.messages || [];
        if (messages.length === 0) return null;

        debugLog({ event: 'meeting_queue_drained', sessionName, count: messages.length });
        return messages.map(m => m.text).join('\n\n');
    } catch (err) {
        debugLog({ event: 'meeting_queue_drain_error', error: err.message });
        return null;
    }
}

// Merge two optional context strings (either or both may be null)
function mergeContexts(...parts) {
    const joined = parts.filter(Boolean).join('\n\n');
    return joined || null;
}

// Check for unread messages for this agent
async function checkUnreadMessages(cwd) {
    try {
        const agentsResponse = await fetch(`${MAESTRO_HOST_URL}/api/agents`);
        if (!agentsResponse.ok) return null;

        const agentsData = await agentsResponse.json();
        const agent = resolveAgent(cwd, agentsData.agents || []);

        if (!agent) {
            debugLog({ event: 'no_agent_for_cwd', cwd });
            return null;
        }

        // Check for unread messages
        const messagesResponse = await fetch(
            `${MAESTRO_HOST_URL}/api/messages?agent=${encodeURIComponent(agent.id)}&box=inbox&status=unread`
        );
        if (!messagesResponse.ok) return null;

        const messagesData = await messagesResponse.json();
        const messages = messagesData.messages || [];

        if (messages.length === 0) return null;

        debugLog({ event: 'unread_messages_found', agentId: agent.id, count: messages.length });

        // Format message notification
        const formatSender = (msg) => {
            const name = msg.fromAlias || (msg.from ? msg.from.substring(0, 8) : 'unknown');
            const host = msg.fromHost ? ` (${msg.fromHost})` : '';
            return `${name}${host}`;
        };

        if (messages.length === 1) {
            const msg = messages[0];
            const fromInfo = formatSender(msg);
            const subjectInfo = msg.subject ? ` about "${msg.subject}"` : '';
            const urgentFlag = msg.priority === 'urgent' ? '[URGENT] ' : '';
            return `${urgentFlag}You have a new message from ${fromInfo}${subjectInfo}. Please check your inbox using the agent-messaging skill.`;
        } else {
            const urgentCount = messages.filter(m => m.priority === 'urgent').length;
            const senderInfos = messages.map(m => formatSender(m));
            const uniqueSenders = [...new Set(senderInfos)].slice(0, 3);
            const sendersInfo = uniqueSenders.join(', ');
            const urgentFlag = urgentCount > 0 ? `[${urgentCount} URGENT] ` : '';
            return `${urgentFlag}You have ${messages.length} new messages from ${sendersInfo}. Please check your inbox using the agent-messaging skill.`;
        }
    } catch (err) {
        debugLog({ event: 'message_check_error', error: err.message });
        // Fall back to standalone AMP check (works without AI Maestro)
        return checkUnreadMessagesStandalone();
    }
}

// Main
async function main() {
    const input = await readStdin();

    // Log all input for debugging
    debugLog({ event: 'hook_received', input });

    const agent = detectAgent(input);
    const rawEvent = input.hook_event_name || process.env.CLAUDE_HOOK_EVENT;
    const hookEvent = normalizeEvent(rawEvent, agent);
    const cwd = input.cwd || process.env.GEMINI_CWD || process.cwd();
    const sessionId = input.session_id;
    const transcriptPath = input.transcript_path;

    debugLog({ event: 'agent_detected', agent, rawEvent, hookEvent });

    // Hook response — may be enriched with context injection for inbox notifications
    let hookResponse = {};

    // Handle different hook events
    switch (hookEvent) {
        case 'PreToolUse': {
            // Claude is about to call a tool. We only care about AskUserQuestion
            // (registered with a matcher so this branch normally only fires for it,
            // but guard defensively). Claude DEFERS writing the assistant turn
            // (preamble + AskUserQuestion tool_use) to the transcript JSONL until
            // AFTER the user answers — so while the prompt is pending the chat view
            // has nothing to render and paints a blank spinner. PreToolUse fires
            // BEFORE the block and carries the full tool_input.questions, so we
            // capture it here and write a question_prompt state the Chat view can
            // render inline (mirrors how PermissionRequest captures tool_input).
            const ptuToolName = input.tool_name || input.toolName;
            const ptuToolInput = input.tool_input || input.toolInput || {};
            if (ptuToolName === 'AskUserQuestion' && Array.isArray(ptuToolInput.questions) && ptuToolInput.questions.length > 0) {
                const firstQ = ptuToolInput.questions[0] || {};
                writeState(cwd, {
                    status: 'question_prompt',
                    toolName: ptuToolName,
                    questions: ptuToolInput.questions,
                    description: firstQ.question || 'Claude is asking a question',
                    message: 'Claude is waiting for your answer',
                    sessionId,
                    transcriptPath
                });
            }
            break;
        }

        case 'PermissionRequest':
            // Claude is asking for permission to use a tool
            // Input includes: tool_name, tool_input, tool_use_id, permission_suggestions
            const toolName = input.tool_name || input.toolName;
            const toolInput = input.tool_input || input.toolInput || {};
            const permissionSuggestions = input.permission_suggestions || [];

            // Create a human-readable description of what's being asked
            let description = `Allow ${toolName}?`;
            if (toolName === 'Edit' && toolInput.file_path) {
                description = `Edit ${toolInput.file_path}?`;
            } else if (toolName === 'Write' && toolInput.file_path) {
                description = `Create ${toolInput.file_path}?`;
            } else if (toolName === 'Bash' && toolInput.command) {
                description = `Run: ${toolInput.command}`;
            } else if (toolName === 'Read' && toolInput.file_path) {
                description = `Read ${toolInput.file_path}?`;
            } else if (toolName === 'Grep' && toolInput.path) {
                description = `Search in ${toolInput.path}?`;
            }

            // Build options array similar to Claude's terminal UI
            const options = [
                { key: '1', label: 'Yes', action: 'allow_once' }
            ];

            // Add session-scoped option if available
            const sessionSuggestion = permissionSuggestions.find(s => s.destination === 'session');
            if (sessionSuggestion && sessionSuggestion.rules && sessionSuggestion.rules[0]) {
                const rule = sessionSuggestion.rules[0];
                options.push({
                    key: '2',
                    label: `Yes, allow ${rule.toolName || toolName} from ${rule.ruleContent || 'this location'} during this session`,
                    action: 'allow_session',
                    rule: rule.ruleContent
                });
            }

            // Add local settings option if available
            const localSuggestion = permissionSuggestions.find(s => s.destination === 'localSettings');
            if (localSuggestion && localSuggestion.rules && localSuggestion.rules[0]) {
                const rule = localSuggestion.rules[0];
                options.push({
                    key: String(options.length + 1),
                    label: `Yes, always allow this command`,
                    action: 'allow_always',
                    rule: rule.ruleContent
                });
            }

            // Always add the "type to respond" option
            options.push({
                key: String(options.length + 1),
                label: 'Type here to tell Claude what to do differently',
                action: 'custom'
            });

            writeState(cwd, {
                status: 'permission_request',
                toolName,
                toolInput,
                description,
                options,
                message: `Claude wants to ${toolName.toLowerCase()}`,
                sessionId,
                transcriptPath
            });
            break;

        case 'Notification':
            // Check notification type
            const notificationType = input.notification_type || input.type;

            // If an AskUserQuestion prompt was just captured (PreToolUse), the
            // content-free Notification that follows would otherwise overwrite the
            // rich question_prompt state with a blank waiting_for_input — re-creating
            // the hang. Preserve the recent question_prompt instead of downgrading it.
            try {
                const qStateDir = path.join(os.homedir(), '.aimaestro', 'chat-state');
                const qStateFile = path.join(qStateDir, `${hashCwd(cwd)}.json`);
                if (fs.existsSync(qStateFile)) {
                    const qExisting = JSON.parse(fs.readFileSync(qStateFile, 'utf8'));
                    const qAge = Date.now() - new Date(qExisting.updatedAt).getTime();
                    if (qExisting.status === 'question_prompt' && qAge < 15000) {
                        debugLog({ event: 'notification_preserved_question_prompt', cwd, notificationType });
                        break;
                    }
                }
            } catch (e) {}

            if (notificationType === 'idle_prompt') {
                // Claude is waiting for regular input - perfect time to check messages!
                writeState(cwd, {
                    status: 'waiting_for_input',
                    message: input.message || 'Waiting for your input...',
                    notificationType,
                    agent,
                    sessionId,
                    transcriptPath
                });

                // Drain inbox notifications + queued meeting messages; merge into one context.
                const [idleInbox, idleMeeting] = await Promise.all([
                    checkUnreadMessages(cwd),
                    drainMeetingInjectQueue(cwd)
                ]);
                const idleContext = mergeContexts(idleMeeting, idleInbox);
                if (idleContext) {
                    debugLog({ event: 'injecting_context', cwd, agent, trigger: 'idle_prompt', hasInbox: !!idleInbox, hasMeeting: !!idleMeeting });
                    hookResponse = buildContextResponse(agent, rawEvent, idleContext);
                }
            } else if (notificationType === 'permission_prompt') {
                // For permission prompts, preserve existing tool info if we have it
                const stateDir = path.join(os.homedir(), '.aimaestro', 'chat-state');
                const cwdHash = hashCwd(cwd);
                const stateFile = path.join(stateDir, `${cwdHash}.json`);

                let existingState = {};
                try {
                    if (fs.existsSync(stateFile)) {
                        existingState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                        // Only preserve if it's a recent permission_request (within 10 seconds)
                        const age = Date.now() - new Date(existingState.updatedAt).getTime();
                        if (existingState.status !== 'permission_request' || age > 10000) {
                            existingState = {};
                        }
                    }
                } catch (e) {}

                writeState(cwd, {
                    status: 'waiting_for_input',
                    message: input.message || 'Waiting for your input...',
                    notificationType,
                    agent,
                    sessionId,
                    transcriptPath,
                    // Preserve tool info from PermissionRequest if we have it
                    toolName: existingState.toolName,
                    toolInput: existingState.toolInput,
                    options: existingState.options,
                    description: existingState.description || input.message
                });
            }
            break;

        case 'Stop':
            // Claude finished responding - keep this fast (no API calls)
            // Inbox check happens on idle_prompt notification which fires shortly after
            writeState(cwd, {
                status: 'idle',
                message: null,
                agent,
                sessionId,
                transcriptPath
            });
            break;

        case 'SessionStart':
            // Session started - record the session info
            writeState(cwd, {
                status: 'active',
                message: null,
                agent,
                sessionId,
                transcriptPath,
                source: input.source
            });

            // Drain inbox notifications + queued meeting messages; merge into one context.
            const [startInbox, startMeeting] = await Promise.all([
                checkUnreadMessages(cwd),
                drainMeetingInjectQueue(cwd)
            ]);
            const startContext = mergeContexts(startMeeting, startInbox);
            if (startContext) {
                debugLog({ event: 'injecting_context', cwd, agent, trigger: 'session_start', hasInbox: !!startInbox, hasMeeting: !!startMeeting });
                hookResponse = buildContextResponse(agent, rawEvent, startContext);
            }
            break;

        case 'UserPromptSubmit': {
            // PR-B: AUTHORITATIVE BUSY edge. UserPromptSubmit is Claude's reliable
            // turn-START signal (fires once per turn, synchronously BEFORE the model
            // generates). Writing status:busy here — paired with Stop→idle (turn END)
            // — makes busy/idle authoritative from the agent's own lifecycle, so the
            // inject-readiness gate no longer has to scrape terminal output for "busy".
            // Empirically Stop fires once per TURN, not per tool-round, so
            // busy=[UserPromptSubmit, Stop) brackets the whole turn INCLUDING the
            // think→tool-call seam (no mid-turn idle flip → no court). Write busy
            // FIRST so it lands even if the async drain below is slow/cancelled.
            writeState(cwd, { status: 'busy', message: 'Generating…', agent, sessionId, transcriptPath });

            // Drain on every user prompt — this is the reliable delivery slot
            // for Claude Code. SessionStart can be preempted by other plugins'
            // hooks (e.g. Vercel plugin emitting 50KB overwhelms the context
            // budget and our hook gets cancelled). UserPromptSubmit fires once
            // per user turn and rarely contended.
            const [upsInbox, upsMeeting] = await Promise.all([
                checkUnreadMessages(cwd),
                drainMeetingInjectQueue(cwd)
            ]);
            const upsContext = mergeContexts(upsMeeting, upsInbox);
            if (upsContext) {
                debugLog({ event: 'injecting_context', cwd, agent, trigger: 'user_prompt_submit', hasInbox: !!upsInbox, hasMeeting: !!upsMeeting });
                hookResponse = buildContextResponse(agent, rawEvent, upsContext);
            }
            break;
        }

        default:
            // Unknown event - just log it
            if (process.env.DEBUG) {
                console.error(`[ai-maestro-hook] Unknown event: ${hookEvent}`);
            }
    }

    // Output hook response (may include additionalContext for inbox notifications)
    process.stdout.write(JSON.stringify(hookResponse));
    // Force immediate exit — pending fire-and-forget fetches (broadcastStatusUpdate)
    // can otherwise keep the event loop alive past Claude Code's hook deadline,
    // causing the hook to be cancelled before stdout is captured.
    process.exit(0);
}

main().catch(err => {
    console.error('[ai-maestro-hook] Error:', err);
    process.exit(0); // Don't block Claude
});
