#!/usr/bin/env node
'use strict';
/*
 * swb — Switchboard CLI. One file, zero npm deps. Node >= 18.
 * See CONTRACTS.md — that file is law. Verbs: sync claim done ask discover new show release doctor.
 * Importable as a module (nothing runs on require); executing the file runs main().
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const VERSION = '1.0.0';
const LINEAR_URL = 'https://api.linear.app/graphql';
const CALL_TIMEOUT_MS = 5000;
const CACHE_STALE_MS = 45000;
const CLAIM_VERIFY_DELAY_MS = 1500;
// A session's FIRST digest (no cursor yet) looks back this far, not to epoch —
// otherwise every fresh session replays the board's entire history (seen live).
const FIRST_LOOK_WINDOW_MS = 30 * 60 * 1000;

// Kit state name -> Linear workflow state name. IDENTITY since 2026-07-07:
// the kit speaks Linear's own vocabulary (owner call — 'Triage/Ready' confused
// every first-time user). The map stays as the doctor's checklist + seam for
// teams that rename their Linear states.
const STATE_MAP = {
  Backlog: 'Backlog',
  Todo: 'Todo',
  'In Progress': 'In Progress',
  'In Review': 'In Review',
  Done: 'Done',
};
const REQUIRED_STATES = Object.keys(STATE_MAP); // the five swb states doctor verifies
// Reasonable Linear state TYPE for each required state when doctor --fix creates it.
const STATE_TYPE = {
  Backlog: 'backlog',
  Todo: 'unstarted',
  'In Progress': 'started',
  'In Review': 'started',
  Done: 'completed',
};

// Paths & config
function homeDir() {
  // SWITCHBOARD_HOME is the ONE home-dir override the hook pack + installer also
  // honor (CONTRACTS.md v2 — SWB_HOME is dead). Falls back to ~/.switchboard.
  return process.env.SWITCHBOARD_HOME || path.join(os.homedir(), '.switchboard');
}
function paths() {
  const home = homeDir();
  return {
    home,
    env: path.join(home, 'env'),
    cache: path.join(home, 'cache.json'),
    events: path.join(home, 'events.jsonl'),
    ownership: path.join(home, 'ownership.json'),
    cursors: path.join(home, 'cursors'),
  };
}
function cursorPath(sessionId) {
  return path.join(paths().cursors, `${sanitizeId(sessionId)}.json`);
}
function sanitizeId(id) {
  return String(id || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
}
function ensureHome() {
  const p = paths();
  fs.mkdirSync(p.home, { recursive: true });
  fs.mkdirSync(p.cursors, { recursive: true });
}

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}
function loadEnv() {
  const p = paths();
  let fileEnv = {};
  try {
    fileEnv = parseEnvFile(fs.readFileSync(p.env, 'utf8'));
  } catch (_) { /* missing env file is fine; may come from process.env */ }
  return {
    LINEAR_API_KEY: process.env.LINEAR_API_KEY || fileEnv.LINEAR_API_KEY || '',
    SWB_TEAM_KEY: process.env.SWB_TEAM_KEY || fileEnv.SWB_TEAM_KEY || '',
  };
}
function loadRepoConfig(cwd) {
  const file = path.join(cwd || process.cwd(), '.swb.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      teamKey: cfg.teamKey || '',
      testCommand: cfg.testCommand || 'node --test',
      defaultBranch: cfg.defaultBranch || 'master',
    };
  } catch (_) {
    return { teamKey: '', testCommand: 'node --test', defaultBranch: 'master' };
  }
}
// Team resolution: .swb.json teamKey -> env SWB_TEAM_KEY. Refuse without a team.
function resolveTeamKey(cwd) {
  const repo = loadRepoConfig(cwd);
  const env = loadEnv();
  return repo.teamKey || env.SWB_TEAM_KEY || '';
}

// events.jsonl — EVERY verb + hook appends
function logEvent(evt) {
  try {
    ensureHome();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...evt }) + '\n';
    fs.appendFileSync(paths().events, line);
  } catch (_) { /* logging must never throw into a verb */ }
}

// Cache
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(paths().cache, 'utf8'));
  } catch (_) {
    return null;
  }
}
function writeCache(cache) {
  ensureHome();
  fs.writeFileSync(paths().cache, JSON.stringify(cache, null, 2));
}
function cacheAgeMs(cache, now) {
  if (!cache || !cache.fetchedAt) return Infinity;
  const t = Date.parse(cache.fetchedAt);
  if (Number.isNaN(t)) return Infinity;
  return (now || Date.now()) - t;
}
function isStale(cache, now) {
  return cacheAgeMs(cache, now) > CACHE_STALE_MS;
}

// Ownership
function readOwnership() {
  try {
    return JSON.parse(fs.readFileSync(paths().ownership, 'utf8'));
  } catch (_) {
    return {};
  }
}
function writeOwnership(obj) {
  ensureHome();
  fs.writeFileSync(paths().ownership, JSON.stringify(obj, null, 2));
}

// Cursors
function readCursor(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(cursorPath(sessionId), 'utf8'));
  } catch (_) {
    return { lastSeenTs: null, lastInjectTs: null };
  }
}
function writeCursor(sessionId, cursor) {
  ensureHome();
  fs.writeFileSync(cursorPath(sessionId), JSON.stringify(cursor, null, 2));
}

