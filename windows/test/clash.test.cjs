const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const YAML = require('yaml');
const {Clash, ENTRY, EXIT} = require('../clash.cjs');
const {Backend} = require('../backend.cjs');

async function fixture(t, options = {}) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linkbox-clash-'));
 t.after(() => fs.rm(root, {recursive: true, force: true}));
 await fs.writeFile(path.join(root, 'clash-verge.yaml'), 'proxies: []\n');
 const b = await new Backend(path.join(root, 'data')).init();
 b.settings.configDir = root;
 b.clash = new Clash(() => b.settings, () => '', {endpoint: {}, ...options});
 return {root, b, adapter: b.clash};
}

test('controller surface sends only named reads, entry switch and validated reload', async t => {
 const events = [];
 const {adapter, root} = await fixture(t, {
  validate: async file => { events.push(['validate', await fs.readFile(file, 'utf8')]); },
  transport: async (_endpoint, method, route, body) => { events.push([method, route, body]); return {}; },
 });
 assert.equal(adapter.api, undefined);
 assert.equal(adapter.request, undefined);
 await adapter.relayState();
 await adapter.providers();
 await adapter.connections();
 await adapter.switchEntry('a/b?c');
 const payload = 'proxies: []';
 await adapter.reload(root, payload, () => events.push(['prepare']), () => assert.fail('rollback'));
 assert.deepEqual(events, [
  ['GET', '/configs', undefined], ['GET', '/proxies', undefined],
  ['GET', '/providers/proxies', undefined], ['GET', '/connections', undefined],
  ['PUT', '/proxies/' + encodeURIComponent(ENTRY), {name: 'a/b?c'}],
  ['validate', payload], ['prepare'], ['PUT', '/configs?force=false', {payload}],
 ]);
});

test('HTTP errors ignore response content and classify explicit reload rejection', async t => {
 let status = 401, body = 'password: fixture-only';
 const {adapter, root} = await fixture(t, {endpoint: {secret: 'local-test'}, validate: () => {}});
 const requests = [];
 t.mock.method(http, 'request', (options, respond) => {
  requests.push(options);
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => queueMicrotask(() => {
   req.emit('socket', {connecting: false});
   const response = new EventEmitter();
   response.statusCode = status;
   response.resume = () => {};
   respond(response);
   if (body) response.emit('data', Buffer.from(body));
   response.emit('end');
   req.emit('close');
  });
  return req;
 });
 await assert.rejects(adapter.providers(), {message: 'Clash 控制接口返回 401', rejected: true});
 assert.equal(requests[0].headers.Authorization, 'Bearer local-test');
 status = 200;
 await assert.rejects(adapter.connections(), {message: 'Clash 返回无效数据'});
 status = 400;
 for (body of ['password: fixture-only', '']) {
  let rolledBack = false;
  await assert.rejects(adapter.reload(root, 'proxies: []', () => {}, () => { rolledBack = true; }),
   {message: 'Clash 控制接口返回 400，文件已回退；请刷新状态后重试'});
  assert.ok(rolledBack);
 }
});

test('a connected controller failure preserves the transport error and leaves the reload unconfirmed', async t => {
 const {adapter, root} = await fixture(t, {validate: () => {}});
 t.mock.method(http, 'request', () => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => queueMicrotask(() => {
   req.emit('socket', {connecting: false});
   req.emit('error', Object.assign(Error('read ECONNRESET'), {code: 'ECONNRESET'}));
   req.emit('close');
  });
  return req;
 });
 await assert.rejects(adapter.relayState(), {message: 'read ECONNRESET'});
 await assert.rejects(adapter.reload(root, 'proxies: []', () => {}, () => assert.fail('rollback')),
  {message: '已写入新配置，Clash 未确认，请刷新状态核对'});
});

