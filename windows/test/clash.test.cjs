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
 await b.clash.config();
 return {root, b, adapter: b.clash};
}

test('controller surface sends only named reads, entry switch and validated reload', async t => {
 const events = [];
 const {adapter} = await fixture(t, {
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
 await adapter.reload(payload, () => events.push(['prepare']), () => assert.fail('rollback'));
 assert.deepEqual(events, [
  ['GET', '/configs', undefined], ['GET', '/proxies', undefined],
  ['GET', '/providers/proxies', undefined], ['GET', '/connections', undefined],
  ['PUT', '/proxies/' + encodeURIComponent(ENTRY), {name: 'a/b?c'}],
  ['validate', payload], ['prepare'], ['PUT', '/configs?force=false', {payload}],
 ]);
});

test('HTTP errors ignore response content and classify explicit reload rejection', async t => {
 let status = 401, body = 'password: fixture-only';
 const {adapter} = await fixture(t, {endpoint: {secret: 'local-test'}, validate: () => {}});
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
 await assert.rejects(adapter.providers(), {message: 'Clash API 返回 401', rejected: true});
 assert.equal(requests[0].headers.Authorization, 'Bearer local-test');
 status = 200;
 await assert.rejects(adapter.connections(), {message: 'Clash 返回无效数据'});
 status = 400;
 for (body of ['password: fixture-only', '']) {
  let rolledBack = false;
  await assert.rejects(adapter.reload('proxies: []', () => {}, () => { rolledBack = true; }),
   {message: 'Clash API 返回 400，文件已回退；请刷新状态后重试'});
  assert.ok(rolledBack);
 }
});

test('a connected controller failure hides transport details and leaves the reload unconfirmed', async t => {
 const {adapter} = await fixture(t, {validate: () => {}});
 t.mock.method(http, 'request', () => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => queueMicrotask(() => {
   req.emit('socket', {connecting: false});
   req.emit('error', Object.assign(Error('token: fixture-only'), {code: 'ECONNRESET'}));
   req.emit('close');
  });
  return req;
 });
 await assert.rejects(adapter.relayState(), {message: '无法读取 Clash 控制接口响应'});
 await assert.rejects(adapter.reload('proxies: []', () => {}, () => assert.fail('rollback')),
  {message: '已写入新配置，Clash 未确认，请刷新状态核对'});
});

test('manual switch persists both verified selectors and preserves unrelated profile data', async t => {
 let entry = 'old', verified = false;
 const {b, root} = await fixture(t, {
  transport: (_endpoint, method, route, body) => {
   assert.equal(route, '/proxies/' + encodeURIComponent(ENTRY));
   assert.equal(method, 'PUT');
   entry = body.name;
  },
 });
 const other = {uid: 'other', selected: [{name: ENTRY, now: 'unrelated'}]};
 const initial = {current: 'active', items: [{uid: 'active', selected: [{name: 'other group', now: 'keep'}]}, other]};
 const file = path.join(root, 'profiles.yaml');
 const original = YAML.stringify(initial);
 await fs.writeFile(file, original);
 b.state = async () => {
  assert.equal(await fs.readFile(file, 'utf8'), original);
  return {mode: 'global', entry, exit: EXIT, dialer: ENTRY, live: ['old', 'new'], switchable: ['old','new'],
   entryOwners: {old: 'owner', new: entry === 'old' || verified ? 'owner' : 'external'}};
 };
 await assert.rejects(b.switchNode('new', 'old'), /待核对/);
 assert.equal(await fs.readFile(file, 'utf8'), original);
 await assert.rejects(fs.stat(path.join(b.dataDir, 'backups')), {code: 'ENOENT'});

 entry = 'old';
 verified = true;
 const after = await b.switchNode('new', 'old');
 assert.equal(after.entry, 'new');
 assert.equal(after.switchWarning, undefined);
 initial.items[0].selected.push({name: ENTRY, now: 'new'}, {name: 'GLOBAL', now: EXIT});
 assert.deepEqual(YAML.parse(await fs.readFile(file, 'utf8')), initial);
 const backups = await fs.readdir(path.join(b.dataDir, 'backups'));
 assert.equal(backups.length, 1);
 assert.equal(await fs.readFile(path.join(b.dataDir, 'backups', backups[0]), 'utf8'), original);
});

test('selector persistence refuses concurrent changes and malformed YAML', async t => {
 const {b, adapter, root} = await fixture(t);
 const file = path.join(root, 'profiles.yaml');
 const original = YAML.stringify({current: 'active', items: [{uid: 'active'}]});
 const backup = path.join(b.dataDir, 'backups');
 await fs.writeFile(file, original);
 const write = fs.writeFile;
 const concurrent = original + '# edited by Verge\n';
 const stub = t.mock.method(fs, 'writeFile', async (dest, ...args) => {
  await write(dest, ...args);
  if (dest.startsWith(file + '.linkbox-')) await write(file, concurrent);
 });
 await assert.rejects(adapter.persistSelection('new', backup), /同时更新/);
 assert.equal(await fs.readFile(file, 'utf8'), concurrent);
 assert.ok((await fs.readdir(root)).every(name => !name.includes('.linkbox-')));
 stub.mock.restore();

 await fs.writeFile(file, 'current: [password: fixture-only');
 await assert.rejects(adapter.persistSelection('new', backup), {message: '无法读取 Clash Verge 订阅选择，未修改'});
 assert.equal(await fs.readFile(file, 'utf8'), 'current: [password: fixture-only');
});

test('reads and reload use the same controller deadline after validation', async t => {
 const deadlines = [];
 const {adapter} = await fixture(t, {validate: () => {}});
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
 await assert.rejects(adapter.connections(), {message: 'Clash 控制接口超时'});
 await assert.rejects(adapter.reload('proxies: []', () => {}, () => assert.fail('rollback')),
  {message: '已写入新配置，Clash 未确认，请刷新状态核对'});
 assert.deepEqual(deadlines, [6000, 6000]);
});