// Linear GraphQL client — 5s timeout, header Authorization: <key> (no Bearer)
async function linear(query, variables, apiKey) {
  const key = apiKey || loadEnv().LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY missing — set it in ~/.switchboard/env');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(LINEAR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query, variables: variables || {} }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error(`Linear API timed out after ${CALL_TIMEOUT_MS}ms`);
    throw new Error(`Linear API request failed: ${err && err.message ? err.message : err}`);
  }
  clearTimeout(timer);
  let json;
  try {
    json = await res.json();
  } catch (_) {
    throw new Error(`Linear API returned non-JSON (HTTP ${res.status})`);
  }
  if (json.errors && json.errors.length) {
    throw new Error('Linear API error: ' + json.errors.map((e) => e.message).join('; '));
  }
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`);
  return json.data;
}

async function getViewer(apiKey) {
  const d = await linear('query { viewer { id name displayName email } }', {}, apiKey);
  return d.viewer;
}

// Fetch the ACTIVE members of a team: {id, name, displayName}. Used by `ask` to
// canonicalize a human-typed @target into the member's @displayName handle.
async function getTeamMembers(teamKey, apiKey) {
  const q = `query($key: String!) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes { id key
        members(first: 100) { nodes { id name displayName active } } } } }`;
  const d = await linear(q, { key: teamKey }, apiKey);
  const team = d.teams && d.teams.nodes && d.teams.nodes[0];
  if (!team) throw new Error(`Team "${teamKey}" not found for this API key`);
  return ((team.members && team.members.nodes) || []).filter((m) => m.active !== false);
}

// Resolve a human-typed @target ("@Turni", "@turni.saha", "Turni Saha") against a
// team's members. Match case-insensitively on displayName, full name, or the
// FIRST word of the name. Returns the matched member or null (no match).
function matchMember(rawTarget, members) {
  const needle = String(rawTarget || '').replace(/^@+/, '').trim().toLowerCase();
  if (!needle) return null;
  for (const m of members || []) {
    const dn = String(m.displayName || '').trim().toLowerCase();
    const full = String(m.name || '').trim().toLowerCase();
    const first = firstWord(m.name || '').toLowerCase();
    if (needle === dn || needle === full || (first && needle === first)) return m;
  }
  return null;
}

async function getTeamByKey(teamKey, apiKey) {
  const q = `query($key: String!) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes { id key name
        states(first: 50) { nodes { id name type position } } } } }`;
  const d = await linear(q, { key: teamKey }, apiKey);
  const team = d.teams && d.teams.nodes && d.teams.nodes[0];
  if (!team) throw new Error(`Team "${teamKey}" not found for this API key`);
  return team;
}

// Fetch issues + recent comments for a team and rebuild the cache in the
// CANONICAL SCHEMA v2 (CONTRACTS.md): viewer, states keyed by swb name →
// {linearName,id}, issues[].state as swb names, comments[].issueKey + discovery.
async function fetchTeamState(teamKey, apiKey) {
  const team = await getTeamByKey(teamKey, apiKey);
  const viewerRaw = await safeViewer(apiKey);
  // team(id:) takes String! (iter-2 P0 — ID! is rejected).
  const q = `query($teamId: String!) {
    team(id: $teamId) {
      issues(first: 100, orderBy: updatedAt) {
        nodes {
          id identifier title createdAt updatedAt
          state { name type }
          assignee { id name }
          labels { nodes { name } }
          comments(first: 20) {
            nodes { id body createdAt user { id name } }
          }
        }
      }
    }
  }`;
  const d = await linear(q, { teamId: team.id }, apiKey);
  const nodes = (d.team && d.team.issues && d.team.issues.nodes) || [];
  // Which issues are the pinned Discoveries thread? (label swb-meta.) Comments
  // sitting on those are discovery:true; consumers surface them as `disc` lines.
  const discoveryKeys = new Set(
    nodes
      .filter((n) => (n.labels && n.labels.nodes ? n.labels.nodes : []).some((l) => l.name === 'swb-meta'))
      .map((n) => n.identifier)
  );
  const issues = [];
  const comments = [];
  for (const n of nodes) {
    issues.push({
      id: n.id,
      key: n.identifier,
      title: n.title,
      state: n.state ? swbStateName(n.state.name) : null, // swb state names (mapped at fetch time)
      assignee: n.assignee ? n.assignee.name : null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    });
    for (const c of (n.comments && n.comments.nodes) || []) {
      comments.push({
        issueKey: n.identifier,
        author: c.user ? c.user.name : 'unknown',
        body: c.body,
        createdAt: c.createdAt,
        discovery: discoveryKeys.has(n.identifier),
      });
    }
  }
  // states: swb name → { linearName, id }. Only the five mapped states.
  const states = {};
  const byLinearName = new Map((team.states && team.states.nodes ? team.states.nodes : []).map((s) => [s.name, s]));
  for (const [swbName, linearName] of Object.entries(STATE_MAP)) {
    const s = byLinearName.get(linearName);
    states[swbName] = { linearName, id: s ? s.id : null };
  }
  const viewer = viewerRaw
    ? { name: viewerRaw.name || null, displayName: viewerRaw.displayName || viewerRaw.name || null }
    : null;
  return { fetchedAt: new Date().toISOString(), teamKey, viewer, states, issues, comments };
}

// Refetch into cache; on failure return the stale cache (serve-stale, loud age stamp handled by caller).
async function refreshCache(teamKey, apiKey) {
  const fresh = await fetchTeamState(teamKey, apiKey);
  writeCache(fresh);
  return fresh;
}
async function ensureCache(teamKey, apiKey, now) {
  const cache = readCache();
  if (cache && cache.teamKey === teamKey && !isStale(cache, now)) return { cache, refreshed: false };
  try {
    const fresh = await refreshCache(teamKey, apiKey);
    return { cache: fresh, refreshed: true };
  } catch (err) {
    if (cache) return { cache, refreshed: false, error: err };
    throw err;
  }
}

// Digest — exact format from CONTRACTS.md §Digest
function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n);
}
function fmtTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Build ordered delta items newer than sinceTs. viewerName drives @you ordering.
// viewerName may be a string OR the v2 cache viewer object {name, displayName}.
function buildDeltaItems(cache, sinceTs, viewerName) {
  const since = sinceTs ? Date.parse(sinceTs) : 0;
  const meTokens = viewerIdentityTokens(viewerName);
  // Broadened @you matcher: a comment counts as mine if it @-mentions ANY of my
  // handle tokens — displayName, my first name, or my full name — each matched
  // word-boundaried + case-insensitive so short names never substring-promote.
  // This is the fix for callers who type @Turni while my displayName is turni.saha.
  const items = [];
  for (const c of cache.comments || []) {
    const t = Date.parse(c.createdAt);
    if (Number.isNaN(t) || t <= since) continue;
    // Suppress the viewer's own comments — you don't need to be told what you said.
    // Match on ANY identity token: Linear authors under the full name ("Turni Saha")
    // while the digest handle is the displayName ("turni.saha").
    if (meTokens.includes(String(c.author || '').trim().toLowerCase())) continue;
    const isDiscovery = c.discovery === true;
    const mentioned = bodyMentionsViewer(c.body, viewerName);
    let kind;
    if (mentioned) kind = 'you';
    else if (isDiscovery) kind = 'comment'; // rendered as a `disc` line
    else continue; // ordinary non-mention, non-discovery comment → not surfaced
    items.push({
      kind,
      ts: t,
      key: c.issueKey,
      author: c.author,
      text: c.body,
    });
  }
  for (const iss of cache.issues || []) {
    const created = Date.parse(iss.createdAt);
    const updated = Date.parse(iss.updatedAt);
    if (!Number.isNaN(created) && created > since) {
      items.push({ kind: 'new', ts: created, key: iss.key, title: iss.title, state: iss.state });
    } else if (!Number.isNaN(updated) && updated > since) {
      // A state change / claim shows up as an update. Suppress your OWN claims —
      // an issue now assigned to you is not news you need pushed back at you.
      if (meTokens.includes(String(iss.assignee || '').trim().toLowerCase())) continue;
      items.push({ kind: 'state', ts: updated, key: iss.key, title: iss.title, state: iss.state, assignee: iss.assignee });
    }
  }
  // @you first, then newest → oldest within each group.
  items.sort((a, b) => {
    const ay = a.kind === 'you' ? 0 : 1;
    const by = b.kind === 'you' ? 0 : 1;
    if (ay !== by) return ay - by;
    return b.ts - a.ts;
  });
  return items;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function firstWord(s) { return String(s || '').trim().split(/\s+/)[0]; }
// Full-string identity tokens for self-suppression, lowercased: my displayName
// AND my full name. Comparing author/assignee against both is what makes
// "don't echo my own actions" hold when Linear authors under "Turni Saha" but
// the handle is "turni.saha" (observed live in the coordination-proof runs).
// First name is deliberately NOT an identity token — full-string equality only.
function viewerIdentityTokens(viewer) {
  const out = [];
  if (viewer && typeof viewer === 'object') {
    if (viewer.displayName) out.push(String(viewer.displayName).trim().toLowerCase());
    if (viewer.name) out.push(String(viewer.name).trim().toLowerCase());
  } else if (viewer) {
    out.push(String(viewer).trim().toLowerCase());
  }
  return out;
}
// Which agent harness is driving this process? Used for the board-visible
// claim label. CLAUDECODE is set by Claude Code sessions; CODEX_* by Codex.
function harnessName() {
  if (process.env.CLAUDECODE) return 'claude';
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME || process.env.CODEX_THREAD_ID) return 'codex';
  return 'agent';
}
// Accept either a plain name string or the v2 cache viewer object {name, displayName}.
function viewerNameOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v.displayName || v.name || '');
}

// The set of @-handle tokens that count as "me" for @you matching. A caller can
// type @<displayName>, @<FirstName>, or @<Full Name>; any of them must surface a
// comment as @you. viewer may be a v2 object {name, displayName} OR a bare name
// string (older callers / tests pass just the display token). Deduped, lowercased.
function viewerHandleTokens(viewer) {
  const tokens = [];
  if (viewer && typeof viewer === 'object') {
    if (viewer.displayName) tokens.push(String(viewer.displayName));
    if (viewer.name) { tokens.push(firstWord(viewer.name)); tokens.push(String(viewer.name).trim()); }
  } else if (viewer) {
    const s = String(viewer);
    tokens.push(s);
    tokens.push(firstWord(s)); // a bare "Turni Saha" string still yields "Turni"
  }
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const v = String(t || '').trim();
    if (!v) continue;
    const lc = v.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(v);
  }
  return out;
}
// Build one case-insensitive, word-boundaried @mention regex per handle token.
// Word-boundaried so short handles (sam→"same") never substring-promote a comment.
function mentionRegexesFor(viewer) {
  return viewerHandleTokens(viewer).map((tok) => new RegExp('@' + escapeRe(tok) + '\\b', 'i'));
}
// True iff the body @-mentions ANY of the viewer's handle tokens.
function bodyMentionsViewer(body, viewer) {
  const text = String(body || '');
  return mentionRegexesFor(viewer).some((re) => re.test(text));
}

function swbStateName(linearName) {
  for (const [swbName, linName] of Object.entries(STATE_MAP)) {
    if (linName === linearName) return swbName;
  }
  return linearName || '?';
}

// Parse an issue key like "HAC-123" into { teamKey: 'HAC', number: 123 }.
// Linear's IssueFilter has no `identifier` field, so every by-key lookup must
// filter on number + team.key instead (CONTRACTS iter-2 P0).
function parseIssueKey(key) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(key || '').trim());
  if (!m) throw new Error(`Malformed issue key "${key}" (expected e.g. HAC-123)`);
  return { teamKey: m[1].toUpperCase(), number: Number(m[2]) };
}

// Render the digest exactly per CONTRACTS.md. Returns '' on empty delta (print nothing).
// ownership (optional) upgrades a state item to a `claim` line when we hold its file globs.
function renderDigest(cache, items, now, ownership) {
  if (!items.length) return '';
  const ageS = Math.max(0, Math.round(cacheAgeMs(cache, now.getTime()) / 1000));
  const MAX = 12;
  const shown = items.slice(0, MAX);
  const extra = items.length - shown.length;
  const lines = [];
  lines.push(`── switchboard · ${fmtTime(now)} · cache ${ageS}s · ${items.length} new ──`);
  for (const it of shown) {
    if (it.kind === 'you') {
      lines.push(`@you   ${it.key} ${it.author}: "${trunc(it.text, 300)}" → swb show ${it.key}`); // @you carries the full comment (300) — it is addressed to you
    } else if (it.kind === 'comment') {
      lines.push(`disc   ${trunc(it.text, 90)} (${it.author})`);
    } else if (it.kind === 'state') {
      const own = ownership && ownership[it.key];
      if (own && own.files && own.files.length) lines.push(claimLine(it, ownership));
      else lines.push(`state  ${it.key} → ${swbStateName(it.state)}`);
    } else if (it.kind === 'new') {
      lines.push(`new    ${it.key} ${trunc(it.title, 60)} [Backlog]`);
    }
  }
  if (extra > 0) lines.push(`+${extra} more`);
  lines.push('act    if any item above touches your claimed ticket or declared files, state the impact before continuing');
  lines.push('──');
  return lines.join('\n');
}

// claim-line variant is emitted by state items that also carry assignee+files, but the
// contract's canonical claim line is produced when we know files (ownership). We render it
// from ownership when available for a state item.
function claimLine(item, ownership) {
  const own = ownership && ownership[item.key];
  const files = own && own.files ? own.files.join(',') : '';
  return `claim  ${item.key} ${trunc(item.title, 40)} → ${item.assignee || '?'}   files: ${files}`;
}

// git helpers (cross-platform via spawnSync; no shell)
function git(args, opts) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...(opts || {}) });
  return { code: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}
function inGitRepo(cwd) {
  const r = git(['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.code === 0 && String(r.stdout).trim() === 'true';
}
function gitLogSummary(cwd, n) {
  const r = git(['log', `-${n || 5}`, '--oneline'], { cwd });
  return r.code === 0 ? r.stdout.trim() : '';
}

// Comment signature + posting
function signComment(body, viewerName) {
  return `${body}\n\n🤖 Claude — via ${viewerName || 'unknown'} · swb v${VERSION}`;
}
async function postComment(issueId, body, viewerName, apiKey) {
  const q = `mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }`;
  const d = await linear(q, { issueId, body: signComment(body, viewerName) }, apiKey);
  if (!d.commentCreate || !d.commentCreate.success) throw new Error('commentCreate failed');
  return d.commentCreate.comment;
}

// Issue lookup helpers (live, not cache — mutations must read truth).
// IssueFilter has no `identifier` field, so we parse KEY → team.key + number
// and filter on those instead (iter-2 P0 — the old identifier filter is rejected).
async function findIssueByKey(teamKey, key, apiKey) {
  const { teamKey: keyTeam, number } = parseIssueKey(key);
  const q = `query($number: Float!, $teamKey: String!) {
    issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }, first: 1) {
      nodes {
        id identifier title description number
        team { id key }
        state { id name type }
        assignee { id name }
        labels { nodes { id name } }
      }
    }
  }`;
  const d = await linear(q, { number, teamKey: keyTeam }, apiKey);
  const node = d.issues && d.issues.nodes && d.issues.nodes[0];
  if (!node) throw new Error(`Issue ${key} not found`);
  if (node.team && node.team.key !== teamKey) {
    throw new Error(`Issue ${key} belongs to team ${node.team.key}, not ${teamKey}`);
  }
  return node;
}
async function getStateIdByName(teamKey, swbName, apiKey) {
  const linName = STATE_MAP[swbName] || swbName;
  const team = await getTeamByKey(teamKey, apiKey);
  const st = (team.states.nodes || []).find((s) => s.name === linName);
  if (!st) throw new Error(`Workflow state "${linName}" (${swbName}) missing on team ${teamKey} — run: swb doctor --fix`);
  return { stateId: st.id, teamId: team.id };
}
// Direct-by-id read — STRONGLY consistent, unlike the issues(filter:) search
// path, which reads a lagging index (observed 17s+ stale live on 2026-07-07 and
// falsely reported a just-claimed issue as unassigned). Race verification MUST
// use this, never the filtered search.
async function getIssueById(issueId, apiKey) {
  const q = `query($id: String!) {
    issue(id: $id) { id identifier assignee { id name } state { id name } } }`;
  const d = await linear(q, { id: issueId }, apiKey);
  if (!d.issue) throw new Error(`issue ${issueId} not found by id`);
  return d.issue;
}

async function setAssigneeAndState(issueId, assigneeId, stateId, apiKey) {
  const q = `mutation($id: String!, $assigneeId: String, $stateId: String) {
    issueUpdate(id: $id, input: { assigneeId: $assigneeId, stateId: $stateId }) {
      success issue { id assignee { id name } state { name } } } }`;
  const d = await linear(q, { id: issueId, assigneeId, stateId }, apiKey);
  if (!d.issueUpdate || !d.issueUpdate.success) throw new Error('issueUpdate failed');
  return d.issueUpdate.issue;
}

// Fail-open recipe. `steps` are numbered, human-doable actions that accomplish
// the same thing in the Linear UI / terminal; `cause` is the underlying error
// (a raw GraphQL / network message) surfaced as a final `cause:` line — never a
// bare error dump instead of steps.
class RecipeError extends Error {
  constructor(message, steps, cause) {
    super(message);
    this.name = 'RecipeError';
    this.recipe = steps || [];
    this.cause = cause || null;
  }
}
function printRecipe(message, steps, out, cause) {
  const w = out || process.stdout;
  w.write(`\nMANUAL RECIPE: ${message}\n`);
  steps.forEach((s, i) => w.write(`  ${i + 1}. ${s}\n`));
  if (cause) w.write(`  cause: ${String(cause)}\n`);
  w.write('\n');
}

// Verbs. Each returns { code, out } where out lines are collected; a thin main() prints them.
// Verbs throw RecipeError to trigger the fail-open recipe + exit 2.

async function verbSync(ctx) {
  const { teamKey, apiKey, sessionId, hook, out, now } = ctx;
  const viewer = await safeViewer(apiKey); // sync tolerates viewer failure (name only affects @you)
  const { cache, error } = await ensureCache(teamKey, apiKey, now.getTime());
  if (error) {
    // We fell back to stale cache because the refetch failed. Record the failure
    // explicitly (ok:false + fetchError) so events.jsonl shows the degraded read.
    logEvent({ cmd: 'sync', args: ['stale'], sessionId, ok: false, ms: 0, fetchError: error.message });
  }
  if (!cache) {
    // no cache at all and refetch failed → nothing to show; in hook mode stay silent
    if (!hook) out.write('switchboard: no data (Linear unreachable, no cache)\n');
    return { code: 0 };
  }
  const cursor = readCursor(sessionId);
  const sinceTs = cursor.lastSeenTs || new Date(now.getTime() - FIRST_LOOK_WINDOW_MS).toISOString();
  const items = buildDeltaItems(cache, sinceTs, viewer || (cache && cache.viewer));
  const digest = renderDigest(cache, items, now, readOwnership());
  // advance cursor to newest item ts (or now) so we don't repeat
  const newest = items.length ? new Date(Math.max(...items.map((i) => i.ts))).toISOString() : cursor.lastSeenTs;
  writeCursor(sessionId, { lastSeenTs: newest || new Date(now.getTime()).toISOString(), lastInjectTs: cursor.lastInjectTs });
  if (hook) {
    if (digest) {
      out.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: digest },
      }) + '\n');
    }
    return { code: 0 };
  }
  if (digest) out.write(digest + '\n');
  else if (error) out.write(`switchboard: serving stale cache (${Math.round(cacheAgeMs(cache, now.getTime()) / 1000)}s) — ${error.message}\n`);
  return { code: 0 };
}

async function safeViewer(apiKey) {
  try { return await getViewer(apiKey); } catch (_) { return null; }
}

async function verbClaim(ctx) {
  const { teamKey, apiKey, args, sessionId, out, cwd } = ctx;
  const key = args._[1];
  const files = (typeof args.files === 'string' ? args.files : '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!key) throw new RecipeError('claim needs an issue key', ['Usage: swb claim <KEY> --files <g1,g2>']);
  const recipe = [
    `Open Linear and assign yourself to ${key}`,
    `Move ${key} to "In Progress"`,
    `git worktree add ../switchboard-wt/${key} -b ${key}`,
    `Post a comment on ${key}: "claiming ${key}; files: ${files.join(', ') || '(none)'}"`,
  ];
  try {
    const viewer = await getViewer(apiKey);
    const issue = await findIssueByKey(teamKey, key, apiKey);
    // refuse if assigned to someone else
    if (issue.assignee && issue.assignee.id && issue.assignee.id !== viewer.id) {
      throw new RecipeError(
        `${key} already assigned to ${issue.assignee.name}`,
        [`${key} is held by ${issue.assignee.name}. Coordinate before claiming, or ask them to release.`]
      );
    }
    const { stateId } = await getStateIdByName(teamKey, 'In Progress', apiKey);
    await setAssigneeAndState(issue.id, viewer.id, stateId, apiKey);
    // verify-after-write race protocol (delay overridable for tests, default 1500ms).
    // Recheck by ID: the filtered search index lags writes by many seconds, and
    // trusting it here produced false "race lost" back-offs on tickets we owned.
    await sleep(ctx.claimDelayMs == null ? CLAIM_VERIFY_DELAY_MS : ctx.claimDelayMs);
    const recheck = await getIssueById(issue.id, apiKey);
    if (!recheck.assignee || recheck.assignee.id !== viewer.id) {
      out.write(`\n⚠ claim race lost: ${key} is now assigned to ${recheck.assignee ? recheck.assignee.name : 'someone else'}. Backing off.\n`);
      return { code: 3 };
    }
    // worktree (skip with warning if not a git repo). Record its ABSOLUTE path —
    // verbDone aims the test gate at it regardless of where done is invoked
    // (live tour finding: gate once tested whatever cwd it was run from).
    let worktreeAbs = '';
    if (inGitRepo(cwd)) {
      const wt = path.join('..', 'switchboard-wt', key);
      const r = git(['worktree', 'add', wt, '-b', key], { cwd });
      if (r.code !== 0) out.write(`⚠ worktree add failed (continuing): ${r.stderr.trim() || r.stdout.trim()}\n`);
      else { worktreeAbs = path.resolve(cwd, wt); out.write(`worktree: ${wt} (branch ${key})\n`); }
    } else {
      out.write('⚠ not in a git repo — skipping worktree creation\n');
    }
    // Board-visible agent attribution: label the issue with the harness that
    // claimed it (claude / codex / agent). The signed comment is the audit trail;
    // the label is the at-a-glance chip judges and PMs see on every board row.
    try {
      const labelId = await ensureLabel(issue.team.id, harnessName(), apiKey);
      const existing = (issue.labels && issue.labels.nodes ? issue.labels.nodes : []).map((l) => l.id);
      if (!existing.includes(labelId)) {
        await linear(
          `mutation($id: String!, $labelIds: [String!]) { issueUpdate(id: $id, input: { labelIds: $labelIds }) { success } }`,
          { id: issue.id, labelIds: [...existing, labelId] }, apiKey
        );
      }
    } catch (_) { /* labeling is best-effort — never fail a claim over a chip */ }
    // ownership.json
    const own = readOwnership();
    own[key] = { files, assignee: viewer.name, sessionId, ts: new Date().toISOString(), worktree: worktreeAbs || undefined };
    writeOwnership(own);
    // claim comment listing files
    await postComment(issue.id, `Claimed ${key}${args.approved ? ' (human-approved)' : ''}. Files: ${files.length ? files.join(', ') : '(none declared)'}`, viewer.name, apiKey);
    out.write(`✔ claimed ${key} → ${viewer.name} · In Progress · files: ${files.join(', ') || '(none)'}\n`);
    // Print the FULL ticket at the moment of claiming: the description is the
    // work spec, and an agent must never start building from the title alone.
    out.write(`\n── ${key} ${issue.title || ''} ──\n`);
    if (issue.description) out.write(`${issue.description}\n`);
    else out.write(`(no description — ask the ticket author or the PM what the acceptance criteria are BEFORE building)\n`);
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError(`could not claim ${key} — claim it by hand:`, recipe, err.message);
  }
}

async function verbDone(ctx) {
  const { teamKey, apiKey, args, out, cwd, repo } = ctx;
  const key = args._[1];
  if (!key) throw new RecipeError('done needs an issue key', ['Usage: swb done <KEY> --pr <url>']);
  const recipe = [
    `Ensure tests pass in the ticket's worktree: ${repo.testCommand}`,
    `Open the PR for ${key} and copy its URL`,
    `Move ${key} to "In Review" in Linear`,
    `Post a summary comment on ${key} describing what changed`,
  ];
  // (1) test gate — run first, refuse on non-zero. The gate ALWAYS aims at the
  // ticket's worktree when one was recorded at claim time: that is where the
  // work lives. Testing the invocation cwd let a passing base repo vouch for a
  // broken worktree (caught live in the first user tour).
  const ownEntry = readOwnership()[key];
  const gateCwd = ownEntry && ownEntry.worktree && fs.existsSync(ownEntry.worktree) ? ownEntry.worktree : cwd;
  const gateRepo = gateCwd === cwd ? repo : loadRepoConfig(gateCwd);
  out.write(`▶ test gate runs in: ${gateCwd}\n`);
  const testResult = runTestCommand(gateRepo.testCommand, gateCwd, out);
  if (testResult.code !== 0) {
    out.write(`\n✖ ${key}: tests failed (exit ${testResult.code}) — refusing to mark done.\n`);
    throw new RecipeError(`tests failed for ${key} (exit ${testResult.code})`, recipe);
  }
  // (2) require --pr (must be an actual URL string, not a bare flag)
  const prUrl = typeof args.pr === 'string' ? args.pr : '';
  if (!prUrl) {
    throw new RecipeError(`done requires --pr <url> for ${key}`, recipe);
  }
  try {
    const viewer = await getViewer(apiKey);
    const issue = await findIssueByKey(teamKey, key, apiKey);
    // (3) move In Review
    const { stateId } = await getStateIdByName(teamKey, 'In Review', apiKey);
    await setAssigneeAndState(issue.id, issue.assignee ? issue.assignee.id : viewer.id, stateId, apiKey);
    // (4) summary comment (arg or generated from git log -5 --oneline)
    let summary = typeof args.summary === 'string' ? args.summary : '';
    if (!summary) {
      const log = gitLogSummary(gateCwd, 5); // the worktree's commits ARE the work
      summary = log ? `Recent commits:\n${log}` : 'Work completed.';
    }
    await postComment(issue.id, `Done → In Review. PR: ${prUrl}\n\n${summary}`, viewer.name, apiKey);
    // (5) remove ownership entry
    const own = readOwnership();
    if (own[key]) { delete own[key]; writeOwnership(own); }
    out.write(`✔ ${key} → In Review · PR ${prUrl}\n`);
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError(`could not mark ${key} done — finish it by hand:`, recipe, err.message);
  }
}

