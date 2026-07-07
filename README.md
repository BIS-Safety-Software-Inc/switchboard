# Switchboard

**A coordination layer that turns Linear into shared memory for eight parallel
Claude Code sessions.** The terminal is the interface, Linear is the hub, humans
are the routing layer.

Eight devs each driving agents in their own terminal are eight islands:
discoveries die in context windows, claims go unseen, questions sit unread, and
two agents quietly build against incompatible assumptions. Switchboard is the
patch panel between the islands — a single-file CLI (`swb`) plus three Claude
Code hooks that inject "what changed since your last look" on every prompt.

The dev speaks English; their agent speaks `swb`; a digest keeps everyone
current without anyone opening Linear.

## Install

Node ≥ 18. Zero npm dependencies. Cross-platform (macOS / Linux / Windows).

```sh
git clone https://github.com/BIS-Safety-Software-Inc/switchboard.git && cd switchboard && node install.js
```

The installer verifies Node, creates `~/.switchboard/`, saves your
`LINEAR_API_KEY`, merges the three hooks into `~/.claude/settings.json` (backing
your original up first), drops a `swb` shim on your `PATH`, and runs
`swb doctor`. It is safe to run twice. Full details, PowerShell commands, and
uninstall steps are in **[INSTALL.md](./INSTALL.md)**.

## Architecture (in 10 lines)

1. **Three planes:** read (the digest), write (the protocol), guard (collision safety).
2. **Read — daemonless.** A hook checks `cache.json` age; only if stale (>45s) it fetches the team's board inline (time-boxed 5s), then injects a delta digest.
3. **Cache + per-session cursor** live under `~/.switchboard/`; each session only sees what changed since *its* last look.
4. **Write — one CLI, one file.** All Linear mutations go through idempotent `swb` verbs (`claim`, `ask`, `done`, `discover`, `new`, `release`) — never raw API calls.
5. **Every write is signed** `🤖 Claude — via <human> · swb v1.0.0`; the human is always the assignee.
6. **Gates are structural:** `swb new` lands in Triage (human promotes to Ready); `swb done` refuses without green tests + a PR (human merges to Done).
7. **Guard — two layers:** a git worktree per claimed ticket, plus a `PreToolUse` hook that *warns* (never blocks) when you edit a file another ticket has claimed.
8. **Three hooks:** `UserPromptSubmit` (digest every prompt), `PostToolUse` (mid-run injection, throttled ≥5 min), `PreToolUse` (ownership guard on Edit/Write/MultiEdit).
9. **Fails open:** any verb that errors prints a numbered `MANUAL RECIPE:` a human can follow by hand — nobody is ever blocked on the tool.
10. **Everything is one readable file** (`swb.js`) any dev can patch live, plus `events.jsonl` logging every verb and hook for the post-hoc experiment.

```
swb.js                  # the entire CLI — one file, zero deps
hooks/                  # userpromptsubmit · posttooluse · pretooluse
install.js  INSTALL.md  # installer + install/uninstall docs
PLAYBOOK.html           # the participant playbook (rules, roles, walkthrough)
AGENTS-template.md      # drop-in AGENTS.md protocol for team repos
CONTRACTS.md            # the build contract — interfaces are law
test/                   # node --test unit + live round-trip suites
```

## Read this before the hackathon

- **[PLAYBOOK.html](./PLAYBOOK.html)** — the one document participants read: how
  it works in 60 seconds, MUSTs vs DEFAULTs, role relationships, the Q&A loop,
  goal-loop rules, AI-captain duties, the 15-minute planning-day walkthrough, and
  troubleshooting. One screenful per role.
- **[AGENTS-template.md](./AGENTS-template.md)** — paste into your team repo so
  your agents follow the protocol (and it survives context compaction).
- **[INSTALL.md](./INSTALL.md)** — install, PATH setup, `SWITCHBOARD_HOME`,
  uninstall.
- **[CONTRACTS.md](./CONTRACTS.md)** — the locked build contract (for builders).

## Quick loop

```sh
swb sync                                   # what changed since your last look
swb claim HAC-42 --files "src/auth/**"     # assign → In Progress → worktree → declare files
swb ask HAC-23 @sarah "composite key?"     # signed question, lands in Sarah's next digest
swb done HAC-42 --pr https://…/pull/123     # refuses without green tests + PR → In Review
```

You never type these — your agent does, as ordinary Bash calls you see in the
permission flow.

---

Private project — managed via the `bis-new` dual-repo setup.
Canonical: `BIS-Safety-Software-Inc/switchboard` · mirror: `TurniSaha/switchboard` (auto-synced on push).
