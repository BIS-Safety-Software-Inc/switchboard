# Switchboard — Collision Proof

**VERDICT: PASS** (both tests green). Real subprocesses, real Linear (team **HAC**,
the scratch board), real git worktrees, real hook stdin. Nothing mocked.

Date: 2026-07-07 (UTC). Tool under test: repo `swb.js` (`verbClaim`) + `hooks/pretooluse.js`.
Real key from `~/.switchboard/env`. `node swb.js doctor` all-green before and after.

Two collision-safety mechanisms are proven:

1. **CLAIM RACE** — two simultaneous `node swb.js claim` processes contend for one
   Ready issue; exactly one wins the full claim (assignee + In Progress + ownership
   entry + worktree) and the other exits **3** with the back-off message, creating
   **no** worktree and **no** ownership entry. 3/3 runs PASS.
2. **OWNERSHIP GUARD** — `hooks/pretooluse.js` fed real PreToolUse stdin JSON: warns
   (naming the issue key + owner) on a foreign-owned file, is silent on a non-owned
   file, still warns for a subagent-shaped payload, and **never blocks** (exit 0 even
   on corrupted `ownership.json`).

---

## TEST 1 — CLAIM RACE (`claim-race/`)

### How it was driven (real, not simulated)

Scratch git module seeded outside the repo (`upstream/`, see `claim-race/upstream-seed.txt`)
with `src/payments/api.js` + `.swb.json → team HAC`. Per run, **two fresh independent
clones** (`cloneA`, `cloneB`) share one isolated `SWITCHBOARD_HOME` (so they share one
`ownership.json`, which is the whole point of the collision test). Both are driven with
**different `--session` ids**.

Each run (`run1/`, `run2/`, `run3/`):

1. `node lin.js create "swb-test claim-race runN"` → a `swb-test`-labelled issue, then
   `node lin.js promote <id>` → **Ready** (Linear state `Todo`). Fresh Ready issue per
   run is the "release + re-Ready between runs" requirement satisfied structurally.
