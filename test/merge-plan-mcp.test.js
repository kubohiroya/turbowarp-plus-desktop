const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const {installMergePlanMcp} = require('../src-main/merge-plan-mcp-ipc');

const project = {repository: 'repo', folder: 'game'};
const editorUrl = 'tw-editor://./plus-gui/gui.html';
const tool = (name, args) => ({method: 'tools/call', params: {name, arguments: args}});
const rpc = (connection, message, headers) => fetch(connection.url, {
  method: 'POST',
  headers: {Authorization: `Bearer ${connection.token}`, Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json', ...headers},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, ...message})
});
const call = async (connection, message) => (await rpc(connection, message)).json();

function editor (t, confirm = async () => true) {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, handler) => handlers.set(name, handler);
  const webContents = new EventEmitter();
  const frame = {url: editorUrl};
  webContents.mainFrame = frame;
  const event = {sender: webContents, senderFrame: frame};
  frame.send = (channel, id, name, args) => {
    assert.equal(channel, 'merge-plan-mcp-read');
    ipc.emit('merge-plan-mcp-result', event, id, true, {name, args});
  };
  installMergePlanMcp(ipc, webContents, confirm);
  t.after(() => webContents.emit('destroyed'));
  return {ipc, frame, webContents, event,
    start: (sender = event) => handlers.get('merge-plan-mcp-start')(sender, project),
    stop: token => handlers.get('merge-plan-mcp-stop')(event, token)};
}

test('requires a trusted editor, explicit approval and a loopback bearer token', async t => {
  let approve = false;
  const {start, stop, frame} = editor(t, async requested => {
    assert.deepEqual(requested, project);
    return approve;
  });
  assert.equal(await start(), null);
  frame.url = 'https://remote.example/';
  await assert.rejects(start(), /editor is unavailable/);
  frame.url = editorUrl;
  approve = true;
  const connection = await start();
  assert.equal(new URL(connection.url).hostname, '127.0.0.1');
  assert.equal((await rpc({...connection, token: 'invalid'}, {method: 'tools/list'})).status, 401);
  assert.equal((await rpc(connection, {method: 'tools/list'}, {Origin: 'https://remote.example/'})).status, 403);
  assert.equal((await fetch(connection.url, {headers: {Authorization: `Bearer ${connection.token}`}})).status, 405);
  await stop('wrong token');
  assert.equal((await rpc(connection, {method: 'tools/list'})).status, 200);
  await stop(connection.token);
  await assert.rejects(rpc(connection, {method: 'tools/list'}));
});

test('serves only the read tools in their own editor and revokes shares when the editor navigates', async t => {
  const first = editor(t);
  const second = editor(t);
  const a = await first.start();
  const b = await second.start();
  const init = await call(a, {method: 'initialize', params: {protocolVersion: '2025-11-25'}});
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, {tools: {}});
  const notified = await rpc(a, {id: undefined, method: 'notifications/initialized'});
  assert.equal(notified.status, 202);
  assert.equal(await notified.text(), '');
  const listing = await call(a, {method: 'tools/list'});
  assert.equal(listing.result.tools.length, 4);
  assert.ok(listing.result.tools.every(item => item.annotations.readOnlyHint));
  const read = tool('merge_plan_read_file', {generationId: 'generation', path: 'project.source.json'});
  assert.deepEqual((await call(a, read)).result.structuredContent, {name: read.params.name, args: read.params.arguments});
  assert.equal((await call(a, tool('merge_plan_read_file', {...read.params.arguments, limit: 999999}))).error.code, -32602);
  assert.equal((await call(a, tool('merge_plan_current_playtest', {project: '/other'}))).error.code, -32602);
  const runtime = tool('merge_plan_current_playtest', {sessionId: 'session', variables: [{id: 'trail', targetId: 'sprite', offset: 32}],
    logLimit: 5});
  assert.deepEqual((await call(a, runtime)).result.structuredContent, {name: runtime.params.name, args: runtime.params.arguments});
  assert.equal((await call(a, tool(runtime.params.name, {variables: [{id: 'x', value: 'write'}]}))).error.code, -32602);
  assert.equal((await call(a, tool(runtime.params.name, {logLimit: 51}))).error.code, -32602);
  assert.equal((await call(a, tool('merge_plan_write_file', read.params.arguments))).error.code, -32602);
  assert.equal((await rpc({...b, token: a.token}, read)).status, 401);
  first.webContents.emit('did-start-navigation', {isMainFrame: false, isSameDocument: false});
  assert.equal((await rpc(a, read)).status, 200);
  first.webContents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false});
  await assert.rejects(rpc(a, read));
  assert.equal((await rpc(b, read)).status, 200);
});

test('navigation during the approval prompt cannot open a stale share', async t => {
  let accept;
  const {start, webContents} = editor(t, () => new Promise(resolve => { accept = resolve; }));
  const opening = start();
  webContents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false});
  accept(true);
  assert.equal(await opening, null);
});
