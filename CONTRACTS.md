# Switchboard — Build Contracts (v1, locked by mastermind 2026-07-06)

These interfaces are LAW for all builders. Deviations require a BUILDLOG.md entry and mastermind sign-off.
Spec context: `~/Desktop/AI Hackathon/switchboard-spec.html`. Read it once before building.

## Runtime & repo layout

- Node >= 18, **zero npm dependencies** (built-in `fetch`, `fs`, `path`, `child_process`, `node:test`).
- Cross-platform: no bash-isms in any `.js`; path handling via `path`; must run under PowerShell.
- Layout:
  ```
  swb.js                  # the entire CLI — ONE file, < 800 lines target
  hooks/userpromptsubmit.js
  hooks/posttooluse.js
  hooks/pretooluse.js
  install.js              # installer (run: node install.js)
  INSTALL.md
  test/swb.test.js        # unit tests, mocked fetch
  test/hooks.test.js      # stdin-fixture tests
  test/fixtures/*.json
  evidence/               # integration proof artifacts (mastermind writes)
  BUILDLOG.md CONTRACTS.md README.md
  ```
- **No builder runs `git commit`. Ever.** Mastermind commits.

## Config & state files (all under `~/.switchboard/`)

| File | Format | Owner |
|---|---|---|
| `env` | `KEY=VALUE` lines: `LINEAR_API_KEY`, optional `SWB_TEAM_KEY` | user |
| `cache.json` | `{fetchedAt: ISO, teamKey, issues: [...], comments: [...], states: {...}}` | swb |
| `cursors/<sessionId>.json` | `{lastSeenTs: ISO, lastInjectTs: ISO}` | hooks |
| `events.jsonl` | one JSON/line: `{ts, cmd, args, sessionId, ok, ms, error?}` — EVERY verb + hook appends | all |
| `ownership.json` | `{ "<ISSUE-KEY>": {files: [globs], assignee, sessionId, ts} }` | swb |

Repo-local: `.swb.json` → `{"teamKey": "SWB-or-team", "testCommand": "node --test", "defaultBranch": "master"}`.
Team resolution order: `.swb.json` teamKey → env `SWB_TEAM_KEY`. **Refuse to run without a resolved team.** All queries/mutations are filtered to that ONE team.

## Linear API contract

- Endpoint `https://api.linear.app/graphql`, header `Authorization: <key>` (no Bearer). Time-box every call at 5s.
- State mapping (swb name → Linear workflow state name): `Triage→Backlog`, `Ready→Todo`, `In Progress→In Progress`, `In Review→In Review`, `Done→Done`. `doctor` verifies all five exist on the team and prints which are missing (creating missing states via `workflowStateCreate` is a doctor `--fix` action).
- Every comment body ends with: `\n\n🤖 Claude — via {viewer.name} · swb v{VERSION}`.
- Test hygiene: every issue created by tests gets label `swb-test` (create label if missing); test teardown deletes all `swb-test` issues. Tests NEVER touch issues lacking that label.

## CLI surface (exact)

```
swb sync [--session <id>] [--hook]     # print delta digest since cursor; --hook = JSON hook output mode
swb claim <KEY> --files <g1,g2> [--session <id>]
swb done <KEY> --pr <url>              # runs .swb.json testCommand; exit!=0 → REFUSE with output
swb ask <KEY> <@user> "<question>"
swb discover "<text>"                  # appends repo DISCOVERIES.md + comments on pinned 'Discoveries' issue (label swb-meta, create on first use)
swb new "<title>" [--body "<b>"]       # ALWAYS created in Triage state
swb show <KEY>
swb release <KEY>
swb doctor [--fix]
```

- `claim` protocol: fetch issue → refuse if assignee set and ≠ viewer → set assignee+In Progress → sleep 1500ms → re-fetch → if assignee ≠ viewer, print back-off and exit 3. Then `git worktree add ../switchboard-wt/<KEY> -b <KEY>` (skip with warning if not in a git repo), write ownership.json, post claim comment listing files.
- `done` gate order: (1) run testCommand, stream output, refuse on non-zero; (2) require `--pr`; (3) move In Review; (4) post summary comment (arg `--summary` or generated from `git log -5 --oneline`); (5) ownership entry removed.
- **Fail-open recipe**: every mutation path wrapped; on ANY error print `MANUAL RECIPE:` + numbered steps a human can do in the Linear UI / terminal to accomplish the same thing, then exit 2. Never leave the user blocked on swb.
- Exit codes: 0 ok · 2 failed-with-recipe · 3 claim-lost-race.

## Digest format (exact)

```
── switchboard · {HH:MM} · cache {age}s · {N} new ──
@you   {KEY} {author}: "{comment ≤ 100 chars}" → swb show {KEY}
claim  {KEY} {title ≤ 40} → {assignee}   files: {globs}
state  {KEY} → {swb state name}
disc   {text ≤ 90} ({author})
new    {KEY} {title ≤ 60} [Triage]
act    if any item above touches your claimed ticket or declared files, state the impact before continuing
──
```
Max 12 item lines (drop oldest, note `+N more`). `@you` lines always first. Empty delta → print nothing (and in hook mode emit no context). The `act` line only appears when there ≥1 item.

## Hook contract (Claude Code)

All three hooks: read stdin JSON (`session_id`, `cwd`, `tool_input`...), never block (any internal error → exit 0, log to events.jsonl), delegate to `swb` logic (require/import swb.js internals or spawn `swb sync --hook`).

- `userpromptsubmit.js`: stale cache (>45s) → refetch; emit `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<digest>"}}`; nothing when delta empty.
- `posttooluse.js`: only if `now - lastInjectTs > 300s` AND delta non-empty → same additionalContext shape (hookEventName "PostToolUse"); update lastInjectTs.
- `pretooluse.js`: for Edit/Write/MultiEdit, resolve `tool_input.file_path` against ownership.json globs of OTHER sessions/assignees → if owned by someone else, emit `{"systemMessage":"⚠ switchboard: <file> is owned by <KEY> (<assignee>) — coordinate before editing"}`. ALWAYS allow (warn-only).
- Installer merges into `~/.claude/settings.json` (backup to `settings.json.swb-bak` first): UserPromptSubmit → node hook; PostToolUse matcher `*`; PreToolUse matcher `Edit|Write|MultiEdit`.

## Definition of done per component

- Unit tests green via `node --test` on Node 18+, no network.
- `swb doctor` green on this machine against team `HAC` (the designated scratch board; label-hygiene rules above are MANDATORY).
- Every claim in README/INSTALL verified by actually running the command.
