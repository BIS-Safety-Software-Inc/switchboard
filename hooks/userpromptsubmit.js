#!/usr/bin/env node
'use strict';
/*
 * switchboard hook — UserPromptSubmit
 * ────────────────────────────────────────────────────────────────────────────
 * Fires on EVERY prompt. Injects the delta digest so the dev's agent is current
 * the instant they type anything. See CONTRACTS.md §"Hook contract".
 *
 * Behaviour (CONTRACTS.md):
 *   - Read stdin JSON: {session_id, cwd, tool_input, ...}.
 *   - If cache is stale (>45s) → refetch via swb (best-effort; failure is
 *     tolerated, we serve stale).
 *   - Emit {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
 *          "additionalContext":"<digest>"}} on a non-empty delta.
 *   - Emit NOTHING on empty delta.
 *   - NEVER block: any internal error → exit 0 + one events.jsonl line.
 *
 * INTEGRATION SEAM (thin, documented):
 *   swb.js does not have to exist for this hook to work. We prefer swb.js
 *   exports when present, else fall back to a self-contained implementation
 *   coded against the CONTRACTS.md cache/cursor/digest contract:
 *     - swb.hookDigest({sessionId, cwd})  -> {text, hasItems, wroteCursor}
 *         (if exported, we use it verbatim — single source of truth)
 *     - swb.refetchIfStale({maxAgeMs, cwd}) -> Promise (optional)
 *   REFETCH: we shell out to `node <swb.js> sync --hook --session <id>` ONLY to
 *   let swb refresh the cache; we still compute + emit the digest ourselves so
 *   the hook is deterministic and testable with fixtures today. If swb.js is
 *   absent, refetch is skipped silently and we serve whatever cache exists.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_EVENT = 'UserPromptSubmit';
const CACHE_MAX_AGE_MS = 45 * 1000; // stale threshold for UserPromptSubmit

// ── state-file locations (CONTRACTS.md §"Config & state files") ──────────────
function swbHome() {
  return process.env.SWITCHBOARD_HOME || path.join(os.homedir(), '.switchboard');
}
function cachePath() { return path.join(swbHome(), 'cache.json'); }
function ownershipPath() { return path.join(swbHome(), 'ownership.json'); }
function eventsPath() { return path.join(swbHome(), 'events.jsonl'); }
function cursorPath(sessionId) {
  return path.join(swbHome(), 'cursors', `${sanitizeId(sessionId)}.json`);
}
function sanitizeId(id) {
  // cursors/<sessionId>.json — never let a hostile id escape the dir
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

// ── never-throw helpers ─────────────────────────────────────────────────────
function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null; // missing OR corrupted → treat as absent, never crash
  }
}
function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}
function logEvent(entry) {
  try {
    fs.mkdirSync(swbHome(), { recursive: true });
    fs.appendFileSync(eventsPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) { /* logging must never throw */ }
}
function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw) || {};
  } catch (_) {
    return {}; // empty/corrupted stdin → behave as an empty event
  }
}

// ── seam to swb.js ───────────────────────────────────────────────────────────
function loadSwb() {
  try { return require(path.join(__dirname, '..', 'swb.js')); }
  catch (_) { return null; }
}
function swbJsPath() {
  const p = path.join(__dirname, '..', 'swb.js');
  return fs.existsSync(p) ? p : null;
}

// Best-effort cache refresh. Never blocks longer than the timeout; failure OK.
// MUST be awaited: swb.refetchIfStale is async — firing it without awaiting lets
// main()'s process.exit(0) kill the in-flight Linear fetch, so the cache would
// never actually freshen and the ">45s → refetch" contract would be a no-op.
async function refetchIfStale(sessionId, cwd) {
  const cache = readJsonSafe(cachePath());
  const fresh = cache && cache.fetchedAt &&
    (Date.now() - Date.parse(cache.fetchedAt)) <= CACHE_MAX_AGE_MS;
  if (fresh) return;
  const swb = loadSwb();
  if (swb && typeof swb.refetchIfStale === 'function') {
    try { await swb.refetchIfStale({ maxAgeMs: CACHE_MAX_AGE_MS, cwd, sessionId }); } catch (_) {}
    return;
  }
  const jsPath = swbJsPath();
  if (!jsPath) return; // no swb yet → serve stale silently (CONTRACTS: loud age stamp lives in digest)
  try {
    spawnSync(process.execPath, [jsPath, 'sync', '--hook', '--session', String(sessionId)], {
      cwd: cwd || process.cwd(),
      timeout: 6000,
      stdio: 'ignore',
    });
  } catch (_) { /* refetch is best-effort */ }
}

