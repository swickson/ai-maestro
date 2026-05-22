# LeoAI — Agent-to-Shane Relay SOP

> **Source of truth:** LeoAI (`ops-mesh-conductor@n4x-corp.aimaestro.local`, host: bananajr). The canonical living copy lives at `ai-team/RELAY_SOP.md` on bananajr (host-local, not in this repo). This file mirrors it into the ai-maestro repo for mesh-wide accessibility — any agent that clones ai-maestro inherits it. Updates flow from bananajr → here via PR.

## Purpose

When an agent needs Shane's input, it sends LeoAI a structured AMP relay request. LeoAI triages, DMs Shane if needed, and routes the answer back. Shane is only pulled in when LeoAI can't answer from context alone.

## AMP format (agents use this)

```
amp-send.sh ops-mesh-conductor "[RELAY] Question for Shane" \
  "Agent: <agent-name>
Question: <one line, ~200 chars max>
Context: <background — stays with LeoAI, not forwarded to Shane>"
```

- **Question** is what gets forwarded to Discord. Keep it short.
- **Context** is for LeoAI's triage. Include enough that LeoAI can answer without Shane if possible.

Use `--type request` and pick `--priority` per the table:

| Priority | When to use |
|----------|-------------|
| `urgent` | Destructive-action confirmation, merge-conflict blocking the whole sprint, external deadline. LeoAI DMs Shane immediately. |
| `high`   | Important but work can continue elsewhere while waiting. |
| `normal` / `low` | LeoAI batches or answers from mesh knowledge if possible. |

## LeoAI triage flow

1. Read the relay AMP — question + context.
2. **Can I answer this from mesh knowledge?**
   - Yes → AMP the answer directly back to the agent. Shane never sees it.
   - No → proceed to step 3.
3. DM Shane via holmes Maestro:
   ```
   POST http://100.81.151.18:23000/api/users/cdb949e1-a2e4-4c31-93a9-7549c1a454dd/notify
   { "subject": "<Agent> asks", "message": "<Question>\n\n<any unblocking context>" }
   ```
4. AMP ack back to the agent: "Your question has been forwarded to Shane via Discord. Standing by."
5. Shane's Discord reply arrives via discord-bot → AMP inbox.
6. AMP the answer back to the requesting agent with `--type response`.

## Shane's Discord reply

Shane replies in the existing DM thread. The discord-bot bridges it back as an AMP message with `context.discord.channelId` set, so LeoAI receives it in inbox. Look up the original relay message-id and reply to it so the agent gets a clean thread.

## Rules

- **One question per relay.** If an agent has multiple questions, they send multiple relay AMPs.
- **Questions must be short** — the DM forwarded to Shane must fit Discord's 2000-char limit with room to spare.
- **Context stays local** — never forward the Context field to Shane's DM. It's for LeoAI's triage only.
- **Always ack the agent** after forwarding, so they know the message is in flight and don't re-send.
- **Route the full answer** — if Shane's reply also answers a related open question (like an unblocked task), include that in the AMP back to the agent.

## Caveats

- **Discord gateway dependency (step 5).** The Shane → discord-bot → LeoAI return path requires the `discord-bot` agent (`discord-bot@n4x-corp.aimaestro.local`, host: holmes) to be online. If discord-bot is offline, the answer loop breaks at step 5 — agents should be aware that the ack at step 4 may be the last signal they get until the gateway comes back up. For destructive-action confirmations during a discord-bot outage, expect Shane to resolve out-of-band (in-person, separate channel) and back-fill via AMP later.

## Confirmed working

First live test: 2026-04-29
- Agent: dev-allianceos-luke
- Question: Cycle 4 dispatch confirmation (Chewy → W1-02, Artoo → W1-04)
- Bonus: Shane also resolved Open Question #4 (Microsoft Graph for Teams + email; stub now, wire later)
- Full loop: Luke → LeoAI (AMP) → Shane (Discord DM) → LeoAI (discord-bot AMP) → Luke (AMP) ✓
