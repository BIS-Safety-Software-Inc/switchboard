'use strict';
// SCOPED DELIVERY battery — re-enabled 2026-07-08 pm with the kit already in the
// field, so every path gets an automated lock (the hybrid previously had only a
// manual four-scenario proof). Design under test:
//   mentions follow the person (deliver ANYWHERE, deduped via lastYouTs);
//   board chatter follows the repo (.swb.json walk-up / claim-worktree / panic env).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UPS = path.join(ROOT, 'hooks', 'userpromptsubmit.js');
const FIX = path.join(__dirname, 'fixtures');
const YELLOW = '[103;30m';

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}
// Cache whose fetchedAt is now (no refetch spawn) with deterministic item times.
function freshCache() {
  const c = readFixture('cache.json');
  c.fetchedAt = new Date().toISOString();
  // Fixture items are dated 2026-07-06; a fresh session's first look reaches
  // back only 30 min. Pull the ambient marker item (HAC-40, a new ticket) into
  // the window so in-repo deliveries have something to show.
  for (const iss of c.issues) {
    if (iss.key === 'HAC-40') iss.createdAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  }
  return c;
}
function mentionCache() {
  const c = freshCache();
  c.comments.push({
    issueKey: 'HAC-90', author: 'Dana Lee', discovery: false,
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(), // inside first-look window
    body: '@marc urgent: which schema do we freeze?',
  });
  return c;
}
function makeHome(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-scope-home-'));
  fs.mkdirSync(path.join(home, 'cursors'), { recursive: true });
  if (state.cache) fs.writeFileSync(path.join(home, 'cache.json'), JSON.stringify(state.cache));
  fs.writeFileSync(path.join(home, 'ownership.json'), JSON.stringify(state.ownership || {}));
  return home;
}
function cleanup(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function runUps(stdinObj, home, extraEnv) {
  const r = spawnSync(process.execPath, [UPS], {
    input: JSON.stringify(stdinObj),
    env: Object.assign({}, process.env, { SWITCHBOARD_HOME: home }, extraEnv || {}),
    encoding: 'utf8', timeout: 15000,
  });
  return { status: r.status, out: (r.stdout || '').trim() };
}
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-outside-')); // no .swb.json above tmp

test('scope: out-of-repo session gets NOTHING when the delta is ambient-only', () => {
  const home = makeHome({ cache: freshCache(), ownership: readFixture('ownership.json') });
  try {
    const r = runUps({ session_id: 's-scope-a', cwd: OUTSIDE, prompt: 'x' }, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out, '', 'ambient chatter suppressed outside repos: ' + r.out.slice(0, 80));
  } finally { cleanup(home); }
});

test('scope: out-of-repo session DOES get an @you mention, yellow, ambient excluded, deduped', () => {
  const home = makeHome({ cache: mentionCache(), ownership: {} });
  try {
    const r1 = runUps({ session_id: 's-scope-b', cwd: OUTSIDE, prompt: 'x' }, home);
    assert.ok(r1.out.length > 0, 'mention delivered out-of-repo');
    const p1 = JSON.parse(r1.out);
    assert.ok(p1.hookSpecificOutput.additionalContext.includes('urgent: which schema'), 'mention text present');
    assert.ok(!p1.hookSpecificOutput.additionalContext.includes('HAC-40'), 'ambient new-ticket excluded');
    assert.ok(p1.systemMessage.includes(YELLOW), 'yellow receipt painted');
    assert.match(p1.systemMessage.replace(/\[[0-9;]*m/g, ''), /switchboard \(mention\)/);
    const r2 = runUps({ session_id: 's-scope-b', cwd: OUTSIDE, prompt: 'x' }, home);
    assert.strictEqual(r2.out, '', 'same mention not re-delivered');
  } finally { cleanup(home); }
});

test('scope: mention seen out-of-repo is NOT repeated in-repo; ambient still arrives there', () => {
  const home = makeHome({ cache: mentionCache(), ownership: {} });
  try {
    const r1 = runUps({ session_id: 's-scope-c', cwd: OUTSIDE, prompt: 'x' }, home);
    assert.ok(r1.out.length > 0, 'mention delivered out-of-repo first');
    const r2 = runUps({ session_id: 's-scope-c', cwd: '.', prompt: 'x' }, home);
    assert.ok(r2.out.length > 0, 'in-repo delivery still fires');
    const p2 = JSON.parse(r2.out);
    assert.ok(!p2.hookSpecificOutput.additionalContext.includes('urgent: which schema'), 'mention not repeated in-repo');
    assert.ok(p2.hookSpecificOutput.additionalContext.includes('HAC-40'), 'ambient items delivered in-repo');
  } finally { cleanup(home); }
});

test('scope: a SUBDIRECTORY of the repo counts as in-repo (walk-up)', () => {
  const home = makeHome({ cache: freshCache(), ownership: readFixture('ownership.json') });
  const sub = path.join(ROOT, 'test', 'fixtures');
  try {
    const r = runUps({ session_id: 's-scope-d', cwd: sub, prompt: 'x' }, home);
    assert.ok(r.out.length > 0, 'full digest in a subdirectory of the repo');
    assert.ok(JSON.parse(r.out).hookSpecificOutput.additionalContext.includes('HAC-40'), 'ambient included');
  } finally { cleanup(home); }
});

test('scope: cwd inside a claim WORKTREE counts as in-repo even without .swb.json there', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-wt-')); // bare dir, no .swb.json
  const own = readFixture('ownership.json');
  own['HAC-31'].worktree = wt;
  const home = makeHome({ cache: freshCache(), ownership: own });
  try {
    const r = runUps({ session_id: 's-scope-e', cwd: wt, prompt: 'x' }, home);
    assert.ok(r.out.length > 0, 'worktree session hears the full digest');
    assert.ok(JSON.parse(r.out).hookSpecificOutput.additionalContext.includes('HAC-40'), 'ambient included in worktree');
  } finally { cleanup(home); try { fs.rmSync(wt, { recursive: true, force: true }); } catch (_) {} }
});

test('scope: SWB_DIGEST_EVERYWHERE=1 panic switch restores machine-wide full digests', () => {
  const home = makeHome({ cache: freshCache(), ownership: readFixture('ownership.json') });
  try {
    const r = runUps({ session_id: 's-scope-f', cwd: OUTSIDE, prompt: 'x' }, home, { SWB_DIGEST_EVERYWHERE: '1' });
    assert.strictEqual(r.status, 0);
    assert.ok(r.out.includes('HAC-40'), 'panic switch: full ambient digest outside any repo');
  } finally { cleanup(home); }
});
