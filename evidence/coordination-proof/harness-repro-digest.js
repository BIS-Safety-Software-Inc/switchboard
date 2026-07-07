'use strict';
/*
 * Reproduce EXACTLY what the switchboard UserPromptSubmit hook would inject for a
 * given session id, WITHOUT advancing the cursor (read-only). Feeds the same stdin
 * the real hook gets, but computes against a COPY of the cursor so we don't mutate
 * live state. Prints the additionalContext digest (or "(empty delta)").
 *
 * Usage: node repro-digest.js <sessionId> <cwd>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const hookPath = '/Users/turni.saha/Desktop/AI Hackathon/switchboard/hooks/userpromptsubmit.js';
const hook = require(hookPath);

function swbHome() {
  return process.env.SWITCHBOARD_HOME || path.join(os.homedir(), '.switchboard');
}

async function main() {
  const sessionId = process.argv[2];
  const cwd = process.argv[3] || process.cwd();
  if (!sessionId) throw new Error('need sessionId');
  // computeDigestInline is read-only w.r.t. the cursor (it never writes). It reads
  // cache.json + ownership.json + cursors/<id>.json and returns the digest text.
  const r = hook.computeDigestInline(sessionId, cwd);
  if (r.hasItems && r.text) {
    process.stdout.write(r.text + '\n');
  } else {
    process.stdout.write('(empty delta — nothing would be injected)\n');
  }
}
main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