test('verified manual switch leaves a newly active Verge profile alone', async t => {
 let entry = 'old';
 const {b, root} = await fixture(t, {transport: (_endpoint, _method, _route, body) => { entry = body.name; }});
 const file = path.join(root, 'profiles.yaml');
 const original = YAML.stringify({current: 'a', items: [{uid: 'a'}, {uid: 'b'}]});
 const changed = original.replace('current: a', 'current: b');
 await fs.writeFile(file, original);
 b.state = async () => {
  if (entry === 'new') await fs.writeFile(file, changed);
  return {mode: 'global', entry, exit: EXIT, dialer: ENTRY, switchable: ['old', 'new'],
   entryOwners: {old: 'a', new: 'a'}};
 };
 assert.equal((await b.switchNode('new', 'old')).entry, 'new');
 assert.equal(await fs.readFile(file, 'utf8'), changed);
});

test('post-reload persistence compares profiles before staging the replacement', async t => {
 const {adapter, root} = await fixture(t);
 const file = path.join(root, 'profiles.yaml');
 const original = {current: 'a', items: [{uid: 'a'}]};
 const write = fs.writeFile;
 await write(file, YAML.stringify(original));
 t.mock.method(fs, 'writeFile', async (target, ...args) => {
  if (target.startsWith(file + '.linkbox-')) await write(file, YAML.stringify({...original, current: 'b'}));
  return write(target, ...args);
 });

 await adapter.persistSelection(file, 'fast');
 assert.deepEqual(YAML.parse(await fs.readFile(file, 'utf8')), {
  current: 'a', items: [{uid: 'a', selected: [{name: ENTRY, now: 'fast'}]}],
 });
});

test('verified manual switch cannot overwrite a late Verge edit', async t => {
 let entry = 'old';
 const {b, root} = await fixture(t, {transport: (_endpoint, _method, _route, body) => { entry = body.name; }});
 const file = path.join(root, 'profiles.yaml');
 const original = YAML.stringify({current: 'a', items: [{uid: 'a'}]});
 const changed = original + '# Verge edit\n';
 await fs.writeFile(file, original);
 b.state = async () => {
  return {mode: 'global', entry, exit: EXIT, dialer: ENTRY, switchable: ['old', 'new'],
   entryOwners: {old: 'a', new: 'a'}};
 };
 let vergeContents = original;
 const rename = fs.rename;
 t.mock.method(fs, 'rename', async (source, destination) => {
  if (destination === file) {
   vergeContents = changed;
   await fs.writeFile(file, vergeContents);
  }
  await rename(source, destination);
 });
 assert.equal((await b.switchNode('new', 'old')).entry, 'new');
 assert.equal(await fs.readFile(file, 'utf8'), vergeContents);
});

test('reads honor a caller-supplied timeout and reload gives the controller thirty seconds', async t => {
 const deadlines = [];
 const {adapter, root} = await fixture(t, {validate: () => {}});
 const schedule = setTimeout;
 t.mock.method(globalThis, 'setTimeout', (callback, timeout) => {
  deadlines.push(timeout);
  return schedule(callback, 0);
 });
 t.mock.method(http, 'request', () => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => { req.emit('socket', {connecting: false}); };
  req.destroy = error => {
   req.emit('error', error);
   req.emit('close');
  };
  return req;
 });
 await assert.rejects(adapter.connections(4000), {message: 'Clash 控制接口超时'});
 await assert.rejects(adapter.reload(root, 'proxies: []', () => {}, () => assert.fail('rollback')),
  {message: '已写入新配置，Clash 未确认，请刷新状态核对'});
 assert.deepEqual(deadlines, [4000, 30000]);
});

