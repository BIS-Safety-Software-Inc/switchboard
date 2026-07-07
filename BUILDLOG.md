# BUILDLOG

## 2026-07-06 · Iteration 1 (mastermind: Fable, builders: Opus 4.8)
- Repo created via bis-new (dual-remote wired).
- Linear: teamCreate blocked (free plan, 2-team cap). DECISION: Team 2 (key HAC, 0 issues) is the scratch test bed with swb-test label hygiene + full cleanup; its state/label config is pre-work the hackathon board needs anyway. A dedicated scratch workspace key in ~/.switchboard/env supersedes this if provided.
- CONTRACTS.md v1 locked. Fleet launched: CLI core / hook pack / installer in parallel, adversarial review per component.

## 2026-07-06 · Iteration 2 (mastermind: Fable)
- Smoke verdict on iter 1: NOT shippable. Two P0 GraphQL bugs proven live (teamId ID!->String!; IssueFilter has no identifier field -> use number+team.key). Root cause of green-but-broken: mocks substring-matched the buggy queries (self-confirming synthetic tests). DoD now REQUIRES live round-trip tests behind SWB_LIVE_LINEAR_KEY.
- Cache schema arbitrated: CANONICAL v2 locked in CONTRACTS.md (swb.js shape + viewer + comments[].issueKey + discovery flag; mentions computed, never stored). SWITCHBOARD_HOME is the one home-dir override.
- Fleet: swb-core-fix (P0s+P2s+live tests, verifies against HAC), hooks-align (canonical schema), installer-polish (matcher/force/doctor-cwd lows). Disjoint file ownership. Then live E2E smoke.
