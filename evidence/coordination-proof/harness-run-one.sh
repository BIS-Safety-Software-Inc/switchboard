#!/usr/bin/env bash
# One full coordination-proof measurement cycle.
# Args: $1 = run number (1..3)
# Requires: LINEAR_API_KEY sourced; SCRATCH, SWB, EVID env set by caller.
set -uo pipefail

RUN="$1"
RUNDIR="$EVID/run$RUN"
mkdir -p "$RUNDIR"

echo "════════════════════════════════════════════════════════════"
echo " RUN $RUN"
echo "════════════════════════════════════════════════════════════"

# Fresh session ids per run
SID_A=$(uuidgen | tr 'A-Z' 'a-z')
SID_B=$(uuidgen | tr 'A-Z' 'a-z')
echo "session A = $SID_A"
echo "session B = $SID_B"
echo "$SID_A" > "$RUNDIR/session-A.id"
echo "$SID_B" > "$RUNDIR/session-B.id"

# Clean per-run state: remove any cursor for these ids (fresh), reset ownership.
rm -f ~/.switchboard/cursors/$SID_A.json ~/.switchboard/cursors/$SID_B.json
echo '{}' > ~/.switchboard/ownership.json

# Reset both clones' schema/consumer to the v1 baseline (fresh cursor files == fresh run).
cd "$SCRATCH/cloneA" && git checkout -q -- lib/schema.js consumer.js 2>/dev/null
cd "$SCRATCH/cloneB" && git checkout -q -- lib/schema.js consumer.js 2>/dev/null
# clean any leftover worktrees from a prior run
rm -rf "$SCRATCH/switchboard-wt" 2>/dev/null
cd "$SCRATCH/cloneA" && git worktree prune 2>/dev/null
cd "$SCRATCH/cloneB" && git worktree prune 2>/dev/null

# ── (1b) create the two tickets, promote to Ready ──────────────────────────────
echo "--- creating tickets (Ready) ---"
TICKETS=$(node "$SP/setup-tickets.js" "R$RUN change quiz_progress to composite key" "R$RUN build consumer of quiz_progress")
echo "$TICKETS" | tee "$RUNDIR/tickets.json"
T_A=$(echo "$TICKETS" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).A))')
T_B=$(echo "$TICKETS" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).B))')
echo "T-A=$T_A  T-B=$T_B"
echo "$T_A" > "$RUNDIR/T_A.key"; echo "$T_B" > "$RUNDIR/T_B.key"

# ── (2) Session B claims T-B (declares consumer files), then runs a real Claude ─
echo "--- B claims $T_B ---"
cd "$SCRATCH/cloneB"
node "$SWB" claim "$T_B" --files "consumer.js" --session "$SID_B" 2>&1 | tee "$RUNDIR/B-claim.txt"

echo "--- B turn 1: implement consumer against CURRENT contract ---"
B_PROMPT1='Read lib/schema.js in this project to see how the quiz_progress object is shaped, then write consumer.js so it can find one quiz_progress record by its key, using exactly the key field(s) the schema lists today. Keep the code small. At the end, list which key field(s) your lookup uses, then stop.'
claude -p "$B_PROMPT1" --session-id "$SID_B" --add-dir "$SCRATCH/cloneB" \
  --allowedTools "Read,Edit,Write" --permission-mode acceptEdits \
  < /dev/null > "$RUNDIR/B-turn1.out.txt" 2> "$RUNDIR/B-turn1.err.txt"
echo "B turn1 exit=$?"
echo "----- B turn1 output (head) -----"; head -40 "$RUNDIR/B-turn1.out.txt"
echo "----- consumer.js after turn1 -----"; cat "$SCRATCH/cloneB/consumer.js" | tee "$RUNDIR/consumer-after-turn1.js"

# snapshot B's cursor right after turn 1 (so we can prove the measurement delta is fresh)
cp -f ~/.switchboard/cursors/$SID_B.json "$RUNDIR/B-cursor-after-turn1.json" 2>/dev/null || echo "{}" > "$RUNDIR/B-cursor-after-turn1.json"
echo "B cursor after turn1:"; cat "$RUNDIR/B-cursor-after-turn1.json"

