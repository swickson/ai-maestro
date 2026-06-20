# Ops Conductor — Agent-to-Operator Relay SOP

> **Source of truth:** the ops conductor agent (`ops-<role>@<org>.aimaestro.local`, host: the dev host). The canonical living copy lives at `ai-team/RELAY_SOP.md` on the dev host (host-local, not in this repo). This file mirrors it into the ai-maestro repo for mesh-wide accessibility — any agent that clones ai-maestro inherits it. Updates flow from the dev host → here via PR.

## Purpose

When an agent needs the operator's input, it sends the ops conductor agent a structured AMP relay request. The ops conductor triages, DMs the operator if needed, and routes the answer back. The operator is only pulled in when the ops conductor can't answer from context alone.

## AMP format (agents use this)

```
amp-send.sh ops-<role> "[RELAY] Question for the operator" \
  "Agent: <agent-name>
Question: <one line, ~200 chars max>
Context: <background — stays with the ops conductor, not forwarded to the operator>"
```

- **Question** is what gets forwarded to Discord. Keep it short.
- **Context** is for the ops conductor's triage. Include enough that the ops conductor can answer without the operator if possible.

Use `--type request` and pick `--priority` per the table:

| Priority | When to use |
|----------|-------------|
| `urgent` | Destructive-action confirmation, merge-conflict blocking the whole sprint, external deadline. The ops conductor DMs the operator immediately. |
| `high`   | Important but work can continue elsewhere while waiting. |
| `normal` / `low` | The ops conductor batches or answers from mesh knowledge if possible. |

## Ops conductor triage flow

1. Read the relay AMP — question + context.
2. **Can I answer this from mesh knowledge?**
   - Yes → AMP the answer directly back to the agent. The operator never sees it.
   - No → proceed to step 3.
3. DM the operator via the prod host Maestro:
   ```
   POST http://<TAILSCALE_IP>:23000/api/users/<operator-user-id>/notify
   { "subject": "<Agent> asks", "message": "<Question>\n\n<any unblocking context>" }
   ```
4. AMP ack back to the agent: "Your question has been forwarded to the operator via Discord. Standing by."
5. The operator's Discord reply arrives via discord-bot → AMP inbox.
6. AMP the answer back to the requesting agent with `--type response`.

## The operator's Discord reply

The operator replies in the existing DM thread. The discord-bot bridges it back as an AMP message with `context.discord.channelId` set, so the ops conductor receives it in inbox. Look up the original relay message-id and reply to it so the agent gets a clean thread.

## Rules

- **One question per relay.** If an agent has multiple questions, they send multiple relay AMPs.
- **Questions must be short** — the DM forwarded to the operator must fit Discord's 2000-char limit with room to spare.
- **Context stays local** — never forward the Context field to the operator's DM. It's for the ops conductor's triage only.
- **Always ack the agent** after forwarding, so they know the message is in flight and don't re-send.
- **Route the full answer** — if the operator's reply also answers a related open question (like an unblocked task), include that in the AMP back to the agent.

## Caveats

- **Discord gateway dependency (step 5).** The operator → discord-bot → ops conductor return path requires the `discord-bot` agent (`discord-bot@<org>.aimaestro.local`, host: the prod host) to be online. If discord-bot is offline, the answer loop breaks at step 5 — agents should be aware that the ack at step 4 may be the last signal they get until the gateway comes back up. For destructive-action confirmations during a discord-bot outage, expect the operator to resolve out-of-band (in-person, separate channel) and back-fill via AMP later.

## Confirmed working

First live test: 2026-04-29
- Agent: dev-<team>-<role>
- Question: Cycle 4 dispatch confirmation (an agent → W1-02, an agent → W1-04)
- Bonus: the operator also resolved Open Question #4 (Microsoft Graph for Teams + email; stub now, wire later)
- Full loop: an agent → ops conductor (AMP) → the operator (Discord DM) → ops conductor (discord-bot AMP) → an agent (AMP) ✓
