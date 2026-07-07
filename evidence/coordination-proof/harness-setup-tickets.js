'use strict';
/*
 * Setup helper for the coordination proof.
 * Creates two swb-test-labelled tickets on team HAC and promotes both to Ready
 * (the PM gate), using swb.js's own Linear client so it matches production shapes.
 *
 * Usage: node setup-tickets.js "<T-A title>" "<T-B title>"
 * Prints JSON: {"A":"HAC-XX","B":"HAC-YY"}
 */
const swb = require('/Users/turni.saha/Desktop/AI Hackathon/switchboard/swb.js');

const TEAM = 'HAC';

async function ensureLabel(teamId, name, apiKey) {
  const q = `query($teamId: String!) { team(id: $teamId) { labels(first: 200) { nodes { id name } } } }`;
  const d = await swb.linear(q, { teamId }, apiKey);
  const existing = (d.team.labels.nodes || []).find((l) => l.name === name);
  if (existing) return existing.id;
  const m = `mutation($teamId: String!, $name: String!) {
    issueLabelCreate(input: { teamId: $teamId, name: $name }) { success issueLabel { id } } }`;
  const r = await swb.linear(m, { teamId, name }, apiKey);
  return r.issueLabelCreate.issueLabel.id;
}

async function createReadyTicket(team, title, body, labelId, readyStateId, apiKey) {
  const m = `mutation($teamId: String!, $title: String!, $desc: String, $stateId: String!, $labelId: String!) {
    issueCreate(input: { teamId: $teamId, title: $title, description: $desc, stateId: $stateId, labelIds: [$labelId] }) {
      success issue { id identifier state { name } labels { nodes { name } } } } }`;
  const d = await swb.linear(m, { teamId: team.id, title, desc: body, stateId: readyStateId, labelId }, apiKey);
  if (!d.issueCreate || !d.issueCreate.success) throw new Error('issueCreate failed for ' + title);
  return d.issueCreate.issue;
}

async function main() {
  const apiKey = swb.loadEnv().LINEAR_API_KEY;
  if (!apiKey) throw new Error('no LINEAR_API_KEY');
  const titleA = process.argv[2];
  const titleB = process.argv[3];
  if (!titleA || !titleB) throw new Error('need two titles');

  const team = await swb.getTeamByKey(TEAM, apiKey);
  // Ready = Linear "Todo"
  const readyState = (team.states.nodes || []).find((s) => s.name === 'Todo');
  if (!readyState) throw new Error('Ready/Todo state missing on team ' + TEAM);
  const labelId = await ensureLabel(team.id, 'swb-test', apiKey);

  const a = await createReadyTicket(team, titleA, 'quiz_progress contract owner', labelId, readyState.id, apiKey);
  const b = await createReadyTicket(team, titleB, 'quiz_progress consumer', labelId, readyState.id, apiKey);

  process.stdout.write(JSON.stringify({ A: a.identifier, B: b.identifier, aLabels: a.labels.nodes.map((l) => l.name), bLabels: b.labels.nodes.map((l) => l.name), aState: a.state.name, bState: b.state.name }) + '\n');
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
