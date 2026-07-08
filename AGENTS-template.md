# AGENTS.md — Switchboard protocol (drop-in)

> Paste this section into your team repo's `AGENTS.md` on planning day. It is the
> contract your agents read on every run. Fill in the two `<TEAM CHOICE>` blocks;
> leave everything else exactly as written — it is the coordination floor.
>
> Why this file matters: verbal briefings die at the first context compaction.
> Anything written here survives. This file, plus the hooks, IS the protocol.

---

## You are one of many parallel sessions

Sixteen developers are driving agents against **one shared Linear board**. You
coordinate through the board, not by guessing. Your job: build your claimed
ticket without colliding with anyone else's work, and surface anything the rest
of the team needs to know.

The human speaks English. **You speak `swb`.** Every board write goes through an
`swb` verb — never a raw Linear MCP write, never a freestyle API call.

---

## MUSTs (non-negotiable — this is the coordination floor)

- **No drive-by refactors.** No changes outside your ticket's declared files —
  however ugly the neighboring code. Cleanup is its own ticket, proposed in
  Backlog like everything else. Agent-cheap refactoring produces unreviewable
  2,000-line diffs; the reviewer's time is the scarce resource, not yours.
- **Compose with the repo's own CLAUDE.md.** bistrainerdev's hard stops,
  /bis-plan → /bis-build workflow, design-system rules, and dev-DB read-only
  policy all still bind. This file adds the TEAM coordination layer on top;
  where they conflict, the repo hard-stop wins.