test('Windows Network Check can verify a controller response after five seconds', async t => {
 const {b} = await fixture(t);
 const platform = Object.getOwnPropertyDescriptor(process, 'platform');
 Object.defineProperty(process, 'platform', {...platform, value: 'win32'});
 t.after(() => Object.defineProperty(process, 'platform', platform));
 t.mock.method(os, 'networkInterfaces', () => ({}));
 b.trace = async () => ({ip: '203.0.113.10'});
 b.settings.expectedIP = '203.0.113.10';
 b.ipv6Probe = async () => ({connected: false});
 b.powershell = async () => JSON.stringify({connections: [{LocalPort: 5000, LocalAddress: '127.0.0.1'}]});
 const replies = {
  '/configs': {mode: 'global'},
  '/proxies': {proxies: {[ENTRY]: {now: 'relay', all: ['relay']}, GLOBAL: {now: EXIT}}},
  '/providers/proxies': {},
  '/connections': {connections: [{metadata: {sourcePort: '5000', sourceIP: '127.0.0.1'}, chains: [EXIT]}]},
 };
 const deadlines = [];
 t.mock.method(globalThis, 'setTimeout', (abandon, ms) => {
  deadlines.push(ms);
  if (ms < 5000) queueMicrotask(abandon);
 });
 t.mock.method(http, 'request', ({path: route}, respond) => {
  const req = new EventEmitter();
  req.on('newListener', event => {
   if (event === 'error') req.emit('socket', {connecting: false});
  });
  req.destroy = error => req.emit('error', error);
  req.end = () => queueMicrotask(() => {
   const response = Object.assign(new EventEmitter(), {statusCode: 200});
   respond(response);
   response.emit('data', Buffer.from(JSON.stringify(replies[route])));
   response.emit('end');
   req.emit('close');
  });
  return req;
 });
 const report = await b.networkCheck();
 assert.equal(report.stable, true);
 assert.equal(report.claude.status, 'ok');
 assert.deepEqual(deadlines, Array(7).fill(6000));
});

test('a rejection after seven seconds still rolls back a Windows reload', async t => {
 const {root, adapter} = await fixture(t, {validate: () => {}});
 const file = path.join(root, 'clash-verge.yaml');
 const original = await fs.readFile(file, 'utf8'), payload = 'proxies: [{name: new}]';
 let deadline;
 t.mock.method(globalThis, 'setTimeout', (abandon, ms) => {
  deadline = {abandon, ms};
 });
 t.mock.method(http, 'request', (_options, respond) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = error => req.emit('error', error);
  req.end = () => queueMicrotask(() => {
   req.emit('socket', {connecting: false});
   if (deadline.ms < 7000) deadline.abandon();
   else respond(Object.assign(new EventEmitter(), {statusCode: 400, resume() {}}));
   req.emit('close');
  });
  return req;
 });
 const reload = adapter.reload(root, payload, () => fs.writeFile(file, payload), () => fs.writeFile(file, original));
 await assert.rejects(reload, /400.*文件已回退/);
 assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('a concurrent rediscovery of the same controller does not cancel the reload', async t => {
 const requests = [];
 let releaseSecond;
 const secondVersion = new Promise(resolve => { releaseSecond = resolve; });
 let versions = 0, validate;
 const {adapter, root} = await fixture(t, {
  endpoint: undefined,
  resolveConfig: async () => ({config: {'external-controller': '127.0.0.1:9097'}}),
  validate: () => validate(),
  transport: async (_endpoint, method, route, body) => {
   if (route === '/version') { if (++versions === 2) await secondVersion; return {}; }
   requests.push([method, route, body]);
   return {};
  },
 });
 const first = adapter.providers(), second = adapter.connections();
 await first;
 // The slower discovery finishes while the reload is validating and replaces the cached endpoint.
 validate = async () => { releaseSecond(); await second; };
 await adapter.reload(root, 'proxies: []', () => {}, () => assert.fail('rollback'));
 assert.deepEqual(requests.at(-1), ['PUT', '/configs?force=false', {payload: 'proxies: []'}]);
});

test('a reload uses the controller rediscovered after the original one stopped answering', async t => {
 const puts = [];
 let releaseSecond, validate;
 const secondVersion = new Promise(resolve => { releaseSecond = resolve; });
 let versions = 0;
 const {adapter, root} = await fixture(t, {
  endpoint: undefined,
  resolveConfig: async () => ({config: {'external-controller': '127.0.0.1:9097'}}),
  validate: () => validate(),
  transport: async (endpoint, method, route) => {
   if (route === '/version') {
    versions += 1;
    if (versions === 2) await secondVersion;
    endpoint.found = versions;
    return {};
   }
   if (method === 'PUT') puts.push(endpoint.found);
   return {};
  },
 });
 const first = adapter.providers(), second = adapter.connections();
 await first;
 validate = async () => { releaseSecond(); await second; };
 await adapter.reload(root, 'proxies: []', () => {}, () => assert.fail('rollback'));
 assert.deepEqual(puts, [2]);
});
