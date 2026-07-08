'use strict';
/*
 * switchboard hook-pack tests
 * ────────────────────────────────────────────────────────────────────────────
 * Drives each hook as a real child process (node hooks/<x>.js) with a stdin
 * fixture and an ISOLATED SWITCHBOARD_HOME (temp dir) so the real
 * ~/.switchboard/ is never touched. Asserts:
 *   - exact output JSON shapes (CONTRACTS.md §"Hook contract")
 *   - empty-delta silence (nothing on stdout)
 *   - PostToolUse 300s throttle behaviour
 *   - a corrupted cache.json still yields exit 0 (fail-open)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOKS = {
  ups: path.join(ROOT, 'hooks', 'userpromptsubmit.js'),
  ptu: path.join(ROOT, 'hooks', 'posttooluse.js'),
  pre: path.join(ROOT, 'hooks', 'pretooluse.js'),
};
const FIX = path.join(__dirname, 'fixtures');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

// Build a throwaway SWITCHBOARD_HOME populated with the given state files.
// state: {cache, ownership, cursors:{<id>:{...}}, cacheRaw:"<string>"}
function makeHome(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-hooktest-'));
  fs.mkdirSync(path.join(home, 'cursors'), { recursive: true });
  if (state.cacheRaw !== undefined) {
    fs.writeFileSync(path.join(home, 'cache.json'), state.cacheRaw, 'utf8');
  } else if (state.cache) {
    fs.writeFileSync(path.join(home, 'cache.json'), JSON.stringify(state.cache), 'utf8');
  }
  if (state.ownership) {
    fs.writeFileSync(path.join(home, 'ownership.json'), JSON.stringify(state.ownership), 'utf8');
  }
  if (state.cursors) {
    for (const id of Object.keys(state.cursors)) {
      fs.writeFileSync(path.join(home, 'cursors', `${id}.json`),
        JSON.stringify(state.cursors[id]), 'utf8');
    }
  }
  return home;
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
}

// Run a hook binary with stdin, in an isolated home. Returns {status,out,err}.
function runHook(hookPath, stdinObj, home) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(stdinObj),
    env: Object.assign({}, process.env, { SWITCHBOARD_HOME: home }),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// A cache whose fetchedAt is "now" (fresh → no refetch spawn) but whose items
// are timestamped in a fixed window so cursor math is deterministic.
function freshCache() {
  const c = readFixture('cache.json');
  c.fetchedAt = new Date().toISOString();
  return c;
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── UserPromptSubmit ─────────────────────────────────────────────────────────
//
// The hook DEFERS to swb.js's hookDigest when present (single source of truth,
// per CONTRACTS.md "delegate to swb logic"). So the child-process tests assert
// the ENVELOPE contract + digest STRUCTURE that any conformant engine must
// satisfy. The EXACT digest content is pinned separately against this hook's own
// reference engine (see "reference digest" test) so the mastermind has a
// correct baseline to diff swb.js's hookDigest against.

test('userpromptsubmit: emits UserPromptSubmit additionalContext on non-empty delta', () => {
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': readFixture('cursor-old.json') },
  });
  try {
    const r = runHook(HOOKS.ups, readFixture('stdin-userpromptsubmit.json'), home);
    assert.strictEqual(r.status, 0, 'exit 0');
    assert.ok(r.out.length > 0, 'produced output');
    const parsed = JSON.parse(r.out);
    // envelope contract — the shape this hook owns. systemMessage is the
    // human-visible one-line receipt (users otherwise never see the digest);
    // additionalContext is the agent-only full block.
    assert.deepStrictEqual(Object.keys(parsed), ['systemMessage', 'hookSpecificOutput']);
    // The human-visible block: EVERY digest line painted solid yellow (ANSI
    // 103/30 per line), full content — no truncated teaser (owner call).
    const receiptLines = parsed.systemMessage.split('\n');
    assert.ok(receiptLines.every((l) => l.includes('\u001b[103;30m') && l.includes('\u001b[0m')), 'every line painted yellow');
    // Solid box: every painted row is the SAME width and none exceeds the box
    // (long lines are wrapped, not padded to the longest raw line).
    const contents = receiptLines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
    const widths = new Set(contents.map((c) => c.length));
    assert.strictEqual(widths.size, 1, 'uniform row width: ' + [...widths].join(','));
    assert.ok([...widths][0] <= 92, 'rows fit a normal terminal');
    const stripped = parsed.systemMessage.replace(/\u001b\[[0-9;]*m/g, '');
    assert.match(stripped, /switchboard: \d+ board updates?/, 'count headline');
    assert.ok(stripped.includes('@you'), 'full digest content visible to the human');
    assert.ok(stripped.includes('act    if any item above touches'), 'act line included');
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.deepStrictEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    // digest structure invariants every engine must satisfy:
    assert.ok(ctx.startsWith('── switchboard · '), 'header prefix');
    assert.ok(/cache \d+s · \d+ new ──/.test(ctx), 'age + count in header');
    assert.ok(/\n@you /.test('\n' + ctx), '@you line present');
    assert.ok(ctx.indexOf('@you') < ctx.indexOf('\nclaim'), '@you before claim');
    assert.ok(ctx.includes('act    if any item above touches'), 'act directive');
    assert.ok(ctx.trim().endsWith('──'), 'footer');
  } finally { cleanup(home); }
});

test('userpromptsubmit reference engine: EXACT digest content per CONTRACTS.md', () => {
  // Pins THIS hook's own inline digest (swb.js-independent). This is the
  // authoritative reference for the CONTRACTS.md "Digest format".
  const engine = require('../hooks/userpromptsubmit.js');
  const cache = freshCache();
  const ownership = readFixture('ownership.json');
  const since = Date.parse('2026-07-06T14:16:00.000Z');
  const items = engine.buildItems(cache, ownership, 'marc', since);
  const lines = items.map(i => i.text);
  assert.ok(items[0].you, '@you sorts first');
  assert.strictEqual(lines[0],
    '@you   HAC-23 sarah: "@marc does quiz_progress need a composite key per attempt?" → swb show HAC-23');
  assert.ok(lines.includes('claim  HAC-23 Quiz progress schema → sarah   files: src/schema/**,db/migrations/*.sql'),
    'foreign claim (sarah) surfaces with real issue key');
  assert.ok(!lines.some(l => l.startsWith('claim  HAC-31')), 'my own claim (marc) suppressed');
  // Own-assignee state moves are suppressed (same rule as own claims/comments —
  // fixed 2026-07-07 after the live tour showed your own claim echoing back).
  assert.ok(!lines.some(l => l.startsWith('state  HAC-31')), 'my own state change suppressed');
  // A FOREIGN state change still surfaces: bump sarah's HAC-23 past the cursor.
  const cache2 = JSON.parse(JSON.stringify(cache));
  const h23 = cache2.issues.find(i => i.key === 'HAC-23');
  h23.updatedAt = '2026-07-06T14:21:00.000Z';
  h23.stateChangedAt = '2026-07-06T14:21:00.000Z';
  const lines2 = engine.buildItems(cache2, ownership, 'marc', since).map(i => i.text);
  assert.ok(lines2.includes('state  HAC-23 → In Progress'), 'foreign state change surfaces');
  assert.ok(lines.includes('disc   auth middleware strips X-Custom headers (dana)'), 'discovery');
  assert.ok(lines.includes('new    HAC-40 New triage ticket about auth headers [Backlog]'), 'new triage');
  // full render round-trips the exact block shape
  const digest = engine.renderDigest(cache, items);
  assert.ok(digest.startsWith('── switchboard · '));
  assert.ok(digest.trim().endsWith('──'));
  assert.ok(digest.includes('act    if any item above touches your claimed ticket or declared files, state the impact before continuing'));
});

test('userpromptsubmit: advances lastSeenTs so a re-run is silent (empty delta)', () => {
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': readFixture('cursor-old.json') },
  });
  try {
    const first = runHook(HOOKS.ups, readFixture('stdin-userpromptsubmit.json'), home);
    assert.ok(first.out.length > 0, 'first run emits');
    // cursor should now be advanced on disk
    const cur = JSON.parse(fs.readFileSync(path.join(home, 'cursors', 'sess-marc-1.json'), 'utf8'));
    assert.ok(cur.lastSeenTs, 'lastSeenTs written');
    // second run: same cache, advanced cursor → nothing new
    const second = runHook(HOOKS.ups, readFixture('stdin-userpromptsubmit.json'), home);
    assert.strictEqual(second.status, 0);
    assert.strictEqual(second.out, '', 'empty delta → no output');
  } finally { cleanup(home); }
});

test('userpromptsubmit: empty delta (cursor ahead of all items) emits nothing', () => {
  const cur = { lastSeenTs: new Date(NOW + 60_000).toISOString() };
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': cur },
  });
  try {
    const r = runHook(HOOKS.ups, readFixture('stdin-userpromptsubmit.json'), home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'no context on empty delta');
  } finally { cleanup(home); }
});

test('userpromptsubmit: corrupted cache.json still exits 0 and emits nothing', () => {
  // No ownership either → the digest has no independent source of items, so a
  // corrupt cache must yield an empty (but crash-free) result. This isolates
  // the "corrupted cache file still exits 0" contract point.
  const home = makeHome({
    cacheRaw: '{ this is not json ]]]',
    cursors: { 'sess-marc-1': readFixture('cursor-old.json') },
  });
  try {
    const r = runHook(HOOKS.ups, readFixture('stdin-userpromptsubmit.json'), home);
    assert.strictEqual(r.status, 0, 'fail-open exit 0');
    assert.strictEqual(r.out, '', 'no digest from a corrupt cache');
    // an events.jsonl line was written (ok:true, we degraded gracefully)
    const ev = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(ev[ev.length - 1]);
    assert.strictEqual(last.cmd, 'hook:userpromptsubmit');
  } finally { cleanup(home); }
});

test('userpromptsubmit: garbage stdin still exits 0', () => {
  const home = makeHome({ cache: freshCache() });
  try {
    const r = spawnSync(process.execPath, [HOOKS.ups], {
      input: 'not-json-at-all',
      env: Object.assign({}, process.env, { SWITCHBOARD_HOME: home }),
      encoding: 'utf8', timeout: 15000,
    });
    assert.strictEqual(r.status, 0);
  } finally { cleanup(home); }
});

test('seam: default (flag off) uses the inline engine → correct issue keys, no undefined', () => {
  // Proves the hook does NOT delegate to swb.js unless SWB_HOOK_DIGEST=swb, so a
  // buggy sibling swb.js cannot leak "undefined" into the digest by default.
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': readFixture('cursor-old.json') },
  });
  try {
    const r = spawnSync(process.execPath, [HOOKS.ups], {
      input: JSON.stringify(readFixture('stdin-userpromptsubmit.json')),
      // note: SWB_HOOK_DIGEST deliberately UNSET
      env: Object.assign({}, process.env, { SWITCHBOARD_HOME: home, SWB_HOOK_DIGEST: '' }),
      encoding: 'utf8', timeout: 15000,
    });
    assert.strictEqual(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!/\bundefined\b/.test(ctx), 'never emits a stray undefined');
    assert.ok(ctx.includes('@you   HAC-23 sarah:'), 'correct @you issue key');
    assert.ok(ctx.includes('→ swb show HAC-23'), 'correct show pointer');
  } finally { cleanup(home); }
});

test('seam: digestLooksWellFormed is a QA gate for swb.js hookDigest', () => {
  // The mastermind uses this to gate flipping SWB_HOOK_DIGEST=swb on: swb.js's
  // hookDigest output must pass BEFORE it becomes the default source.
  const engine = require('../hooks/userpromptsubmit.js');
  const bad = '── switchboard · 10:00 · cache 0s · 1 new ──\n@you   undefined x: "y" → swb show undefined\n──';
  const good = '── switchboard · 10:00 · cache 0s · 1 new ──\n@you   HAC-1 x: "y" → swb show HAC-1\n──';
  assert.strictEqual(engine.digestLooksWellFormed(bad), false, 'stray undefined rejected');
  assert.strictEqual(engine.digestLooksWellFormed(good), true);
  assert.strictEqual(engine.digestLooksWellFormed(''), false);
  assert.strictEqual(engine.digestLooksWellFormed('garbage'), false, 'bad header rejected');
});

// ── PostToolUse (throttle) ───────────────────────────────────────────────────

test('posttooluse: injects when lastInjectTs is old (>300s) and delta non-empty', () => {
  // lastSeenTs sits BEFORE the fixture items (they are dated 14:17-14:22) so the
  // delta is non-empty; lastInjectTs is old wall-clock so the throttle is open.
  const cur = { lastSeenTs: '2026-07-06T14:16:00.000Z', lastInjectTs: iso(600_000) };
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': cur },
  });
  try {
    const stdin = { session_id: 'sess-marc-1', cwd: '/repo', hook_event_name: 'PostToolUse',
      tool_name: 'Edit', tool_input: { file_path: '/repo/x.js' } };
    const r = runHook(HOOKS.ptu, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.ok(r.out.length > 0, 'emitted mid-turn digest');
    const parsed = JSON.parse(r.out);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('@you   HAC-23'));
    // lastInjectTs must have advanced to ~now
    const after = JSON.parse(fs.readFileSync(path.join(home, 'cursors', 'sess-marc-1.json'), 'utf8'));
    assert.ok(Date.parse(after.lastInjectTs) >= NOW - 5_000, 'lastInjectTs updated');
  } finally { cleanup(home); }
});

test('posttooluse: throttled when lastInjectTs is recent (<300s) → nothing', () => {
  const recent = iso(60_000); // 1 min ago
  // lastSeenTs BEFORE fixture items → delta IS non-empty; the ONLY reason output
  // is suppressed is the throttle. Proves throttle, not emptiness, gates it.
  const cur = { lastSeenTs: '2026-07-06T14:16:00.000Z', lastInjectTs: recent };
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': cur },
  });
  try {
    const stdin = { session_id: 'sess-marc-1', cwd: '/repo', hook_event_name: 'PostToolUse',
      tool_name: 'Edit', tool_input: { file_path: '/repo/x.js' } };
    const r = runHook(HOOKS.ptu, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'throttled → no output');
    // lastInjectTs must be UNCHANGED
    const after = JSON.parse(fs.readFileSync(path.join(home, 'cursors', 'sess-marc-1.json'), 'utf8'));
    assert.strictEqual(after.lastInjectTs, recent, 'lastInjectTs untouched while throttled');
  } finally { cleanup(home); }
});

test('posttooluse: not throttled but empty delta → nothing and no lastInjectTs change', () => {
  const cur = { lastSeenTs: new Date(NOW + 60_000).toISOString(), lastInjectTs: iso(600_000) };
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': cur },
  });
  try {
    const stdin = { session_id: 'sess-marc-1', cwd: '/repo', hook_event_name: 'PostToolUse',
      tool_name: 'Edit', tool_input: { file_path: '/repo/x.js' } };
    const r = runHook(HOOKS.ptu, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'empty delta → no output');
    const after = JSON.parse(fs.readFileSync(path.join(home, 'cursors', 'sess-marc-1.json'), 'utf8'));
    assert.strictEqual(after.lastInjectTs, cur.lastInjectTs, 'no injection → lastInjectTs unchanged');
  } finally { cleanup(home); }
});

test('posttooluse: corrupted cache still exits 0', () => {
  const cur = { lastSeenTs: iso(600_000), lastInjectTs: iso(600_000) };
  const home = makeHome({ cacheRaw: '###broken###', cursors: { 'sess-marc-1': cur } });
  try {
    const stdin = { session_id: 'sess-marc-1', tool_name: 'Edit', tool_input: { file_path: '/repo/x.js' } };
    const r = runHook(HOOKS.ptu, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'corrupt cache → no digest');
  } finally { cleanup(home); }
});

// ── PreToolUse (ownership warn, always allow) ────────────────────────────────

test('pretooluse: warns when editing a file owned by another session', () => {
  const home = makeHome({ ownership: readFixture('ownership.json') });
  try {
    const r = runHook(HOOKS.pre, readFixture('stdin-pretooluse-foreign.json'), home);
    assert.strictEqual(r.status, 0, 'ALWAYS allow → exit 0');
    const parsed = JSON.parse(r.out);
    assert.ok(typeof parsed.systemMessage === 'string');
    assert.ok(parsed.systemMessage.startsWith('⚠ switchboard: '), 'warn prefix');
    assert.ok(parsed.systemMessage.includes('is owned by HAC-23 (sarah)'), 'owner named');
    assert.ok(parsed.systemMessage.includes('coordinate before editing'), 'coordinate CTA');
    // never a permission decision
    assert.ok(!('hookSpecificOutput' in parsed), 'no permission decision object');
  } finally { cleanup(home); }
});

test('pretooluse: silent when editing your OWN claimed file', () => {
  const home = makeHome({ ownership: readFixture('ownership.json') });
  try {
    const r = runHook(HOOKS.pre, readFixture('stdin-pretooluse-own.json'), home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'own file → no warning');
  } finally { cleanup(home); }
});

test('pretooluse: silent for a file nobody owns', () => {
  const home = makeHome({ ownership: readFixture('ownership.json') });
  try {
    const stdin = { session_id: 'sess-marc-1', cwd: '/repo/switchboard', tool_name: 'Write',
      tool_input: { file_path: '/repo/switchboard/README.md' } };
    const r = runHook(HOOKS.pre, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'unowned file → no warning');
  } finally { cleanup(home); }
});

test('pretooluse: ignores non-watched tools (Read/Bash)', () => {
  const home = makeHome({ ownership: readFixture('ownership.json') });
  try {
    const stdin = { session_id: 'sess-x', cwd: '/repo/switchboard', tool_name: 'Read',
      tool_input: { file_path: '/repo/switchboard/db/migrations/0007.sql' } };
    const r = runHook(HOOKS.pre, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'non-watched tool → no warning even on owned file');
  } finally { cleanup(home); }
});

test('pretooluse: MultiEdit is watched and warns on foreign ownership', () => {
  const home = makeHome({ ownership: readFixture('ownership.json') });
  try {
    const stdin = { session_id: 'sess-marc-1', cwd: '/repo/switchboard', tool_name: 'MultiEdit',
      tool_input: { file_path: '/repo/switchboard/src/schema/quiz.ts', edits: [] } };
    const r = runHook(HOOKS.pre, stdin, home);
    assert.strictEqual(r.status, 0);
    const parsed = JSON.parse(r.out);
    assert.ok(parsed.systemMessage.includes('HAC-23 (sarah)'), 'schema/** owned by sarah');
  } finally { cleanup(home); }
});

test('pretooluse: corrupted ownership.json still exits 0 and is silent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-hooktest-'));
  fs.writeFileSync(path.join(home, 'ownership.json'), '{{{not json', 'utf8');
  try {
    const stdin = { session_id: 'sess-marc-1', tool_name: 'Edit',
      tool_input: { file_path: '/repo/x.sql' } };
    const r = runHook(HOOKS.pre, stdin, home);
    assert.strictEqual(r.status, 0, 'fail-open');
    assert.strictEqual(r.out, '', 'no warning from corrupt ownership');
  } finally { cleanup(home); }
});

test('pretooluse: missing file_path → no crash, no output', () => {
  const home = makeHome({ ownership: readFixture('ownership.json') });
  try {
    const stdin = { session_id: 'sess-marc-1', tool_name: 'Edit', tool_input: {} };
    const r = runHook(HOOKS.pre, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '');
  } finally { cleanup(home); }
});

// ── unit: glob matcher (pure) ────────────────────────────────────────────────

test('glob matcher: *, **, ? and separators', () => {
  const { globMatch } = require('../hooks/pretooluse.js');
  assert.ok(globMatch('src/player/*', 'src/player/shell.tsx'));
  assert.ok(!globMatch('src/player/*', 'src/player/sub/deep.tsx'), '* does not cross /');
  assert.ok(globMatch('src/player/**', 'src/player/sub/deep.tsx'), '** crosses /');
  assert.ok(globMatch('db/migrations/*.sql', 'db/migrations/0007_x.sql'));
  assert.ok(!globMatch('db/migrations/*.sql', 'db/migrations/0007_x.ts'));
  assert.ok(globMatch('src/**/quiz.ts', 'src/schema/quiz.ts'), 'a/**/b');
  // windows backslash paths normalize
  assert.ok(globMatch('src/player/*', 'src\\player\\shell.tsx'));
});

