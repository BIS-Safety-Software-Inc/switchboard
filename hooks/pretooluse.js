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
 *   - ALWAYS allow (warn-only). Never emit a permission decision / never block.
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

    if (WATCHED_TOOLS.has(toolName) && filePath) {
      const ownership = readJsonSafe(ownershipPath());
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
