# BUILDLOG

## 2026-07-06 · Iteration 1 (mastermind: Fable, builders: Opus 4.8)
- Repo created via bis-new (dual-remote wired).
- Linear: teamCreate blocked (free plan, 2-team cap). DECISION: Team 2 (key HAC, 0 issues) is the scratch test bed with swb-test label hygiene + full cleanup; its state/label config is pre-work the hackathon board needs anyway. A dedicated scratch workspace key in ~/.switchboard/env supersedes this if provided.
- CONTRACTS.md v1 locked. Fleet launched: CLI core / hook pack / installer in parallel, adversarial review per component.

## 2026-07-06 · Iteration 2 (mastermind: Fable)
- Smoke verdict on iter 1: NOT shippable. Two P0 GraphQL bugs proven live (teamId ID!->String!; IssueFilter has no identifier field -> use number+team.key). Root cause of green-but-broken: mocks substring-matched the buggy queries (self-confirming synthetic tests). DoD now REQUIRES live round-trip tests behind SWB_LIVE_LINEAR_KEY.
- Cache schema arbitrated: CANONICAL v2 locked in CONTRACTS.md (swb.js shape + viewer + comments[].issueKey + discovery flag; mentions computed, never stored). SWITCHBOARD_HOME is the one home-dir override.
- Fleet: swb-core-fix (P0s+P2s+live tests, verifies against HAC), hooks-align (canonical schema), installer-polish (matcher/force/doctor-cwd lows). Disjoint file ownership. Then live E2E smoke.

## 2026-07-06 · Iteration 3 (mastermind: Opus 4.8) — @you mention loop fix
- LAST BLOCKER (smoke-proven): `swb ask` wrote the literal typed mention (e.g. `@Turni`) while the digest `@you` matcher was built ONLY from `viewer.displayName` (`turni.saha`), so first-name mentions never surfaced as @you — the Q&A notification promise silently failed.
- FIX both sides in swb.js:
  - ask-side: `verbAsk` now fetches team members (`getTeamMembers`) and resolves the @target via `matchMember` (case-insensitive on displayName / full name / first word of name). Writes the canonical `@<displayName>`, keeping the typed form after it when they differ (`@turni.saha (Turni)`). Unknown target → keeps raw text + prints a warning listing valid handles.
  - matcher-side: new `viewerHandleTokens`/`mentionRegexesFor`/`bodyMentionsViewer` build the @you regex set from displayName + first word of name + full name (escaped, word-boundaried, case-insensitive). `buildDeltaItems` now uses `bodyMentionsViewer`. Mirrored in `hooks/userpromptsubmit.js` inline engine (matcher change only; hooks tests stay green — posttooluse reuses its `computeDigest`).
- Tests: added mocked ask-normalization (3) + matcher (4) unit tests; extended the LIVE round-trip to post an `@FirstName` ask and assert a SECOND session's digest surfaces `@you <key>`.
- VERIFIED: bare `node --test` green (68 tests, 65 pass, 3 live-skip, 0 fail). Live subset green with the real HAC key — proof digest emitted: `@you   HAC-268 Turni Saha: "@turni.saha (Turni) does the digest surface a @Turni first-name mention? …" → swb show HAC-268`. HAC board torn down to 0 swb-test issues (0 issues total). No git commit (mastermind commits).

## 2026-07-06 · Iteration 4 — CLOSING (mastermind: Fable)
- PROOFS BOTH PASS. Coordination go/no-go 3/3 (real hook delivery, neutral prompts, B adapted unprompted every run). Collision: claim race 3/3 (27/27 asserts), ownership guard 4/4. Evidence under evidence/.
- Honest findings handled: (1) single-key race limitation documented (arbiter = Linear user id; real pilot = one key per dev, cross-user race exercised via second org user ai@bistraining.ca); (2) self-suppression displayName-vs-fullname bug FIXED by mastermind (viewerIdentityTokens in swb.js + hook, regression test added, 69 tests green).
- Playbook verified against live tool (zero material divergences). DRYRUN-CHECKLIST.md + evidence/INDEX.md written.
- Fleet ops note: every agent failure this build was a StructuredOutput emit, never the work — final iterations switched to plain-text verdicts.
- REMAINING FOR HUMANS: real-Windows install test (Jul 9), key rotation before Jul 13, VS Code-free onboarding of 16 devs per checklist.

## 2026-07-07 · Onboarding (mastermind: Fable)
- Owner decision: no video; tour + auto-open playbook. /swb-tour command (installer copies to ~/.claude/commands/) = guided hands-on: Part 1 solo mechanics, Part 2 PAIRED — solo digest is quiet BY DESIGN (deltas + self-suppression), so all cross-agent behavior (claim arrival, @you round-trip, race, guard) is buddy-based. Installer: 7 steps, opens PLAYBOOK.html at end (--no-open to skip; auto-skipped when not a TTY so tests/CI never pop a browser). 70 tests green.

## 2026-07-07 · Owner decisions during first live tour
- Linear PAID upgrade approved: unlimited tickets. 250-cap mitigations in docs stay as history; Triage gate retained for CURATION (not quota).
- Tour step 4 now names the Triage-watcher duty (PM/captain/named member, sweep cadence) + exact Linear UI click path for promote (status icon in list view).

## 2026-07-07 · Vocabulary refactor + fresh E2E retest (mastermind: Fable)
- Kit now speaks Linear-native state names (Backlog/Todo) everywhere — Triage/Ready retired after first-user confusion. 73 tests green.
- FRESH-DEV E2E PASS on this machine post-rename: public clone -> install --key (isolated home) -> doctor all green -> new [Backlog] w/ URL -> API promote -> claim (worktree+spec-print) -> done (test-gate -> In Review) -> second-session digest correct -> board clean.
- New participant deliverable: Floor Tour click-through artifact (floor-not-rails framing, 4 MUSTs, Gate-2-under-skip-permissions honesty, proposer-bias disclosure, autonomy dial) for the Friday prep meeting.