async function verbAsk(ctx) {
  const { teamKey, apiKey, args, out } = ctx;
  const key = args._[1];
  const mention = args._[2];
  const question = args._[3];
  if (!key || !mention || !question) {
    throw new RecipeError('ask needs <KEY> <@user> "<question>"', ['Usage: swb ask <KEY> @user "question"']);
  }
  const recipe = [
    `Open ${key} in Linear`,
    `Post a comment mentioning ${mention}: "${question}"`,
  ];
  try {
    const viewer = await getViewer(apiKey);
    const issue = await findIssueByKey(teamKey, key, apiKey);
    // Canonicalize the @target against the team's members so the digest's @you
    // matcher (built from displayName / first name / full name) always surfaces
    // it. A caller may type @Turni while the member's displayName is turni.saha.
    const members = await getTeamMembers(teamKey, apiKey);
    const match = matchMember(mention, members);
    let handle;
    if (match) {
      const canonical = `@${match.displayName}`;
      const typed = String(mention || '').replace(/^@+/, '').trim();
      // Keep the human-typed form after the canonical handle when they differ, so
      // the reader still sees what was originally written: "@turni.saha (Turni)".
      handle = typed && typed.toLowerCase() !== String(match.displayName).toLowerCase()
        ? `${canonical} (${typed})`
        : canonical;
    } else {
      // No member matched — keep the raw text but WARN with the valid handles so
      // the caller can retry (@you would otherwise silently never fire).
      handle = mention;
      const valid = members.map((m) => `@${m.displayName}`).join(', ') || '(no members found)';
      out.write(`⚠ "${mention}" matched no team member — posting the raw mention. Valid handles: ${valid}\n`);
    }
    const body = `${handle} ${question}`;
    await postComment(issue.id, body, viewer.name, apiKey);
    out.write(`✔ asked on ${key}: ${handle} ${trunc(question, 80)}\n`);
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError(`could not post the question on ${key} — ask by hand:`, recipe, err.message);
  }
}

