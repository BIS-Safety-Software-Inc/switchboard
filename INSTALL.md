# Installing switchboard

`swb` is a single-file Node CLI plus three Claude Code hooks. It keeps a team
in sync on a Linear board straight from the terminal — claim a ticket, work it,
mark it done — and quietly surfaces what teammates are doing while you type.

**Requirements:** Node 18 or newer. Nothing else — zero npm dependencies.

Check your Node:

```sh
node --version   # must print v18.x or higher
```

---

## One-line install

### macOS / Linux

```sh
git clone https://github.com/BIS-Safety-Software-Inc/switchboard.git && cd switchboard && node install.js
```

### Windows (PowerShell)

```powershell
git clone https://github.com/BIS-Safety-Software-Inc/switchboard.git; cd switchboard; node install.js
```

The installer walks six steps and is **safe to run twice** (it never duplicates
hooks or overwrites your settings):

1. verifies Node ≥ 18
2. creates the `~/.switchboard/` state tree
3. asks for (or accepts) your `LINEAR_API_KEY` and writes `~/.switchboard/env` (mode `600` on macOS/Linux)
4. registers the three Claude Code hooks by **merging** into `~/.claude/settings.json` (your existing hooks are backed up to `settings.json.swb-bak` and left untouched)
5. drops a `swb` shim on your `PATH`
6. runs `swb doctor` and prints the result

### Providing the key without a prompt

```sh
node install.js --key lin_api_XXXXXXXX          # pass it directly
LINEAR_API_KEY=lin_api_XXXXXXXX node install.js  # or via env
node install.js --no-prompt                      # skip the key for now, add it later
```

Get a key from Linear → **Settings → API → Personal API keys**. It looks like
`lin_api_...`. Re-running the installer keeps a key you already saved unless you
pass a new one with `--key` (or `--force`).

### Finishing the PATH setup

The installer creates the shim but can't edit your shell profile for you. If it
warns that `~/.local/bin` (or `%USERPROFILE%\.local\bin`) is not on your `PATH`:

**macOS / Linux** — add to `~/.zshrc` or `~/.bashrc`, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

**Windows (PowerShell)** — run once, then open a new PowerShell window:

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\.local\bin", "User")
```

Confirm it worked:

```sh
swb doctor
```

A green `swb doctor` means the key is valid, your team resolves, and all five
Linear workflow states exist. If a state is missing, run `swb doctor --fix`.

---

## 60-second quickstart: claim → work → done

Run these from inside a git repo that has a `.swb.json` (see below). Every
command is real — nothing here is a placeholder.

**1. See what's happening on the board (5s)**

```sh
swb sync
```

Prints a short digest of new comments, claims, and state changes since you last
looked. Empty board? It prints nothing.

**2. Claim a ticket and the files you'll touch (10s)**

```sh
swb claim HAC-42 --files "src/auth/**,src/api/login.js"
```

This assigns the ticket to you, moves it to **In Progress**, creates a git
worktree at `../switchboard-wt/HAC-42`, and posts a comment listing your files.
If someone already holds it, `swb` backs off and tells you.

**3. Do the work.** Open a Claude Code session in the worktree. The hooks now
feed you the board digest as you go and warn you before editing a file another
teammate has claimed — no action needed on your part.

Found something worth sharing mid-task?

```sh
swb discover "auth tokens expire after 15m, not 60m as the docs say"
```

**4. Mark it done (10s)**

```sh
swb done HAC-42 --pr https://github.com/your-org/your-repo/pull/123
```

`swb` runs your test command first (from `.swb.json`) and **refuses** if tests
fail. On green, it moves the ticket to **In Review** and posts a summary.

That's the loop: `sync` → `claim` → work → `done`.

### The repo config: `.swb.json`

Each repo that uses `swb` needs a `.swb.json` at its root:

```json
{ "teamKey": "HAC", "testCommand": "node --test", "defaultBranch": "main" }
```

- `teamKey` — the Linear team every query and mutation is scoped to.
- `testCommand` — run by `swb done`; a non-zero exit blocks the transition.
- `defaultBranch` — used when creating worktrees.

Without a resolvable team (`.swb.json` `teamKey` or the `SWB_TEAM_KEY` env var),
`swb` refuses to run.

---

## Uninstall

Uninstalling is fully manual and reversible — the installer only ever *added*
things, and backed up whatever it touched.

**1. Restore your Claude Code settings.** The installer saved your original file
before merging:

```sh
# macOS / Linux
mv ~/.claude/settings.json.swb-bak ~/.claude/settings.json
```

```powershell
# Windows (PowerShell)
Move-Item "$env:USERPROFILE\.claude\settings.json.swb-bak" "$env:USERPROFILE\.claude\settings.json" -Force
```

If there is **no** `.swb-bak` file (you had no settings before installing, or
you've since made other edits you want to keep), just delete the three
switchboard hook groups by hand — search `~/.claude/settings.json` for
`hooks/userpromptsubmit.js`, `hooks/posttooluse.js`, and `hooks/pretooluse.js`
and remove those group objects.

**2. Remove the shim.**

```sh
# macOS / Linux
rm ~/.local/bin/swb
```

```powershell
# Windows (PowerShell)
Remove-Item "$env:USERPROFILE\.local\bin\swb.cmd"
```

**3. Remove the state and config.** This deletes your saved key, cache, and
event log — do it last.

```sh
# macOS / Linux
rm -rf ~/.switchboard
```

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.switchboard"
```

**4. (Optional) Remove the clone and any leftover worktrees.**

```sh
rm -rf /path/to/switchboard ../switchboard-wt
```

That's a complete removal — no daemons, no registry keys, no global npm
packages to hunt down.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `swb: command not found` | `~/.local/bin` isn't on `PATH` — see [Finishing the PATH setup](#finishing-the-path-setup), or run via `node /path/to/switchboard/swb.js`. |
| `swb doctor` says a workflow state is missing | Run `swb doctor --fix` to create the missing Linear states. |
| `LINEAR_API_KEY missing` | Add `LINEAR_API_KEY=lin_api_...` to `~/.switchboard/env`, or re-run `node install.js --key ...`. |
| `no team resolved` | Add a `.swb.json` with `"teamKey"` to your repo, or set `SWB_TEAM_KEY` in `~/.switchboard/env`. |
| Installer says `settings.json` is not valid JSON | It left your file untouched and saved a copy at `settings.json.swb-unparseable`. Fix the JSON, then re-run. |
