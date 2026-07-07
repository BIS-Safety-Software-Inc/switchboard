#!/usr/bin/env node
'use strict';

// switchboard installer — run: node install.js
//
// Idempotent, cross-platform (macOS / Linux / Windows PowerShell), ZERO npm deps.
// What it does:
//   1. verify Node >= 18
//   2. create the ~/.switchboard/ tree (env, cache.json, cursors/, events.jsonl, ownership.json)
//   3. resolve LINEAR_API_KEY (from --key, env, or interactive prompt) and write ~/.switchboard/env (chmod 600 where supported)
//   4. register the three Claude Code hooks by MERGING into ~/.claude/settings.json non-destructively
//      (backup to settings.json.swb-bak first; append groups; never clobber existing hooks)
//   5. put `swb` on PATH via a shim (~/.local/bin/swb on unix, %USERPROFILE%\.local\bin\swb.cmd on Windows)
//   6. run `swb doctor` and print its output
//
// Safe to run twice: re-running never duplicates hooks, never overwrites an existing key,
// and never re-clobbers the backup once one exists.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const MIN_NODE_MAJOR = 18;
const IS_WINDOWS = process.platform === 'win32';
const REPO_ROOT = __dirname;

// ── tiny logging helpers ────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function color(code, s) { return useColor ? `[${code}m${s}[0m` : s; }
const ok = (s) => console.log(`${color('32', '✓')} ${s}`);
const info = (s) => console.log(`${color('36', '›')} ${s}`);
const warn = (s) => console.log(`${color('33', '!')} ${s}`);
const step = (s) => console.log(`\n${color('1', s)}`);

// ── HOME resolution (env-overridable so tests can point at a temp dir) ───────
// NOTE: SWB_HOME is reserved by swb.js to mean the ~/.switchboard DIRECTORY (not the
// user home). To override the user home for tests, use SWB_INSTALL_HOME instead.
function resolveHome() {
  if (process.env.SWB_INSTALL_HOME) return process.env.SWB_INSTALL_HOME;
  if (IS_WINDOWS) {
    return process.env.USERPROFILE || process.env.HOMEPATH || os.homedir();
  }
  return process.env.HOME || os.homedir();
}

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { key: null, force: false, noPrompt: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' || a === '--linear-key') { args.key = argv[++i]; }
    else if (a.startsWith('--key=')) { args.key = a.slice('--key='.length); }
    else if (a === '--force') { args.force = true; }
    else if (a === '--no-prompt' || a === '--yes' || a === '-y') { args.noPrompt = true; }
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function printHelp() {
  console.log(`switchboard installer

Usage:
  node install.js [options]

Options:
  --key <LINEAR_API_KEY>   Provide the Linear API key non-interactively.
  --force                  Overwrite an existing LINEAR_API_KEY in ~/.switchboard/env.
  --no-prompt, -y          Never prompt; skip the key if none is supplied.
  --help, -h               Show this help.

Environment:
  LINEAR_API_KEY           Used if --key is not given.
  SWB_INSTALL_HOME         Override the user home directory (advanced / testing).
`);
}

// ── Node version gate ─────────────────────────────────────────────────────────
function verifyNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(
      `switchboard requires Node >= ${MIN_NODE_MAJOR}. You are running ${process.version}.\n` +
      `Install a newer Node (https://nodejs.org) and re-run: node install.js`
    );
    process.exit(1);
  }
  ok(`Node ${process.version} (>= ${MIN_NODE_MAJOR})`);
}

// ── directory tree ─────────────────────────────────────────────────────────────
function ensureTree(swbDir) {
  const cursorsDir = path.join(swbDir, 'cursors');
  fs.mkdirSync(swbDir, { recursive: true });
  fs.mkdirSync(cursorsDir, { recursive: true });

  // Seed empty state files only if absent — never truncate existing state.
  ensureFile(path.join(swbDir, 'events.jsonl'), '');
  ensureFile(path.join(swbDir, 'ownership.json'), '{}\n');
  ensureFile(
    path.join(swbDir, 'cache.json'),
    JSON.stringify({ fetchedAt: null, teamKey: null, issues: [], comments: [], states: {} }, null, 2) + '\n'
  );

  ok(`state tree at ${swbDir}`);
  return { cursorsDir };
}

function ensureFile(p, contents) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, contents);
}