async function verbDiscover(ctx) {
  const { teamKey, apiKey, args, out, cwd } = ctx;
  const text = args._[1];
  if (!text) throw new RecipeError('discover needs "<text>"', ['Usage: swb discover "finding"']);
  const recipe = [
    `Append the finding to ${path.join(cwd, 'DISCOVERIES.md')}`,
    "Open (or create) the pinned 'Discoveries' issue in Linear and add the label swb-meta",
    `Post a comment on it: "${trunc(text, 80)}"`,
  ];
  try {
    const viewer = await getViewer(apiKey);
    // append to repo DISCOVERIES.md
    const discFile = path.join(cwd, 'DISCOVERIES.md');
    const stamp = new Date().toISOString();
    const entry = `- ${stamp} — ${text} (${viewer.name})\n`;
    let header = '';
    if (!fs.existsSync(discFile)) header = '# Discoveries\n\n';
    fs.appendFileSync(discFile, header + entry);
    // pinned 'Discoveries' issue (label swb-meta), create on first use
    const issue = await ensureDiscoveriesIssue(teamKey, apiKey);
    await postComment(issue.id, text, viewer.name, apiKey);
    out.write(`✔ discovery recorded → DISCOVERIES.md + ${issue.identifier}\n`);
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError('could not record the discovery in Linear — do it by hand:', recipe, err.message);
  }
}