# ── (3) Session A: claim T-A, change schema to composite key, broadcast ─────────
echo "--- A claims $T_A ---"
cd "$SCRATCH/cloneA"
node "$SWB" claim "$T_A" --files "lib/schema.js" --session "$SID_A" 2>&1 | tee "$RUNDIR/A-claim.txt"

echo "--- A changes lib/schema.js to composite key ---"
cat > "$SCRATCH/cloneA/lib/schema.js" <<'SCHEOF'
'use strict';
/**
 * Data-shape contracts for the quiz service.
 * quiz_progress: tracks how far a user has gotten.
 *
 * CONTRACT (v2): COMPOSITE key — a user can have progress per quiz per attempt.
 */
const quiz_progress = {
  key: ['user_id', 'quiz_id', 'attempt_no'],
  fields: {
    user_id: 'string',
    quiz_id: 'string',
    attempt_no: 'number',
    percent_complete: 'number',
  },
};

module.exports = { quiz_progress };
SCHEOF
echo "schema now:"; cat "$SCRATCH/cloneA/lib/schema.js" | tee "$RUNDIR/schema-after-A-change.js" >/dev/null

echo "--- A broadcasts the contract change (discover) ---"
node "$SWB" discover "R$RUN quiz_progress contract changed to composite key (user_id, quiz_id, attempt_no) — consumers must pass all three" --session "$SID_A" 2>&1 | tee "$RUNDIR/A-discover.txt"

echo "--- A asks B on $T_B (mentions B's viewer) ---"
node "$SWB" ask "$T_B" "@turni.saha" "R$RUN heads up — quiz_progress is now a composite key (user_id, quiz_id, attempt_no); your consumer must pass all three" --session "$SID_A" 2>&1 | tee "$RUNDIR/A-ask.txt"

# Force a cache refresh so B's next-turn hook sees A's fresh discovery+comment.
# The 45s-stale guard would otherwise serve the pre-broadcast cache; deleting
# cache.json forces the hook's refetch (and our repro) to read live truth.
rm -f ~/.switchboard/cache.json
cd "$SCRATCH/cloneB"
node "$SWB" sync --session cache-warm-$RUN > /dev/null 2>&1
rm -f ~/.switchboard/cursors/cache-warm-$RUN.json

# ── EVIDENCE: capture EXACTLY what the hook will inject on B's measurement turn ──
# Snapshot the live cache + B's cursor so the digest is fully reconstructable.
cp -f ~/.switchboard/cache.json "$RUNDIR/cache-at-measurement.json" 2>/dev/null
cp -f ~/.switchboard/cursors/$SID_B.json "$RUNDIR/B-cursor-at-measurement.json" 2>/dev/null
echo "--- reproducing the digest the hook WILL inject for B (read-only) ---"
node "$SP/repro-digest.js" "$SID_B" "$SCRATCH/cloneB" | tee "$RUNDIR/injected-digest.txt"

# ── (4) MEASUREMENT: continue B with a strictly NEUTRAL prompt ──────────────────
echo "--- B turn 2 (MEASUREMENT): neutral 'continue with your ticket' ---"
cd "$SCRATCH/cloneB"
claude -p --resume "$SID_B" "continue with your ticket" --add-dir "$SCRATCH/cloneB" \
  --allowedTools "Read,Edit,Write" --permission-mode acceptEdits \
  < /dev/null > "$RUNDIR/B-turn2.out.txt" 2> "$RUNDIR/B-turn2.err.txt"
echo "B turn2 exit=$?"
echo "----- B turn2 output (FULL) -----"; cat "$RUNDIR/B-turn2.out.txt"
echo "----- consumer.js after turn2 -----"; cat "$SCRATCH/cloneB/consumer.js" | tee "$RUNDIR/consumer-after-turn2.js"

# capture the actual hook events.jsonl entries for B this run (proof the hook fired)
grep -F "$SID_B" ~/.switchboard/events.jsonl | tail -6 > "$RUNDIR/B-hook-events.jsonl"
echo "----- B hook events -----"; cat "$RUNDIR/B-hook-events.jsonl"

echo "RUN $RUN complete."
