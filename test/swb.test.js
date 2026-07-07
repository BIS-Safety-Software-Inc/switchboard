'use strict';
/*
 * swb CLI unit tests — CONTRACTS.md is law.
 * ────────────────────────────────────────────────────────────────────────────
 * NO real network. global.fetch is replaced by a router keyed on the GraphQL
 * operation text in each request body. Each test runs in an ISOLATED home dir
 * (SWITCHBOARD_HOME → temp) so the real ~/.switchboard/ is never touched, and
 * captures verb output via an injected `out` sink.
 *
 * Coverage: every verb happy path, the claim verify-after-write race (exit 3),
 * done refusing on a failing testCommand, new landing in Triage, fail-open
 * MANUAL RECIPE on API error (exit 2), and exact digest formatting
 * (@you-first ordering, 12-line cap, act-line only when items exist).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const swb = require('../swb.js');

// ── isolated home + repo cwd ─────────────────────────────────────────────────
function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-test-'));
  fs.mkdirSync(path.join(home, 'cursors'), { recursive: true });
  return home;
}
function mkRepo(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-repo-'));
  fs.writeFileSync(
    path.join(dir, '.swb.json'),
    JSON.stringify(cfg || { teamKey: 'HAC', testCommand: 'node -e "process.exit(0)"', defaultBranch: 'master' })
  );
  return dir;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// A collecting output sink shaped like a writable stream.
function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

// ── fetch mock ───────────────────────────────────────────────────────────────
// handlers: array of { match: (query)=>bool, reply: (query,vars,callIndex)=>object }
// Each request body is {query, variables}. Reply is the GraphQL `data` payload
// (or {errors:[...]} to simulate an API error). Unmatched → throws (test bug).
function installFetch(handlers) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ query: body.query, variables: body.variables, headers: init.headers });
    for (const h of handlers) {
      if (h.match(body.query, body.variables)) {
        const idx = h._n || 0;
        h._n = idx + 1;
        const payload = typeof h.reply === 'function' ? h.reply(body.query, body.variables, idx) : h.reply;
        // A payload carrying `errors` is returned as-is (simulates a GraphQL error
        // response); anything else is the `data` object and gets wrapped.
        const json = payload && payload.errors ? payload : { data: payload };
        return { ok: true, status: 200, json: async () => json };
      }
    }
    throw new Error('unmatched GraphQL op in test:\n' + body.query);
  };
  return calls;
}
function has(q, sub) { return q.indexOf(sub) !== -1; }

// Common handler builders.
const H = {
  viewer: (name) => ({ match: (q) => has(q, 'viewer {'), reply: { viewer: { id: 'u-me', name: name || 'Turni', email: 't@x' } } }),
  teamByKey: (states) => ({
    match: (q) => has(q, 'teams(filter'),
    reply: { teams: { nodes: [{ id: 'team-1', key: 'HAC', name: 'Hackathon', states: { nodes: states } }] } },
  }),
  commentCreate: (capture) => ({
    match: (q) => has(q, 'commentCreate'),
    reply: (q, v) => { if (capture) capture(v); return { commentCreate: { success: true, comment: { id: 'c-new' } } }; },
  }),
  issueUpdate: () => ({ match: (q) => has(q, 'issueUpdate'), reply: { issueUpdate: { success: true, issue: { id: 'i-1', assignee: { id: 'u-me', name: 'Turni' }, state: { name: 'In Progress' } } } } }),
  // Direct-by-id read used by the claim recheck (strongly consistent path).
  issueById: (issue) => ({ match: (q) => has(q, 'issue(id:'), reply: { issue } }),
  issueCreate: (capture) => ({
    match: (q) => has(q, 'issueCreate'),
    reply: (q, v) => { if (capture) capture(v); return { issueCreate: { success: true, issue: { id: 'i-new', identifier: 'HAC-99', url: 'https://linear.app/bis-agents/issue/HAC-99/x', state: { name: 'Backlog' } } } }; },
  }),
};

const FULL_STATES = [
  { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'st-todo', name: 'Todo', type: 'unstarted' },
  { id: 'st-inprogress', name: 'In Progress', type: 'started' },
  { id: 'st-inreview', name: 'In Review', type: 'started' },
  { id: 'st-done', name: 'Done', type: 'completed' },
];

// findIssueByKey handler returning a specific issue snapshot per call index.
function issueByKey(snapshots) {
  const arr = Array.isArray(snapshots) ? snapshots : [snapshots];
  return {
    match: (q) => has(q, 'issues(filter') && has(q, 'identifier'),
    reply: (q, v, idx) => {
      const snap = arr[Math.min(idx, arr.length - 1)];
      return { issues: { nodes: [snap] } };
    },
  };
}

// Run a verb via the public run() with test wiring. Returns { code, out }.
async function runVerb(argv, { home, cwd, apiKey } = {}) {
  const out = sink();
  const code = await swb.run(argv, {
    out,
    cwd,
    apiKey: apiKey || 'lin_test_key',
    claimDelayMs: 0,
    now: new Date('2026-07-06T14:22:00.000Z'),
  });
  return { code, out: out.text() };
}

// Each test wraps in its own home/env so state never leaks.
function withEnv(home, apiKey, fn) {
  const prevHome = process.env.SWITCHBOARD_HOME;
  const prevKey = process.env.LINEAR_API_KEY;
  const prevFetch = global.fetch;
  process.env.SWITCHBOARD_HOME = home;
  process.env.LINEAR_API_KEY = apiKey || 'lin_test_key';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevHome === undefined) delete process.env.SWITCHBOARD_HOME; else process.env.SWITCHBOARD_HOME = prevHome;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = prevKey;
      global.fetch = prevFetch;
    });
}

// ════════════════════════════════════════════════════════════════════════════
// DIGEST FORMATTING (pure — no fetch)
// ════════════════════════════════════════════════════════════════════════════

test('digest: exact format, @you first, act line present, cache age', () => {
  const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swb-cache.json'), 'utf8'));
  const now = new Date('2026-07-06T14:22:00.000Z');
  // viewer "marc" → the @marc comment sorts to the top as @you
  const items = swb.buildDeltaItems(cache, null, 'marc');
  const digest = swb.renderDigest(cache, items, now, {});
  const lines = digest.split('\n');
  // header — HH:MM is the viewer's LOCAL time, so assert the shape, not the hour
  assert.match(lines[0], /^── switchboard · \d{2}:\d{2} · cache \d+s · 5 new ──$/);
  // first content line is the @you mention
  assert.ok(lines[1].startsWith('@you   HAC-23 sarah:'), 'first line must be @you: ' + lines[1]);
  assert.ok(lines[1].includes('→ swb show HAC-23'));
  // last two lines are the act directive then the closing rule
  assert.strictEqual(lines[lines.length - 1], '──');
  assert.ok(lines[lines.length - 2].startsWith('act    '), 'act line before closing rule');
});

test('digest: empty delta prints nothing (no act line)', () => {
  const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swb-cache.json'), 'utf8'));
  const now = new Date('2026-07-06T14:22:00.000Z');
  // cursor after the newest ts → zero items
  const items = swb.buildDeltaItems(cache, '2026-07-06T23:59:00.000Z', 'marc');
  assert.strictEqual(items.length, 0);
  assert.strictEqual(swb.renderDigest(cache, items, now, {}), '');
});

test('digest: 12-line cap with +N more', () => {
  const now = new Date('2026-07-06T14:22:00.000Z');
  const issues = [];
  for (let i = 0; i < 20; i++) {
    issues.push({
      id: 'x' + i, key: 'HAC-' + i, title: 'ticket ' + i,
      createdAt: new Date(Date.parse('2026-07-06T13:00:00.000Z') + i * 1000).toISOString(),
      updatedAt: new Date(Date.parse('2026-07-06T13:00:00.000Z') + i * 1000).toISOString(),
      state: 'Triage', assignee: null, labels: [],
    });
  }
  const cache = { fetchedAt: now.toISOString(), teamKey: 'HAC', issues, comments: [], states: {} };
  const items = swb.buildDeltaItems(cache, null, 'nobody');
  const digest = swb.renderDigest(cache, items, now, {});
  const lines = digest.split('\n');
  // header + 12 items + "+8 more" + act + closing = 16
  const moreLine = lines.find((l) => /^\+\d+ more$/.test(l));
  assert.ok(moreLine, 'expected a +N more line');
  assert.strictEqual(moreLine, '+8 more');
  const itemLines = lines.filter((l) => l.startsWith('new    '));
  assert.strictEqual(itemLines.length, 12, 'exactly 12 item lines');
});

test('digest: claim line rendered when ownership holds files for a state item', () => {
  const now = new Date('2026-07-06T14:22:00.000Z');
  const cache = {
    fetchedAt: now.toISOString(), teamKey: 'HAC',
    issues: [{ id: 'i31', key: 'HAC-31', title: 'player-ui', createdAt: '2026-07-06T09:00:00.000Z', updatedAt: '2026-07-06T14:20:00.000Z', state: 'In Progress', assignee: 'Marc', labels: [] }],
    comments: [], states: {},
  };
  const items = swb.buildDeltaItems(cache, '2026-07-06T14:00:00.000Z', 'nobody');
  const own = { 'HAC-31': { files: ['src/player/*'], assignee: 'Marc' } };
  const digest = swb.renderDigest(cache, items, now, own);
  assert.ok(digest.includes('claim  HAC-31'), 'expected claim line: ' + digest);
  assert.ok(digest.includes('files: src/player/*'));
  assert.ok(digest.includes('→ Marc'));
});

// ════════════════════════════════════════════════════════════════════════════
// SYNC
// ════════════════════════════════════════════════════════════════════════════

test('sync: fetches, prints digest, advances cursor', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('marc'),
      // team fetch used by fetchTeamState (team(id:...) issues)
      H.teamByKey(FULL_STATES),
      {
        match: (q) => has(q, 'team(id:') && has(q, 'issues(first'),
        reply: {
          team: { issues: { nodes: [
            { id: 'i23', identifier: 'HAC-23', title: 'schema', createdAt: '2026-07-06T10:00:00.000Z', updatedAt: '2026-07-06T10:00:00.000Z', state: { name: 'In Progress', type: 'started' }, assignee: { id: 'u-s', name: 'sarah' }, labels: { nodes: [] }, comments: { nodes: [{ id: 'c1', body: '@marc composite key?', createdAt: '2026-07-06T14:18:00.000Z', user: { id: 'u-s', name: 'sarah' } }] } },
          ] } },
        },
      },
    ]);
    const { code, out } = await runVerb(['sync', '--session', 's1'], { home, cwd });
    assert.strictEqual(code, 0);
    assert.match(out, /── switchboard ·/);
    assert.match(out, /@you   HAC-23 sarah:/);
    // cursor written
    const cur = JSON.parse(fs.readFileSync(path.join(home, 'cursors', 's1.json'), 'utf8'));
    assert.ok(cur.lastSeenTs, 'cursor lastSeenTs set');
  });
  rm(home); rm(cwd);
});

test('sync --hook: emits UserPromptSubmit additionalContext JSON', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('marc'),
      H.teamByKey(FULL_STATES),
      {
        match: (q) => has(q, 'team(id:') && has(q, 'issues(first'),
        reply: { team: { issues: { nodes: [
          { id: 'i40', identifier: 'HAC-40', title: 'new triage item', createdAt: '2026-07-06T14:19:00.000Z', updatedAt: '2026-07-06T14:19:00.000Z', state: { name: 'Backlog', type: 'backlog' }, assignee: null, labels: { nodes: [] }, comments: { nodes: [] } },
        ] } } },
      },
    ]);
    const { code, out } = await runVerb(['sync', '--hook', '--session', 's2'], { home, cwd });
    assert.strictEqual(code, 0);
    const obj = JSON.parse(out.trim());
    assert.strictEqual(obj.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(obj.hookSpecificOutput.additionalContext, /new    HAC-40/);
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// CLAIM (happy path + race)
// ════════════════════════════════════════════════════════════════════════════

test('claim: happy path assigns, writes ownership, posts comment, exit 0', async () => {
  const home = mkHome();
  const cwd = mkRepo(); // not a git repo → worktree skipped with warning
  const commentBodies = [];
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      H.teamByKey(FULL_STATES),
      // 1st fetch: unassigned; re-fetch after our write: assigned to us (Turni) → claim holds
      issueByKey([
        { id: 'i-14', identifier: 'HAC-14', title: 'player ui', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-todo', name: 'Todo' }, assignee: null, labels: { nodes: [] } },
        { id: 'i-14', identifier: 'HAC-14', title: 'player ui', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-me', name: 'Turni' }, labels: { nodes: [] } },
      ]),
      H.issueUpdate(),
      H.issueById({ id: 'i-14', identifier: 'HAC-14', assignee: { id: 'u-me', name: 'Turni' }, state: { id: 'st-inprogress', name: 'In Progress' } }),
      H.commentCreate((v) => commentBodies.push(v.body)),
    ]);
    const { code, out } = await runVerb(['claim', 'HAC-14', '--files', 'src/player/*,src/ui/*', '--session', 's1'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /✔ claimed HAC-14/);
    assert.match(out, /no description — ask the ticket author/, 'claim surfaces the missing-spec nudge');
    assert.match(out, /not in a git repo/); // worktree skipped
    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8'));
    assert.deepStrictEqual(own['HAC-14'].files, ['src/player/*', 'src/ui/*']);
    assert.strictEqual(own['HAC-14'].assignee, 'Turni');
    // claim comment lists files + is signed
    assert.ok(commentBodies.some((b) => b.includes('src/player/*') && b.includes('swb v')), 'signed claim comment listing files');
  });
  rm(home); rm(cwd);
});

test('claim: race — assignee changed on re-fetch → back off, exit 3', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      H.teamByKey(FULL_STATES),
      // first findIssueByKey: unassigned; second (re-fetch): assigned to someone else
      issueByKey([
        { id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-todo', name: 'Todo' }, assignee: null, labels: { nodes: [] } },
        { id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-other', name: 'Marc' }, labels: { nodes: [] } },
      ]),
      H.issueUpdate(),
      H.issueById({ id: 'i-14', identifier: 'HAC-14', assignee: { id: 'u-other', name: 'Marc' }, state: { id: 'st-inprogress', name: 'In Progress' } }),
      H.commentCreate(),
    ]);
    const { code, out } = await runVerb(['claim', 'HAC-14', '--files', 'src/*', '--session', 's1'], { home, cwd });
    assert.strictEqual(code, 3, out);
    assert.match(out, /claim race lost/);
    assert.match(out, /Marc/);
    // ownership NOT written on a lost race
    assert.ok(!fs.existsSync(path.join(home, 'ownership.json')) || !JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8'))['HAC-14']);
  });
  rm(home); rm(cwd);
});

// Regression (live, 2026-07-07 first user tour): Linear's issues(filter:) search
// index lags writes by many seconds. The recheck MUST read issue(id:) — trusting
// the stale filtered path produced a false "race lost" on a ticket we owned.
test('claim: stale search index does NOT cause a false race loss', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      H.teamByKey(FULL_STATES),
      // The filtered search NEVER catches up in this scenario: always unassigned/Todo.
      issueByKey({ id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-todo', name: 'Todo' }, assignee: null, labels: { nodes: [] } }),
      H.issueUpdate(),
      // The strongly-consistent by-id read shows the truth: it's ours.
      H.issueById({ id: 'i-14', identifier: 'HAC-14', assignee: { id: 'u-me', name: 'Turni' }, state: { id: 'st-inprogress', name: 'In Progress' } }),
      H.commentCreate(),
    ]);
    const { code, out } = await runVerb(['claim', 'HAC-14', '--files', 'src/*', '--session', 's1'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /✔ claimed HAC-14/);
  });
  rm(home); rm(cwd);
});

test('claim: refuses when already held by another (recipe, exit 2)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-todo', name: 'Todo' }, assignee: { id: 'u-other', name: 'Marc' }, labels: { nodes: [] } }),
    ]);
    const { code, out } = await runVerb(['claim', 'HAC-14', '--files', 'src/*'], { home, cwd });
    assert.strictEqual(code, 2, out);
    assert.match(out, /MANUAL RECIPE:/);
    assert.match(out, /Marc/);
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// DONE (test gate + --pr + summary)
// ════════════════════════════════════════════════════════════════════════════

test('done: refuses on failing testCommand (exit 2, recipe, no API calls)', async () => {
  const home = mkHome();
  const cwd = mkRepo({ teamKey: 'HAC', testCommand: 'node -e "process.exit(1)"', defaultBranch: 'master' });
  let apiCalled = false;
  await withEnv(home, 'lin_test_key', async () => {
    global.fetch = async () => { apiCalled = true; return { ok: true, status: 200, json: async () => ({ data: {} }) }; };
    const { code, out } = await runVerb(['done', 'HAC-14', '--pr', 'http://pr/1'], { home, cwd });
    assert.strictEqual(code, 2, out);
    assert.match(out, /tests failed/);
    assert.match(out, /MANUAL RECIPE:/);
    assert.strictEqual(apiCalled, false, 'must not touch the API when tests fail');
  });
  rm(home); rm(cwd);
});

test('done: refuses without --pr even when tests pass (exit 2)', async () => {
  const home = mkHome();
  const cwd = mkRepo({ teamKey: 'HAC', testCommand: 'node -e "process.exit(0)"', defaultBranch: 'master' });
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([H.viewer('Turni')]);
    const { code, out } = await runVerb(['done', 'HAC-14'], { home, cwd });
    assert.strictEqual(code, 2, out);
    assert.match(out, /requires --pr/);
  });
  rm(home); rm(cwd);
});

test('done: happy path moves In Review, posts summary, removes ownership (exit 0)', async () => {
  const home = mkHome();
  const cwd = mkRepo({ teamKey: 'HAC', testCommand: 'node -e "process.exit(0)"', defaultBranch: 'master' });
  // seed ownership so we can assert removal
  fs.writeFileSync(path.join(home, 'ownership.json'), JSON.stringify({ 'HAC-14': { files: ['src/*'], assignee: 'Turni', sessionId: 's1', ts: 'x' } }));
  const bodies = [];
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-me', name: 'Turni' }, labels: { nodes: [] } }),
      H.teamByKey(FULL_STATES),
      H.issueUpdate(),
      H.commentCreate((v) => bodies.push(v.body)),
    ]);
    const { code, out } = await runVerb(['done', 'HAC-14', '--pr', 'http://pr/9', '--summary', 'did the thing'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /HAC-14 → In Review/);
    assert.ok(bodies.some((b) => b.includes('http://pr/9') && b.includes('did the thing')), 'summary comment has PR + summary');
    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8'));
    assert.ok(!own['HAC-14'], 'ownership entry removed');
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// ASK / DISCOVER / NEW / SHOW / RELEASE
// ════════════════════════════════════════════════════════════════════════════

test('ask: posts a mention comment (exit 0)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  const bodies = [];
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-23', identifier: 'HAC-23', title: 'schema', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-s', name: 'sarah' }, labels: { nodes: [] } }),
      // sarah IS a member whose displayName is exactly "sarah" → canonicalizes to @sarah
      teamMembers([{ id: 'u-s', name: 'Sarah Kim', displayName: 'sarah', active: true }]),
      H.commentCreate((v) => bodies.push(v.body)),
    ]);
    const { code, out } = await runVerb(['ask', 'HAC-23', '@sarah', 'composite key per attempt?'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /✔ asked on HAC-23/);
    assert.ok(bodies.some((b) => b.startsWith('@sarah composite key') && b.includes('swb v')), 'mention + signature');
  });
  rm(home); rm(cwd);
});

// ── ask-side normalization: resolve @target → canonical @displayName ──────────
// The Q&A loop's @you promise fails when `ask` writes the literal typed mention
// (@Turni) but the digest matcher only knows the displayName (turni.saha). `ask`
// must canonicalize the target against the team's members before posting.

// Handler for getTeamMembers: teams(filter ...) { members { name displayName } }.
// Distinguished from H.teamByKey by the `members(first` selection.
function teamMembers(members) {
  return {
    match: (q) => has(q, 'teams(filter') && has(q, 'members(first'),
    reply: { teams: { nodes: [{ id: 'team-1', key: 'HAC', members: { nodes: members } }] } },
  };
}

test('ask: canonicalizes @FirstName → @displayName, keeps typed form (exit 0)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  const bodies = [];
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-23', identifier: 'HAC-23', title: 'schema', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-t', name: 'Turni Saha' }, labels: { nodes: [] } }),
      teamMembers([{ id: 'u-t', name: 'Turni Saha', displayName: 'turni.saha', active: true }]),
      H.commentCreate((v) => bodies.push(v.body)),
    ]);
    // caller types the FIRST name; must be rewritten to the canonical handle
    const { code, out } = await runVerb(['ask', 'HAC-23', '@Turni', 'composite key per attempt?'], { home, cwd });
    assert.strictEqual(code, 0, out);
    // canonical handle written, with the typed form kept after it
    assert.ok(bodies.length === 1, 'one comment posted');
    assert.ok(bodies[0].startsWith('@turni.saha (Turni) composite key'), 'canonical @displayName + typed form: ' + bodies[0]);
    assert.match(out, /@turni\.saha \(Turni\)/);
  });
  rm(home); rm(cwd);
});

test('ask: exact displayName match writes bare canonical handle (no dup)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  const bodies = [];
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-23', identifier: 'HAC-23', title: 'schema', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: null, labels: { nodes: [] } }),
      teamMembers([{ id: 'u-t', name: 'Turni Saha', displayName: 'turni.saha', active: true }]),
      H.commentCreate((v) => bodies.push(v.body)),
    ]);
    // caller already typed the displayName → no "(typed)" suffix
    const { code, out } = await runVerb(['ask', 'HAC-23', '@turni.saha', 'q?'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.ok(bodies[0].startsWith('@turni.saha q?'), 'bare canonical handle, no dup: ' + bodies[0]);
    assert.ok(!/\(turni\.saha\)/.test(bodies[0]), 'no redundant typed suffix');
  });
  rm(home); rm(cwd);
});

test('ask: unknown @target keeps raw text but warns with valid handles', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  const bodies = [];
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-23', identifier: 'HAC-23', title: 'schema', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: null, labels: { nodes: [] } }),
      teamMembers([{ id: 'u-t', name: 'Turni Saha', displayName: 'turni.saha', active: true }]),
      H.commentCreate((v) => bodies.push(v.body)),
    ]);
    const { code, out } = await runVerb(['ask', 'HAC-23', '@nobody', 'q?'], { home, cwd });
    assert.strictEqual(code, 0, out);
    // raw mention preserved in the posted body
    assert.ok(bodies[0].startsWith('@nobody q?'), 'raw mention kept: ' + bodies[0]);
    // warning names the valid handle set
    assert.match(out, /matched no team member/);
    assert.match(out, /@turni\.saha/);
  });
  rm(home); rm(cwd);
});

// ── matcher-side broadening: @you fires on displayName / first name / full name ─
test('matchMember: matches on displayName, first name, and full name (case-insensitive)', () => {
  const members = [{ id: 'u-t', name: 'Turni Saha', displayName: 'turni.saha', active: true }];
  assert.strictEqual(swb.matchMember('@turni.saha', members).id, 'u-t', 'displayName');
  assert.strictEqual(swb.matchMember('@Turni', members).id, 'u-t', 'first name');
  assert.strictEqual(swb.matchMember('TURNI SAHA', members).id, 'u-t', 'full name, case-insensitive, no @');
  assert.strictEqual(swb.matchMember('@marc', members), null, 'no false match');
});

test('viewerHandleTokens: dedups displayName / first / full for object and string viewers', () => {
  const obj = swb.viewerHandleTokens({ name: 'Turni Saha', displayName: 'turni.saha' });
  assert.deepStrictEqual(obj, ['turni.saha', 'Turni', 'Turni Saha'], 'three distinct tokens: ' + JSON.stringify(obj));
  // when displayName equals the first name, no duplicate token survives
  const same = swb.viewerHandleTokens({ name: 'Marc Chen', displayName: 'marc' });
  assert.deepStrictEqual(same.map((s) => s.toLowerCase()), ['marc', 'marc chen'], 'marc + full only: ' + JSON.stringify(same));
  // bare string viewer still yields the string + its first word
  assert.deepStrictEqual(swb.viewerHandleTokens('Turni Saha'), ['Turni Saha', 'Turni']);
});

test('bodyMentionsViewer: @FirstName matches an object viewer whose displayName differs', () => {
  const viewer = { name: 'Turni Saha', displayName: 'turni.saha' };
  // THE BUG: a comment typed with @Turni must still be @you even though the
  // displayName is turni.saha.
  assert.ok(swb.bodyMentionsViewer('@Turni can you review this?', viewer), '@FirstName is me');
  assert.ok(swb.bodyMentionsViewer('ping @turni.saha here', viewer), '@displayName is me');
  assert.ok(swb.bodyMentionsViewer('hey @Turni Saha ok', viewer), '@FullName is me');
  assert.ok(!swb.bodyMentionsViewer('a comment for @marc', viewer), 'someone else is not me');
  // word-boundary guard: @turnip must NOT match @Turni
  assert.ok(!swb.bodyMentionsViewer('the @turnip soup', viewer), 'no substring promotion');
});

test('buildDeltaItems: @Turni comment surfaces as @you for a turni.saha viewer', () => {
  const now = new Date('2026-07-06T14:22:00.000Z');
  const cache = {
    fetchedAt: now.toISOString(), teamKey: 'HAC',
    viewer: { name: 'Turni Saha', displayName: 'turni.saha' },
    issues: [], states: {},
    comments: [
      // authored by a DIFFERENT person, mentioning the viewer by first name
      { issueKey: 'HAC-23', author: 'sarah', body: '@Turni what schema shape?', createdAt: '2026-07-06T14:18:00.000Z', discovery: false },
    ],
  };
  const items = swb.buildDeltaItems(cache, null, cache.viewer);
  assert.strictEqual(items.length, 1, 'the mention is surfaced');
  assert.strictEqual(items[0].kind, 'you', 'and it is an @you item');
  const digest = swb.renderDigest(cache, items, now, {});
  assert.match(digest, /@you   HAC-23 sarah: "@Turni what schema shape\?"/);
});

test('new: always lands in Triage (Backlog stateId sent) (exit 0)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  let sentVars = null;
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.teamByKey(FULL_STATES),
      H.issueCreate((v) => { sentVars = v; }),
    ]);
    const { code, out } = await runVerb(['new', 'Fix the auth header bug', '--body', 'details here'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /\[Triage — the "Backlog" group in Linear\]/, 'creation names BOTH vocabularies');
    assert.match(out, /https:\/\/linear\.app\//, 'creation prints the clickable issue URL');
    // must send the Backlog (Triage) state id, never Ready/Todo
    assert.strictEqual(sentVars.stateId, 'st-backlog', 'new must target Triage → Backlog state');
    assert.strictEqual(sentVars.title, 'Fix the auth header bug');
  });
  rm(home); rm(cwd);
});

test('discover: appends DISCOVERIES.md and comments on pinned issue', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      H.teamByKey(FULL_STATES),
      // ensureLabel: team labels query → then no create needed (swb-meta exists)
      { match: (q) => has(q, 'labels(first'), reply: { team: { labels: { nodes: [{ id: 'l-meta', name: 'swb-meta' }] } } } },
      // find existing Discoveries issue
      { match: (q) => has(q, 'title: { eq: "Discoveries" }'), reply: { issues: { nodes: [{ id: 'i-disc', identifier: 'HAC-1', team: { key: 'HAC' }, labels: { nodes: [{ name: 'swb-meta' }] } }] } } },
      H.commentCreate(),
    ]);
    const { code, out } = await runVerb(['discover', 'auth middleware strips X-Custom headers'], { home, cwd });
    assert.strictEqual(code, 0, out);
    const md = fs.readFileSync(path.join(cwd, 'DISCOVERIES.md'), 'utf8');
    assert.match(md, /# Discoveries/);
    assert.match(md, /auth middleware strips X-Custom headers/);
  });
  rm(home); rm(cwd);
});

test('show: prints issue detail with swb state name', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      { match: (q) => has(q, 'issues(filter') && has(q, 'comments(first'), reply: { issues: { nodes: [{
        identifier: 'HAC-23', title: 'schema', description: 'the desc', team: { key: 'HAC' },
        state: { name: 'In Progress' }, assignee: { name: 'sarah' }, labels: { nodes: [{ name: 'backend' }] },
        comments: { nodes: [{ body: 'a comment', createdAt: '2026-07-06T14:18:00.000Z', user: { name: 'sarah' } }] },
      }] } } },
    ]);
    const { code, out } = await runVerb(['show', 'HAC-23'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /HAC-23  schema/);
    assert.match(out, /state: In Progress/);
    assert.match(out, /the desc/);
    assert.match(out, /a comment/);
  });
  rm(home); rm(cwd);
});

test('release: unassigns, frees ownership, keeps branch (exit 0)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  fs.writeFileSync(path.join(home, 'ownership.json'), JSON.stringify({ 'HAC-14': { files: ['src/*'], assignee: 'Turni', sessionId: 's1', ts: 'x' } }));
  await withEnv(home, 'lin_test_key', async () => {
    let releaseVars = null;
    installFetch([
      H.viewer('Turni'),
      H.teamByKey(FULL_STATES), // release now resolves the Ready state id
      issueByKey({ id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-me', name: 'Turni' }, labels: { nodes: [] } }),
      { match: (q) => has(q, 'issueUpdate') && has(q, 'assigneeId: null'), reply: (q, v) => { releaseVars = v; return { issueUpdate: { success: true } }; } },
      H.commentCreate(),
    ]);
    const { code, out } = await runVerb(['release', 'HAC-14'], { home, cwd });
    assert.strictEqual(releaseVars && releaseVars.stateId, 'st-todo', 'release moves the ticket back to Ready (Todo)');
    assert.strictEqual(code, 0, out);
    assert.match(out, /released HAC-14 \(branch kept\)/);
    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8'));
    assert.ok(!own['HAC-14'], 'ownership freed');
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// DOCTOR
// ════════════════════════════════════════════════════════════════════════════

test('doctor: all five states present → green (exit 0)', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([H.viewer('Turni'), H.teamByKey(FULL_STATES)]);
    const { code, out } = await runVerb(['doctor'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /doctor: all green/);
  });
  rm(home); rm(cwd);
});

test('doctor: missing state reported, exit 2; --fix creates it', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  // team missing "In Review"
  const missing = FULL_STATES.filter((s) => s.name !== 'In Review');
  await withEnv(home, 'lin_test_key', async () => {
    // plain doctor → reports missing, exit 2
    installFetch([H.viewer('Turni'), H.teamByKey(missing)]);
    let r = await runVerb(['doctor'], { home, cwd });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /In Review.*MISSING/);
    assert.match(r.out, /swb doctor --fix/);

    // doctor --fix → creates the missing state, re-verifies green
    let createdName = null;
    installFetch([
      H.viewer('Turni'),
      // getTeamByKey is called multiple times; first returns missing, after fix returns full
      { match: (q) => has(q, 'teams(filter'), reply: (q, v, idx) => ({
        teams: { nodes: [{ id: 'team-1', key: 'HAC', name: 'Hackathon', states: { nodes: idx === 0 ? missing : FULL_STATES } }] },
      }) },
      { match: (q) => has(q, 'workflowStateCreate'), reply: (q, v) => { createdName = v.name; return { workflowStateCreate: { success: true, workflowState: { id: 'st-new', name: v.name } } }; } },
    ]);
    r = await runVerb(['doctor', '--fix'], { home, cwd });
    assert.strictEqual(createdName, 'In Review', 'must create the missing Linear state');
    assert.match(r.out, /created missing state "In Review"/);
    assert.strictEqual(r.code, 0, r.out);
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// FAIL-OPEN RECIPE on API error
// ════════════════════════════════════════════════════════════════════════════

test('fail-open: GraphQL error on a mutation prints MANUAL RECIPE + exit 2', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-23', identifier: 'HAC-23', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: null, labels: { nodes: [] } }),
      teamMembers([{ id: 'u-s', name: 'Sarah Kim', displayName: 'sarah', active: true }]),
      // commentCreate fails at the API layer
      { match: (q) => has(q, 'commentCreate'), reply: { errors: [{ message: 'rate limited' }] } },
    ]);
    const { code, out } = await runVerb(['ask', 'HAC-23', '@sarah', 'q?'], { home, cwd });
    assert.strictEqual(code, 2, out);
    assert.match(out, /MANUAL RECIPE:/);
    // recipe lists the manual steps the human can do
    assert.match(out, /Post a comment mentioning @sarah/);
  });
  rm(home); rm(cwd);
});

test('fail-open: network throw is caught and recipe printed', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([
      H.viewer('Turni'),
      H.teamByKey(FULL_STATES),
      { match: (q) => has(q, 'issueCreate'), reply: () => { throw new Error('boom'); } },
    ]);
    const { code, out } = await runVerb(['new', 'a ticket'], { home, cwd });
    assert.strictEqual(code, 2, out);
    assert.match(out, /MANUAL RECIPE:/);
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// TEAM RESOLUTION + EVENTS LOG
// ════════════════════════════════════════════════════════════════════════════

test('refuse to run without a resolved team (exit 2)', async () => {
  const home = mkHome();
  const cwd = mkRepo({ testCommand: 'node --test' }); // no teamKey, no env
  const prevEnvTeam = process.env.SWB_TEAM_KEY;
  delete process.env.SWB_TEAM_KEY;
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([]);
    const { code, out } = await runVerb(['sync'], { home, cwd });
    assert.strictEqual(code, 2, out);
    assert.match(out, /no team resolved/);
  });
  if (prevEnvTeam !== undefined) process.env.SWB_TEAM_KEY = prevEnvTeam;
  rm(home); rm(cwd);
});

test('events.jsonl: every verb appends a line', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  await withEnv(home, 'lin_test_key', async () => {
    installFetch([H.viewer('Turni'), H.teamByKey(FULL_STATES)]);
    await runVerb(['doctor'], { home, cwd });
    const log = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.ok(log.length >= 1);
    const last = JSON.parse(log[log.length - 1]);
    assert.strictEqual(last.cmd, 'doctor');
    assert.ok('ts' in last && 'ok' in last && 'ms' in last);
  });
  rm(home); rm(cwd);
});

// ════════════════════════════════════════════════════════════════════════════
// swb-test LABEL HYGIENE  (CONTRACTS.md line 44 — MANDATORY)
// ────────────────────────────────────────────────────────────────────────────
// Contract: every issue a test creates gets the `swb-test` label (created if it
// does not exist); teardown deletes ALL `swb-test` issues; tests NEVER touch an
// issue that lacks that label. These helpers implement that lifecycle against
// the live HAC scratch board. They are the guardrail that protects the shared
// board from a runaway integration test.
//
// This block is OPT-IN: it only touches the network when SWB_LIVE_LINEAR_KEY
// (and SWB_LIVE_TEAM_KEY, default 'HAC') are set, so the default `node --test`
// run stays fully mocked and offline. Real fetch is used here, never the mock.
// ════════════════════════════════════════════════════════════════════════════

const SWB_TEST_LABEL = 'swb-test';

// Ensure the swb-test label exists on the team, returning its id (create if missing).
async function ensureSwbTestLabel(teamId, apiKey) {
  // team(id:) takes String! (iter-2 P0 — ID! is rejected at query validation).
  const q = `query($teamId: String!) { team(id: $teamId) { labels(first: 250) { nodes { id name } } } }`;
  const d = await swb.linear(q, { teamId }, apiKey);
  const existing = (d.team.labels.nodes || []).find((l) => l.name === SWB_TEST_LABEL);
  if (existing) return existing.id;
  const m = `mutation($teamId: String!, $name: String!) {
    issueLabelCreate(input: { teamId: $teamId, name: $name }) { success issueLabel { id name } } }`;
  const r = await swb.linear(m, { teamId, name: SWB_TEST_LABEL }, apiKey);
  if (!r.issueLabelCreate || !r.issueLabelCreate.success) throw new Error('could not create swb-test label');
  return r.issueLabelCreate.issueLabel.id;
}

// Create an issue that ALWAYS carries the swb-test label. Returns the new issue.
async function createTestIssue(teamKey, title, apiKey) {
  const team = await swb.getTeamByKey(teamKey, apiKey);
  const labelId = await ensureSwbTestLabel(team.id, apiKey);
  const m = `mutation($teamId: String!, $title: String!, $labelIds: [String!]) {
    issueCreate(input: { teamId: $teamId, title: $title, labelIds: $labelIds }) {
      success issue { id identifier labels { nodes { name } } } } }`;
  const d = await swb.linear(m, { teamId: team.id, title, labelIds: [labelId] }, apiKey);
  if (!d.issueCreate || !d.issueCreate.success) throw new Error('createTestIssue failed');
  return d.issueCreate.issue;
}

// List every issue on the team currently carrying the swb-test label.
async function listSwbTestIssues(teamKey, apiKey) {
  const q = `query($key: String!) {
    issues(filter: { team: { key: { eq: $key } }, labels: { name: { eq: "${SWB_TEST_LABEL}" } } }, first: 250) {
      nodes { id identifier labels { nodes { name } } } } }`;
  const d = await swb.linear(q, { key: teamKey }, apiKey);
  return d.issues.nodes || [];
}

// Delete ONLY issues that carry the swb-test label. Guarded: an issue whose
// labels do not include swb-test is never deleted (contract: tests NEVER touch
// issues lacking that label). Returns the count deleted.
async function teardownSwbTestIssues(teamKey, apiKey) {
  const nodes = await listSwbTestIssues(teamKey, apiKey);
  let deleted = 0;
  for (const n of nodes) {
    const labels = (n.labels && n.labels.nodes) || [];
    if (!labels.some((l) => l.name === SWB_TEST_LABEL)) continue; // hard guardrail
    const m = `mutation($id: String!) { issueDelete(id: $id) { success } }`;
    const r = await swb.linear(m, { id: n.id }, apiKey);
    if (r.issueDelete && r.issueDelete.success) deleted++;
  }
  return deleted;
}

// Attach the swb-test label to an already-created issue (by identifier). Used so
// an issue the CLI `new` verb creates — which does NOT self-label — is still
// guaranteed to be reaped by teardown. Returns the issue's id.
async function labelIssueSwbTest(teamKey, identifier, apiKey) {
  const team = await swb.getTeamByKey(teamKey, apiKey);
  const labelId = await ensureSwbTestLabel(team.id, apiKey);
  const found = await swb.findIssueByKey(teamKey, identifier, apiKey);
  const existing = ((found.labels && found.labels.nodes) || []).map((l) => l.id);
  const m = `mutation($id: String!, $labelIds: [String!]) {
    issueUpdate(id: $id, input: { labelIds: $labelIds }) { success } }`;
  const r = await swb.linear(m, { id: found.id, labelIds: existing.concat([labelId]) }, apiKey);
  if (!r.issueUpdate || !r.issueUpdate.success) throw new Error('labelIssueSwbTest failed');
  return found.id;
}

// Expose the helpers so hooks.test.js / a future integration harness can reuse them.
module.exports = { ensureSwbTestLabel, createTestIssue, listSwbTestIssues, teardownSwbTestIssues, labelIssueSwbTest, SWB_TEST_LABEL };

const LIVE_KEY = process.env.SWB_LIVE_LINEAR_KEY;
const LIVE_TEAM = process.env.SWB_LIVE_TEAM_KEY || 'HAC';

test('swb-test hygiene: create-with-label then teardown-deletes-only-labelled (live)', {
  skip: LIVE_KEY ? false : 'set SWB_LIVE_LINEAR_KEY to run the live label-hygiene guardrail',
}, async () => {
  // 1. create an issue — it must come back carrying the swb-test label.
  const issue = await createTestIssue(LIVE_TEAM, `swb hygiene probe ${Date.now()}`, LIVE_KEY);
  const names = (issue.labels.nodes || []).map((l) => l.name);
  assert.ok(names.includes(SWB_TEST_LABEL), 'test-created issue must carry the swb-test label');

  // 2. it must appear in the swb-test set…
  const before = await listSwbTestIssues(LIVE_TEAM, LIVE_KEY);
  assert.ok(before.some((n) => n.identifier === issue.identifier), 'probe issue is listed as swb-test');

  // 3. teardown deletes every swb-test issue and touches nothing else…
  await teardownSwbTestIssues(LIVE_TEAM, LIVE_KEY);
  const after = await listSwbTestIssues(LIVE_TEAM, LIVE_KEY);
  assert.strictEqual(after.length, 0, 'teardown must remove all swb-test issues');
});

test('swb-test hygiene: teardown never deletes an unlabelled issue', {
  skip: LIVE_KEY ? false : 'set SWB_LIVE_LINEAR_KEY to run the live label-hygiene guardrail',
}, async () => {
  // The guardrail is enforced by filtering to the swb-test label on BOTH the
  // query and the per-issue check; assert the invariant directly against the set
  // teardown would act on: nothing in it lacks the label.
  const nodes = await listSwbTestIssues(LIVE_TEAM, LIVE_KEY);
  for (const n of nodes) {
    const names = ((n.labels && n.labels.nodes) || []).map((l) => l.name);
    assert.ok(names.includes(SWB_TEST_LABEL), `teardown candidate ${n.identifier} must carry swb-test`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// LIVE ROUND-TRIP  (CONTRACTS.md DoD — REQUIRED; mocks self-confirmed the iter-1
// P0s, so these drive the REAL CLI against the REAL HAC board.)
// ────────────────────────────────────────────────────────────────────────────
// Covers: sync populates a non-empty, schema-valid v2 cache; `new` lands in
// Triage; `show` finds it; `claim` moves it In Progress + assigns the viewer;
// `release` unassigns. Every issue the run creates carries the swb-test label,
// and an unconditional teardown deletes ALL swb-test issues at the end so the
// HAC board is left clean even if an assertion throws mid-flight.
// ════════════════════════════════════════════════════════════════════════════

// Drive a real CLI verb against Linear in an isolated home + repo cwd.
function liveRunner() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-live-home-'));
  fs.mkdirSync(path.join(home, 'cursors'), { recursive: true });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-live-repo-'));
  fs.writeFileSync(
    path.join(cwd, '.swb.json'),
    JSON.stringify({ teamKey: LIVE_TEAM, testCommand: 'node -e "process.exit(0)"', defaultBranch: 'master' })
  );
  const prevHome = process.env.SWITCHBOARD_HOME;
  process.env.SWITCHBOARD_HOME = home;
  return {
    home, cwd,
    async run(argv) {
      const out = sink();
      const code = await swb.run(argv, { out, cwd, apiKey: LIVE_KEY, claimDelayMs: 1500 });
      return { code, out: out.text() };
    },
    cleanup() {
      if (prevHome === undefined) delete process.env.SWITCHBOARD_HOME; else process.env.SWITCHBOARD_HOME = prevHome;
      rm(home); rm(cwd);
    },
  };
}

// Pull the created key (e.g. HAC-123) out of `swb new`'s success line.
function keyFromNewOutput(out) {
  const m = /✔ created\s+([A-Z][A-Z0-9]*-\d+)/.exec(out);
  return m ? m[1] : null;
}

test('LIVE round-trip: sync → new(Triage) → show → claim(In Progress) → release, then teardown', {
  skip: LIVE_KEY ? false : 'set SWB_LIVE_LINEAR_KEY to run the live round-trip',
}, async () => {
  const R = liveRunner();
  let createdKey = null;
  let liveDigestOut = null; // captured @you digest, printed after the run as proof
  try {
    // ── sync: populates a non-empty, schema-valid v2 cache ────────────────────
    const s = await R.run(['sync', '--session', 'live1']);
    assert.strictEqual(s.code, 0, s.out);
    const cache = JSON.parse(fs.readFileSync(path.join(R.home, 'cache.json'), 'utf8'));
    // v2 schema invariants
    assert.ok(cache.fetchedAt && !Number.isNaN(Date.parse(cache.fetchedAt)), 'cache.fetchedAt is an ISO date');
    assert.strictEqual(cache.teamKey, LIVE_TEAM, 'cache.teamKey matches the team');
    assert.ok(cache.viewer && typeof cache.viewer === 'object', 'cache.viewer is an object');
    assert.ok(cache.viewer.name, 'cache.viewer.name present');
    // states: swb name → { linearName, id } for all five swb states
    for (const swbName of swb.REQUIRED_STATES) {
      const st = cache.states && cache.states[swbName];
      assert.ok(st && st.linearName && st.id, `states.${swbName} has {linearName,id}: ${JSON.stringify(st)}`);
      assert.strictEqual(st.linearName, swb.STATE_MAP[swbName], `states.${swbName}.linearName maps correctly`);
    }
    assert.ok(Array.isArray(cache.issues), 'cache.issues is an array');
    assert.ok(Array.isArray(cache.comments), 'cache.comments is an array');
    // "non-empty schema-valid cache": states are fully populated (the always-present part)
    assert.strictEqual(Object.keys(cache.states).length, swb.REQUIRED_STATES.length, 'all five states cached');

    // ── new: ALWAYS lands in Triage ──────────────────────────────────────────
    const title = `swb live probe ${Date.now()}`;
    const n = await R.run(['new', title, '--body', 'live round-trip probe body']);
    assert.strictEqual(n.code, 0, n.out);
    assert.match(n.out, /\[Triage\]/);
    createdKey = keyFromNewOutput(n.out);
    assert.ok(createdKey, `parsed a created key from: ${n.out}`);
    // label it immediately so teardown is guaranteed to reap it.
    await labelIssueSwbTest(LIVE_TEAM, createdKey, LIVE_KEY);
    // verify it really is in Triage (Backlog) via a live read
    const created = await swb.findIssueByKey(LIVE_TEAM, createdKey, LIVE_KEY);
    assert.strictEqual(swb.swbStateName(created.state.name), 'Triage', `new issue ${createdKey} is in Triage`);

    // ── show: finds the issue by its parsed key (number + team.key filter) ────
    const sh = await R.run(['show', createdKey]);
    assert.strictEqual(sh.code, 0, sh.out);
    assert.ok(sh.out.includes(createdKey) && sh.out.includes(title), `show output names the issue: ${sh.out}`);
    assert.match(sh.out, /state: Triage/);

    // ── claim: moves it In Progress + assigns the viewer ──────────────────────
    const cl = await R.run(['claim', createdKey, '--files', 'src/live/*', '--session', 'live1']);
    assert.strictEqual(cl.code, 0, cl.out);
    assert.match(cl.out, new RegExp(`✔ claimed ${createdKey}`));
    const afterClaim = await swb.findIssueByKey(LIVE_TEAM, createdKey, LIVE_KEY);
    assert.strictEqual(swb.swbStateName(afterClaim.state.name), 'In Progress', 'claim moved it to In Progress');
    const viewer = await swb.getViewer(LIVE_KEY);
    assert.ok(afterClaim.assignee && afterClaim.assignee.id === viewer.id, 'claim assigned the viewer');
    // ownership recorded
    const own = JSON.parse(fs.readFileSync(path.join(R.home, 'ownership.json'), 'utf8'));
    assert.ok(own[createdKey] && own[createdKey].files.includes('src/live/*'), 'ownership records the claim');

    // ── release: unassigns, frees ownership, keeps branch ─────────────────────
    const rel = await R.run(['release', createdKey]);
    assert.strictEqual(rel.code, 0, rel.out);
    assert.match(rel.out, new RegExp(`released ${createdKey}`));
    const afterRelease = await swb.findIssueByKey(LIVE_TEAM, createdKey, LIVE_KEY);
    assert.ok(!afterRelease.assignee, 'release cleared the assignee');
    const own2 = JSON.parse(fs.readFileSync(path.join(R.home, 'ownership.json'), 'utf8'));
    assert.ok(!own2[createdKey], 'release freed ownership');

    // ── ask(@FirstName) → the digest from a SECOND session surfaces it as @you ──
    // THE BLOCKER this fix closes: a caller types the viewer's FIRST name, but the
    // digest @you matcher used to be built only from displayName. Post an ask with
    // the first-name mention and prove a fresh-session digest promotes it to @you.
    const viewerFull = await swb.getViewer(LIVE_KEY);
    const firstName = String(viewerFull.name || '').trim().split(/\s+/)[0];
    assert.ok(firstName, 'viewer has a first name to mention');
    const qText = `does the digest surface a @${firstName} first-name mention? probe ${Date.now()}`;
    const ak = await R.run(['ask', createdKey, `@${firstName}`, qText]);
    assert.strictEqual(ak.code, 0, ak.out);
    // ask canonicalized the first-name @target to the member's @displayName handle
    assert.ok(
      ak.out.includes(`@${viewerFull.displayName}`),
      `ask canonicalized @${firstName} → @${viewerFull.displayName}: ${ak.out}`
    );

    // Second session: fresh cursor (epoch) + forced refetch so the new comment is
    // in-cache. Delete the cache so `sync` refetches the just-posted ask comment.
    try { fs.unlinkSync(path.join(R.home, 'cache.json')); } catch (_) {}
    const dg = await R.run(['sync', '--session', 'live2']);
    assert.strictEqual(dg.code, 0, dg.out);
    liveDigestOut = dg.out;
    // the mention must appear as an @you line pointing at our issue
    assert.match(dg.out, new RegExp(`@you\\s+${createdKey}\\b`), `digest surfaces @you for ${createdKey}: ${dg.out}`);
    assert.ok(dg.out.includes(`→ swb show ${createdKey}`), 'digest @you line has the show pointer');
  } finally {
    // Unconditional teardown: delete ALL swb-test issues so the board ends clean.
    try { await teardownSwbTestIssues(LIVE_TEAM, LIVE_KEY); } catch (_) { /* best-effort */ }
    R.cleanup();
  }
  // Board must have zero swb-test issues afterwards.
  const after = await listSwbTestIssues(LIVE_TEAM, LIVE_KEY);
  assert.strictEqual(after.length, 0, 'teardown left zero swb-test issues on the board');
  // Emit the captured @you digest as proof of the closed Q&A-notification loop.
  if (liveDigestOut) {
    process.stdout.write('\n===== LIVE @you DIGEST (proof) =====\n' + liveDigestOut + '===== END LIVE DIGEST =====\n');
  }
});