// ── GATE 2: claim/done via Bash are denied without --approved — the human gate
// that survives --dangerously-skip-permissions (hooks fire regardless).
test('pretooluse gate2: denies swb claim without --approved, allows with it, respects off-switch', () => {
  const home = makeHome({ ownership: {} });
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-g2-'));
  try {
    const mk = (command) => ({ session_id: 'g2', cwd: repoDir, tool_name: 'Bash', tool_input: { command } });
    // no .swb.json → gate2 defaults ON
    let r = runHook(HOOKS.pre, mk('swb claim HAC-9 --files "src/**"'), home);
    assert.strictEqual(r.status, 0);
    let parsed = JSON.parse(r.out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', 'claim denied without approval');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /GATE 2/);
    // done also gated, incl. node …/swb.js form
    r = runHook(HOOKS.pre, mk('node "/x/switchboard/swb.js" done HAC-9 --pr https://x/1'), home);
    parsed = JSON.parse(r.out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', 'done denied without approval');
    // --approved passes through (no output at all)
    r = runHook(HOOKS.pre, mk('swb claim HAC-9 --files "src/**" --approved'), home);
    assert.strictEqual(r.out.trim(), '', 'approved claim not blocked');
    // quoted path WITH SPACES — the exact form that bypassed the gate live
    r = runHook(HOOKS.pre, mk('cd ~/x && node "/Users/t/AI Hackathon/switchboard/swb.js" claim HAC-9 --files "s/**"'), home);
    parsed = JSON.parse(r.out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', 'quoted spaced path gated');
    // a command that merely MENTIONS the words mid-text is NOT gated
    r = runHook(HOOKS.pre, mk('python3 - <<X\nprint("docs say: swb claim HAC-1")\nX'), home);
    assert.strictEqual(r.out.trim(), '', 'mention-only text not gated');
    // reads are never gated
    r = runHook(HOOKS.pre, mk('swb sync'), home);
    assert.strictEqual(r.out.trim(), '', 'sync never gated');
    // team off-switch in .swb.json
    fs.writeFileSync(path.join(repoDir, '.swb.json'), JSON.stringify({ teamKey: 'HAC', gate2: 'off' }));
    r = runHook(HOOKS.pre, mk('swb claim HAC-9 --files "src/**"'), home);
    assert.strictEqual(r.out.trim(), '', 'gate2 off → no deny');
  } finally { cleanup(home); try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch (_) {} }
});

// Regression (live, 2026-07-08): the mid-turn door delivered digests with NO
// human-visible receipt — agent informed, cursor advanced, human saw nothing.
test('posttooluse: mid-turn delivery carries the yellow receipt too', () => {
  const home = makeHome({
    cache: freshCache(),
    ownership: readFixture('ownership.json'),
    cursors: { 'sess-marc-1': readFixture('cursor-old.json') }, // stale lastInjectTs → not throttled
  });
  try {
    const stdin = { session_id: 'sess-marc-1', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'echo hi' } };
    const r = runHook(HOOKS.ptu, stdin, home);
    assert.strictEqual(r.status, 0);
    assert.ok(r.out.length > 0, 'delivered (non-empty delta, not throttled)');
    const parsed = JSON.parse(r.out);
    assert.ok(parsed.systemMessage, 'mid-turn delivery has a human-visible receipt');
    assert.ok(parsed.systemMessage.includes('\u001b[103;30m'), 'painted yellow');
    assert.match(parsed.systemMessage.replace(/\u001b\[[0-9;]*m/g, ''), /switchboard \(mid-turn\): \d+ board update/);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('@you'), 'agent still gets the full digest');
  } finally { cleanup(home); }
});