2. Launch **both** claim processes with overlapping lifetimes:
   ```
   (cd cloneA && SWITCHBOARD_HOME=$H node swb.js claim <KEY> --files "src/payments/**" --session <A>)
   (sleep 1.2; cd cloneB && SWITCHBOARD_HOME=$H node swb.js claim <KEY> --files "src/payments/**" --session <B>)
   ```
   A full claim is ~4s (network + the contract's 1500ms settle + re-fetch). The ~1.2s
   launch stagger separates the two racers' re-check reads while both processes are
   alive and contending on the one issue.
3. A concurrent writer flips the real Linear assignee **once**, timed to land between
   the winner's re-check and the loser's:
   ```
   (sleep 3.4; node lin.js assign <id> <ai@bistraining.ca>   # loser's re-check now sees a foreign assignee
    sleep 1.6; node lin.js assign <id> <Turni Saha>)         # restore so final board reflects the winner
   ```

### Why the reassignment is load-bearing (honest single-key note)

`verbClaim`'s race arbiter is `recheck.assignee.id !== viewer.id` (swb.js:645). It only
registers a **loss** when the re-fetched assignee is a *different identity* than the
racer's own viewer — and the viewer is derived from the API **key**, not the
`--session` id. I have exactly one Linear key (one viewer, "Turni Saha"), so two
same-user racers both set that same assignee and both pass the check. To exercise the
**real** exit-3 back-off path end-to-end I made exactly one racer's re-fetched assignee
diverge, by reassigning to the **real** second org user `ai@bistraining.ca` (id
`3152218a-…`) during that racer's settle window. This is not a mock: it is the real
swb.js code path, real GraphQL mutation, real re-fetch, real git worktree.

The consequence of the single key is documented as its own artifact — see
**`single-key-finding/`** below. It is the honest caveat behind this test's design.

### Per-run results (from `claim-race/RESULTS.txt`)

| Run | Issue | Winner | Loser | Winner exit | Loser exit | Loser back-off | Loser worktree | Winner worktree | ownership.json | board |
|----|-------|--------|-------|-------------|-----------|----------------|----------------|-----------------|----------------|-------|
| 1 | HAC-288 | cloneA | cloneB | 0 | **3** | ✔ "claim race lost … Backing off" | none | `switchboard-wt/HAC-288` @ branch HAC-288 | 1 entry, winner session | In Progress / Turni Saha |
| 2 | HAC-289 | cloneA | cloneB | 0 | **3** | ✔ | none | `switchboard-wt/HAC-289` | 1 entry, winner session | In Progress / Turni Saha |
| 3 | HAC-290 | cloneA | cloneB | 0 | **3** | ✔ | none | `switchboard-wt/HAC-290` | 1 entry, winner session | In Progress / Turni Saha |

All 9 assertions × 3 runs = 27/27 green. (In an earlier tuning pass the winner/loser
flipped to cloneB by natural timing jitter — confirming the split is a genuine race,
not hardcoded.)

### Key evidence per run (`run1/` shown; run2/run3 identical shape)

- `A.out` / `B.out` — verbatim stdout of each claim process.
- `A.code` / `B.code` — process exit codes (`0` winner, `3` loser).
- `events.jsonl` — the isolated home's event log. The decisive line:
  ```
  {"cmd":"claim","sessionId":"run1-loserB-…","ok":false,"ms":2719,"error":"claim-lost-race"}
  {"cmd":"claim","sessionId":"run1-winnerA-…","ok":true,"ms":3169}
  ```
- `winner-worktrees.txt` — `git worktree list` for the winner (2 lines: main + `switchboard-wt/HAC-288`).
- `loser-worktrees.txt` — `git worktree list` for the loser (1 line: main tree only → NO worktree created).
- `ownership-after.json` — the shared `ownership.json` after the race: exactly ONE
  entry, keyed by the issue, `sessionId` = the **winner's** session.
- `02-reassign-to-other.txt` / `03-restore-winner.txt` — proof the concurrent
  assignee flip actually happened (`ai@bistraining.ca` → `Turni Saha`).
- `04-final-state.txt` — `In Progress|Turni Saha` (winner is assignee + In Progress on the real board).
- `00-issue.txt`, `01-promote.txt`, `99-delete.txt` — issue lifecycle (create → Ready → deleted teardown).

### Reproduce

```
source ~/.switchboard/env            # exports LINEAR_API_KEY
bash claim-race/harness-claim-race.sh   # requires the seeded upstream + lin.js alongside
```
(`harness-claim-race.sh` and `lin.js` are archived here; the scratch clones + isolated
homes are regenerated per run and were pruned from evidence as reproducible.)

---

## Single-key finding (`single-key-finding/`) — honest caveat

Two fresh independent clones, **single key**, **truly simultaneous** (no stagger, no
external reassignment). Result:

```
A exit=0:  ✔ claimed HAC-291 → Turni Saha · In Progress · files: src/payments/**
B exit=0:  ✔ claimed HAC-291 → Turni Saha · In Progress · files: src/payments/**
final:     In Progress|Turni Saha
```

**Both processes exit 0 and both "claim" the same issue.** Because they share one Linear
viewer, the contract's assignee re-check cannot split them; the only exclusion observed
was an incidental filesystem collision on the shared `../switchboard-wt/<KEY>` parent
dir (`'../switchboard-wt/HAC-291' already exists`), which is *not* the claim protocol.
This is a genuine limitation: **`swb claim`'s single-winner guarantee holds only when
the two racers are different Linear users** (different keys) — which is the real pilot
topology (each teammate has their own key). The graded CLAIM RACE above therefore
injects a real second identity to exercise the exit-3 path the contract promises.
Files: `A.out`, `B.out`, `A.code`, `B.code`, `final-state.txt`, `ownership-after.json`.

---

## TEST 2 — OWNERSHIP GUARD (`ownership-guard/`)

Live claim state used for all cases (`live-claim-ownership.json`): session
`owner-session-AAAA-1111` (assignee "Turni Saha") owns `HAC-901` → globs
`src/payments/**`, `src/payments/*`. Each case pipes real PreToolUse stdin JSON into
`node hooks/pretooluse.js` under an isolated `SWITCHBOARD_HOME`:

```
SWITCHBOARD_HOME=<home> node hooks/pretooluse.js < <case>.stdin.json
```

| Case | stdin | session | file | Expected | Observed | Result |
|------|-------|---------|------|----------|----------|--------|
| a | `a-foreign-owned.stdin.json` | `other-session-BBBB-2222` (≠ owner) | `src/payments/api.js` | WARN naming key+owner | `{"systemMessage":"⚠ switchboard: /repo/switchboard/src/payments/api.js is owned by HAC-901 (Turni Saha) — coordinate before editing"}`, exit 0 | ✔ |
| b | `b-non-owned.stdin.json` | `other-session-BBBB-2222` | `src/reports/summary.js` | SILENCE | 0 bytes stdout, exit 0 | ✔ |
| c | `c-subagent-owned.stdin.json` | `subagent-CCCC-3333` (+ `parent_session_id`, `transcript_path`, `agent_type`, `permission_mode`; tool `MultiEdit`) | `src/payments/charge.js` | WARN still fires | `{"systemMessage":"⚠ switchboard: …/src/payments/charge.js is owned by HAC-901 (Turni Saha) — coordinate before editing"}`, exit 0 | ✔ |
| d | `d-corrupt-ownership.stdin.json` (ownership.json = `{ this is NOT valid json ]]]`) | `other-session-BBBB-2222` | `src/payments/api.js` | NEVER block: exit 0, silent | 0 bytes stdout, exit 0 | ✔ |

Assertions, all green:
- (a) the `systemMessage` **names the issue key `HAC-901` and owner `Turni Saha`** and
  ends with "coordinate before editing".
- (b) a non-owned file → **empty stdout, exit 0** (true silence).
- (c) a **subagent-shaped** payload (distinct session id + agent metadata the hook must
  ignore) editing an owned file → warn **still fires**, naming `HAC-901`.
- (d) **corrupted `ownership.json`** → hook exits 0 and is silent — it **never blocks**,
  honoring the fail-open contract (`hooks/pretooluse.js` always `process.exit(0)`).

Each case's exact stdin (`*.stdin.json`), stdout (`*.stdout.txt`), and exit code
(`*.exit`) are saved. The hook's own event log confirms every invocation ran with
`"ok":true` (never threw): `hook-events-guardhome.jsonl` (cases a/b/c) and
`hook-events-corrupthome.jsonl` (case d). The corrupted input itself is preserved at
`d-corrupt-ownership.input-ownership.json`.

---

## Teardown / board hygiene (verified at end of run)

- Every `swb-test` issue deleted (HAC-283 probe + HAC-285…HAC-291). `node lin.js listTest`
  returns empty.
- Full HAC board re-listed: **1 issue** — `HAC-270 | Backlog | [swb-meta] | Discoveries`
  (the pinned meta thread, untouched). 0 `swb-test` issues.
- Real `~/.switchboard/ownership.json` reset to `{}`.
- Real repo `git worktree list` = only the main tree on `main` (no stray worktrees).
- Scratch dir removed. `node swb.js doctor` = all green.
