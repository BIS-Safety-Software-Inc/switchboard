#!/usr/bin/env node
'use strict';
/*
 * switchboard hook — PreToolUse
 * ────────────────────────────────────────────────────────────────────────────
 * Fires before Edit/Write/MultiEdit. Warns (does NOT block) when the target
 * file is owned by a DIFFERENT session/assignee per ownership.json.
 * Collision-safety at the edit layer. See CONTRACTS.md §"Hook contract".
 *
 * Behaviour (CONTRACTS.md):
 *   - Read stdin JSON: {session_id, cwd, tool_name, tool_input, ...}.
 *   - For Edit/Write/MultiEdit, resolve tool_input.file_path against the
 *     ownership.json globs of OTHER sessions/assignees.
 *   - If owned by someone else, emit
 *       {"systemMessage":"⚠ switchboard: <file> is owned by <KEY> (<assignee>)
 *        — coordinate before editing"}.
 *   - Ownership guard: ALWAYS allow (warn-only), never blocks an edit.
 *   - GATE 2 (added 2026-07-07, owner directive): Bash commands running
 *     `swb claim`/`swb done` are DENIED unless they carry --approved. This is
 *     the human claim/finish gate rebuilt at the hook layer, where
 *     --dangerously-skip-permissions cannot reach (the flag skips permission
 *     evaluation; lifecycle hooks still fire). The deny reason instructs the
 *     agent to ask its human in chat, then re-run with --approved. Teams dial
 *     it off with "gate2": "off" in the repo's .swb.json.
 *   - NEVER throw: any internal error → exit 0 + one events.jsonl line.
 *
 * INTEGRATION SEAM (thin, documented):
 *   Self-contained. Reads ownership.json directly (owner: swb) per CONTRACTS.md.
 *   Uses swb.js's matcher if it exports one (swb.globMatch / swb.ownerFor),
 *   else a zero-dep cross-platform glob matcher below. No spawning.
 *
 * MultiEdit note: MultiEdit's tool_input carries a single file_path plus an
 * edits[] array, so file_path resolution is identical to Edit/Write.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WATCHED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function swbHome() {
  return process.env.SWITCHBOARD_HOME || path.join(os.homedir(), '.switchboard');
}
function ownershipPath() { return path.join(swbHome(), 'ownership.json'); }
function eventsPath() { return path.join(swbHome(), 'events.jsonl'); }
function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
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

// ── zero-dep, cross-platform glob → RegExp ───────────────────────────────────
// Supports **, *, ?, and character classes. Path separators normalized to '/'.
function normSep(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }

function globToRegExp(glob) {
  const g = normSep(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // ** → match across path separators (any number of chars incl. '/')
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++; // consume a following slash so 'a/**/b' works
      } else {
        re += '[^/]*'; // single * → not across '/'
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '.') {
      re += '\\.';
    } else if ('+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function globMatch(glob, relPath) {
  try { return globToRegExp(glob).test(normSep(relPath)); }
  catch (_) { return false; }
}

// Resolve the edited file to a set of comparable path forms (relative-to-cwd,
// and its basename tail) so ownership globs written relative to the repo root
// match regardless of how the tool reported file_path.
function candidatePaths(filePath, cwd) {
  const raw = normSep(filePath);
  const out = new Set();
  out.add(raw);
  try {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd || process.cwd(), filePath);
    const rel = normSep(path.relative(cwd || process.cwd(), abs));
    if (rel && !rel.startsWith('..')) out.add(rel);
    out.add(normSep(abs));
  } catch (_) {}
  // also try stripping a leading './'
  for (const p of Array.from(out)) {
    if (p.startsWith('./')) out.add(p.slice(2));
  }
  return Array.from(out);
}

// Cross-MACHINE ownership: ownership.json is local to each laptop, so it only
// knows claims made HERE. Other people's claims travel as signed board comments
// ("Claimed HAC-305. Files: src/turni/**") which every machine's cache already
// holds. Parse them for In Progress issues assigned to someone else — that is
// the cross-person guard (live finding: the guard was silent for a teammate's
// claim because only the local file was consulted).
function cachePath() { return path.join(swbHome(), 'cache.json'); }
function remoteOwnership() {
  const cache = readJsonSafe(cachePath());
  if (!cache) return {};
  const meTokens = [];
  const v = cache.viewer;
  if (v && typeof v === 'object') {
    if (v.displayName) meTokens.push(String(v.displayName).trim().toLowerCase());
    if (v.name) meTokens.push(String(v.name).trim().toLowerCase());
  }
  const inProgress = new Map();
  for (const iss of cache.issues || []) {
    if (!iss || iss.state !== 'In Progress' || !iss.assignee) continue;
    if (meTokens.includes(String(iss.assignee).trim().toLowerCase())) continue; // my own
    inProgress.set(iss.key, iss.assignee);
  }
  const out = {};
  for (const c of cache.comments || []) {
    if (!c || !inProgress.has(c.issueKey)) continue;
    const m = /^Claimed (\S+)(?: \(human-approved\))?\. Files: (.+)$/m.exec(String(c.body || ''));
    if (!m || m[1] !== c.issueKey) continue;
    const globs = m[2].trim();
    if (!globs || globs.startsWith('(none')) continue;
    out[c.issueKey] = {
      files: globs.split(',').map((x) => x.trim()).filter(Boolean),
      assignee: inProgress.get(c.issueKey),
      remote: true,
    };
  }
  return out;
}

