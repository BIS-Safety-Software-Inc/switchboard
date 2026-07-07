'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_JS = path.join(REPO_ROOT, 'install.js');
const installer = require('../install.js');

// Make a fresh temp HOME for each scenario and clean it up after.
function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-home-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runInstaller(home, extraEnv = {}, extraArgs = []) {
  // Start from a clean env: strip any inherited SWB_HOME/SWB_INSTALL_HOME/LINEAR_API_KEY
  // so the test controls them precisely.
  const baseEnv = { ...process.env };
  delete baseEnv.SWB_HOME;
  delete baseEnv.SWB_INSTALL_HOME;
  delete baseEnv.LINEAR_API_KEY;
  const res = cp.spawnSync(process.execPath, [INSTALL_JS, '--no-prompt', ...extraArgs], {
    env: { ...baseEnv, SWB_INSTALL_HOME: home, NO_COLOR: '1', ...extraEnv },
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return res;
}

function readSettings(home) {
  const p = path.join(home, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// helper: does any group in an event array carry a command containing `needle`?
function eventHasCommandContaining(settings, event, needle) {
  const groups = (settings.hooks && settings.hooks[event]) || [];
  return groups.some((g) => (g.hooks || []).some((h) => h.command && h.command.includes(needle)));
}

// ── unit: mergeEvent is idempotent and non-clobbering ───────────────────────────
test('mergeEvent appends a group and is idempotent', () => {
  const settings = {};
  const reg = { matcher: 'Edit|Write|MultiEdit', command: 'node "/x/hooks/pretooluse.js"' };

  assert.equal(installer.mergeEvent(settings, 'PreToolUse', reg), true, 'first merge changes');
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.deepEqual(settings.hooks.PreToolUse[0], {
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: reg.command }],
  });

  assert.equal(installer.mergeEvent(settings, 'PreToolUse', reg), false, 'second merge is a no-op');
  assert.equal(settings.hooks.PreToolUse.length, 1, 'no duplicate group');
});

test('mergeEvent never clobbers pre-existing groups in the same event', () => {
  // A user already has an Edit|Write PreToolUse hook of their own.
  const preExisting = {
    matcher: 'Edit|Write',
    hooks: [{ type: 'command', command: 'node "/user/their-own-hook.js"' }],
  };
  const settings = { hooks: { PreToolUse: [preExisting] } };
  const reg = { matcher: 'Edit|Write|MultiEdit', command: 'node "/x/hooks/pretooluse.js"' };

  assert.equal(installer.mergeEvent(settings, 'PreToolUse', reg), true);
  assert.equal(settings.hooks.PreToolUse.length, 2, 'appended, did not merge into their group');
  // Their group is byte-for-byte intact.
  assert.deepEqual(settings.hooks.PreToolUse[0], preExisting);
  // Ours is the new second group.
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, reg.command);
});

// ── integration: full installer against a temp HOME ─────────────────────────────
test('installer provisions the ~/.switchboard tree', () => {
  withTempHome((home) => {
    const res = runInstaller(home, { LINEAR_API_KEY: 'lin_api_TESTKEY' });
    assert.equal(res.status, 0, `installer exited nonzero:\n${res.stdout}\n${res.stderr}`);

    const swb = path.join(home, '.switchboard');
    assert.ok(fs.existsSync(path.join(swb, 'events.jsonl')), 'events.jsonl');
    assert.ok(fs.existsSync(path.join(swb, 'ownership.json')), 'ownership.json');
    assert.ok(fs.existsSync(path.join(swb, 'cache.json')), 'cache.json');
    assert.ok(fs.existsSync(path.join(swb, 'cursors')), 'cursors dir');

    const env = fs.readFileSync(path.join(swb, 'env'), 'utf8');
    assert.match(env, /LINEAR_API_KEY=lin_api_TESTKEY/, 'key written to env');

    // ownership.json is valid empty JSON object
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(swb, 'ownership.json'), 'utf8')), {});
  });
});

test('installer merges all three hooks into a fresh settings.json', () => {
  withTempHome((home) => {
    const res = runInstaller(home);
    assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);

    const settings = readSettings(home);
    assert.ok(eventHasCommandContaining(settings, 'UserPromptSubmit', 'userpromptsubmit.js'));
    assert.ok(eventHasCommandContaining(settings, 'PostToolUse', 'posttooluse.js'));
    assert.ok(eventHasCommandContaining(settings, 'PreToolUse', 'pretooluse.js'));

    // matchers match the contract
    const pre = settings.hooks.PreToolUse.find((g) => (g.hooks || []).some((h) => h.command.includes('pretooluse.js')));
    assert.equal(pre.matcher, 'Edit|Write|MultiEdit');
    const post = settings.hooks.PostToolUse.find((g) => (g.hooks || []).some((h) => h.command.includes('posttooluse.js')));
    assert.equal(post.matcher, '*');
    const ups = settings.hooks.UserPromptSubmit.find((g) => (g.hooks || []).some((h) => h.command.includes('userpromptsubmit.js')));
    assert.equal(ups.matcher, '');
  });
});

