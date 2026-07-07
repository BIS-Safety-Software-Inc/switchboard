# July 9 Dry Run — Checklist

Goal: prove the kit on **other people's machines** before the July 10 install deadline. The machine it was built on already passes everything (see `evidence/INDEX.md`) — the dry run exists to find what only fresh environments can find.

## Setup (Turni, before volunteers arrive)

- [ ] **Rotate the Linear API key** used during the build (it appeared in a chat transcript). Each volunteer creates their OWN personal key — that also exercises the multi-user paths for real.
- [ ] Confirm HAC (Team 2) board is clean: only the pinned `Discoveries` (swb-meta) issue.
- [ ] `git pull` — volunteers install from the repo at its frozen state.
- [ ] Have `PLAYBOOK.html` open on a screen; volunteers get the install line from `INSTALL.md`, not from you verbally (that's part of the test).

## Test 1 — Unassisted install (per volunteer, ~10 min)

- [ ] Volunteer installs from INSTALL.md alone — no help unless blocked. Note every question they ask (each one is a doc bug).
- [ ] `swb doctor` green on their machine, their own key.
- [ ] **At least one volunteer on Windows/PowerShell** — this is the single biggest untested surface. Watch: shim on PATH, worktree creation, hook firing.

## Test 2 — Two-human coordination (~20 min, the point of the day)

Two volunteers, two machines, both on HAC:

- [ ] A: `swb new` a ticket via their Claude, Turni promotes to Ready (PM gate).
- [ ] A claims it (agent runs `swb claim` with declared files).
- [ ] B types anything to their Claude → **digest shows A's claim** (different Linear identities — first real cross-user digest test).
- [ ] B's agent runs `swb ask <KEY> @<A's-first-name> "..."` → A's next digest shows the `@you` line (first-name mention path, cross-user).
- [ ] A's Claude drafts the reply, A approves → B's next digest carries it. **The Q&A loop, human-gated, between two real people.**
- [ ] The adaptation measurement, human edition: A posts a contract-change `swb discover`; B's agent, on a neutral "continue" prompt, should state the impact unprompted (this passed 3/3 agent-vs-agent; watch it with real humans).
- [ ] Both machines: one simultaneous claim on the same Ready ticket → exactly one winner, loser backs off with exit 3 (cross-user race — the arbiter needs different Linear users, which you now have).
- [ ] Cleanup: delete test issues (label them swb-test).

## Test 3 — Sabotage (~10 min)

- [ ] Kill the network mid-`swb claim` → verify the MANUAL RECIPE prints and the human can finish by hand.
- [ ] Corrupt `~/.switchboard/cache.json` → next prompt: hook stays silent or serves stale with age stamp; session never blocks.
- [ ] `swb done` with a failing test → refused with the test output.

## Exit criteria (go/no-go for July 10 distribution)

1. Unassisted install worked on every volunteer machine including Windows, or every failure has a same-day fix.
2. Cross-user digest + @you + Q&A loop worked between two real people.
3. Nothing blocked a session — every failure was fail-open.

If all three hold: freeze July 11, distribute the install line with the July 9 rules packet, chase `swb doctor` screenshots by July 10 EOD.

## Fallback ladder (pre-decided, per spec §9)

Kit misbehaves on the day → cut order: ownership guard → mid-turn injection. CLI verbs + prompt-time digest are the core. Verbs alone still beat freestyle MCP. Full manual protocol (PLAYBOOK MUSTs, humans clicking Linear) is the floor under the floor.
