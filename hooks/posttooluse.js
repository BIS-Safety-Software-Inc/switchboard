#!/usr/bin/env node
'use strict';
/*
 * switchboard hook — PostToolUse
 * ────────────────────────────────────────────────────────────────────────────
 * Fires after EVERY tool use, but self-throttles: it injects the delta digest
 * mid-turn ONLY when ≥300s have passed since this session's last injection
 * (cursor.lastInjectTs) AND the delta is non-empty. This closes the long-agent-
 * run blind spot without spamming. See CONTRACTS.md §"Hook contract".
 *
 * Behaviour (CONTRACTS.md):
 *   - Read stdin JSON: {session_id, cwd, tool_input, ...}.
 *   - Only if (now - lastInjectTs > 300s) AND delta non-empty:
 *       emit {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *             "additionalContext":"<digest>"}} and update lastInjectTs.
 *   - Emit NOTHING otherwise (throttled or empty delta).
 *   - NEVER block: any internal error → exit 0 + one events.jsonl line.
 *
 * INTEGRATION SEAM (thin, documented):
 *   Digest computation is shared with userpromptsubmit.js (single source of
 *   truth in-repo). We require it as a sibling module; if that ever fails the
 *   hook still exits 0 silently (fail-open). Prefer swb.js's own hookDigest
 *   when present (checked inside the shared computeDigest path).
 *   NOTE: PostToolUse does NOT refetch — freshness is UserPromptSubmit's job;
 *   here we only surface what's already cached, throttled.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_EVENT = 'PostToolUse';
const THROTTLE_MS = 300 * 1000; // 300s between mid-turn injections

// Reuse the shared digest engine from the sibling hook. Fail-open if absent.
let engine = null;
try { engine = require('./userpromptsubmit.js'); } catch (_) { engine = null; }

function swbHome() {
  return process.env.SWITCHBOARD_HOME || path.join(os.homedir(), '.switchboard');
}
function eventsPath() { return path.join(swbHome(), 'events.jsonl'); }
function sanitizeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}
function cursorPath(sessionId) {
  return path.join(swbHome(), 'cursors', `${sanitizeId(sessionId)}.json`);
}
function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}
function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return true;
  } catch (_) { return false; }
}
function logEvent(entry) {
  try {
    fs.mkdirSync(swbHome(), { recursive: true });
    fs.appendFileSync(eventsPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}
function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw) || {};
  } catch (_) { return {}; }
}
function tsMs(v) { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }

function main() {
  const start = Date.now();
  let sessionId = 'unknown';
  const input = readStdin();
  try {
    sessionId = input.session_id || input.sessionId || 'unknown';
    const cwd = input.cwd || process.cwd();

    let deliveredDigest;
    // Throttle gate: skip entirely if we injected < 300s ago.
    const cursor = readJsonSafe(cursorPath(sessionId)) || {};
    const lastInject = tsMs(cursor.lastInjectTs);
    const throttled = lastInject > 0 && (Date.now() - lastInject) <= THROTTLE_MS;

    if (!throttled && engine && typeof engine.computeDigest === 'function') {
      // Same unified digest source as UserPromptSubmit — the two hooks never diverge.
      const r = engine.computeDigest(sessionId, cwd);
      if (r.hasItems && r.text && r.text.trim()) {
        // Mid-turn deliveries get the SAME yellow box as prompt-time ones. This
        // door once delivered silently: the agent got the digest, the cursor
        // advanced, and the human saw nothing — "why didn't I see yellow?"
        const itemLines = r.text.split('\n').filter((l) => /^(@you|claim|state|disc|new)\s/.test(l));
        const count = itemLines.length || 1;
        const head = `switchboard (mid-turn): ${count} board update${count === 1 ? '' : 's'}`;
        const paint = engine && typeof engine.paintBox === 'function' ? engine.paintBox : null;
        process.stdout.write(JSON.stringify(Object.assign(
          paint ? { systemMessage: paint(head, r.text) } : {},
          { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: r.text } }
        )));
        deliveredDigest = r.text;
        // advance lastSeenTs when WE own the items (inline path); then stamp
        // lastInjectTs so the 300s throttle window opens.
        if (!r.viaSwb && Array.isArray(r.items) && typeof engine.advanceCursor === 'function') {
          engine.advanceCursor(sessionId, r.items);
        }
        const cur2 = readJsonSafe(cursorPath(sessionId)) || {};
        writeJsonSafe(cursorPath(sessionId), Object.assign({}, cur2, {
          lastInjectTs: new Date().toISOString(),
        }));
      }
      // empty delta → emit nothing, do NOT touch lastInjectTs.
    }
    // throttled OR no engine → emit nothing.

    logEvent({
      ts: new Date().toISOString(), cmd: 'hook:posttooluse',
      args: { throttled: !!throttled }, sessionId, ok: true, ms: Date.now() - start,
      digest: deliveredDigest, // feeds `swb last` — mid-turn deliveries are replayable too
    });
  } catch (err) {
    logEvent({
      ts: new Date().toISOString(), cmd: 'hook:posttooluse',
      args: {}, sessionId, ok: false, ms: Date.now() - start,
      error: String((err && err.message) || err),
    });
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { THROTTLE_MS, cursorPath, readJsonSafe, tsMs };
