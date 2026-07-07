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
// NOTE: SWITCHBOARD_HOME is the ONE name (per CONTRACTS) for overriding the
// ~/.switchboard state/config DIRECTORY — swb.js, the hooks, and this installer all
// honor it. That is NOT the same as the user home. To override the user *home* for
// tests, use SWB_INSTALL_HOME instead. The installer never sets SWITCHBOARD_HOME; by
// default the tree lives under the resolved user home.
function resolveHome() {
  if (process.env.SWB_INSTALL_HOME) return process.env.SWB_INSTALL_HOME;
  if (IS_WINDOWS) {
    return process.env.USERPROFILE || process.env.HOMEPATH || os.homedir();
  }
  return process.env.HOME || os.homedir();
}

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { key: null, force: false, noPrompt: false, noOpen: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' || a === '--linear-key') { args.key = argv[++i]; }
    else if (a.startsWith('--key=')) { args.key = a.slice('--key='.length); }
    else if (a === '--force') { args.force = true; }
    else if (a === '--no-prompt' || a === '--yes' || a === '-y') { args.noPrompt = true; }
    else if (a === '--no-open') { args.noOpen = true; }
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function printHelp() {
  console.log(`switchboard installer

Usage:
  node install.js [options]

Options:
  --key <LINEAR_API_KEY>   Provide the Linear API key non-interactively (always saved,
                           replacing any existing saved key).
  --force                  Allow an exported LINEAR_API_KEY (or a prompt) to REPLACE the
                           key already saved in ~/.switchboard/env.
  --no-prompt, -y          Never prompt; skip the key if none is supplied.
  --no-open                Don't open PLAYBOOK.html in the browser at the end.
  --help, -h               Show this help.

Environment:
  LINEAR_API_KEY           Seeds the saved key when none exists yet. It does NOT overwrite
                           an already-saved key unless you also pass --force (use --key to
                           set a new key unconditionally).
  SWITCHBOARD_HOME         Override the ~/.switchboard state/config directory. The installer
                           itself never sets this; set it yourself to relocate the tree.
  SWB_INSTALL_HOME         Override the user home directory (advanced / testing only).
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
  // Seed an empty cache.json shaped to CANONICAL SCHEMA v2 (swb.js overwrites it on first
  // fetch). Keys mirror the contract so a never-synced tree still parses cleanly.
  ensureFile(
    path.join(swbDir, 'cache.json'),
    JSON.stringify(
      { fetchedAt: null, teamKey: null, viewer: null, states: {}, issues: [], comments: [] },
      null,
      2
    ) + '\n'
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

// Resolve the key the user is supplying this run, honoring the no-clobber rule:
//
//   A saved key is REPLACED only when the user is explicit — i.e. passes --key or --force.
//   A shell-exported LINEAR_API_KEY on its own must NEVER silently clobber a saved key;
//   it only SEEDS a key when none is saved yet.
//
// Returns '' when nothing should change on disk — the caller then keeps whatever is saved.
async function resolveExplicitKey(args, existingKey) {
  // --key is the most explicit signal of intent: always apply it (seeds or replaces).
  if (args.key) return args.key.trim();

  // A shell-exported LINEAR_API_KEY seeds a missing key, but only replaces a saved one
  // when the user ALSO passes --force. Without --force + an existing key, it's ignored.
  const envKey = (process.env.LINEAR_API_KEY || '').trim();
  if (envKey) {
    if (!existingKey || args.force) return envKey;
    return ''; // saved key present and no --force → do not clobber
  }

  // No key on the command line or in the environment.
  if (args.noPrompt || !process.stdin.isTTY) return ''; // nothing new offered
  if (existingKey && !args.force) return ''; // already have one; don't nag

  // Interactive install with no key anywhere: the key is MANDATORY. Print the
  // exact click-path here — this prompt is the moment the user actually needs
  // it, not a doc they already scrolled past. Loop until a plausible key is
  // pasted AND Linear accepts it; Ctrl-C is the only way out without one.
  console.log('');
  console.log(color('1', 'You need your PERSONAL Linear API key (takes ~1 minute):'));
  console.log('  1. Open linear.app and log in (accept the workspace invite first if you haven\'t)');
  console.log('  2. Click the workspace name (top-left) → Settings');
  console.log('  3. Security & access → Personal API keys → New API key');
  console.log('  4. Name it "switchboard", create it, and copy the lin_api_... value');
  console.log('  (Every person needs their OWN key — never share one.)');
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askOnce = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    for (;;) {
      const answer = (await askOnce('Paste your LINEAR_API_KEY: ')).trim();
      if (!answer) {
        warn('The key is required — switchboard cannot talk to your board without it. (Ctrl-C to abort the install.)');
        continue;
      }
      if (!/^lin_api_/.test(answer)) {
        warn('That doesn\'t look like a Linear API key (they start with lin_api_). Copy the WHOLE value from step 4.');
        continue;
      }
      const who = await validateKeyLive(answer);
      if (who === null) {
        warn('Linear rejected that key — re-copy it (the full value, no spaces), or mint a fresh one and try again.');
        continue;
      }
      if (who) ok(`key works — hello, ${who}`);
      return answer;
    }
  } finally {
    rl.close();
  }
}

// Quick live check: does Linear accept this key? Returns the viewer name,
// '' when the check could not run (offline — accept the key, doctor will judge
// it later), or null when Linear explicitly rejected it.
async function validateKeyLive(key) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query: '{ viewer { name } }' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    if (json && json.data && json.data.viewer && json.data.viewer.name) return json.data.viewer.name;
    return null; // HTTP-level or auth error → explicit rejection
  } catch (_) {
    return ''; // network trouble → don't block the install on it; doctor re-checks
  }
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

  if (next.LINEAR_API_KEY) {
    ok(`LINEAR_API_KEY written to ${envPath}`);
  } else {
    warn(`No LINEAR_API_KEY yet — swb will NOT work until you add one.`);
    warn(`Get one: linear.app → workspace name → Settings → Security & access → Personal API keys.`);
    warn(`Then re-run: node install.js`);
  }
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
    // UserPromptSubmit is NOT a tool event — it has no tool to match against, so we emit
    // NO matcher key at all (matcher omitted). A matcher: "" here would be a meaningless
    // (and technically wrong) field for a non-tool event.
    UserPromptSubmit: { command: hookCmd('userpromptsubmit.js') },
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
  // Only carry a `matcher` key when the registration actually has one — non-tool
  // events (UserPromptSubmit) emit a group with no matcher field at all.
  const group = { hooks: [{ type: 'command', command: reg.command }] };
  if (Object.prototype.hasOwnProperty.call(reg, 'matcher')) group.matcher = reg.matcher;
  groups.push(group);
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

// ── /swb-tour command ──────────────────────────────────────────────────────────
// Copies the guided-tour slash command into ~/.claude/commands/ so a dev can type
// /swb-tour in any Claude Code session and be walked through the real loop.
function installTourCommand(claudeDir) {
  const src = path.join(REPO_ROOT, 'commands', 'swb-tour.md');
  if (!fs.existsSync(src)) {
    warn(`tour command source missing at ${src}; skipping /swb-tour install.`);
    return;
  }
  const cmdDir = path.join(claudeDir, 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  const dest = path.join(cmdDir, 'swb-tour.md');
  fs.copyFileSync(src, dest);
  ok(`/swb-tour command at ${dest}`);
}

// ── open the playbook ──────────────────────────────────────────────────────────
// Best-effort, fail-soft: a broken opener must never fail the install. Skipped in
// non-TTY runs (tests, CI) and with --no-open.
function openPlaybook(args) {
  const playbook = path.join(REPO_ROOT, 'PLAYBOOK.html');
  if (!fs.existsSync(playbook)) return;
  info(`playbook: ${playbook}`);
  if (args.noOpen || !process.stdout.isTTY) return;
  try {
    if (process.platform === 'darwin') cp.spawn('open', [playbook], { detached: true, stdio: 'ignore' }).unref();
    else if (IS_WINDOWS) cp.spawn('cmd', ['/c', 'start', '', playbook], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('xdg-open', [playbook], { detached: true, stdio: 'ignore' }).unref();
    ok('opened PLAYBOOK.html in your browser');
  } catch (err) {
    warn(`could not open the playbook automatically (${err.message}) — open it yourself: ${playbook}`);
  }
}

// ── run swb doctor ─────────────────────────────────────────────────────────────
const DOCTOR_TIMEOUT_MS = 30000;

// swb resolves its team from the .swb.json in the directory it runs in. Validate against
// the user's own project when they launched the installer from one (their cwd has a
// .swb.json), otherwise fall back to the switchboard repo root.
function doctorCwd() {
  const userCwd = process.cwd();
  if (userCwd !== REPO_ROOT && fs.existsSync(path.join(userCwd, '.swb.json'))) return userCwd;
  return REPO_ROOT;
}

// Best-effort read of the team swb doctor will validate against, so we can print a note.
// Mirrors swb's resolution order: .swb.json teamKey → SWB_TEAM_KEY.
function resolvedTeam(cwd, swbDir) {
  try {
    const cfgPath = path.join(cwd, '.swb.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.teamKey) return { team: cfg.teamKey, source: `.swb.json in ${cwd}` };
    }
  } catch (_) { /* ignore unparseable config; swb will surface it */ }
  const envMap = fs.existsSync(path.join(swbDir, 'env'))
    ? parseEnvFile(fs.readFileSync(path.join(swbDir, 'env'), 'utf8'))
    : {};
  const envTeam = envMap.SWB_TEAM_KEY || (process.env.SWB_TEAM_KEY || '').trim();
  if (envTeam) return { team: envTeam, source: 'SWB_TEAM_KEY' };
  return { team: null, source: null };
}

function runDoctor(swbDir) {
  step('Running: swb doctor');
  const swbTarget = path.join(REPO_ROOT, 'swb.js');
  if (!fs.existsSync(swbTarget)) {
    warn(`swb.js not found at ${swbTarget}; skipping doctor. Run "swb doctor" after the CLI is present.`);
    return;
  }

  const cwd = doctorCwd();
  const { team, source } = resolvedTeam(cwd, swbDir);
  if (team) info(`doctor will validate against team ${team} (${source}), running in ${cwd}`);
  else info(`doctor will run in ${cwd} (no team resolved yet — add a .swb.json teamKey or SWB_TEAM_KEY)`);

  // SWITCHBOARD_HOME is the ONE override name swb.js honors for its ~/.switchboard dir.
  // Point it at the exact tree we just provisioned so doctor never writes elsewhere.
  const childEnv = { ...process.env, SWITCHBOARD_HOME: swbDir };
  const res = cp.spawnSync(process.execPath, [swbTarget, 'doctor'], {
    stdio: 'inherit',
    env: childEnv,
    cwd,
    timeout: DOCTOR_TIMEOUT_MS,
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      warn(`swb doctor timed out after ${DOCTOR_TIMEOUT_MS / 1000}s — check network / LINEAR_API_KEY, then run "swb doctor" manually.`);
    } else {
      warn(`could not run swb doctor: ${res.error.message}`);
    }
  } else if (res.status !== 0) {
    warn(`swb doctor exited ${res.status} — see output above (often just a missing LINEAR_API_KEY).`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  console.log(color('1', 'switchboard installer'));

  step('1/7  Checking Node');
  verifyNode();

  const home = resolveHome();
  const swbDir = path.join(home, '.switchboard');
  const claudeDir = path.join(home, '.claude');

  step('2/7  Creating ~/.switchboard/');
  ensureTree(swbDir);

  step('3/7  Configuring Linear API key');
  await writeEnv(swbDir, args);

  step('4/7  Registering Claude Code hooks');
  mergeSettings(claudeDir);

  step('5/7  Installing swb shim');
  installShim(home);

  step('6/7  Installing /swb-tour command');
  installTourCommand(claudeDir);

  // step 7 = doctor
  runDoctor(swbDir);

  openPlaybook(args);

  console.log(`\n${color('32', 'Done.')} switchboard installed. Next: open a Claude Code session and type  /swb-tour`);
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
  validateKeyLive,
  parseEnvFile,
  serializeEnv,
  mergeEvent,
  mergeSettings,
  hookRegistrations,
  groupHasCommand,
};
