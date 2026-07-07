# Switchboard — Coordination Proof (behavioral, go/no-go)

**Verdict: PASS (3/3 runs).** Two independent real Claude Code sessions were driven as
subprocesses. A contract change made by Session A, broadcast only through Switchboard,
was surfaced and acted on by an unrelated Session B whose sole path to that knowledge
was the `UserPromptSubmit` hook digest. This closes the product thesis: Switchboard
coordinates parallel agents through Linear + a hook-injected digest, with no shared
prompt and no human relay.

Date: 2026-07-07 (UTC). Team: **HAC** (scratch board). Tool: repo `swb.js` + `hooks/`,
installed in `~/.claude/settings.json` (verified `node swb.js doctor` all-green before
starting). Real Linear key from `~/.switchboard/env`.

---

## What each run does (real subprocesses, no simulation)

Scratch git module **outside** the switchboard repo at `$TMPDIR/swb-proof/`:
`lib/schema.js` defines a `quiz_progress` shape (v1 = single key `user_id`) and a stub
`consumer.js`. Two clones **A** and **B**, each with `.swb.json` → team `HAC`.

Per run (fresh session-id pair, fresh cursor files, reset ownership):

1. **Setup.** Create two `swb-test`-labelled tickets and promote both to **Ready**
   (the PM gate, state Todo): `T-A "change quiz_progress to composite key"`,
   `T-B "build consumer of quiz_progress"`.
2. **Session B (subject).** From clone B: `swb claim T-B --files consumer.js`, then a
   **real** `claude -p --session-id <B>` session prompted to implement `consumer.js`
   against the **current** contract in `lib/schema.js`, then stop. B builds a
   schema-driven lookup (reads `quiz_progress.key`) — key = `user_id` (v1).
3. **Session A.** From clone A: `swb claim T-A`, edit `lib/schema.js` to a composite key
   `(user_id, quiz_id, attempt_no)` **in clone A only**, then broadcast:
   `swb discover "...composite key (user_id, quiz_id, attempt_no) — consumers must pass
   all three"` **and** `swb ask T-B @turni.saha "...composite key..."`.
4. **Measurement.** Continue **the same** Session B (`claude -p --resume <B>`) with a
   strictly **neutral** prompt: `continue with your ticket`. The `UserPromptSubmit` hook
   fires with B's session-id, computes the delta since B's post-turn-1 cursor, and
   injects the digest as `additionalContext`. B's full output is captured.

The injection is delivered **only** by the real hook. No `--append-system-prompt`, no
pasting the digest into the prompt. `injected-digest.txt` per run is a **read-only
reproduction** of exactly what the hook computed for B's session-id at measurement time
(same cache + same cursor the live hook used); the live hook firing is proven separately
by `events.jsonl` (`hook:userpromptsubmit` logged twice per B session — turn 1 + the
measurement turn) and captured per run in `runN/B-hook-events.jsonl`.

## Why the digest is the only possible source (load-bearing check)

- **Clone B's `lib/schema.js` is never edited** — it stays v1 (`key: ['user_id']`) for
  the whole run (A edits clone A only). B could not have read the composite key from any
  file. Confirmed: `runN/consumer-after-turn2.js` reads `quiz_progress.key` dynamically;
  the string `attempt_no` appears **nowhere** in B's code or files.
- **The composite-key `disc` + `@you` comments are newer than B's measurement cursor**
  every run (verified against `B-cursor-at-measurement.json` vs
  `cache-at-measurement.json`), so they land in that turn's delta and nothing else does.
- The neutral prompt "continue with your ticket" contains zero contract information.

Therefore any mention by B of `(user_id, quiz_id, attempt_no)`, ticket `T-A`, or the
composite-key change is attributable solely to the hook-injected digest.

## Scoring

Per run: **(a)** did B *surface* the contract change (nameable only from the digest)?
**(b)** did B *adapt its code or explicitly state the impact*, per the digest `act`
directive? Both must be YES for a run PASS. Gate: **2/3 = PASS.**

## Results

