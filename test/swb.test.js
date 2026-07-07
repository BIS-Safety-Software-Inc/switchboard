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
  issueCreate: (capture) => ({
    match: (q) => has(q, 'issueCreate'),
    reply: (q, v) => { if (capture) capture(v); return { issueCreate: { success: true, issue: { id: 'i-new', identifier: 'HAC-99', state: { name: 'Backlog' } } } }; },
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
      H.commentCreate((v) => commentBodies.push(v.body)),
    ]);
    const { code, out } = await runVerb(['claim', 'HAC-14', '--files', 'src/player/*,src/ui/*', '--session', 's1'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /✔ claimed HAC-14/);
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
      H.commentCreate((v) => bodies.push(v.body)),
    ]);
    const { code, out } = await runVerb(['ask', 'HAC-23', '@sarah', 'composite key per attempt?'], { home, cwd });
    assert.strictEqual(code, 0, out);
    assert.match(out, /✔ asked on HAC-23/);
    assert.ok(bodies.some((b) => b.startsWith('@sarah composite key') && b.includes('swb v')), 'mention + signature');
  });
  rm(home); rm(cwd);
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
    assert.match(out, /\[Triage\]/);
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
    installFetch([
      H.viewer('Turni'),
      issueByKey({ id: 'i-14', identifier: 'HAC-14', title: 't', team: { id: 'team-1', key: 'HAC' }, state: { id: 'st-inprogress', name: 'In Progress' }, assignee: { id: 'u-me', name: 'Turni' }, labels: { nodes: [] } }),
      { match: (q) => has(q, 'issueUpdate') && has(q, 'assigneeId: null'), reply: { issueUpdate: { success: true } } },
      H.commentCreate(),
    ]);
    const { code, out } = await runVerb(['release', 'HAC-14'], { home, cwd });
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
  const q = `query($teamId: ID!) { team(id: $teamId) { labels(first: 250) { nodes { id name } } } }`;
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

// Expose the helpers so hooks.test.js / a future integration harness can reuse them.
module.exports = { ensureSwbTestLabel, createTestIssue, listSwbTestIssues, teardownSwbTestIssues, SWB_TEST_LABEL };

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