// ── delta + digest (self-contained; mirrors CONTRACTS.md "Digest format") ────
// Prefer swb.js's own computation if it exposes one — single source of truth.
function computeDigestViaSwb(sessionId, cwd) {
  const swb = loadSwb();
  if (swb && typeof swb.hookDigest === 'function') {
    try {
      const r = swb.hookDigest({ sessionId, cwd });
      if (r && typeof r.text === 'string') {
        return { text: r.text, hasItems: !!r.hasItems, viaSwb: true };
      }
    } catch (_) { /* fall through to inline */ }
  }
  return null;
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n);
}
function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function hhmm(d) {
  const dt = d instanceof Date ? d : new Date();
  const h = String(dt.getHours()).padStart(2, '0');
  const m = String(dt.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
function tsMs(v) { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function firstWord(s) { return String(s == null ? '' : s).trim().split(/\s+/)[0] || ''; }

// CANONICAL SCHEMA v2: cache.viewer is an OBJECT {name, displayName} (never a
// bare string). Resolve it to the single name token used for @-mention matching.
// Accepts a string too so callers that already hold a name (and the reference
// test that passes 'marc' straight into buildItems) keep working.
function viewerName(viewer) {
  if (!viewer) return '';
  if (typeof viewer === 'string') return viewer;
  // Prefer displayName (the @-handle Linear surfaces) then fall back to name.
  return String(viewer.displayName || viewer.name || '');
}

// Build the delta item list from cache + ownership since the cursor's lastSeenTs.
// Item order within a category preserves cache order; @you always sorts first.
function buildItems(cache, ownership, viewer, sinceMs) {
  const items = [];
  const issues = Array.isArray(cache && cache.issues) ? cache.issues : [];
  const comments = Array.isArray(cache && cache.comments) ? cache.comments : [];
  const byKey = new Map();
  for (const it of issues) { if (it && it.key) byKey.set(it.key, it); }

  // viewer may arrive as a v2 {name, displayName} object OR a bare name string
  // (the reference test passes 'marc' directly). Resolve to the handle token.
  const you = viewerName(viewer).toLowerCase();
  // Match on the FIRST word of the handle so a "Turni Saha" viewer still keys
  // off "turni" — identical to swb.js's firstWord(viewerName) mention logic.
  const youToken = firstWord(you);
  // Only an actual @-mention counts (word-boundaried), never a bare substring —
  // otherwise short names (sam→"same", ana→"banana") falsely promote comments to
  // the top @you slot. This IS the @-word-boundary regex CONTRACTS.md mandates;
  // v2 stores no mentions[] array, so the body is the ONLY source.
  const mentionRe = youToken
    ? new RegExp('@' + escapeRe(youToken) + '\\b', 'i')
    : null;
  const mentionsYou = (body) => {
    if (!mentionRe) return false;
    return mentionRe.test(String(body || ''));
  };

  // @you — new comments addressed to the viewer (author ≠ viewer)
  const youLines = [];
  const otherComments = [];
  for (const c of comments) {
    if (!c) continue;
    const created = tsMs(c.createdAt);
    if (created <= sinceMs) continue;
    const author = String(c.author || '');
    if (you && author.toLowerCase() === you) continue; // don't surface my own
    // CANONICAL SCHEMA v2: comments[].discovery is the ONLY meta flag.
    const isDiscovery = c.discovery === true;
    if (isDiscovery) {
      otherComments.push({ kind: 'disc', c });
      continue;
    }
    // v2: mentions are NEVER stored — compute them from the body with the
    // word-boundary @name regex. There is no c.mentions array to consult.
    if (mentionsYou(c.body)) {
      youLines.push({ kind: 'you', c });
    } else {
      otherComments.push({ kind: 'other-comment', c });
    }
  }
  for (const y of youLines) {
    const c = y.c;
    items.push({
      you: true,
      ts: tsMs(c.createdAt),
      text: `@you   ${pad(c.issueKey || '?', 6)} ${c.author || '?'}: "${trunc(c.body, 100)}" → swb show ${c.issueKey || '?'}`,
    });
  }

  // claim — ownership entries newer than cursor
  const own = ownership && typeof ownership === 'object' ? ownership : {};
  for (const key of Object.keys(own)) {
    const e = own[key];
    if (!e) continue;
    if (tsMs(e.ts) <= sinceMs) continue;
    if (you && String(e.assignee || '').toLowerCase() === you) continue; // my own claim
    const globs = Array.isArray(e.files) ? e.files.join(',') : '';
    const it = byKey.get(key);
    const title = trunc(it && it.title, 40);
    items.push({
      you: false,
      ts: tsMs(e.ts),
      text: `claim  ${pad(key, 6)} ${title} → ${e.assignee || '?'}   files: ${globs}`,
    });
  }

  // state — issues whose state changed since cursor
  for (const it of issues) {
    if (!it || !it.key) continue;
    const changedAt = it.stateChangedAt || it.updatedAt;
    if (tsMs(changedAt) <= sinceMs) continue;
    if (tsMs(it.createdAt) > sinceMs) continue; // brand-new issues surface as `new`
    if (!it.state) continue;
    items.push({
      you: false,
      ts: tsMs(changedAt),
      text: `state  ${pad(it.key, 6)} → ${it.state}`,
    });
  }

  // disc — discovery comments
  for (const o of otherComments) {
    if (o.kind !== 'disc') continue;
    const c = o.c;
    items.push({
      you: false,
      ts: tsMs(c.createdAt),
      text: `disc   ${trunc(c.body, 90)} (${c.author || '?'})`,
    });
  }

  // new — issues created since cursor in Triage
  for (const it of issues) {
    if (!it || !it.key) continue;
    if (tsMs(it.createdAt) <= sinceMs) continue;
    const state = String(it.state || '');
    if (state && state.toLowerCase() !== 'triage') continue; // CONTRACTS: new items are Triage
    items.push({
      you: false,
      ts: tsMs(it.createdAt),
      text: `new    ${pad(it.key, 6)} ${trunc(it.title, 60)} [Triage]`,
    });
  }

  return items;
}

// Assemble the exact digest block. Returns null when there are no items.
function renderDigest(cache, items) {
  if (!items.length) return null;
  // @you first, then chronological within the rest.
  const you = items.filter(i => i.you);
  const rest = items.filter(i => !i.you).sort((a, b) => a.ts - b.ts);
  let ordered = you.concat(rest);

  const MAX = 12;
  let extraNote = null;
  if (ordered.length > MAX) {
    // drop oldest of the non-@you tail, keep @you
    const overflow = ordered.length - MAX;
    const keep = you.concat(rest.slice(overflow));
    extraNote = `+${overflow} more`;
    ordered = keep.slice(0, MAX);
  }

  const now = new Date();
  let ageS = '?';
  if (cache && cache.fetchedAt) {
    const a = Math.max(0, Math.round((Date.now() - Date.parse(cache.fetchedAt)) / 1000));
    if (Number.isFinite(a)) ageS = String(a);
  }
  const n = items.length;
  const header = `── switchboard · ${hhmm(now)} · cache ${ageS}s · ${n} new ──`;

  const lines = [header];
  for (const it of ordered) lines.push(it.text);
  if (extraNote) lines.push(extraNote);
  lines.push('act    if any item above touches your claimed ticket or declared files, state the impact before continuing');
  lines.push('──');
  return lines.join('\n');
}

function computeDigestInline(sessionId, cwd) {
  const cache = readJsonSafe(cachePath());
  const ownership = readJsonSafe(ownershipPath());
  const cursor = readJsonSafe(cursorPath(sessionId)) || {};
  const viewer = (cache && cache.viewer) || process.env.SWB_VIEWER || '';
  const sinceMs = tsMs(cursor.lastSeenTs); // 0 (epoch) when no cursor → surface all
  const items = buildItems(cache, ownership, viewer, sinceMs);
  const text = renderDigest(cache, items);
  return { text: text || '', hasItems: !!text, cache, items, viewer };
}

// Unified digest source used by BOTH hooks.
//
// SEAM POLICY (documented, flippable by mastermind):
//   The hook-pack's own inline engine is the DEFAULT and authoritative source —
//   hooks are the deterministic awareness layer and must emit a correct digest
//   with zero external assumptions. Set SWB_HOOK_DIGEST=swb to delegate to
//   swb.js's hookDigest (its cursor-advance side effect is then intentional).
//   The two engines are NOT guaranteed byte-identical, so the swb path is gated:
//   its output must pass digestLooksWellFormed() at runtime before we inject it.
//   If swb.js's digest is malformed (e.g. a field-name mismatch renders a literal
//   "undefined" on the @you line), we DO NOT inject garbage — we emit nothing for
//   this turn rather than surface a corrupt digest. digestLooksWellFormed() is
//   thus both an offline QA gate for the mastermind AND a runtime safety net.
//   Note hookDigest is not pure (it advances the cursor), so once we've called it
//   the delta is consumed; on a rejected malformed digest we suppress output
//   rather than silently re-run the inline engine against a half-consumed delta.
function digestLooksWellFormed(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (!text.startsWith('── switchboard · ')) return false;
  // a field-name mismatch surfaces as literal "undefined" in the item region
  if (/\bundefined\b/.test(text)) return false;
  return true;
}
function computeDigest(sessionId, cwd) {
  if (process.env.SWB_HOOK_DIGEST === 'swb') {
    const viaSwb = computeDigestViaSwb(sessionId, cwd);
    if (viaSwb) {
      // Runtime safety net: never inject a malformed swb.js digest. If it fails
      // the well-formedness gate, suppress this turn's output (empty delta) — the
      // cursor was already advanced by hookDigest, so re-running inline here would
      // see a half-consumed delta. Better to say nothing than to say "undefined".
      const wellFormed = digestLooksWellFormed(viaSwb.text);
      const text = wellFormed ? viaSwb.text : '';
      const hasItems = !!(wellFormed && viaSwb.hasItems && viaSwb.text && viaSwb.text.trim());
      return { text, hasItems, items: null, viaSwb: true };
    }
    // swb.js absent / no hookDigest → fall through to inline (nothing consumed yet)
  }
  const r = computeDigestInline(sessionId, cwd);
  return { text: r.text, hasItems: r.hasItems, items: r.items, viaSwb: false };
}

// Advance lastSeenTs to the newest item we just surfaced (so we don't repeat).
function advanceCursor(sessionId, items) {
  let maxTs = 0;
  for (const it of items) if (it.ts > maxTs) maxTs = it.ts;
  const cur = readJsonSafe(cursorPath(sessionId)) || {};
  const next = Object.assign({}, cur, {
    lastSeenTs: maxTs ? new Date(maxTs).toISOString() : (cur.lastSeenTs || new Date().toISOString()),
  });
  writeJsonSafe(cursorPath(sessionId), next);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  let sessionId = 'unknown';
  const input = readStdin();
  try {
    sessionId = input.session_id || input.sessionId || 'unknown';
    const cwd = input.cwd || process.cwd();

    // Awaited so the async Linear refetch actually completes (and writes the
    // refreshed cache) BEFORE we compute the digest and exit — see the comment
    // on refetchIfStale. The subsequent digest then reflects fresh data.
    await refetchIfStale(sessionId, cwd);

    const r = computeDigest(sessionId, cwd);
    const text = r.text;
    const hasItems = r.hasItems && !!(text && text.trim());
    // advance the cursor when WE computed the items (inline path). When swb.js's
    // hookDigest owns the digest it also owns cursor advancement (wroteCursor).
    if (hasItems && !r.viaSwb && Array.isArray(r.items)) advanceCursor(sessionId, r.items);

    if (hasItems && text.trim()) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: text },
      }));
    }
    // empty delta → emit nothing.

    logEvent({
      ts: new Date().toISOString(), cmd: 'hook:userpromptsubmit',
      args: {}, sessionId, ok: true, ms: Date.now() - start,
    });
  } catch (err) {
    // NEVER block. Log and exit 0.
    logEvent({
      ts: new Date().toISOString(), cmd: 'hook:userpromptsubmit',
      args: {}, sessionId, ok: false, ms: Date.now() - start,
      error: String((err && err.message) || err),
    });
  }
  process.exit(0);
}

if (require.main === module) {
  // main() is async now; a rejection must still never block the prompt.
  main().catch(() => process.exit(0));
}

module.exports = {
  // exported for tests + reuse by the other hooks
  buildItems, renderDigest, computeDigestInline, computeDigest,
  digestLooksWellFormed, advanceCursor,
  readJsonSafe, cachePath, cursorPath, ownershipPath, eventsPath, swbHome,
  sanitizeId, tsMs,
};