// ── env file with LINEAR_API_KEY ───────────────────────────────────────────────
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function serializeEnv(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

// Resolve the key the user is *explicitly* supplying this run (flag > env > prompt).
// Returns '' when the user supplied nothing new — the caller then keeps whatever is on disk.
async function resolveExplicitKey(args, existingKey) {
  if (args.key) return args.key.trim();
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY.trim();
  if (args.noPrompt || !process.stdin.isTTY) return ''; // nothing new offered
  if (existingKey && !args.force) return ''; // already have one; don't nag

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Enter your LINEAR_API_KEY (blank to skip for now): ', resolve);
  });
  rl.close();
  return answer.trim();
}

async function writeEnv(swbDir, args) {
  const envPath = path.join(swbDir, 'env');
  const existing = fs.existsSync(envPath) ? parseEnvFile(fs.readFileSync(envPath, 'utf8')) : {};
  const existingKey = existing.LINEAR_API_KEY || '';

  const explicitKey = await resolveExplicitKey(args, existingKey);

  const next = { ...existing };
  if (explicitKey) {
    // An explicitly supplied key is deliberate intent → apply it.
    if (existingKey && existingKey !== explicitKey) {
      info('replacing existing LINEAR_API_KEY with the newly supplied value.');
    }
    next.LINEAR_API_KEY = explicitKey;
  }
  // else: no new key offered → keep the existing file value untouched.

  // Write the file even if the key is blank so the location exists and is documented.
  const header = '# switchboard config — see INSTALL.md\n# LINEAR_API_KEY=lin_api_...\n# optional: SWB_TEAM_KEY=HAC\n';
  const body = Object.keys(next).length ? serializeEnv(next) : '';
  fs.writeFileSync(envPath, header + body);
  chmod600(envPath);

  if (next.LINEAR_API_KEY) ok(`LINEAR_API_KEY written to ${envPath}`);
  else warn(`No LINEAR_API_KEY yet — add one to ${envPath} before using swb.`);
  return envPath;
}

function chmod600(p) {
  // chmod is a no-op / unsupported on Windows; guard it.
  if (IS_WINDOWS) return;
  try { fs.chmodSync(p, 0o600); } catch (_) { /* best-effort */ }
}

// ── settings.json hook merge (the delicate part) ────────────────────────────────
// Registrations are keyed on the exact command string, so a re-run is a no-op.
function hookRegistrations() {
  const nodeBin = 'node';
  const hookCmd = (file) => `${nodeBin} "${path.join(REPO_ROOT, 'hooks', file)}"`;
  return {
    UserPromptSubmit: { matcher: '', command: hookCmd('userpromptsubmit.js') },
    PostToolUse: { matcher: '*', command: hookCmd('posttooluse.js') },
    PreToolUse: { matcher: 'Edit|Write|MultiEdit', command: hookCmd('pretooluse.js') },
  };
}

function groupHasCommand(group, command) {
  return Array.isArray(group.hooks) && group.hooks.some((h) => h && h.command === command);
}

// Merge one registration into the array for an event, non-destructively.
// Returns true if a change was made.
function mergeEvent(settings, eventName, reg) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks[eventName])) settings.hooks[eventName] = [];
  const groups = settings.hooks[eventName];

  // Already registered anywhere in this event? Nothing to do (idempotent).
  if (groups.some((g) => g && groupHasCommand(g, reg.command))) return false;

  // Append a fresh, isolated group so we never mutate the user's existing groups.
  groups.push({ matcher: reg.matcher, hooks: [{ type: 'command', command: reg.command }] });
  return true;
}

function mergeSettings(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const backupPath = path.join(claudeDir, 'settings.json.swb-bak');

  fs.mkdirSync(claudeDir, { recursive: true });

  let settings = {};
  let raw = '';
  if (fs.existsSync(settingsPath)) {
    raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
      // Do not risk corrupting a file we can't parse. Back it up and refuse to merge.
      const bad = settingsPath + '.swb-unparseable';
      fs.writeFileSync(bad, raw);
      warn(`~/.claude/settings.json is not valid JSON. Left it untouched; saved a copy at ${bad}.`);
      warn('Add the switchboard hooks manually (see INSTALL.md) once the file parses.');
      return { settingsPath, changed: false };
    }
  }

  // Back up the pristine file exactly once, before our first modification.
  if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, raw);
    info(`backed up settings.json → ${path.basename(backupPath)}`);
  }

  const regs = hookRegistrations();
  let changed = false;
  changed = mergeEvent(settings, 'UserPromptSubmit', regs.UserPromptSubmit) || changed;
  changed = mergeEvent(settings, 'PostToolUse', regs.PostToolUse) || changed;
  changed = mergeEvent(settings, 'PreToolUse', regs.PreToolUse) || changed;

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    ok('switchboard hooks merged into settings.json');
  } else {
    ok('switchboard hooks already present (no change)');
  }
  return { settingsPath, changed };
}