async function ensureLabel(teamId, name, apiKey) {
  // team(id:) takes String! (iter-2 P0 — ID! is rejected by Linear).
  const q = `query($teamId: String!) { team(id: $teamId) { labels(first: 100) { nodes { id name } } } }`;
  const d = await linear(q, { teamId }, apiKey);
  const existing = (d.team.labels.nodes || []).find((l) => l.name === name);
  if (existing) return existing.id;
  const m = `mutation($teamId: String!, $name: String!) {
    issueLabelCreate(input: { teamId: $teamId, name: $name }) { success issueLabel { id } } }`;
  const r = await linear(m, { teamId, name }, apiKey);
  return r.issueLabelCreate.issueLabel.id;
}
async function ensureDiscoveriesIssue(teamKey, apiKey) {
  const team = await getTeamByKey(teamKey, apiKey);
  const labelId = await ensureLabel(team.id, 'swb-meta', apiKey);
  // find an existing 'Discoveries' issue with the label
  const q = `query { issues(filter: { title: { eq: "Discoveries" } }, first: 10) {
    nodes { id identifier team { key } labels { nodes { name } } } } }`;
  const d = await linear(q, {}, apiKey);
  const found = (d.issues.nodes || []).find(
    (n) => n.team && n.team.key === teamKey && (n.labels.nodes || []).some((l) => l.name === 'swb-meta')
  );
  if (found) return found;
  const m = `mutation($teamId: String!, $labelId: String!) {
    issueCreate(input: { teamId: $teamId, title: "Discoveries", description: "Pinned thread for swb discoveries.", labelIds: [$labelId] }) {
      success issue { id identifier } } }`;
  const r = await linear(m, { teamId: team.id, labelId }, apiKey);
  return r.issueCreate.issue;
}

