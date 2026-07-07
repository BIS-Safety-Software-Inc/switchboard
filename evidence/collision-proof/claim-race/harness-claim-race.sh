#!/usr/bin/env bash
# CLAIM RACE harness — real subprocesses, real Linear, single shared key.
#
# HONEST MECHANISM. Both `node swb.js claim` PROCESSES authenticate with the SAME
# Linear key (one viewer = Turni Saha). The contract's race arbiter is
# `recheck.assignee.id !== viewer.id` in verbClaim — it only registers a LOSS when
# the re-fetched assignee is a DIFFERENT identity than the racer's own viewer. With a
# single key two same-user racers BOTH pass that check (proven separately in the
# README "single-key" note). To exercise the REAL exit-3 back-off path end-to-end
# against the REAL Linear server, a concurrent writer reassigns the issue to the
# OTHER real org user (ai@bistraining.ca) at a wall-clock instant that lands AFTER
# the winner's re-check read but BEFORE the loser's. A ~1.2s launch stagger separates
# the two re-check windows (a full claim is ~4s; the re-check read lands ~2.6-2.9s in).
# Both claim processes are alive and contending on the one issue throughout.
# Nothing is mocked: real swb.js code path, real GraphQL, real re-fetch, real git
# worktree, real ownership.json.
set -u
SCRATCH="/private/tmp/claude-502/-Users-turni-saha-Desktop-AI-Hackathon/6694b041-c9b1-4f2e-a635-216c1b74a227/scratchpad/collision"
REPO="/Users/turni.saha/Desktop/AI Hackathon/switchboard"
EVID="$REPO/evidence/collision-proof/claim-race"
LIN="node $SCRATCH/lin.js"
OTHER_USER="3152218a-e0a5-4cf1-8e00-1a614d60d413"   # ai@bistraining.ca (real org user)
WIN_USER="b96c64de-b8da-48a6-b89c-c5b8562824d1"     # Turni Saha (shared-key viewer / winner)

mkdir -p "$EVID"
RESULT_ALL="$EVID/RESULTS.txt"; : > "$RESULT_ALL"
overall_pass=1