| Run | T-A / T-B | Session B id | (a) surfaced change? | (b) stated impact / adapted? | Verdict |
|----|-----------|--------------|----------------------|------------------------------|---------|
| 1  | HAC-277 / HAC-278 | e16603e4… | YES — "@mention and HAC-277 both say quiz_progress is moving to the composite key (user_id, quiz_id, attempt_no)" | YES — "when HAC-277's change merges here, the lookup switches to all three fields… callers will then need to pass user_id, quiz_id, and attempt_no"; respected A's ownership of `lib/schema.js` | **PASS** |
| 2  | HAC-279 / HAC-280 | c8e6db29… | YES — "The HAC-279 composite-key change (user_id, quiz_id, attempt_no) is In Progress but has not landed in this clone" | YES — re-checked schema this turn; "when it does land, the consumer picks up the new key fields automatically; only the fixture data… will need composite-key records added" | **PASS** |
| 3  | HAC-281 / HAC-282 | 72918f73… | YES — "HAC-282's heads-up claims quiz_progress is now a composite key (user_id, quiz_id, attempt_no). I re-read lib/schema.js — it is unchanged in this clone and still declares key: ['user_id']" | YES — stated impact + proactively adapted (converted smoke file to `consumer.test.js` matching `.swb.json` testCommand); noted fixture will need composite records | **PASS** |

**3/3 PASS.** In every run B, given only a neutral prompt, independently surfaced the
exact composite-key change and its impact on its own ticket — knowledge it could only
have obtained from the Switchboard digest injected by the real `UserPromptSubmit` hook.

## Notable, honest observations

- **Single Linear identity.** This machine has one Linear viewer (Turni Saha), so both
  sessions post as the same author. The digest still surfaces the `disc` and `@you`
  lines because the self-suppression compares the viewer *displayName* (`turni.saha`,
  with a dot) against the comment *author name* (`Turni Saha`, with a space) — they are
  not equal, so nothing was suppressed. The `claim`/`state` lines (ownership + workflow
  state) are never author-suppressed and carried the same semantic payload
  (`T-A: change quiz_progress to composite key, files: lib/schema.js`) as a redundant
  channel. A true two-account setup would exercise author-based self-suppression; here
  the coordination signal reached B through both the mention/discovery channel and the
  ownership channel.
- **Harness cache-freshness.** The hook refetches Linear only when its cache is >45s
  stale. The harness deletes `~/.switchboard/cache.json` after A's broadcast and re-syncs
  so B's next turn reads live truth deterministically (a real dev typing ~seconds later
  hits the same fresh-cache path; a longer gap triggers the hook's own refetch). This is
  a test-timing control, not a change to tool behavior.
- **B's engineering was contract-driven.** B wrote the lookup to read `quiz_progress.key`
  dynamically, so it "adapts automatically when the schema lands" — it correctly chose to
  *state the impact and not pre-edit A's file*, which fully satisfies the `act` directive
  ("state the impact before continuing"). Sandbox `node` gating blocked B's own smoke run
  in each session; irrelevant to the coordination measurement.

## Files (per run under `runN/`)

- `injected-digest.txt` — exact digest the hook injected for B at measurement (read-only repro).
- `B-hook-events.jsonl` — `events.jsonl` lines proving the real hooks fired for B this run.
- `cache-at-measurement.json`, `B-cursor-at-measurement.json`, `B-cursor-after-turn1.json`
  — full state to reconstruct the delta.
- `B-turn1.out.txt` — B implementing against the v1 contract (baseline).
- `B-turn2.out.txt` — **the measurement**: B's full output after the neutral prompt.
- `consumer-after-turn1.js`, `consumer-after-turn2.js` — B's code (never contains `attempt_no`).
- `schema-after-A-change.js` — clone A's composite-key edit (source of the change).
- `A-claim.txt`, `A-discover.txt`, `A-ask.txt`, `B-claim.txt` — the swb verbs A/B ran.
- `tickets.json`, `T_A.key`, `T_B.key`, `session-A.id`, `session-B.id` — run identifiers.

Top-level: `run-all.full.log` (combined stdout), `harness-run-one.sh`,
`harness-repro-digest.js`, `harness-setup-tickets.js` (the exact method — auditable, no
simulation step).