async function verbNew(ctx) {
  const { teamKey, apiKey, args, out } = ctx;
  const title = args._[1];
  if (!title) throw new RecipeError('new needs "<title>"', ['Usage: swb new "title" [--body "..."]']);
  const recipe = [
    `Create an issue titled "${title}" in team ${teamKey}`,
    'Set its state to Backlog',
    args.body ? `Set description: ${args.body}` : 'Leave description empty',
  ];
  try {
    const { stateId, teamId } = await getStateIdByName(teamKey, 'Backlog', apiKey);
    const m = `mutation($teamId: String!, $title: String!, $desc: String, $stateId: String!) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $desc, stateId: $stateId }) {
        success issue { id identifier url state { name } } } }`;
    const desc = typeof args.body === 'string' ? args.body : null;
    const d = await linear(m, { teamId, title, desc, stateId }, apiKey);
    if (!d.issueCreate || !d.issueCreate.success) throw new Error('issueCreate failed');
    const iss = d.issueCreate.issue;
    // Print the URL and the Linear-native state so the
    // board shows — first-install users once looked
    // for a group named 'Triage' that didn't exist on their board. And print the
    // URL: "open Linear and find it" is a scavenger hunt; a link is not.
    out.write(`✔ created ${iss.identifier} "${trunc(title, 60)}" [Backlog]\n`);
    if (iss.url) out.write(`  ${iss.url}\n`);
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError(`could not create the issue — create it by hand:`, recipe, err.message);
  }
}

// Full-board snapshot, grouped by state: the "what is everyone doing right now"
// panorama. The digest deliberately shows only DELTAS since your last look;
// board is the complement — the whole picture on demand. Read-only, serves the
// cache (refetching if stale) so it costs at most one API round-trip.
const BOARD_STATE_ORDER = ['In Progress', 'In Review', 'Todo', 'Backlog', 'Done'];
async function verbBoard(ctx) {
  const { teamKey, apiKey, out, now } = ctx;
  const { cache, error } = await ensureCache(teamKey, apiKey, now.getTime());
  if (!cache) {
    throw new RecipeError('no board data (Linear unreachable, no cache)', [
      `Open Linear → team ${teamKey} board to view it by hand.`,
    ], error && error.message);
  }
  const age = Math.round(cacheAgeMs(cache, now.getTime()) / 1000);
  out.write(`── ${teamKey} board · cache ${age}s${error ? ' (STALE — refetch failed)' : ''} ──\n`);
  const byState = new Map();
  for (const iss of cache.issues || []) {
    const st = iss.state || '(unknown)';
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(iss);
  }
  const states = [...BOARD_STATE_ORDER.filter((s) => byState.has(s)), ...[...byState.keys()].filter((s) => !BOARD_STATE_ORDER.includes(s))];
  if (!states.length) out.write('  (no issues)\n');
  for (const st of states) {
    const rows = byState.get(st);
    out.write(`${st} (${rows.length})\n`);
    for (const iss of rows) {
      out.write(`  ${iss.key}  ${trunc(iss.title, 48).padEnd(50)} ${iss.assignee ? '→ ' + iss.assignee : ''}\n`);
    }
  }
  out.write('──\n');
  return { code: 0 };
}

// List the team's active members: @handle + full name. Read-only. Exists so a
// human (or the /swb-tour guide) can resolve "Pat" to the exact Linear identity
// ("Patrick Hohol" / @pat.hohol) that digest lines and @you matching key off.
async function verbMembers(ctx) {
  const { teamKey, apiKey, out } = ctx;
  try {
    const members = await getTeamMembers(teamKey, apiKey);
    if (!members.length) { out.write(`no active members found on team ${teamKey}\n`); return { code: 0 }; }
    const pad = Math.max(...members.map((m) => String(m.displayName || '').length)) + 2;
    out.write(`team ${teamKey} — ${members.length} members (@handle → full name):\n`);
    for (const m of members) {
      out.write(`  @${String(m.displayName || '').padEnd(pad)} ${m.name || ''}\n`);
    }
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError('could not list team members', [
      `Open Linear → your team ${teamKey} → Members to read the list by hand.`,
    ], err.message);
  }
}