for RUN in 1 2 3; do
  echo "############################ RUN $RUN ############################" | tee -a "$RESULT_ALL"
  RD="$EVID/run$RUN"; rm -rf "$RD"; mkdir -p "$RD"

  # fresh isolated switchboard home per run
  H="$RD/home"; mkdir -p "$H/cursors"
  printf '{}\n' > "$H/ownership.json"
  printf 'LINEAR_API_KEY=%s\n' "$LINEAR_API_KEY" > "$H/env"

  # fresh clones per run
  CA="$RD/cloneA"; CB="$RD/cloneB"
  git clone -q "$SCRATCH/upstream" "$CA"
  git clone -q "$SCRATCH/upstream" "$CB"
  git -C "$CA" config user.email a@example.com; git -C "$CA" config user.name cloneA
  git -C "$CB" config user.email b@example.com; git -C "$CB" config user.name cloneB

  SID_A="run${RUN}-winnerA-$$-aaaa"
  SID_B="run${RUN}-loserB-$$-bbbb"

  # 1) create + promote (release + re-Ready is implicit: a fresh Ready issue per run)
  read KEYN NUM IID < <($LIN create "swb-test claim-race run$RUN")
  echo "$KEYN $NUM $IID" > "$RD/00-issue.txt"
  $LIN promote "$IID" > "$RD/01-promote.txt"
  echo "issue $KEYN (#$NUM) created + promoted to Ready" | tee -a "$RESULT_ALL"

  # 2) launch both claim processes (overlapping lifetimes) + one timed reassign
  export SWITCHBOARD_HOME="$H"
  ( cd "$CA" && SWITCHBOARD_HOME="$H" node swb.js claim "$KEYN" --files "src/payments/**" --session "$SID_A" > "$RD/A.out" 2>&1 ; echo $? > "$RD/A.code" ) &
  PA=$!
  ( sleep 1.2; cd "$CB" && SWITCHBOARD_HOME="$H" node swb.js claim "$KEYN" --files "src/payments/**" --session "$SID_B" > "$RD/B.out" 2>&1 ; echo $? > "$RD/B.code" ) &
  PB=$!
  ( sleep 3.4; $LIN assign "$IID" "$OTHER_USER" > "$RD/02-reassign-to-other.txt"
    sleep 1.6; $LIN assign "$IID" "$WIN_USER"  > "$RD/03-restore-winner.txt" ) &
  PW=$!
  wait $PA $PB $PW

  ACODE="$(cat "$RD/A.code")"; BCODE="$(cat "$RD/B.code")"
  echo "--- A(cloneA) exit=$ACODE ---" | tee -a "$RESULT_ALL"; sed 's/^/    A| /' "$RD/A.out" | tee -a "$RESULT_ALL"
  echo "--- B(cloneB) exit=$BCODE ---" | tee -a "$RESULT_ALL"; sed 's/^/    B| /' "$RD/B.out" | tee -a "$RESULT_ALL"

  # identify winner/loser by exit code
  WIN_CLONE=""; WIN_OUT=""; LOSE_CLONE=""; LOSE_OUT=""; LOSE_CODE=""; WIN_SID=""
  if [ "$ACODE" = "0" ] && [ "$BCODE" = "3" ]; then WIN_CLONE="$CA"; WIN_OUT="$RD/A.out"; WIN_SID="$SID_A"; LOSE_CLONE="$CB"; LOSE_OUT="$RD/B.out"; LOSE_CODE="$BCODE"
  elif [ "$BCODE" = "0" ] && [ "$ACODE" = "3" ]; then WIN_CLONE="$CB"; WIN_OUT="$RD/B.out"; WIN_SID="$SID_B"; LOSE_CLONE="$CA"; LOSE_OUT="$RD/A.out"; LOSE_CODE="$ACODE"; fi

  cp "$H/ownership.json" "$RD/ownership-after.json"
  git -C "$CA" worktree list > "$RD/A-worktrees.txt"
  git -C "$CB" worktree list > "$RD/B-worktrees.txt"
  cp "$H/events.jsonl" "$RD/events.jsonl" 2>/dev/null || true
  $LIN state "$NUM" > "$RD/04-final-state.txt"; STATE="$(cat "$RD/04-final-state.txt")"

  # ---- assertions ----
  run_pass=1
  fail () { echo "  ✖ $1" | tee -a "$RESULT_ALL"; run_pass=0; }
  ok   () { echo "  ✔ $1" | tee -a "$RESULT_ALL"; }
  echo ">>> ASSERTIONS run $RUN (winner=$([ "$WIN_CLONE" = "$CA" ] && echo cloneA || ([ "$WIN_CLONE" = "$CB" ] && echo cloneB || echo NONE)))" | tee -a "$RESULT_ALL"

  [ -n "$WIN_CLONE" ] && ok "exactly one winner(exit0)+one loser(exit3): A=$ACODE B=$BCODE" || fail "not a clean 1-win/1-loss split: A=$ACODE B=$BCODE"
  [ "$LOSE_CODE" = "3" ] && ok "loser exit code = 3" || fail "loser exit != 3 (got '$LOSE_CODE')"
  if [ -n "$LOSE_OUT" ] && grep -q "claim race lost" "$LOSE_OUT" && grep -q "Backing off" "$LOSE_OUT"; then ok "loser printed back-off ('claim race lost … Backing off')"; else fail "loser back-off message missing"; fi
  if [ -n "$LOSE_CLONE" ]; then git -C "$LOSE_CLONE" worktree list > "$RD/loser-worktrees.txt"; fi
  if [ -n "$LOSE_CLONE" ] && [ "$(wc -l < "$RD/loser-worktrees.txt" | tr -d ' ')" = "1" ]; then ok "loser created NO worktree (only its main tree)"; else fail "loser created a worktree unexpectedly"; fi
  grep -q "✔ claimed $KEYN" "$WIN_OUT" 2>/dev/null && ok "winner printed '✔ claimed $KEYN'" || fail "winner claim confirmation missing"
  if grep -q "worktree:" "$WIN_OUT" 2>/dev/null && grep -q "branch $KEYN" "$WIN_OUT" 2>/dev/null; then ok "winner created worktree (branch $KEYN)"; else fail "winner worktree line missing"; fi
  git -C "$WIN_CLONE" worktree list > "$RD/winner-worktrees.txt" 2>/dev/null
  grep -q "switchboard-wt/$KEYN" "$RD/winner-worktrees.txt" 2>/dev/null && ok "winner worktree present on disk" || fail "winner worktree not on disk"
  OWN="$(node -e '
    const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const key=process.argv[2], sid=process.argv[3];const k=Object.keys(o);
    let r="OK";
    if(k.length!==1) r="BADCOUNT:"+k.length;
    else if(k[0]!==key) r="BADKEY:"+k[0];
    else if(o[key].sessionId!==sid) r="BADSID:"+o[key].sessionId;
    console.log(r);
  ' "$RD/ownership-after.json" "$KEYN" "$WIN_SID")"
  [ "$OWN" = "OK" ] && ok "ownership.json: exactly ONE entry ($KEYN) owned by WINNER session" || fail "ownership.json wrong: $OWN"
  [ "$STATE" = "In Progress|Turni Saha" ] && ok "board: winner=Turni Saha + In Progress ($STATE)" || fail "board final state/assignee wrong: '$STATE'"

  [ "$run_pass" = "1" ] && echo "RUN $RUN: PASS" | tee -a "$RESULT_ALL" || { echo "RUN $RUN: FAIL" | tee -a "$RESULT_ALL"; overall_pass=0; }

  # release winner worktree + delete issue (teardown-as-we-go; final sweep re-checks)
  git -C "$WIN_CLONE" worktree remove --force "../switchboard-wt/$KEYN" 2>/dev/null || true
  $LIN delete "$IID" > "$RD/99-delete.txt"
  echo "issue $KEYN deleted (teardown)" | tee -a "$RESULT_ALL"; echo "" | tee -a "$RESULT_ALL"
done

echo "================ OVERALL: $([ "$overall_pass" = "1" ] && echo PASS || echo FAIL) ================" | tee -a "$RESULT_ALL"
exit $([ "$overall_pass" = "1" ] && echo 0 || echo 1)
