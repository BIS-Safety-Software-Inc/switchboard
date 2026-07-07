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

test('mergeEvent omits the matcher key for a matcher-less registration', () => {
  const settings = {};
  // A registration with NO matcher property (non-tool event, e.g. UserPromptSubmit).
  const reg = { command: 'node "/x/hooks/userpromptsubmit.js"' };

  assert.equal(installer.mergeEvent(settings, 'UserPromptSubmit', reg), true);
  const group = settings.hooks.UserPromptSubmit[0];
  assert.deepEqual(group, { hooks: [{ type: 'command', command: reg.command }] });
  assert.equal(Object.prototype.hasOwnProperty.call(group, 'matcher'), false, 'no matcher key emitted');
});

test('hookRegistrations gives UserPromptSubmit no matcher, tool events a matcher', () => {
  const regs = installer.hookRegistrations();
  assert.equal(Object.prototype.hasOwnProperty.call(regs.UserPromptSubmit, 'matcher'), false,
    'UserPromptSubmit registration carries no matcher');
  assert.equal(regs.PostToolUse.matcher, '*');
  assert.equal(regs.PreToolUse.matcher, 'Edit|Write|MultiEdit|Bash');
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
    assert.equal(pre.matcher, 'Edit|Write|MultiEdit|Bash');
    const post = settings.hooks.PostToolUse.find((g) => (g.hooks || []).some((h) => h.command.includes('posttooluse.js')));
    assert.equal(post.matcher, '*');
    // UserPromptSubmit is not a tool event → the group carries NO matcher key at all.
    const ups = settings.hooks.UserPromptSubmit.find((g) => (g.hooks || []).some((h) => h.command.includes('userpromptsubmit.js')));
    assert.equal(Object.prototype.hasOwnProperty.call(ups, 'matcher'), false, 'UserPromptSubmit group must have no matcher key');
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

function savedKey(home) {
  const env = fs.readFileSync(path.join(home, '.switchboard', 'env'), 'utf8');
  const m = env.match(/^LINEAR_API_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}

test('an exported LINEAR_API_KEY seeds a key only when none is saved yet', () => {
  withTempHome((home) => {
    // Fresh tree, no saved key → the exported env var SEEDS it.
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_SEED' });
    assert.equal(savedKey(home), 'lin_api_SEED', 'env var seeds the initial key');
  });
});

test('an exported LINEAR_API_KEY alone does NOT clobber a saved key', () => {
  withTempHome((home) => {
    // Save an original key.
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_ORIGINAL' });
    assert.equal(savedKey(home), 'lin_api_ORIGINAL');

    // Re-run with a DIFFERENT exported key but NO --key and NO --force.
    // Per the no-clobber rule, the saved key must survive untouched.
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_DIFFERENT' });
    assert.equal(savedKey(home), 'lin_api_ORIGINAL', 'shell-exported key must not silently clobber the saved key');
  });
});

test('--force lets an exported LINEAR_API_KEY replace a saved key', () => {
  withTempHome((home) => {
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_ORIGINAL' });
    // With --force, the exported key is allowed to replace the saved one.
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_FORCED' }, ['--force']);
    assert.equal(savedKey(home), 'lin_api_FORCED', '--force + env key replaces the saved key');
  });
});

test('--key always replaces the saved key, even without --force', () => {
  withTempHome((home) => {
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_ORIGINAL' });
    // --key is explicit intent → replaces unconditionally. No exported env key here.
    runInstaller(home, {}, ['--key', 'lin_api_VIAFLAG']);
    assert.equal(savedKey(home), 'lin_api_VIAFLAG', '--key replaces the saved key');
  });
});

test('installer preserves the saved key when no key is offered at all', () => {
  withTempHome((home) => {
    runInstaller(home, { LINEAR_API_KEY: 'lin_api_KEEP' });
    // No --key, no --force, no exported LINEAR_API_KEY → nothing to change.
    runInstaller(home, { LINEAR_API_KEY: '' });
    assert.equal(savedKey(home), 'lin_api_KEEP', 'saved key preserved when no override given');
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

test('installer drops the /swb-tour command and stays idempotent', () => {
  withTempHome((home) => {
    const res = runInstaller(home);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const tourPath = path.join(home, '.claude', 'commands', 'swb-tour.md');
    assert.ok(fs.existsSync(tourPath), 'swb-tour.md copied into ~/.claude/commands/');
    const first = fs.readFileSync(tourPath, 'utf8');
    assert.match(first, /Switchboard tour/i, 'tour content present');

    const res2 = runInstaller(home); // re-run must not fail or mangle the file
    assert.equal(res2.status, 0);
    assert.equal(fs.readFileSync(tourPath, 'utf8'), first, 'tour file identical after re-run');
  });
});