async function verbShow(ctx) {
  const { teamKey, apiKey, args, out } = ctx;
  const key = args._[1];
  if (!key) throw new RecipeError('show needs an issue key', ['Usage: swb show <KEY>']);
  // IssueFilter has no `identifier` field — filter on number + team.key (iter-2 P0).
  const { teamKey: keyTeam, number } = parseIssueKey(key);
  const q = `query($number: Float!, $teamKey: String!) {
    issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }, first: 1) {
      nodes {
        identifier title description team { key }
        state { name } assignee { name }
        labels { nodes { name } }
        comments(first: 30) { nodes { body createdAt user { name } } }
      } } }`;
  const d = await linear(q, { number, teamKey: keyTeam }, apiKey);
  const iss = d.issues && d.issues.nodes && d.issues.nodes[0];
  if (!iss) throw new RecipeError(`Issue ${key} not found`, [`Open ${key} in Linear directly`]);
  out.write(`${iss.identifier}  ${iss.title}\n`);
  out.write(`state: ${swbStateName(iss.state && iss.state.name)}   assignee: ${iss.assignee ? iss.assignee.name : '(unassigned)'}\n`);
  const labels = (iss.labels.nodes || []).map((l) => l.name);
  if (labels.length) out.write(`labels: ${labels.join(', ')}\n`);
  if (iss.description) out.write(`\n${iss.description}\n`);
  const comments = iss.comments.nodes || [];
  if (comments.length) {
    out.write('\ncomments:\n');
    for (const c of comments) {
      out.write(`  • ${c.user ? c.user.name : '?'} (${c.createdAt}):\n    ${String(c.body).replace(/\n/g, '\n    ')}\n`);
    }
  }
  return { code: 0 };
}

async function verbRelease(ctx) {
  const { teamKey, apiKey, args, out } = ctx;
  const key = args._[1];
  if (!key) throw new RecipeError('release needs an issue key', ['Usage: swb release <KEY>']);
  const recipe = [
    `Unassign yourself from ${key} in Linear (or leave assignee, your call)`,
    `Remove ${key} from ~/.switchboard/ownership.json`,
    'Keep the branch/worktree (release does not delete it)',
  ];
  try {
    const viewer = await getViewer(apiKey);
    const issue = await findIssueByKey(teamKey, key, apiKey);
    // free the assignee AND send it back to Ready — an unassigned "In Progress"
    // ticket is a lie on the board (seen live: nobody owns it, nobody can grab it).
    const { stateId } = await getStateIdByName(teamKey, 'Todo', apiKey);
    const q = `mutation($id: String!, $stateId: String) {
      issueUpdate(id: $id, input: { assigneeId: null, stateId: $stateId }) { success } }`;
    await linear(q, { id: issue.id, stateId }, apiKey);
    const own = readOwnership();
    if (own[key]) { delete own[key]; writeOwnership(own); }
    await postComment(issue.id, `Released ${key}. File ownership freed; branch kept.`, viewer.name, apiKey);
    out.write(`✔ released ${key} (branch kept)\n`);
    return { code: 0 };
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError(`could not release ${key} — release it by hand:`, recipe, err.message);
  }
}

async function verbDoctor(ctx) {
  const { teamKey, apiKey, args, out } = ctx;
  const fix = !!args.fix;
  let allOk = true;
  out.write('swb doctor\n');
  // API key
  const env = loadEnv();
  if (!env.LINEAR_API_KEY) { out.write('  ✖ LINEAR_API_KEY missing (set in ~/.switchboard/env)\n'); allOk = false; }
  else out.write('  ✔ LINEAR_API_KEY present\n');
  // team resolution
  if (!teamKey) { out.write('  ✖ team not resolved (.swb.json teamKey or SWB_TEAM_KEY)\n'); return { code: 2 }; }
  out.write(`  ✔ team resolved: ${teamKey}\n`);
  let viewer = null;
  try {
    viewer = await getViewer(apiKey);
    out.write(`  ✔ API reachable — viewer: ${viewer.name}\n`);
  } catch (err) {
    out.write(`  ✖ Linear API unreachable: ${err.message}\n`);
    return { code: 2 };
  }
  let team;
  try {
    team = await getTeamByKey(teamKey, apiKey);
    out.write(`  ✔ team found: ${team.key} (${team.name})\n`);
  } catch (err) {
    out.write(`  ✖ ${err.message}\n`);
    return { code: 2 };
  }
  // verify the five workflow states
  const present = new Set((team.states.nodes || []).map((s) => s.name));
  const missing = [];
  for (const swbName of REQUIRED_STATES) {
    const linName = STATE_MAP[swbName];
    if (present.has(linName)) out.write(`  ✔ state ${swbName} → "${linName}" exists\n`);
    else { out.write(`  ✖ state ${swbName} → "${linName}" MISSING\n`); missing.push(swbName); allOk = false; }
  }
  if (missing.length && fix) {
    for (const swbName of missing) {
      const linName = STATE_MAP[swbName];
      try {
        const m = `mutation($teamId: String!, $name: String!, $type: String!) {
          workflowStateCreate(input: { teamId: $teamId, name: $name, type: $type, color: "#95a2b3" }) {
            success workflowState { id name } } }`;
        await linear(m, { teamId: team.id, name: linName, type: STATE_TYPE[swbName] }, apiKey);
        out.write(`  ✔ created missing state "${linName}" (${swbName})\n`);
      } catch (err) {
        out.write(`  ✖ failed to create "${linName}": ${err.message}\n`);
      }
    }
    // re-verify
    const team2 = await getTeamByKey(teamKey, apiKey);
    const present2 = new Set((team2.states.nodes || []).map((s) => s.name));
    allOk = REQUIRED_STATES.every((s) => present2.has(STATE_MAP[s]));
  } else if (missing.length) {
    out.write(`  → run "swb doctor --fix" to create: ${missing.map((s) => STATE_MAP[s]).join(', ')}\n`);
  }
  out.write(allOk ? '  ✔ doctor: all green\n' : '  ✖ doctor: issues found (see above)\n');
  return { code: allOk ? 0 : 2 };
}

function runTestCommand(cmd, cwd, out) {
  const parts = tokenize(cmd);
  const bin = parts[0];
  const rest = parts.slice(1);
  out.write(`\n▶ running test gate: ${cmd}\n`);
  // Stream output straight through (stdio: 'inherit') per the contract's "stream
  // output" requirement. This also avoids spawnSync's default 1 MiB maxBuffer,
  // which would otherwise raise ENOBUFS and mis-report a PASSING suite that
  // prints a lot as a failure.
  const r = spawnSync(bin, rest, { cwd, stdio: 'inherit' });
  // With inherited stdio the only failure that yields an `error` is the binary
  // not being spawnable (e.g. ENOENT) — a real, non-zero condition.
  if (r.error) { out.write(`  (could not run test command: ${r.error.message})\n`); return { code: 1 }; }
  return { code: r.status == null ? 1 : r.status };
}
// minimal shell-free tokenizer for testCommand (handles simple quoted args)
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s))) !== null) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Arg parsing
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hook') { args.hook = true; continue; }
    if (a === '--fix') { args.fix = true; continue; }
    // Gate-2 handshake: appended by the agent ONLY after its human said yes in
    // the conversation (the pretooluse hook denies claim/done without it).
    if (a === '--approved') { args.approved = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[name] = true; }
      else { args[name] = next; i++; }
      continue;
    }
    args._.push(a);
  }
  return args;
}

