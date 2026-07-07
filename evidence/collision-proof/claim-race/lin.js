#!/usr/bin/env node
'use strict';
// Tiny Linear helper for the collision-proof harness. Subcommands print a single
// line to stdout so bash can capture with $(...). All I/O is real Linear GraphQL.
const KEY = process.env.LINEAR_API_KEY;
const API = 'https://api.linear.app/graphql';
const TEAM_ID = 'b865f93b-2ba3-4a17-bc74-317d6dc6c2a7';
const LABEL_ID = 'a1033653-bbb7-49db-868f-f7acb8f2e074';

async function gql(query, variables) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: KEY },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const d = await r.json();
  if (d.errors) throw new Error('GraphQL: ' + JSON.stringify(d.errors));
  return d.data;
}

async function todoStateId() {
  const d = await gql('query{teams(filter:{key:{eq:"HAC"}},first:1){nodes{states(first:50){nodes{id name}}}}}');
  return d.teams.nodes[0].states.nodes.find((s) => s.name === 'Todo').id;
}
async function issueIdByNumber(num) {
  const d = await gql(
    'query($n:Float!){issues(filter:{number:{eq:$n},team:{key:{eq:"HAC"}}},first:1){nodes{id}}}',
    { n: Number(num) }
  );
  const node = d.issues.nodes[0];
  if (!node) throw new Error('issue #' + num + ' not found');
  return node.id;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'create') {
    // create <title> → prints "IDENTIFIER NUMBER ID"
    const title = rest[0];
    const d = await gql(
      'mutation($t:String!,$title:String!,$l:[String!]){issueCreate(input:{teamId:$t,title:$title,labelIds:$l}){success issue{id identifier number}}}',
      { t: TEAM_ID, title, l: [LABEL_ID] }
    );
    const i = d.issueCreate.issue;
    process.stdout.write(`${i.identifier} ${i.number} ${i.id}`);
  } else if (cmd === 'promote') {
    // promote <id> → to Ready(Todo), unassigned
    const sid = await todoStateId();
    await gql(
      'mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s,assigneeId:null}){success}}',
      { id: rest[0], s: sid }
    );
    process.stdout.write('promoted');
  } else if (cmd === 'assign') {
    // assign <id> <userId> → prints assignee name
    const d = await gql(
      'mutation($id:String!,$a:String!){issueUpdate(id:$id,input:{assigneeId:$a}){success issue{assignee{name}}}}',
      { id: rest[0], a: rest[1] }
    );
    process.stdout.write(d.issueUpdate.issue.assignee ? d.issueUpdate.issue.assignee.name : 'null');
  } else if (cmd === 'state') {
    // state <number> → prints "StateName|Assignee"
    const d = await gql(
      'query($n:Float!){issues(filter:{number:{eq:$n},team:{key:{eq:"HAC"}}},first:1){nodes{state{name} assignee{name}}}}',
      { n: Number(rest[0]) }
    );
    const n = d.issues.nodes[0];
    process.stdout.write(`${n.state.name}|${n.assignee ? n.assignee.name : 'unassigned'}`);
  } else if (cmd === 'delete') {
    // delete <id>
    const d = await gql('mutation($id:String!){issueDelete(id:$id){success}}', { id: rest[0] });
    process.stdout.write(String(d.issueDelete.success));
  } else if (cmd === 'idByNumber') {
    process.stdout.write(await issueIdByNumber(rest[0]));
  } else if (cmd === 'listTest') {
    // list all swb-test labelled HAC issues → "IDENT ID" per line
    const d = await gql(
      'query{teams(filter:{key:{eq:"HAC"}},first:1){nodes{issues(first:100){nodes{id identifier labels{nodes{name}}}}}}}'
    );
    const nodes = d.teams.nodes[0].issues.nodes.filter((i) => i.labels.nodes.some((l) => l.name === 'swb-test'));
    process.stdout.write(nodes.map((i) => `${i.identifier} ${i.id}`).join('\n'));
  } else {
    process.stderr.write('unknown cmd: ' + cmd);
    process.exit(2);
  }
}
main().catch((e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
