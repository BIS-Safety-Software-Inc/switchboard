# Switchboard — Evidence Index

Every claim below was produced by actually running the thing, on this machine, against live Linear (team HAC, scratch board). Where a claim matters, the raw output is in this tree.

## 1. The go/no-go: does an injected digest change another agent's behavior?

**PASS — 3/3 runs** (gate was 2/3). `coordination-proof/`

Method: two real Claude Code sessions (subprocesses, distinct session ids) in two clones of a toy project sharing a contract file. Session A claims its ticket, changes the contract to a composite key, broadcasts via `swb discover` + `swb ask` @-mentioning B. Session B — whose follow-up prompt was strictly neutral ("continue with your ticket") — surfaced the change and stated the impact in all three runs, knowledge deliverable only by the UserPromptSubmit digest. No simulation: real hook, real events.jsonl trail (`runN/B-hook-events.jsonl`), B's clone never contained the new contract (`consumer-after-*.js`, `schema-after-A-change.js`).

- `coordination-proof/README.md` — method + results table
- `coordination-proof/run{1,2,3}/` — injected digest, B transcripts (turn 1 + measurement), cursors, cache snapshots, ticket keys, session ids
- `coordination-proof/harness-*.{sh,js}` — the exact auditable harness

## 2. Collision safety

**PASS.** `collision-proof/`

- Claim race, 3/3 runs, 27/27 assertions: two simultaneous `swb claim` processes → exactly one winner; loser exits 3 with the back-off message, creates no worktree, no ownership entry. Authoritative trail in each run's events.jsonl.
- Ownership guard, 4/4: foreign-session edit of an owned file → systemMessage warn naming issue + owner; non-owned file → silence; subagent-shaped stdin → still warns; corrupted ownership.json → still exit 0 (never blocks).
- **Known limitation** (`collision-proof/single-key-finding/`): the race arbiter compares Linear user ids, so two sessions under the SAME API key (same human) do not exclude each other — the exit-3 path requires different Linear users, which is the real pilot topology (one key per dev). Same-dev sessions are governed by the one-claim-per-dev WIP rule instead.

## 3. Live E2E verb loop (iter-2 smoke)

Full loop run for real against HAC: `new` (→Triage, labelled) → API promote (PM gate) → `claim` (assignee + In Progress + worktree + ownership + signed comment) → `ask` → second-session `sync` (digest showed claim + act line) → `done` (test-gate streamed, → In Review, summary comment, ownership cleared) → `show` → full board cleanup. Recorded in BUILDLOG iter-2 and the workflow journals (session transcript dirs in BUILDLOG).

## 4. Test suite

`node --test` (bare form): 69 tests, 66 pass, 0 fail, 3 live-gated skips. With `SWB_LIVE_LINEAR_KEY` exported: the live round-trips run too — sync populates a schema-v2 cache, new→Triage with swb-test label, show/claim/release round-trip, @you first-name mention surfaces in a second session's digest, teardown leaves zero swb-test issues.

## 5. Known-honest gaps (for the July 9 dry run)

- **Windows untested on real hardware.** Code is cross-platform by construction (pure Node, no bash-isms, .cmd shim, path handling) and reviewed for it, but no live Windows run has happened. First dry-run item.
- **Same-key sessions don't race-exclude** (above). Documented in PLAYBOOK.
- **Digest cache staleness window**: the hook refetches when cache >45s stale; a broadcast landing mid-turn can wait until the next prompt. Mid-turn PostToolUse injection (300s throttle) narrows but does not close this.
- The Linear API key used throughout this build was pasted in chat once — **rotate it before July 13** and never attach it to the real hackathon boards.
