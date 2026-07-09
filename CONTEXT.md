# Project Context — Living Document

> **MANDATORY RULE**: When session context usage hits **50% or higher**, the AI agent MUST perform a comprehensive update to this document before continuing any other work. This is non-negotiable.

> **On every new session start**: Read this file FIRST. It is the single source of truth for project state.

---

## Last Updated
- **Date**: 2026-07-09 (afternoon)
- **Session**: Session 3 (S1 = Jul 6 build; S2 = Jul 7 fix day; S3 = Jul 8-9 ship + field)
- **Last Commit**: cdc3857 ("quiet mode FINAL") + b1b227d (handoff)
- **Build Status**: `node --test` → 83 tests, 80 pass, 0 fail, 3 skips; fresh-public-clone E2E verified on cdc3857

---

## 1. What Is This Project?

**Switchboard** — the coordination floor for the BIS AI Hackathon (July 13 planning half-day / July 14 build day). Turns Linear (workspace "BIS Agents", 2 teams) into shared memory for ~16 parallel Claude Code sessions: `swb` CLI (agents' only write path to the board), 3 Claude Code hooks (digest injection + yellow receipt, mid-turn, ownership guard + Gate 2), installer, guided `/swb-tour`, and participant docs. Also the live testbed for the bis-gastown CLI+Linear pivot. Public repo: `BIS-Safety-Software-Inc/switchboard` (gmail mirror synced).

## 2. Current Status

**SHIPPED + FROZEN at cdc3857 (quiet mode FINAL).** Kit released to all 16 participants Jul 8 (Teams message + out-of-band graph zip). Field tours (Preeti/Windows, Abenanth, Rejith, Sabareesh) drove ~12 fixes Jul 8-9. Scoping saga (4 flips) ended QUIET: full digests only in swb repos (.swb.json walk-up / claim-worktree / SWB_DIGEST_EVERYWHERE panic env); @you mentions deliver EVERYWHERE (yellow "switchboard (mention)", lastYouTs dedupe); door logging on every delivery. CODE FREEZE: changes only on owner ask or breakage; debug order = swb last → door log → panic switch → code LAST. Both worlds one `git revert` apart; Friday prep meeting = config lock point.

### Superseded status (Jul 7)

Kit is feature-complete and live-tested by 2 real users (Turni mac + Preeti Windows). July 6: built via autonomous ultracode loop, coordination go/no-go PASSED 3/3, collision proofs green. July 7: ~15 UX/correctness fixes from live first-user testing, then major additions — full-digest yellow receipt (ANSI 103/30), `swb board`/`members` verbs, spec-print on claim, harness label chips, **Linear-native state names everywhere (Backlog/Todo — Triage/Ready retired)**, mandatory-key installer with live validation, auto-PATH (Windows registry-safe + unix profile), FLOOR-TOUR.html opens first on install, **Gate 2 built into pretooluse hook (claim/done denied without `--approved`; survives --dangerously-skip-permissions; `"gate2":"off"` in .swb.json to disable)** — proven live twice on the designer's own session, PLANNING-DAY.html working checklist, tour Part 2 director/responder roles + mandatory flip.

## 3. What To Do Next

1. Turni sends the two Teams messages (final drafts in Jul 9 session): all-hands (git pull, quiet mode, open sessions inside repo folders) + captains (.swb.json per TEAM BRANCH Monday — Team1=BIS/Team2=HAC, "while on your team branch" wording; AGENTS append; merge/Fable/sweep duties).
2. Human items: rotate Turni's Linear key · Windows execution of graph-zip install.ps1 (2 min) · Thursday membership sweep · Friday prep hour (FLOOR-TOUR walk + planning questions).
3. Open with Turni: captains commit .swb.json Monday w/ real testCommand vs earlier w/ explicit no-op.
4. Quiet-mode confusion before Friday → flip = revert scoping commits; Friday locks it.

### Superseded next-steps (Jul 7)

1. **PENDING USER REQUEST (interrupted)**: "#13 put this in the planning questions" — sandbox/demo question is Section F open-box in PLANNING-DAY.html; user may want it ALSO as an explicit DECIDE line in the planning questions list. Confirm with Turni. (PLANNING-DAY.html + AGENTS-template preview were opened in his browser — he's reading them; expect edit requests.)
2. Fresh end-to-end retests: Turni's machine (wipe ~/.switchboard, re-clone, install, /swb-tour) + Preeti's Windows re-test with latest.
3. Two-person Part 2 finale with new director/flip choreography (race + guard demos still not run human-vs-human).
4. Organizer items before Fri Jul 11 prep meeting: sandbox/demo answer (dev infra owner), how code reaches the dev server, Linear paid upgrade (approved, not yet done?), rotate Turni's Linear API key (pasted in chat Jul 6), announcement packet (install line + floor tour + planning doc).
5. Keep FLOOR-TOUR.html repo copy ↔ artifact in sync when editing (artifact URL: 8b13c4bd-...).

## 4. User Decisions (DO NOT RE-ASK)

| Decision | Chosen | Date | Rationale |
|----------|--------|------|-----------|
| Kit posture | Floor not rails; 4 MUSTs (own key, team joined, named Backlog sweeper, writes via swb); everything else DIAL | Jul 7 | Teams decide on planning day |
| Gate 2 | Built into hook, default ON, survives skip-permissions; `"gate2":"off"` opt-out | Jul 7 | "ideally that's what I want" |
| State names | Linear-native (Backlog/Todo) internally + everywhere | Jul 7 | First users hunted for nonexistent "Triage" |
| Yellow receipt | FULL digest, every line solid yellow, @you carries full comment (300) | Jul 7 | Humans must see what agents got |
| Tour Part 2 | One director per pair + mandatory role flip | Jul 7 | Dual-guide collision observed live |
| Codex seats | /codex plugin inside Claude Code = full mode; bare CLI = degraded | Jul 7 | Turni corrected me |
| Linear plan | Paid upgrade, unlimited tickets | Jul 7 | Removes 250 cap |
| Roles | QA owns reviews + ask-culture; captain owns merge cadence; sweeper can assign at promote | Jul 7 | Planning doc |
| bistrainerdev | Each team gets own master branch; hackathon AGENTS.md COMPOSES with repo CLAUDE.md (hard-stops win) | Jul 7 | |
| Installer | Opens FLOOR-TOUR.html first and foremost; key mandatory w/ live validation | Jul 7 | |

### Session 3 decisions (Jul 8-9, DO NOT RE-ASK)
| Decision | Chosen |
|---|---|
| Delivery scope FINAL | QUIET; build day identical both ways; mentions never scoped; Friday = lock |
| Graph zip | Out-of-band Teams only, NEVER committed (embedded token, public repo); CLAUDE.md step 4 installs; mac-verified live, ps1 read-audited |
| Repo CLAUDE.md | Self-guiding DOER ("set me up"): membership check → key paste → Claude installs all incl Node |
| Tour Part 2 | ONE pass one director (flip CUT); board-native @asks, one kickoff ping; wrap auto-opens 3 docs; session starts INSIDE kit folder |
| Fable | $200/team, captain holds key, handed Monday am |
| Codex plugin | EVERYONE installs (openai/codex-plugin-cc) |
| .swb.json | Captains commit once per team branch Monday; kit itself never enters bistrainerdev; per-branch so master untouched |
| Freeze | No changes without owner ask; code last when debugging |

## 5. Architecture Summary

One-file Node CLI (`swb.js`, zero deps) + 3 hooks (registered by ABSOLUTE PATH into ~/.claude/settings.json — `git pull` updates them live; installer re-run refreshes /swb-tour copy + matchers). Cache schema v2 (~/.switchboard/). Digest = deltas since session cursor, 30-min first-look window, self-suppression via identity tokens (displayName + full name). Claim = assign+state via strongly-consistent by-id recheck (filtered search LAGS — never use for verification), worktree, ownership.json, label chip, spec-print. Gate 2 = pretooluse hook denies `swb claim/done` in Bash without `--approved` (anchored regex handles quoted paths with spaces). PreToolUse matcher: `Edit|Write|MultiEdit|Bash`.

## 6. Files Changed This Session (Jul 7)

| File | Change |
|------|--------|
| swb.js | members+board verbs, spec-print on claim, label chips, release→Todo, by-id recheck, identity-token suppression, Backlog/Todo rename, --approved flag, new prints URL |
| hooks/userpromptsubmit.js | yellow full-digest systemMessage, first-look window, own-state suppression, viewer-object fix |
| hooks/pretooluse.js | GATE 2 (deny claim/done without --approved, .swb.json gate2 off-switch) |
| install.js | mandatory key + live validation, auto-PATH (win registry / unix profile), floor-tour-first open, /swb-tour install, matcher upgrade on re-run |
| commands/swb-tour.md | plain-language digest explanation, click paths, buddy resolution via members, same-team rule, director/responder + mandatory flip, Backlog vocabulary |
| FLOOR-TOUR.html (new) | click-through participant tour; "everything on one screen" layman diagram; Gate 2 honest story |
| PLANNING-DAY.html (new) | July 13 working checklist (MUST/DECIDE/WHO), sandbox OPEN item |
| AGENTS-template.md | no-drive-by, compose-with-CLAUDE.md, knowledge tools, team fill-ins |
| test/* | 74 tests incl. gate2, staleness regression, board/members |

## 7. Completed Work

### Session 1 — 2026-07-06
Autonomous ultracode build (Fable mastermind + Opus fleets): swb CLI, hooks, installer, playbook; coordination go/no-go 3/3; collision proofs; evidence/; pushed public.

### Session 2 — 2026-07-07
Live two-user testing (Turni + Preeti/Windows) → ~15 fixes; yellow receipt; board/members verbs; Linear-native rename; Gate 2 flag-proof; floor tour + planning day docs; system map artifact (33be4d16); floor tour artifact (8b13c4bd); tour director/flip; bistrainerdev investigation (Adobe CF 2023, no local CF run story, dev DB read-only rule exists, /bis-plan workflow binds).

### Session 3 — 2026-07-08/09
10-gate release audit → shipped · graph-zip step · secrets/malice sweep clean · quiet/loud saga → QUIET final (cdc3857) w/ 6-test scope battery + door logging · field fixes: done-gate aims at recorded worktree, solid yellow box, mid-turn yellow, cross-machine guard, swb last, board-native Part 2, flip cut · laptop repair: ~/.config/git wiped 15:28 Jul 8 by unknown — credential router + hooks + git-push-mirror restored VERBATIM from bis-gastown/docs/CODEX-DUAL-REPO-SETUP.md, mirror ✓ · push-mirror leaves clone shallow (unshallow to fix; remote never affected).

## 8. Known Risks

- **OPEN: sandbox/demo environment does not exist** (agenda promises it; PLANNING-DAY §F; organizer decision needed before Fri).
- **OPEN: how code reaches the dev server unknown** (not in repo docs; ask infra owner).
- Gate 2 handshake trusts agent to actually ask before adding --approved (logged + visible; agent-grade trust).
- Idle-blindness: no push while terminal idle (v1 contract: delivery at next prompt).
- Turni's Linear key pasted in chat Jul 6 — ROTATE before Jul 13.
- Teams must JOIN Linear team (workspace invite insufficient) — Preeti still not in `swb members` last checked.
- testCommand for CF undefined until planning day — done-gate is theater without it.
- (S3) push-mirror leaves local clone SHALLOW — git log looks truncated; `git fetch --unshallow`; remote unaffected.
- (S3) ~/.config/git wipe culprit unidentified; restore source = the gastown setup doc.
- (S3) THIS dev machine's session often sits in-repo (shell parks in kit folder) — ambient digests here are CORRECT; door log proves (not a scoping bug).
