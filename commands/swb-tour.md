---
description: Guided hands-on tour of Switchboard — your Claude walks you through the real claim → digest → ask → done loop on a practice ticket, then the two-person multiplayer round.
---

You are running the Switchboard tour for a hackathon participant. You are the guide; the human just follows along. Use the REAL tool the whole way — never simulate output. Keep each step short: say what's about to happen, run it (or tell them the one thing to do), show what happened, move on. If any command fails, show its MANUAL RECIPE output and explain that fail-open behavior is itself a feature of the kit — then continue.

## Ground rules for you, the guide

- All Linear writes in this tour go through `swb` verbs. Run `swb` yourself via Bash; the human approves.
- Practice tickets are disposable: title every one `tour: <their name> — practice`, and at the end have the human delete them in the Linear UI (two clicks — that's deliberate, it teaches where the board lives).
- If `swb doctor` fails at any point, stop the tour and fix setup first — that IS the tour at that moment.
- Part 2 requires a second person. If they don't have a buddy available now, finish Part 1 and tell them to grab a teammate later and re-run `/swb-tour part2`.

## Part 0 — Preflight (2 min)

1. Run `swb doctor`. All green → continue. Anything red → fix it with the human before proceeding. The usual chain for a missing/invalid key: (a) they must have ACCEPTED the Linear invite to the **BIS Agents** workspace (check email — Turni sent it; no invite accepted = keys won't work), (b) mint a personal key in Linear → **Settings → Security & access → Personal API keys** (each person needs their OWN — never share one), (c) re-run `node install.js` in the switchboard repo and paste it. Missing workflow states → `swb doctor --fix`.
2. Explain in two sentences: "Every prompt you send me, a hook injects a digest of what changed on your team's Linear board — claims, questions for you, discoveries. I write to the board only through `swb` commands you approve. That's the whole system."
3. **Line up the buddy NOW, not later.** Ask: "Part 2 needs a teammate at their own machine — who's your buddy?" Have them ping that person right now (Teams/Slack) with: *"Install switchboard (one line, INSTALL.md) and be ready in ~10 min for /swb-tour Part 2 — I need you for the two-player round."* The buddy installs while your human does Part 1, so nobody waits. If genuinely nobody is available, continue solo and make the LAST thing you say a concrete follow-up: who they'll grab and when they'll run `/swb-tour part2`.

## Part 1 — Solo: the single-player loop (~10 min)

3. **Practice repo.** Create `~/swb-practice` if absent: `git init`, a `.swb.json` with their team key (read the default from the current repo's `.swb.json` or ask them which team they're on) and `"testCommand": "node --test"`, plus `test/ok.test.js` containing one trivially passing `node:test` test. Explain: claim needs a git repo (worktrees), done needs a test command (the gate).
4. **Create.** From `~/swb-practice`, run `swb new "tour: <name> — practice"`. Show them in the Linear UI that it landed in **Triage** — then explain the gate: *agents can never create Ready work; a human promotes.* Have THEM drag it to Todo (Ready) in the Linear UI. That drag is the PM gate they'll use all hackathon.
5. **Claim.** `swb claim <KEY> --files "src/practice/**"`. Then show all four things that just happened: assignee + In Progress on the board, the signed claim comment, the worktree at `../swb-practice-wt/<KEY>` (or the repo's worktree parent), and the entry in `~/.switchboard/ownership.json`. One sentence each.
6. **The digest — and why it's quiet.** Run `swb sync`. It will show little or nothing. Explain the two reasons, because both are design: (a) deltas only — you see what changed since YOUR last look; (b) **self-suppression** — your own claims and comments never echo back at you. Then say the important sentence: *"That means alone, you'll never see the digest do anything interesting. It exists entirely for what OTHER people's agents do. That's Part 2."* Show them a realistic sample digest (from PLAYBOOK.html §digest) so they know the shape: `@you` lines first, then claims/discoveries/new tickets, ending with the act directive.
7. **Done gate.** `swb done <KEY> --pr https://example.com/pr/tour --summary "tour practice"`. Narrate the gate order as it runs: tests execute FIRST (they watch them stream), then the PR requirement, then In Review + a summary comment, then ownership released. Then prove the refusal path: make the test fail (`assert.fail`), create + claim a second practice ticket, attempt `swb done` — watch it refuse with the test output. Fix the test, `swb release` the second ticket. *"Done is a gate, not a status. Your agent cannot lie its way to In Review."*

## Checkpoint — grab your buddy (do not skip past this silently)

Part 1 done → say exactly this kind of thing: *"Part 1 was your own bubble — you haven't seen the product yet. Go get your buddy now; I'll wait."* Then, before starting Part 2, verify the buddy is actually ready: their machine, their own Linear key, `swb doctor` green on their side (they can confirm verbally). If their install isn't done, help debug it from this side — that's a better use of the next five minutes than skipping ahead.

## Part 2 — Paired: how your agents interact (~10 min, needs a buddy)

Everything in Part 1 was your own bubble. This part is the actual product. Buddy = any teammate who finished Part 1 (or at least the install), sitting at their own machine with their own key.

8. **See their claim arrive.** Buddy claims their own practice ticket from their machine. Now have YOUR human send you (Claude) any prompt at all — the digest injected into that turn shows `claim <BUDDY-KEY> … → <buddy>` with their declared files. Point at it: *"You didn't ask. Your agent now knows what your teammate locked. This happens on every prompt, all build day."*
9. **The @you round-trip (the Q&A loop).** Buddy runs `swb ask <YOUR-KEY> @<your-first-name> "does the practice schema need a composite key?"`. Your human's next prompt → the digest's TOP line is `@you … → swb show <KEY>`. Draft a reply grounded in what you know, let your human approve, post it via `swb ask` back (or a comment). Buddy's next digest carries the answer. Spell out what just happened: *question and answer traveled between two people's agents through the board — nobody opened Linear, nobody got interrupted, and the whole exchange is on the ticket forever (which is exactly what judges will ask about).*
10. **The race (optional, 2 min).** Promote one fresh practice ticket to Ready. Both humans tell their Claudes to claim it at the same moment. Exactly one wins; the loser gets the back-off message and walks away clean. *"Two devs can't silently stomp the same ticket."*
11. **The guard (optional, 1 min).** While buddy's claim is live, have your human ask you to edit a file matching the buddy's declared globs — the warning fires naming their ticket and their name. Warn-only: you're never blocked, you're informed.

## Wrap (1 min)

12. Both humans delete every `tour:` ticket in the Linear UI. Confirm the board is clean.
13. Close with the three MUSTs they now have muscle memory for: **claim before you touch files · Triage is where agents create, humans promote · done means tests passed and a PR exists.** Everything else is a team DEFAULT they'll set on planning day. Point them at PLAYBOOK.html for the rest.

If the human asked for `part2` in their invocation, skip straight to Part 2 (verify doctor + an existing practice repo first).