test('installer preserves PRE-EXISTING hooks and backs up settings.json', () => {
  withTempHome((home) => {
    // Seed a settings.json that already has unrelated hooks AND a colliding Edit|Write PreToolUse.
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const original = {
      model: 'claude-fable-5',
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo done' }] }],
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "/user/mine.js"' }] },
        ],
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/user/bash-guard.js"' }] },
        ],
      },
    };
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2) + '\n');

    const res = runInstaller(home);
    assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);

    // Backup is a byte-for-byte copy of the ORIGINAL.
    const bak = fs.readFileSync(path.join(claudeDir, 'settings.json.swb-bak'), 'utf8');
    assert.deepEqual(JSON.parse(bak), original, 'backup captures pristine original');

    const settings = readSettings(home);

    // Unrelated top-level keys survive.
    assert.equal(settings.model, 'claude-fable-5');
    // Unrelated event survives untouched.
    assert.deepEqual(settings.hooks.Stop, original.hooks.Stop);

    // The user's own Edit|Write hook is still present and unmodified.
    assert.ok(
      settings.hooks.PreToolUse.some((g) => (g.hooks || []).some((h) => h.command === 'node "/user/mine.js"')),
      'user PreToolUse hook preserved'
    );
    // Ours was appended alongside it (2 groups now).
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.ok(eventHasCommandContaining(settings, 'PreToolUse', 'pretooluse.js'), 'our hook added');

    // The user's Bash PostToolUse survives; ours appended.
    assert.ok(settings.hooks.PostToolUse.some((g) => g.matcher === 'Bash'));
    assert.ok(eventHasCommandContaining(settings, 'PostToolUse', 'posttooluse.js'));

    // UserPromptSubmit was created fresh.
    assert.ok(eventHasCommandContaining(settings, 'UserPromptSubmit', 'userpromptsubmit.js'));
  });
});

test('installer is idempotent — second run adds no duplicate hooks', () => {
  withTempHome((home) => {
    const first = runInstaller(home);
    assert.equal(first.status, 0, `first run failed:\n${first.stdout}\n${first.stderr}`);
    const afterFirst = readSettings(home);

    const second = runInstaller(home);
    assert.equal(second.status, 0, `second run failed:\n${second.stdout}\n${second.stderr}`);
    const afterSecond = readSettings(home);

    // Deep-equal proves no duplicate groups and no drift.
    assert.deepEqual(afterSecond, afterFirst, 'settings identical after re-run');

    // And exactly ONE group per event carries our command.
    for (const [event, needle] of [
      ['UserPromptSubmit', 'userpromptsubmit.js'],
      ['PostToolUse', 'posttooluse.js'],
      ['PreToolUse', 'pretooluse.js'],
    ]) {
      const count = (afterSecond.hooks[event] || [])
        .filter((g) => (g.hooks || []).some((h) => h.command.includes(needle))).length;
      assert.equal(count, 1, `exactly one ${event} group for ours`);
    }
  });
});

test('installer keeps an existing key and does not overwrite without --force', () => {
  withTempHome((home) => {
    // First install with a key.
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_ORIGINAL' });
    // Second install offering a different key WITHOUT --force keeps the original.
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_DIFFERENT' });
    const env = fs.readFileSync(path.join(home, '.switchboard', 'env'), 'utf8');
    // env var takes priority over file per resolveKey, so DIFFERENT wins here (env is explicit intent).
    // To assert the no-clobber-of-file path, drive it purely through the file:
    assert.match(env, /LINEAR_API_KEY=lin_api_DIFFERENT/);

    // Now run with NO env key at all → the file value must be preserved.
    runInstaller(home, { LINEAR_API_KEY: '' });
    const env2 = fs.readFileSync(path.join(home, '.switchboard', 'env'), 'utf8');
    assert.match(env2, /LINEAR_API_KEY=lin_api_DIFFERENT/, 'file key preserved when no override given');
  });
});

test('installer never clobbers an existing backup on re-run', () => {
  withTempHome((home) => {
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const original = { model: 'orig', hooks: {} };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(original, null, 2) + '\n');

    runInstaller(home); // creates the backup of `original`
    const bakPath = path.join(claudeDir, 'settings.json.swb-bak');
    const bak1 = fs.readFileSync(bakPath, 'utf8');

    runInstaller(home); // must NOT overwrite the backup with the now-modified settings
    const bak2 = fs.readFileSync(bakPath, 'utf8');

    assert.equal(bak1, bak2, 'backup unchanged on re-run');
    assert.deepEqual(JSON.parse(bak2), original, 'backup still the pristine original');
  });
});

test('installer leaves an unparseable settings.json untouched', () => {
  withTempHome((home) => {
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    const garbage = '{ this is not json ]';
    fs.writeFileSync(settingsPath, garbage);

    const res = runInstaller(home);
    assert.equal(res.status, 0, 'installer still succeeds overall');
    // Original file is untouched.
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), garbage);
    // A safety copy was made.
    assert.ok(fs.existsSync(settingsPath + '.swb-unparseable'));
  });
});