// Dispatch
const READ_VERBS = new Set(['sync', 'show', 'doctor', 'members', 'board']);

async function run(argv, options) {
  const opts = options || {};
  const out = opts.out || process.stdout;
  const cwd = opts.cwd || process.cwd();
  const now = opts.now || new Date();
  const args = parseArgs(argv);
  const cmd = args._[0];
  const t0 = Date.now();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out.write(usage());
    return 0;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    out.write(`swb v${VERSION}\n`);
    return 0;
  }

  const env = loadEnv();
  const apiKey = opts.apiKey || env.LINEAR_API_KEY;
  const repo = loadRepoConfig(cwd);
  const teamKey = repo.teamKey || env.SWB_TEAM_KEY || '';
  const sessionId = args.session || opts.sessionId || 'default';

  // Refuse to run without a resolved team (doctor still reports it, but needs team to do anything).
  if (!teamKey && cmd !== 'doctor') {
    out.write('swb: no team resolved. Set "teamKey" in .swb.json or SWB_TEAM_KEY in ~/.switchboard/env.\n');
    logEvent({ cmd, args: args._, sessionId, ok: false, ms: Date.now() - t0, error: 'no-team' });
    return 2;
  }

  const ctx = { teamKey, apiKey, args, sessionId, hook: !!args.hook, out, now, cwd, repo, claimDelayMs: opts.claimDelayMs };
  const verbs = {
    sync: verbSync, claim: verbClaim, done: verbDone, ask: verbAsk,
    discover: verbDiscover, new: verbNew, show: verbShow, release: verbRelease, doctor: verbDoctor, members: verbMembers, board: verbBoard,
  };
  const fn = verbs[cmd];
  if (!fn) {
    out.write(`swb: unknown command "${cmd}"\n\n` + usage());
    logEvent({ cmd, args: args._, sessionId, ok: false, ms: Date.now() - t0, error: 'unknown-command' });
    return 2;
  }

  try {
    const result = await fn(ctx);
    const code = result && typeof result.code === 'number' ? result.code : 0;
    logEvent({ cmd, args: args._, sessionId, ok: code === 0, ms: Date.now() - t0, error: code === 3 ? 'claim-lost-race' : undefined });
    return code;
  } catch (err) {
    if (err instanceof RecipeError) {
      printRecipe(err.message, err.recipe, out, err.cause);
      logEvent({ cmd, args: args._, sessionId, ok: false, ms: Date.now() - t0, error: 'recipe:' + err.message, cause: err.cause || undefined });
      return 2;
    }
    // Any other error is still fail-open: generic recipe with the raw error as cause.
    printRecipe('this action failed — do it manually in the Linear UI:', ['Open Linear and perform the action by hand.'], out, err.message || String(err));
    logEvent({ cmd, args: args._, sessionId, ok: false, ms: Date.now() - t0, error: String(err && err.message || err) });
    return 2;
  }
}

function usage() {
  return [
    `swb v${VERSION} — Switchboard CLI`,
    '',
    'Usage:',
    '  swb sync [--session <id>] [--hook]',
    '  swb claim <KEY> --files <g1,g2> [--session <id>]',
    '  swb done <KEY> --pr <url> [--summary "<text>"]',
    '  swb ask <KEY> <@user> "<question>"',
    '  swb discover "<text>"',
    '  swb new "<title>" [--body "<b>"]',
    '  swb show <KEY>',
    '  swb members',
    '  swb board',
    '  swb release <KEY>',
    '  swb doctor [--fix]',
    '',
  ].join('\n');
}

// Seam for the hook pack (single source of truth). Pure/offline: reads the cache
// and cursor already on disk, builds+renders the digest, advances the cursor.
// Returns { text, hasItems, wroteCursor }. Never throws (fail-open for hooks).
function hookDigest(opts) {
  const o = opts || {};
  const sessionId = o.sessionId || 'default';
  const now = o.now || new Date();
  try {
    const cache = readCache();
    if (!cache) return { text: '', hasItems: false, wroteCursor: false };
    // cache.viewer is the v2 object {name, displayName} — pass the WHOLE identity
    // through so self-suppression can match both the handle and the full name.
    const viewerName = o.viewerName || (cache && cache.viewer) || process.env.SWB_VIEWER || '';
    const cursor = readCursor(sessionId);
    const hdNow = o.now ? new Date(o.now).getTime() : Date.now();
    const hdSince = cursor.lastSeenTs || new Date(hdNow - FIRST_LOOK_WINDOW_MS).toISOString();
    const items = buildDeltaItems(cache, hdSince, viewerName);
    const text = renderDigest(cache, items, now, readOwnership());
    let wroteCursor = false;
    if (items.length) {
      const newest = new Date(Math.max(...items.map((i) => i.ts))).toISOString();
      writeCursor(sessionId, { lastSeenTs: newest, lastInjectTs: cursor.lastInjectTs });
      wroteCursor = true;
    }
    return { text, hasItems: items.length > 0, wroteCursor };
  } catch (_) {
    return { text: '', hasItems: false, wroteCursor: false };
  }
}

// Refetch the team's cache only when stale. Best-effort; swallows errors (serve-stale).
async function refetchIfStale(opts) {
  const o = opts || {};
  try {
    const teamKey = resolveTeamKey(o.cwd);
    if (!teamKey) return false;
    const cache = readCache();
    const max = o.maxAgeMs == null ? CACHE_STALE_MS : o.maxAgeMs;
    if (cache && cache.teamKey === teamKey && cacheAgeMs(cache, Date.now()) <= max) return false;
    await refreshCache(teamKey, loadEnv().LINEAR_API_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

// Entry point — only when executed directly (never on require)
if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => { process.stderr.write(String(err && err.stack || err) + '\n'); process.exit(2); });
}

// Exports for tests / hooks (importing this file runs nothing)
module.exports = {
  VERSION, LINEAR_URL, STATE_MAP, STATE_TYPE, REQUIRED_STATES,
  CACHE_STALE_MS, CLAIM_VERIFY_DELAY_MS, CALL_TIMEOUT_MS,
  // core
  run, parseArgs, usage,
  // config
  paths, homeDir, loadEnv, parseEnvFile, loadRepoConfig, resolveTeamKey,
  // cache/state
  readCache, writeCache, cacheAgeMs, isStale, ensureCache, refreshCache, fetchTeamState,
  readOwnership, writeOwnership, readCursor, writeCursor,
  logEvent,
  // linear
  linear, getViewer, getTeamByKey, getTeamMembers, findIssueByKey, getIssueById, postComment, signComment,
  // mentions
  matchMember, viewerHandleTokens, mentionRegexesFor, bodyMentionsViewer,
  // digest
  buildDeltaItems, renderDigest, swbStateName, trunc, fmtTime, claimLine, viewerNameOf, viewerIdentityTokens, parseIssueKey,
  // recipe
  RecipeError, printRecipe,
  // hook seam
  hookDigest, refetchIfStale,
  // verbs (for direct unit testing)
  verbSync, verbClaim, verbDone, verbAsk, verbDiscover, verbNew, verbShow, verbRelease, verbDoctor, verbMembers, verbBoard,
};