// ── PATH shim ───────────────────────────────────────────────────────────────
function installShim(home) {
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const swbTarget = path.join(REPO_ROOT, 'swb.js');

  if (IS_WINDOWS) {
    const cmdPath = path.join(binDir, 'swb.cmd');
    const contents = `@echo off\r\nnode "${swbTarget}" %*\r\n`;
    fs.writeFileSync(cmdPath, contents);
    ok(`shim at ${cmdPath}`);
    if (!onPath(binDir)) {
      warn(`${binDir} is not on PATH. Add it in PowerShell (persists across sessions):`);
      console.log(`    [Environment]::SetEnvironmentVariable("Path", "$env:Path;${binDir}", "User")`);
      console.log('    # then open a new PowerShell window');
    }
    return cmdPath;
  }

  const shimPath = path.join(binDir, 'swb');
  const contents = `#!/bin/sh\nexec node "${swbTarget}" "$@"\n`;
  fs.writeFileSync(shimPath, contents);
  try { fs.chmodSync(shimPath, 0o755); } catch (_) { /* best-effort */ }
  ok(`shim at ${shimPath}`);
  if (!onPath(binDir)) {
    warn(`${binDir} is not on PATH. Add it to your shell profile:`);
    console.log(`    export PATH="$HOME/.local/bin:$PATH"`);
  }
  return shimPath;
}

function onPath(dir) {
  const parts = (process.env.PATH || '').split(IS_WINDOWS ? ';' : ':');
  const norm = (p) => path.resolve(p).toLowerCase();
  const target = norm(dir);
  return parts.some((p) => p && norm(p) === target);
}

// ── run swb doctor ─────────────────────────────────────────────────────────────
function runDoctor(swbDir) {
  step('Running: swb doctor');
  const swbTarget = path.join(REPO_ROOT, 'swb.js');
  if (!fs.existsSync(swbTarget)) {
    warn(`swb.js not found at ${swbTarget}; skipping doctor. Run "swb doctor" after the CLI is present.`);
    return;
  }
  // swb.js reads SWB_HOME as the ~/.switchboard directory it operates on. Point it at
  // the exact tree we just provisioned so doctor never writes to a different location.
  const childEnv = { ...process.env, SWB_HOME: swbDir };
  const res = cp.spawnSync(process.execPath, [swbTarget, 'doctor'], {
    stdio: 'inherit',
    env: childEnv,
    cwd: REPO_ROOT,
  });
  if (res.error) {
    warn(`could not run swb doctor: ${res.error.message}`);
  } else if (res.status !== 0) {
    warn(`swb doctor exited ${res.status} — see output above (often just a missing LINEAR_API_KEY).`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  console.log(color('1', 'switchboard installer'));

  step('1/6  Checking Node');
  verifyNode();

  const home = resolveHome();
  const swbDir = path.join(home, '.switchboard');
  const claudeDir = path.join(home, '.claude');

  step('2/6  Creating ~/.switchboard/');
  ensureTree(swbDir);

  step('3/6  Configuring Linear API key');
  await writeEnv(swbDir, args);

  step('4/6  Registering Claude Code hooks');
  mergeSettings(claudeDir);

  step('5/6  Installing swb shim');
  installShim(home);

  // step 6 = doctor
  runDoctor(swbDir);

  console.log(`\n${color('32', 'Done.')} switchboard installed. Next: open a Claude Code session and run  swb sync`);
}

// Only run the installer when invoked directly (node install.js), never on require().
// Tests import this module for the pure merge helpers and must not trigger a real install.
if (require.main === module) {
  main().catch((err) => {
    console.error(`\ninstall failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

// Exported for tests (only the pure, side-effect-light pieces).
module.exports = {
  parseArgs,
  parseEnvFile,
  serializeEnv,
  mergeEvent,
  mergeSettings,
  hookRegistrations,
  groupHasCommand,
};