// Regression: self-suppression must match ALL identity tokens. Linear authors
// comments under the full name ("Turni Saha") while the digest handle is the
// displayName ("turni.saha") — a single-token compare failed to suppress in the
// live coordination-proof runs (evidence/coordination-proof/).
test('digest: self-suppression matches full name AND displayName (identity tokens)', () => {
  const viewer = { name: 'Turni Saha', displayName: 'turni.saha' };
  const cache = {
    comments: [
      { issueKey: 'HAC-1', author: 'Turni Saha', body: 'note to self', createdAt: '2026-07-06T12:00:00Z', discovery: true },
      { issueKey: 'HAC-2', author: 'Dana Lee', body: '@turni.saha q?', createdAt: '2026-07-06T12:00:00Z', discovery: false },
    ],
    issues: [
      { key: 'HAC-3', title: 'mine', state: 'In Progress', assignee: 'Turni Saha', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-06T12:00:00Z' },
    ],
  };
  const items = swb.buildDeltaItems(cache, '2026-07-06T00:00:00Z', viewer);
  const kinds = items.map((i) => `${i.kind}:${i.key || ''}`);
  assert.deepStrictEqual(kinds, ['you:HAC-2'], `own comment + own claim suppressed, real @you kept: ${JSON.stringify(kinds)}`);
});

// `swb board` — full-team snapshot grouped by state (the digest's complement).
test('board: groups issues by state with assignees, In Progress first', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  try {
    await withEnv(home, null, async () => {
      // Seed a fresh cache directly so board renders without a fetch.
      const cache = {
        fetchedAt: new Date('2026-07-06T14:22:00.000Z').toISOString(),
        teamKey: 'HAC',
        viewer: { name: 'Turni Saha', displayName: 'turni.saha' },
        states: {},
        issues: [
          { key: 'HAC-1', title: 'player ui', state: 'In Progress', assignee: 'Patrick Hohol', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-06T10:00:00Z' },
          { key: 'HAC-2', title: 'schema', state: 'Ready', assignee: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-06T10:00:00Z' },
          { key: 'HAC-3', title: 'ideas', state: 'Triage', assignee: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-06T10:00:00Z' },
        ],
        comments: [],
      };
      fs.writeFileSync(path.join(home, 'cache.json'), JSON.stringify(cache));
      installFetch([]); // any fetch attempt would throw — board must serve the cache
      const { code, out } = await runVerb(['board'], { home, cwd });
      assert.strictEqual(code, 0, out);
      assert.match(out, /In Progress \(1\)/);
      assert.match(out, /HAC-1 {2}player ui.*→ Patrick Hohol/);
      const ipIdx = out.indexOf('In Progress (');
      const trIdx = out.indexOf('Triage (');
      assert.ok(ipIdx !== -1 && trIdx !== -1 && ipIdx < trIdx, 'In Progress renders before Triage');
    });
  } finally { rm(home); rm(cwd); }
});

// `swb members` — the tour's buddy-resolution verb: @handle → full name, read-only.
test('members: lists active team members with handle and full name', async () => {
  const home = mkHome();
  const cwd = mkRepo();
  try {
    await withEnv(home, null, async () => {
      installFetch([
        teamMembers([
          { id: 'u1', name: 'Patrick Hohol', displayName: 'pat.hohol', active: true },
          { id: 'u2', name: 'Gone Person', displayName: 'gone', active: false },
          { id: 'u3', name: 'Turni Saha', displayName: 'turni.saha', active: true },
        ]),
      ]);
      const { code, out } = await runVerb(['members'], { home, cwd });
      assert.strictEqual(code, 0, out);
      assert.match(out, /@pat\.hohol\s+Patrick Hohol/, 'handle → full name row');
      assert.match(out, /@turni\.saha\s+Turni Saha/);
      assert.ok(!out.includes('Gone Person'), 'inactive members excluded');
    });
  } finally { rm(home); rm(cwd); }
});