// Find the first ownership entry (by another session/assignee) that owns file.
function findForeignOwner(ownership, filePath, cwd, mySession, myAssignee) {
  if (!ownership || typeof ownership !== 'object') return null;
  const cands = candidatePaths(filePath, cwd);
  const mine = String(mySession || '');
  const myA = String(myAssignee || '').toLowerCase();
  for (const key of Object.keys(ownership)) {
    const e = ownership[key];
    if (!e || !Array.isArray(e.files)) continue;
    // skip my own claims (same session, or same assignee if session unknown)
    if (mine && String(e.sessionId || '') === mine) continue;
    if (!mine && myA && String(e.assignee || '').toLowerCase() === myA) continue;
    for (const glob of e.files) {
      for (const cand of cands) {
        if (globMatch(glob, cand)) {
          return { key, assignee: e.assignee || '?' };
        }
      }
    }
  }
  return null;
}

function main() {
  const start = Date.now();
  let sessionId = 'unknown';
  const input = readStdin();
  try {
    sessionId = input.session_id || input.sessionId || 'unknown';
    const cwd = input.cwd || process.cwd();
    const toolName = input.tool_name || input.toolName || '';
    const toolInput = input.tool_input || input.toolInput || {};
    const filePath = toolInput.file_path || toolInput.filePath || '';
    const myAssignee = input.assignee || process.env.SWB_VIEWER || '';

    // ── GATE 2: claim/done need the human's word — even under skip-permissions ──
    if (toolName === 'Bash') {
      const cmd = String(toolInput.command || '');
      // Anchored to a command position (start / after ; && || | or newline) so
      // prose or doc edits that merely MENTION the words are not gated. The
      // invocation may be the bare shim (`swb`), an unquoted path ending in
      // swb/swb.js, or a QUOTED path that can contain spaces ("…/AI Hackathon/…"
      // — the exact form that bypassed the first version of this gate, live).
      const SWB_INVOKE = String.raw`(?:node\s+(?:"[^"\n]*swb(?:\.js)?"|'[^'\n]*swb(?:\.js)?'|\S*swb(?:\.js)?)|"[^"\n]*swb"|'[^'\n]*swb'|\S*swb)`;
      const gateRe = new RegExp(String.raw`(^|[;&|]\s*|\n\s*)${SWB_INVOKE}\s+(claim|done)\b`);
      const gm = gateRe.exec(cmd);
      if (gm && !/\s--approved\b/.test(cmd)) {
        const cfg = readJsonSafe(path.join(cwd, '.swb.json')) || {};
        if (String(cfg.gate2 || 'on').toLowerCase() !== 'off') {
          const verb = gm[2];
          logEvent({ ts: new Date().toISOString(), cmd: 'hook:gate2', args: { verb, blocked: true }, sessionId, ok: true, ms: Date.now() - start });
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                `GATE 2 (switchboard): ${verb === 'claim' ? 'taking a ticket' : 'finishing a ticket'} needs your human's explicit yes — even with permissions skipped. ` +
                `Ask them in the conversation ("want me to ${verb} it?"). Once they say yes, re-run this exact command with --approved appended. ` +
                `Never add --approved without their yes in THIS conversation. (Team off-switch: "gate2": "off" in .swb.json.)`,
            },
          }));
          process.exit(0);
        }
      }
    }

    // Ownership guard only inside swb repos (Gate 2 above is exempt: an swb
    // claim/done invocation IS swb context wherever it runs).
    const inSwb = (() => {
      if (process.env.SWB_DIGEST_EVERYWHERE) return true; // panic switch
      if (process.env.SWB_TEAM_KEY) return true;
      try {
        const own = readJsonSafe(ownershipPath()) || {};
        const here = path.resolve(cwd || process.cwd());
        for (const k of Object.keys(own)) {
          const wt = own[k] && own[k].worktree;
          if (wt && (here === path.resolve(wt) || here.startsWith(path.resolve(wt) + path.sep))) return true;
        }
      } catch (_) {}
      let dir = path.resolve(cwd || process.cwd());
      for (let i = 0; i < 10; i++) {
        try { if (fs.existsSync(path.join(dir, '.swb.json'))) return true; } catch (_) {}
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      return false;
    })();
    if (inSwb && WATCHED_TOOLS.has(toolName) && filePath) {
      // Local claims first (authoritative for this machine), then teammates'
      // claims reconstructed from the board cache — cross-machine coverage.
      const localOwn = readJsonSafe(ownershipPath()) || {};
      const ownership = Object.assign({}, remoteOwnership(), localOwn);
      const owner = findForeignOwner(ownership, filePath, cwd, sessionId, myAssignee);
      if (owner) {
        const display = normSep(filePath);
        process.stdout.write(JSON.stringify({
          systemMessage: `⚠ switchboard: ${display} is owned by ${owner.key} (${owner.assignee}) — coordinate before editing`,
        }));
      }
      // no foreign owner → emit nothing (still ALWAYS allow).
    }
    // non-watched tool or no file_path → emit nothing.

    logEvent({
      ts: new Date().toISOString(), cmd: 'hook:pretooluse',
      args: { tool: toolName }, sessionId, ok: true, ms: Date.now() - start,
    });
  } catch (err) {
    logEvent({
      ts: new Date().toISOString(), cmd: 'hook:pretooluse',
      args: {}, sessionId, ok: false, ms: Date.now() - start,
      error: String((err && err.message) || err),
    });
  }
  // ALWAYS allow: exit 0 with no permission decision.
  process.exit(0);
}

if (require.main === module) main();

module.exports = { globMatch, globToRegExp, findForeignOwner, candidatePaths, WATCHED_TOOLS };