- **Use the knowledge tools before guessing at CFML.** The codegraph MCP and
  the BIS knowledge base (bis-knowledgebase/ + ask-BIS) answer codebase facts;
  LLM training data on ColdFusion is thin, so VERIFY idioms against real files
  (your team's anchor files below) instead of inventing them.

- **Gate 2 is built into the kit and survives skip-permissions.** `swb claim` and
  `swb done` are DENIED by a hook unless the command carries `--approved`. When
  you hit the denial: ask your human in the conversation, get their explicit
  yes, then re-run with `--approved`. NEVER append `--approved` without that
  yes — the flag is logged and the claim comment says "human-approved"; a lie
  is visible forever. Teams that want autonomous claiming set `"gate2": "off"`
  in `.swb.json` (a planning-day decision, made out loud).

- **Read the full ticket before building.** `swb claim` prints the spec when you claim; for any OTHER ticket a digest line points you at (an @you question, a teammate's change), run `swb show <KEY>` before acting. Titles are headlines, not specs — never build from a title.

1. **Claim before you edit.** Never edit a file for a ticket you have not
   claimed. Run `swb claim <KEY> --files "<glob1,glob2>"` first. This assigns the
   human, moves the ticket to In Progress, cuts a worktree, and declares your
   files. Work inside that worktree.
2. **Declare your files honestly.** The `--files` globs you pass are what the
   ownership guard checks for *everyone else*. Under-declaring hides collisions;
   over-declaring blocks teammates. Declare exactly what this ticket touches.
3. **Never create Todo work.** `swb new` lands in **Backlog**. Only a human
   promotes Backlog → Ready. Do not move a ticket to Ready yourself.
4. **Never close your own ticket.** `swb done` is the furthest you go — it moves
   the ticket to **In Review**. A human merges the PR to reach Done.
5. **`done` is gated — do not fight it.** `swb done <KEY> --pr <url>` runs the
   test command first and **refuses on failure**, then requires a real `--pr`
   URL. If it refuses, fix the tests or open the PR — do not route around it.
6. **Ask instead of guessing.** When you hit an unknown you would otherwise guess
   at (another ticket's schema, a design intent, an API contract), run
   `swb ask <KEY> @<owner> "<question>"`, park the dependent piece, and continue
   elsewhere. Do not block.
7. **One claim at a time (WIP = 1).** Hold a single ticket. Finish it (`swb done`)
   or `swb release <KEY>` it before claiming the next.
8. **Every write is signed.** `swb` appends `🤖 Claude — via <human> · swb vX`
   automatically. The human is always the assignee and stays accountable — never
   impersonate a human answer; the human gates every reply.
9. **Subagents never write to the board.** If you spawn subagents / a fleet, they
   may *read* (`swb sync`, `swb show`) but all `swb` writes happen from the main
   session where the human sees them. One claim = one worktree, no matter how many
   subagents work inside it.

---

## Act on the digest — don't just read it

A hook injects a **digest** at the top of your context on every prompt (and
mid-run during long tasks). It ends with an `act` directive:

```
act    if any item above touches your claimed ticket or declared files,
       state the impact before continuing
```

**This is mandatory, not a bulletin.** If any digest item — a claim, a state
change, a discovery, an `@you` question, a schema move — intersects your claimed
ticket or declared files, **stop and state the impact before continuing your
current task.** "Session A changed the schema, so I'm adapting my query" is the
behavior the whole system exists to produce. Silently building against a
now-stale assumption is the failure mode it exists to prevent.

Mentions to you (`@you`) always sort first. Detail lives behind `swb show <KEY>`.

---

## Deep reads: spawn a reader subagent, protect your context

The digest gives you headlines; full tickets live behind `swb show`. When MORE
than one ticket needs a deep read (an @you question plus its linked tickets, or
"did anything today touch my files?"), do NOT swallow whole tickets into your
own context — spawn a read-only subagent and keep the conclusion:

> Task: run `swb show HAC-23` and `swb show HAC-31` (and `swb board` for
> orientation). Report ONLY what affects `src/player/**` and any decision I'm
> being asked to make. Two paragraphs max.

Rules: reader subagents are READ-ONLY (`sync` / `show` / `board` / `members` —
never `claim`/`ask`/`done`); one claim's work stays in one main session. The PM
runs the standing version of this: an hourly board-reader sweep that deep-reads
everything and reports stuck tickets, aging @asks, and scope drift.

## `swb` verb crib sheet

| Verb | You run it to… | Notes |
|---|---|---|
| `swb sync` | Print the delta digest since your last look | Read-only. Safe to run anytime. **Codex: run this at the start of every task.** |
| `swb show <KEY>` | Read a ticket's full state + comments | Read-only. Use it whenever a digest line references a ticket. |
| `swb claim <KEY> --files "<globs>"` | Take a Todo ticket | Assign → In Progress → worktree at `../switchboard-wt/<KEY>` → declare files → signed comment. Backs off (exit 3) if you lose a claim race. |
| `swb ask <KEY> @<user> "<question>"` | Ask the ticket owner something | Posts a signed `@mention` comment. Surfaces in their next digest's priority slot. Then park and move on. |
| `swb discover "<text>"` | Share a cross-cutting finding | Appends `DISCOVERIES.md` + comments on the pinned Discoveries thread. Reaches all sessions within one turn. |
| `swb done <KEY> --pr <url>` | Mark work ready for review | **Runs tests first, refuses on non-zero**, requires `--pr`, moves to In Review, posts a summary (or pass `--summary "…"`), frees your file ownership. |
| `swb release <KEY>` | Drop a claim you can't finish | Unassigns, frees file ownership, **keeps** the branch/worktree. |
| `swb new "<title>" [--body "…"]` | File a new ticket | Always lands in **Backlog**. A human promotes it later. |
| `swb doctor [--fix]` | Check your setup | Verifies key, team, API, and the five states. `--fix` creates missing states. |

**Exit codes:** `0` ok · `2` failed-with-recipe (do the printed `MANUAL RECIPE:`
steps by hand) · `3` claim lost the race (re-run after the holder releases).

---

## Fail-open — you are never blocked on the tool

If any `swb` verb errors, it prints:

```
MANUAL RECIPE: <what it was trying to do>
  1. <step a human can do in the Linear UI / terminal>
  2. …
```

Do those steps by hand, tell the human, and keep working. A broken `swb` never
stops the build.

---

## Codex / non-Claude harnesses — degraded mode

**Better option first: run Codex THROUGH Claude Code's `/codex` plugin.** Claude
Code stays your shell (hooks fire → digest + yellow block + guard all work);
the Codex engine does the coding inside it. Full Switchboard, nothing degraded.
The rest of this section applies only if you run the bare `codex` CLI as your
whole terminal:

Automatic digest injection is a Claude Code hook feature. If you are **not**
running under Claude Code (Codex, plain CLI, etc.), you do **not** get the
ambient digest. Your one extra obligation:

> **Run `swb sync` at the start of every task**, and again whenever you're about
> to touch a shared area or make an assumption about another ticket.

This is the same coordination floor, pulled manually instead of pushed. Every
other MUST applies unchanged. (Teams: pair Codex sessions with Claude-heavy
tickets so a blind session isn't on the critical path.)

---

## `.swb.json` (repo root — required)

```json
{ "teamKey": "<TEAM CHOICE: your Linear team key>", "testCommand": "<TEAM CHOICE: e.g. node --test>", "defaultBranch": "main" }
```

- `teamKey` — every query and mutation is scoped to this team. Without a
  resolvable team, `swb` refuses to run.
- `testCommand` — run by `swb done`; a non-zero exit blocks the transition. **QA
  owns this** — point it at the failing-test contracts committed on planning day.
- `defaultBranch` — used when creating worktrees.

---

## Team defaults — decide these on planning day, write them here

_Fill in below. These are yours to set; changing them does not break the floor._

- **Roster & label routing:** who is dev / QA / design / PM; the `@design`,
  `@qa`, `@pm` labels that route digests and questions.
- **File-ownership map:** the glob patterns each area owns, so `--files`
  declarations don't overlap by accident.
- **Ready-ticket template:** acceptance criteria, files to touch, files NOT to
  touch, blocked-by links. (The PM applies this when promoting Backlog → Ready.)
- **Merge cadence & review policy:** per-ticket vs checkpoint; who reviews at
  `done`.

## Team fills in on planning day (from PLANNING-DAY.html)

- Team branch (also `.swb.json` defaultBranch): ______
- testCommand (the done-gate — Section B decision): ______
- Gate 2: on (default) / off: ______
- WIP limit: ______
- Backlog sweeper (name + cadence): ______
- DB-script owner (schema changes serialized through them): ______
- Deploy owner: ______
- God-file lanes (serialized — one ticket at a time): ______
- Anchor files per module ("write CFML like this file"): ______
- Review pairs (QA coordinates): ______
