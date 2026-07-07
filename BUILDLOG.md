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
