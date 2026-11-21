const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const http = require('node:http');
const timers = require('node:timers/promises');
const YAML = require('yaml');
const {Backend, ClashHTTPError, ENTRY, EXIT} = require('../backend.cjs');
const sub = require('../subscriptions.cjs');

const node = (name, server = 'relay.example.invalid') => ({
 name, type: 'ss', server, port: 443, cipher: 'aes-128-gcm', password: 'fixture',
});
const ENTRY_ROUTE = '/proxies/' + encodeURIComponent(ENTRY);
async function fixtureFiles(data) {
 const files = (await fs.readdir(path.dirname(data), {recursive:true, withFileTypes:true})).filter(file => file.isFile());
 return Object.fromEntries(await Promise.all(files.map(async file => {
  const fullPath = path.join(file.parentPath, file.name);
  return [fullPath, await fs.readFile(fullPath)];
 })));
}

async function fixture(t) {
 t.mock.method(timers, 'setTimeout', async () => {});
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-selection-'));
 t.after(() => fs.rm(dir, {recursive: true, force: true}));
 const root = path.join(dir, 'verge'), data = path.join(dir, 'data');
 await fs.mkdir(path.join(root, 'profiles'), {recursive: true});
 const config = {proxies: [node('current'), node('fast'), {...node(EXIT, '203.0.113.10'), 'dialer-proxy': ENTRY}],
  'proxy-groups': [{name: ENTRY, type: 'select', proxies: ['current', 'fast']}]};
 const write = (file, value) => fs.writeFile(path.join(root, file), YAML.stringify(value));
 const items = ['a', 'b'].map(id => ({uid: id, type: 'remote', name: id.toUpperCase(), file: id + '.yaml',
  url: 'https://example.invalid/' + id}));
 await write('clash-verge.yaml', config);
 await write('profiles.yaml', {current: 'a', items});
 await write('profiles/a.yaml', {proxies: ['current','fast','quick'].map(n => node(n))});
 await write('profiles/b.yaml', {proxies: ['same','other'].map(n => node(n))});
 const b = await new Backend(data).init();
 b.settings.configDir = root;
 b.endpoint = {};
 await fs.writeFile(path.join(data, 'subscriptions.json'), JSON.stringify({
  sources: items.map(({uid, url}) => ({name: uid, url})),
 }));
 const policy = path.join(data, 'node-policy.json');
 const state = {mode: 'global', tun: true, entry: 'current', exit: EXIT, dialer: ENTRY,
  mixedPort: 7897, live: ['current', 'fast']};
 const requests = [], downloads = [], atReload = [];
 let providers = {
  [ENTRY]: {vehicleType: 'Compatible', proxies: [node('current')]},
  a: {vehicleType: 'HTTP', proxies: [node('fast')]},
 };
 let refreshed = {}, keepStaleEntry = false;
 b.state = async () => structuredClone(state);
 b.validateConfig = async file => {
  assert.equal(YAML.parse(await fs.readFile(file, 'utf8'))['proxy-groups'][0].name, ENTRY);
 };
 b.textRequest = async url => {
  downloads.push(url);
  return YAML.stringify({proxies: refreshed[url.split('/').at(-1)].map(n => node(n))});
 };
 b.request = async (_endpoint, method, route, body) => {
  if (method === 'GET' && route === '/configs') return {mode:state.mode, tun:{enable:state.tun}};
  if (method === 'GET' && route === '/proxies') return {proxies:{
   GLOBAL:{now:state.exit}, [EXIT]:{'dialer-proxy':state.dialer},
   [ENTRY]:{now:state.entry, all:state.live},
  }};
  if (method === 'GET' && route === '/providers/proxies') return {providers};
  assert.equal(method, 'PUT');
  requests.push({route, body});
  if (route === '/configs?force=false') {
   atReload.push(state.entry);
   const payload = YAML.parse(body.payload), group = payload['proxy-groups'][0];
   assert.deepEqual(group.proxies, []);
   providers = Object.fromEntries(Object.entries(payload['proxy-providers']).map(([owner, p]) => [
    owner, {proxies: p.payload ?? [], vehicleType: 'Inline'},
   ]));
   state.live = group.proxies.concat(group.use.flatMap(id => {
    const provider = payload['proxy-providers'][id];
    return provider.payload.map(n => n.name).filter(name =>
     new RegExp(provider.filter || '.').test(name) && !new RegExp(provider['exclude-filter'] || '(?!)').test(name));
   }));
   if (!keepStaleEntry && !state.live.includes(state.entry)) state.entry = state.live[0];
  } else {
   assert.equal(route, ENTRY_ROUTE);
   assert.ok(state.live.includes(body.name));
   state.entry = body.name;
  }
 };
 const request = async selected => {
  const {fingerprint, current} = await sub.catalog(b);
  return {fingerprint, current, selected};
 };
 const apply = async selected => sub.run(b, await request(selected));
 const legacy = async saved => {
  await fs.writeFile(policy, JSON.stringify({...saved, pinned_entry: 'current'}));
  await fs.writeFile(path.join(root, 'profiles/Script.js'), 'function main(c){return c;}\n' +
   '// BEGIN LINKBOX MANAGED PROVIDERS\nmain=function(r){const m=' + JSON.stringify({pin: node('current')}) +
   ";r['proxy-providers']={};return r;};\n");
 };
 return {b, root, data, config, policy, state, requests, downloads, atReload, items, write, request, apply, legacy,
  setProviders: value => {providers = value;},
  keepStaleEntryOnReload: () => {keepStaleEntry = true;},
  refreshWith: value => {refreshed = value;}, saved: async () => JSON.parse(await fs.readFile(policy, 'utf8'))};
}

for (const flag of ['include-all-providers', 'include-all-proxies', 'include-all']) {
 test(`switches an unmanaged ENTRY using ${flag}`, async t => {
  const {b, config, state, write} = await fixture(t);
  config.proxies = ['current','static-fast','static-slow','static-drop'].map(name => node(name));
  config['proxy-providers'] = {a:{type:'inline',
   payload:['provider-fast','provider-slow','provider-drop','provider-hidden'].map(name => node(name)),
   'exclude-filter':'hidden'}};
  config['proxy-groups'][0] = {name:ENTRY, type:'select', proxies:['current'], [flag]:true,
   filter:'fast|drop|hidden', 'exclude-filter':'drop'};
  await write('clash-verge.yaml', config);
  state.live = ['current'];
  if (flag !== 'include-all-providers') state.live.push('static-fast');
  if (flag !== 'include-all-proxies') state.live.push('provider-fast');
  delete b.state;
  const target = state.live.at(-1);
  assert.equal((await b.switchNode(target,'current')).entry, target);
 });
}

async function saveWithLostAcknowledgment(t) {
 const fx = await fixture(t);
 const {b, state, write, apply, saved, requests} = fx;
 await apply({a:['current','fast'], b:[]});
 await write('profiles/b.yaml', {proxies:[node('fast','b.example.invalid'),node('other')]});
 const controller = b.request;
 b.request = async (...args) => {
  const result = await controller(...args);
  if (args[2] === '/configs?force=false') throw Error('response lost');
  return result;
 };
 await assert.rejects(apply({a:[], b:['fast','other']}), /尚未确认/);
 requests.length = 0;
 assert.deepEqual(state.live, ['fast','other']);
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast']});
 return {...fx, controller};
}

test('Refresh commits an applied Save without reload', async t => {
 const {b, saved, requests} = await saveWithLostAcknowledgment(t);
 const validate = t.mock.method(b, 'validateConfig');
 delete b.state;
 assert.deepEqual(await sub.startup(b), {changed:true});
 assert.deepEqual(await sub.startup(b), {changed:false});
 assert.deepEqual((await b.state()).nodes.map(row => row.name), ['fast','other']);
 const {nodes} = await b.loadNodes();
 assert.deepEqual([...nodes.keys()], ['fast','other']);
 assert.equal(nodes.get('fast').server, 'b.example.invalid');
 const policy = await saved();
 assert.deepEqual(policy.selected_nodes, {b:['fast','other']});
 assert.equal(policy.provider_labels.b, 'B');
 assert.equal(policy.pending_update, undefined);
 assert.deepEqual(requests, []);
 assert.equal(validate.mock.callCount(), 0);
});

test('Sync starts from the applied but unacknowledged Save', async t => {
 const {b, controller, state, refreshWith, saved} = await saveWithLostAcknowledgment(t);
 b.request = controller;
 refreshWith({a:['current','fast'], b:['fast','other','new']});
 await b.updateSubscriptions();
 const policy = await saved();
 assert.deepEqual(policy.selected_nodes, {b:['fast','other']});
 assert.equal(policy.pending_update, undefined);
 assert.deepEqual(state.live, ['fast','other']);
});

test('Refresh confirms a recomputed selection after another lost acknowledgment', async t => {
 const {b, apply, write, saved, requests} = await fixture(t);
 await apply({a:['current','fast'], b:[]});
 const controller = b.request;
 let replaying = false;
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') {
   if (replaying) await controller(...args);
   throw Error('response lost');
  }
  return controller(...args);
 };
 await assert.rejects(apply({a:['fast','quick'], b:[]}), /尚未确认/);
 await write('profiles/a.yaml', {proxies:[node('fast')]});
 replaying = true;
 await assert.rejects(sub.initialize(b), /尚未确认/);
 assert.deepEqual((await saved()).pending_update.selection, {a:['fast']});
 requests.length = 0;
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast']});
 assert.deepEqual(requests, []);
});

test('Save confirms with identical names loaded by an include-all group', async t => {
 const {b, config, write, apply, saved, requests} = await fixture(t);
 config['proxy-providers'] = {b:{type:'inline', payload:['current','fast'].map(n => node(n))}};
 config['proxy-groups'].push({name:'secondary', type:'select', 'include-all':true});
 await write('clash-verge.yaml', config);
 await apply({a:['current','fast'], b:[]});
 assert.equal((await saved()).reload_unconfirmed, undefined);
 delete b.state;
 assert.equal((await b.switchNode('fast', 'current')).entry, 'fast');
 assert.deepEqual(requests.map(({route}) => route), ['/configs?force=false', ENTRY_ROUTE]);
});

test('routine Refresh sends no reload', async t => {
 const {b, apply, requests} = await fixture(t);
 await apply({a:['current','fast'], b:[]});
 requests.length = 0;
 assert.equal(await sub.initialize(b, {refresh:true}), false);
 assert.deepEqual(requests, []);
});

test('reload preserves a native HTTP provider used by another include-all group', async t => {
 const {config, write, apply, requests} = await fixture(t);
 const definition = {type:'http', url:'https://example.invalid/native', path:'native.yaml',
  interval:3600, 'health-check':{enable:false}};
 config['proxy-providers'] = {native:definition};
 config['proxy-groups'].push({name:'secondary', type:'select', 'include-all':true});
 await write('native.yaml', {proxies:[node('native-relay')]});
 await write('clash-verge.yaml', config);
 await apply({a:['current','fast'], b:[]});
 const providers = YAML.parse(requests[0].body.payload)['proxy-providers'];
 assert.deepEqual(providers.native, definition);
 assert.equal(providers.a.type, 'inline');
});

test('same-name owner move with connection refused rolls back', async t => {
 const {b, root, policy, state, apply, write, requests} = await fixture(t);
 await write('profiles/b.yaml', {proxies:[node('current'),node('fast')]});
 await apply({a:['current','fast'], b:[]});
 const files = [policy, ...['clash-verge.yaml','profiles/Script.js','profiles.yaml'].map(file=>path.join(root,file))];
 const before = await Promise.all(files.map(file=>fs.readFile(file)));
 const active = structuredClone(state);
 let connections = 0, code;
 t.mock.method(http, 'request', ()=>{
  const request = new EventEmitter();
  request.write = () => {};
  request.end = () => queueMicrotask(()=>{
   connections++;
   request.emit('socket', Object.assign(new EventEmitter(),{connecting:true}));
   request.emit('error', Object.assign(Error('connection failed'),{code}));
   request.emit('close');
  });
  return request;
 });
 const controller = b.request;
 b.request = (...args) => args[2] === '/configs?force=false' ? Backend.prototype.request.call(b,...args) : controller(...args);
 for (code of ['ECONNREFUSED','ENOENT','ENOTFOUND','ETIMEDOUT']) {
  await assert.rejects(apply({a:[], b:['current','fast']}), /未发送重载请求.*文件已回退/);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))), before);
  await assert.rejects(fs.access(path.join(root,'providers/linkbox/b.yaml')), {code:'ENOENT'});
 }
 assert.equal(connections,4);
 assert.deepEqual(state,active);
 assert.deepEqual(YAML.parse(requests[0].body.payload)['proxy-groups'][0].use, ['a']);
});

test('Refresh confirms an applied same-name owner move', async t => {
 const {b, state, apply, write, saved, requests} = await fixture(t);
 await write('profiles/b.yaml', {proxies:[node('current'),node('fast')]});
 await apply({a:['current','fast'], b:[]});
 const controller = b.request;
 b.request = async (...args) => {
  const result = await controller(...args);
  if (args[2] === '/configs?force=false') throw Object.assign(Error('response lost'),{code:'ECONNRESET'});
  return result;
 };
 await assert.rejects(apply({a:[], b:['current','fast']}), /尚未确认/);
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast']});
 assert.deepEqual((await saved()).pending_update.selection, {b:['current','fast']});
 assert.deepEqual(state.live, ['current','fast']);
 assert.deepEqual(YAML.parse(requests.at(-1).body.payload)['proxy-groups'][0].use, ['b']);
 b.request = controller;
 requests.length = 0;
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual(requests, []);
 assert.deepEqual((await saved()).selected_nodes, {b:['current','fast']});
 assert.equal((await saved()).pending_update, undefined);
});

test('unacknowledged Refreshes retry without rewrites or backups', async t => {
 const {b, data, apply} = await fixture(t);
 await apply({a:['current','fast'], b:[]});
 const reloads = [];
 b.request = async (_endpoint, _method, route) => { reloads.push(route); throw Error('timeout'); };
 await assert.rejects(apply({a:['current','fast','quick'], b:[]}), /尚未确认/);

 const identities = async () => Object.fromEntries(await Promise.all(Object.keys(await fixtureFiles(data)).map(async file => {
  const {ino, mtimeNs} = await fs.stat(file, {bigint:true});
  return [file, [ino, mtimeNs]];
 })));
 const before = await identities();
 reloads.length = 0;
 for (let i = 0; i < 2; i++) {
  await assert.rejects(sub.initialize(b), /尚未确认/);
  assert.deepEqual(await identities(), before);
 }
 assert.deepEqual(reloads, ['/configs?force=false', '/configs?force=false']);
});

async function crashDuringSave({root, data, state, request}, selected = {a:['fast'], b:[]},
                               crashFile = path.join(root, 'clash-verge.yaml'), downloads = null) {
 const profile = path.join(root,'profiles.yaml'), registry = path.join(data,'subscriptions.json');
 const originalProfile = await fs.readFile(profile), originalRegistry = await fs.readFile(registry);
 const selection = selected && await request(selected);
 const child = `
  const fs = require('node:fs/promises');
  const [backendPath, subscriptionsPath, root, data, state, selection, crashFile, downloads] = process.argv.slice(1);
  const {Backend} = require(backendPath), sub = require(subscriptionsPath);
  (async () => {
   const b = await new Backend(data).init();
   b.settings.configDir = root;
   b.state = async () => JSON.parse(state);
   b.validateConfig = async () => {};
   if (downloads !== 'null') {
    b.textRequest = async url => JSON.stringify({
     proxies: JSON.parse(downloads)[url.split('/').at(-1)].map(name =>
      ({name, type:'ss', server:'relay.example.invalid', port:443})),
    });
    b.api = async () => ({});
   }
   const rename = fs.rename;
   fs.rename = async (from,to) => {
    await rename(from,to);
    if (to === crashFile) process.exit(42);
   };
   if (selection === 'null') await sub.initialize(b);
   else await sub.run(b, JSON.parse(selection));
  })().catch(error => { console.error(error.message); process.exit(1); });`;
 assert.throws(()=>execFileSync(process.execPath,['-e',child,require.resolve('../backend.cjs'),
  require.resolve('../subscriptions.cjs'),root,data,JSON.stringify(state),JSON.stringify(selection),crashFile,JSON.stringify(downloads)]), {status:42});
 assert.deepEqual(await fs.readFile(profile),originalProfile);
 assert.deepEqual(await fs.readFile(registry),originalRegistry);
}

test('restart recomputes from newer Verge files after a crash', async t => {
 const fx = await fixture(t);
 const {b, root, data, state, apply, saved, requests, write} = fx;
 await apply({a:['current','fast'], b:[]});
 requests.length = 0;
 await crashDuringSave(fx);
 const profile = path.join(root,'profiles.yaml');
 const renamed = YAML.parse(await fs.readFile(profile,'utf8'));
 renamed.items[0].name = 'Renamed in Verge after the crash';
 await write('profiles.yaml', renamed);
 const config = await b.config();
 config['log-level'] = 'warning';
 await write('clash-verge.yaml', config);
 const script = path.join(root,'profiles/Script.js');
 await fs.writeFile(script, 'function main(c) { c["log-level"] = "warning"; return c; }\n');
 await write('profiles/a.yaml', {proxies:[node('fast', 'new.example.invalid')]});
 const restarted = await new Backend(data).init();
 restarted.settings.configDir = root;
 restarted.endpoint = {};
 restarted.request = b.request;
 restarted.validateConfig = t.mock.fn(b.validateConfig);
 assert.equal(await sub.initialize(restarted), true);
 assert.deepEqual(requests.map(({route}) => route), ['/configs?force=false']);
 assert.deepEqual(state.live, ['fast']);
 assert.deepEqual(YAML.parse(await fs.readFile(profile,'utf8')).items[0].selected, [{name:ENTRY, now:'fast'}]);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast']});
 assert.equal(YAML.parse(await fs.readFile(profile,'utf8')).items[0].name, 'Renamed in Verge after the crash');
 assert.equal((await b.config())['log-level'], 'warning');
 assert.match(await fs.readFile(script,'utf8'), /c\["log-level"\] = "warning"/);
 const reload = YAML.parse(requests[0].body.payload);
 assert.equal(reload['proxy-providers'].a.payload[0].server, 'new.example.invalid');
 assert.equal(restarted.validateConfig.mock.callCount(), 1);
 assert.equal((await saved()).pending_update, undefined);
});

test('restart rolls back its own writes if reload is rejected', async t => {
 const fx = await fixture(t);
 const {b, root, data, state, apply, saved, requests, write, policy} = fx;
 await apply({a:['current','fast'], b:[]});
 requests.length = 0;
 await crashDuringSave(fx);
 const profile = path.join(root,'profiles.yaml');
 const renamed = YAML.parse(await fs.readFile(profile,'utf8'));
 renamed.items[0].name = 'Renamed in Verge after the crash';
 await write('profiles.yaml', renamed);
 const files = [policy, profile, path.join(root,'clash-verge.yaml'), path.join(root,'profiles/Script.js'),
  path.join(root,'providers/linkbox/a.yaml'), path.join(data,'subscriptions.json')];
 const previous = await Promise.all(files.map(file => fs.readFile(file)));
 const controller = b.request;
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') throw new ClashHTTPError(400, true);
  return controller(...args);
 };
 await assert.rejects(sub.initialize(b), /文件已回退/);
 assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), previous);
 assert.deepEqual(state.live, ['current','fast']);
 b.request = controller;
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast']});
});

test('Refresh keeps the journal after a GeoIP validation failure', async t => {
 const fx = await fixture(t);
 const {b, data, apply, requests, saved} = fx;
 await apply({a:['current','fast'], b:[]});
 requests.length = 0;
 await crashDuringSave(fx);
 const before = await fixtureFiles(data);
 const validate = b.validateConfig;
 b.validateConfig = async () => { throw Object.assign(Error('timeout'), {killed:true}); };
 await assert.rejects(sub.initialize(b), /配置校验失败/);
 assert.deepEqual(await fixtureFiles(data), before);

 b.validateConfig = async () => { throw Object.assign(Error('GeoIP database download failed'), {code:1}); };
 await assert.rejects(sub.initialize(b), /配置校验失败/);
 assert.deepEqual(await fixtureFiles(data), before);
 assert.deepEqual(requests, []);
 b.validateConfig = validate;
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast']});
});

test('Refresh retries Save when a present subscription temporarily omits the relay', async t => {
 const fx = await fixture(t);
 const {b, data, apply, requests, saved, state, write} = fx;
 await apply({a:['current','fast'], b:[]});
 requests.length = 0;
 await crashDuringSave(fx, {a:['fast'], b:[]}, fx.policy);
 await write('profiles/a.yaml', {proxies:[node('current')]});
 const before = await fixtureFiles(data);

 await assert.rejects(sub.initialize(b), /管理节点/);
 assert.deepEqual(await fixtureFiles(data), before);
 assert.deepEqual(requests, []);

 await write('profiles/a.yaml', {proxies:[node('current'), node('fast')]});
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast']});
 assert.equal(state.entry, 'fast');
});

test('Refresh keeps the journal when the target profile cannot be read', async t => {
 const fx = await fixture(t);
 const {b, data, root, policy, apply, requests, saved, state} = fx;
 await apply({a:['current','fast'], b:[]});
 requests.length = 0;
 await crashDuringSave(fx, {a:[], b:['other']}, policy);
 const before = await fixtureFiles(data);
 const profile = path.join(root, 'profiles/b.yaml'), readFile = fs.readFile;
 const read = t.mock.method(fs, 'readFile', async (file, ...args) => {
  if (file === profile) throw Object.assign(Error('fixture read failure'), {code:'EACCES'});
  return readFile(file, ...args);
 });
 await assert.rejects(sub.initialize(b), /本地缓存暂不可读/);
 read.mock.restore();
 assert.deepEqual(await fixtureFiles(data), before);
 assert.deepEqual(requests, []);
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {b:['other']});
 assert.equal(state.entry, 'other');
});

test('Refresh confirms after equivalent config reserialization', async t => {
 await checkLateReloadAfterSave(t, ['fast','quick'], {rewrite:true});
});

test('Refresh keeps a relay selected in Verge after a late reload', async t => {
 await checkLateReloadAfterSave(t, ['current','fast'], {vergeEntry:'fast'});
});

async function checkLateReloadAfterSave(t, names, {rewrite, vergeEntry}) {
 const {b, root, apply, requests, state, saved} = await fixture(t);
 const controller = b.request, pending = [];
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') { pending.push(args); throw Error('timeout'); }
  return controller(...args);
 };
 if (vergeEntry) state.live.push('external');
 await assert.rejects(apply({a:names, b:[]}), /尚未确认/);
 assert.equal(pending.length, 1);
 await controller(...pending[0]);
 if (rewrite) {
  const configFile = path.join(root, 'clash-verge.yaml');
  const original = await fs.readFile(configFile, 'utf8'), parsed = YAML.parse(original);
  const rewritten = YAML.stringify(parsed, {collectionStyle:'flow'});
  assert.notEqual(original, rewritten);
  assert.deepEqual(YAML.parse(rewritten), parsed);
  await fs.writeFile(configFile, rewritten);
  state.live.reverse();
 }
 if (vergeEntry) state.entry = vergeEntry;
 requests.length = 0;
 b.request = controller;
 assert.equal(await sub.initialize(b), true);
 assert.equal(state.entry, vergeEntry || names[0]);
 assert.deepEqual(requests, []);
 assert.equal((await saved()).pending_update, undefined);
 assert.equal((await saved()).reload_unconfirmed, undefined);
}

test('saving another subscription keeps unreadable cache selection and provider', async t => {
 const {b, root, write, apply, saved, refreshWith} = await fixture(t);
 await apply({a:['current','fast'], b:['same','other']});
 const before = (await b.config())['proxy-providers'].b;
 await write('profiles/a.yaml', {proxies:['current','fast','same'].map(n => node(n))});
 await fs.writeFile(path.join(root, 'profiles/b.yaml'), 'proxies: [');
 const {sources:[, unreadable]} = await sub.catalog(b);
 assert.deepEqual(unreadable.nodes, []);
 await apply({a:['current','fast','same'], b:[]});
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast'], b:['same','other']});
 await sub.remove(b, {entry:'current', names:['fast']});
 assert.deepEqual((await saved()).selected_nodes, {a:['current'], b:['same','other']});
 assert.deepEqual((await b.config())['proxy-providers'].b, before);
 assert.match(unreadable.warning, /保留原勾选/);
 refreshWith({a:['fast']});
 const original = await saved();
 await assert.rejects(b.updateSubscriptions(), /下载/);
 assert.deepEqual(await saved(), original);
 assert.deepEqual((await b.config())['proxy-providers'].b, before);
});

test('catalog exposes both copies and selects exactly one owner', async t => {
 const {b, write, apply, state} = await fixture(t);
 await write('profiles/b.yaml', {proxies: [node('current'), node('other')]});
 const initial = await sub.catalog(b);
 assert.ok(!JSON.stringify(initial).includes('example.invalid'));
 assert.deepEqual(initial.sources.map(s => s.nodes.map(n => n.selected)), [[true,true,false],[false,false]]);
 await apply({a:['fast'], b:['current']});
 const fresh = await sub.catalog(b);
 assert.equal(fresh.sources[0].nodes[0].selected, false);
 assert.equal(fresh.sources[1].nodes[0].selected, true);
 assert.equal(fresh.sources[1].nodes[0].current, true);
 assert.equal(state.entry, 'current');
});

test('stale catalogs and unknown nodes are refused, duplicate submissions reconcile', async t => {
 const {b, write, request, apply, saved, requests} = await fixture(t);
 const wrong = await request({a:['unknown'], b:[]});
 await assert.rejects(sub.run(b, wrong), /格式无效/);
 await write('profiles/b.yaml', {proxies: [node('current')]});
 await assert.rejects(sub.run(b, wrong), /变化/);
 assert.equal(requests.length, 0);
 await apply({a:['current'], b:['current']});
 assert.deepEqual((await saved()).selected_nodes, {a:['current']});
});

test('first run downloads before seeding even with truncated Verge YAML and drops obsolete policy', async t => {
 const {b, data, root, downloads, refreshWith, saved, requests, legacy} = await fixture(t);
 await legacy({blocked_providers:['a'], excluded_nodes:{'*':['fast']}});
 await fs.writeFile(path.join(root, 'profiles/a.yaml'), 'proxies: [');
 refreshWith({a:['current','fast','new'], b:['fast']});
 assert.equal(await sub.initialize(b), true);
 assert.equal(await sub.initialize(b), false);
 assert.equal(downloads.length, 2);
 assert.deepEqual(await saved(), {selected_nodes:{a:['current','fast']}, provider_labels:{a:'A',b:'B'}});
 assert.ok(!(await fs.readdir(path.join(data, 'backups'), {recursive:true})).some(name => name.endsWith('node-policy.json')));
 assert.ok(!YAML.parse(requests[0].body.payload).proxies.some(n => n.name === 'current'));
});

test('first run seeds in live provider order with picker fallback', async t => {
 const {b, config, state, write, refreshWith, saved, setProviders} = await fixture(t);
 Object.assign(config['proxy-groups'][0], {use:['b','a'], proxies:['quick']});
 config['proxy-providers'] = {
  a:{type:'inline', payload:['current','fast'].map(n => node(n))},
  b:{type:'inline', payload:['current','fast'].map(n => node(n)), 'exclude-filter':'^fast$'},
 };
 await write('clash-verge.yaml', config);
 state.live.push('quick');
 setProviders({a:{proxies:[node('current'), node('fast')]}, b:{proxies:[node('current')]}});
 refreshWith({a:['current','fast','quick'], b:['current','fast','quick']});
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast','quick'], b:['current']});
});

test('first run keeps the live owner for HTTP providers without paths', async t => {
 const {b, items, config, state, write, refreshWith, saved, requests, setProviders} = await fixture(t);
 Object.assign(config['proxy-groups'][0], {use:['live-a','live-b'], proxies:[]});
 config['proxy-providers'] = {
  'live-a':{type:'http', url:items[0].url},
  'live-b':{type:'http', url:items[1].url},
 };
 await write('clash-verge.yaml', config);
 setProviders({'live-a':{proxies:[node('fast')]}, 'live-b':{proxies:[node('current'), node('fast')]}});
 refreshWith({a:['current','fast'], b:['current','fast']});

 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast'], b:['current']});
 assert.deepEqual(YAML.parse(requests[0].body.payload)['proxy-providers'].b.payload.map(n => n.name), ['current']);
 assert.equal(state.entry, 'current');
});

test('first run falls back when the live provider endpoint fails', async t => {
 const {b, config, write, refreshWith, saved} = await fixture(t);
 config['proxy-groups'][0].use = ['b','a'];
 await write('clash-verge.yaml', config);
 refreshWith({a:['current','fast'], b:['current','fast']});
 const controller = b.request;
 b.request = async (...args) => {
  if (args[1] === 'GET' && args[2] === '/providers/proxies') throw new ClashHTTPError(404, true);
  return controller(...args);
 };

 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast']});
});

test('startup seeds with malformed live provider data', async t => {
 const {b, config, write, refreshWith, saved, setProviders} = await fixture(t);
 config['proxy-groups'][0].use = ['a','odd','b'];
 await write('clash-verge.yaml', config);
 refreshWith({a:['current','fast'], b:['current','fast']});
 setProviders({a:null, odd:{proxies:{name:'current'}}, b:{proxies:[null, {}, node('fast')]}});
 delete b.state;

 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['current'], b:['fast']});
});

test('first run falls back for null proxies without losing other owners', async t => {
 const {b, config, write, refreshWith, saved, setProviders} = await fixture(t);
 config['proxy-groups'][0].use = ['a','b'];
 await write('clash-verge.yaml', config);
 refreshWith({a:['current','fast'], b:['current','fast']});
 setProviders({a:{proxies:null}, b:{proxies:[node('fast')]}});

 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['current'], b:['fast']});
});

test('first run does not confirm owner assignment without a success response', async t => {
 const {b, state, refreshWith, saved, requests} = await fixture(t);
 refreshWith({a:['current','fast','quick'], b:['other']});
 const controller = b.request, lost = [];
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') { lost.push(args); throw Error('timeout'); }
  return controller(...args);
 };
 await assert.rejects(sub.initialize(b), /尚未确认/);
 assert.equal((await saved()).selected_nodes, undefined);
 await assert.rejects(sub.initialize(b), /尚未确认/);
 assert.equal(lost.length, 2);
 assert.deepEqual(state.live, ['current','fast']);
 b.request = controller;
 assert.equal(await sub.initialize(b), true);
 assert.deepEqual(requests.map(({route}) => route), ['/configs?force=false']);
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast']});
});

test('upgrade with saved selection cleans the old pin and switches once', async t => {
 const {b, root, state, legacy, downloads, requests, saved, refreshWith} = await fixture(t);
 await legacy({selected_nodes:{a:['fast'],b:['other']}});
 await fs.writeFile(path.join(root, 'profiles/a.yaml'), 'proxies: [');
 refreshWith({a:['fast'],b:['other']});
 assert.equal(await sub.initialize(b), true);
 assert.equal(state.entry, 'fast');
 assert.ok(!YAML.parse(requests.at(-1).body.payload).proxies.some(n => n.name === 'current'));
 assert.equal((await saved()).pinned_entry, undefined);
 assert.equal(await sub.initialize(b), false);
 assert.equal(requests.filter(r => r.route === '/configs?force=false').length, 1);
 assert.equal(downloads.length, 2);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast'],b:['other']});
});

test('upgrade saving B switches off a pin excluded by unreadable A', async t => {
 const {b, root, config, state, legacy, requests, saved, refreshWith, write, apply} = await fixture(t);
 await legacy({selected_nodes:{a:['current','fast']}});
 const cache = path.join(root,'providers/linkbox/a.yaml');
 await fs.mkdir(path.dirname(cache), {recursive:true});
 await write('providers/linkbox/a.yaml', {proxies:['current','fast'].map(n => node(n))});
 config['proxy-providers'] = {a:{
  type:'http', url:'https://example.invalid/a', path:cache,
  filter:'^current$|^fast$', 'exclude-filter':'^current$',
 }};
 Object.assign(config['proxy-groups'][0], {proxies:['current'], use:['a']});
 await write('clash-verge.yaml', config);
 await fs.writeFile(path.join(root, 'profiles/a.yaml'), 'proxies: [');
 refreshWith({b:['other']});
 await assert.rejects(sub.initialize(b), /下载或解析失败/);
 b.history = {latestResults:{other:{owner:'b', chainDelay:10}}};
 if (process.env.LINKBOX_TEST_CORE) b.validateConfig = file => {
  execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', file]);
 };
 await apply({a:[], b:['other']});
 assert.deepEqual(state.live, ['fast','other']);
 assert.equal(state.entry, 'other');
 assert.deepEqual(requests.map(({route}) => route), ['/configs?force=false', ENTRY_ROUTE]);
 assert.ok(!YAML.parse(requests[0].body.payload).proxies.some(n => n.name === 'current'));
 const index = YAML.parse(await fs.readFile(path.join(root,'profiles.yaml'),'utf8'));
 assert.deepEqual(index.items[0].selected, [{name:ENTRY, now:'other'}]);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast'], b:['other']});
 assert.equal((await saved()).pending_update, undefined);
});

for (const flag of ['include-all-proxies', 'include-all']) {
 test(`legacy pin respects filtered ${flag} references`, async t => {
  for (const acceptsPin of [true, false]) {
   await t.test(acceptsPin ? 'includes the pin' : 'excludes the pin', async subtest => {
    const {config, write, apply, legacy, requests, state} = await fixture(subtest);
    await legacy({selected_nodes:{a:['current','fast']}});
    const secondary = {name:'secondary', type:'select', [flag]:true, filter:'(?i)^CURRENT$',
     'exclude-filter': acceptsPin ? '^other$' : '^current$'};
    config['proxy-groups'].push(secondary);
    await write('clash-verge.yaml', config);
    await apply({a:['fast'], b:[]});
    const reload = YAML.parse(requests[0].body.payload);
    assert.deepEqual(reload['proxy-groups'][1], secondary);
    assert.equal(reload.proxies.some(n => n.name === 'current'), acceptsPin);
    assert.deepEqual(state.live, ['fast']);
   });
  }
 });
}

test('sync keeps saved nodes outside the live group and removes vanished nodes and sources', async t => {
 const {b, write, state, requests, items, apply, saved, refreshWith, root} = await fixture(t);
 await apply({a:['current','fast','quick'],b:['other']});
 await write('profiles.yaml',{current:'a',items:[items[0]]});
 Object.assign(state,{entry:'external',live:['external']});
 refreshWith({a:['fast','quick','brand-new']});
 await b.updateSubscriptions();
 assert.deepEqual((await saved()).selected_nodes, {a:['fast','quick']});
 assert.equal(state.entry, 'fast');
 const live = YAML.parse(requests.at(-1).body.payload);
 assert.deepEqual(Object.keys(live['proxy-providers']), ['a']);
 assert.deepEqual(live['proxy-providers'].a.payload.map(n=>n.name), ['fast','quick']);
 assert.match(await fs.readFile(path.join(root,'profiles/a.yaml'),'utf8'), /brand-new/);
});

test('benchmark winner switches after reload in subscription order', async t => {
 const {b, state, requests, root, apply, downloads, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 b.settings.metric = 'entrance';
 b.history = {latestResults:{fast:{chainDelay:10,entranceDelay:90,owner:'a'}, other:{chainDelay:30,entranceDelay:20,owner:'b'}}};
 await apply({a:['fast'],b:['same','other']});
 assert.deepEqual(requests.map(r=>r.route), ['/configs?force=false', ENTRY_ROUTE]);
 assert.equal(state.entry, 'other');
 const live = YAML.parse(requests[0].body.payload);
 assert.equal(live['proxy-providers'].b.type, 'inline');
 assert.equal(live['proxy-providers'].b.path, undefined);
 assert.deepEqual(live['proxy-groups'][0].use, ['a','b']);
 assert.equal(live['proxy-providers'].b.payload[0].name, 'same');
 const saved = YAML.parse(await fs.readFile(path.join(root,'clash-verge.yaml'),'utf8'));
 assert.equal(saved['proxy-providers'].b.type, 'http');
 assert.equal(saved['proxy-providers'].b.filter, '^same$|^other$');
 const index = YAML.parse(await fs.readFile(path.join(root,'profiles.yaml'),'utf8'));
 assert.deepEqual(index.items[0].selected, [{name:ENTRY, now:'other'}]);
 assert.equal(downloads.length, 0);
});

test('present winner is loaded before switching', async t => {
 const {b, write, apply, requests, atReload, state, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 b.history = {latestResults: {fast: {chainDelay:20, owner:'a'}}};
 await write('profiles/a.yaml', {proxies: [node('quick'), node('fast')]});
 const controller = b.request;
 b.request = async (...args) => {
  if (args[2] === ENTRY_ROUTE) assert.equal(atReload.length, 1);
  return controller(...args);
 };
 await apply({a:['fast','quick'],b:[]});
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false', ENTRY_ROUTE]);
 assert.deepEqual(atReload, ['current']);
 assert.equal(state.entry, 'fast');
});

test('empty selection refuses and all vanished can recover in the picker', async t => {
 const {b, root, apply, requests, saved, refreshWith, state} = await fixture(t);
 await assert.rejects(apply({a:[],b:[]}), /没有你勾选/);
 assert.equal(requests.length, 0);
 await apply({a:['current'],b:[]});
 const files = ['clash-verge.yaml','profiles.yaml','profiles/a.yaml','profiles/b.yaml','profiles/Script.js'];
 const snapshot = () => Promise.all(files.map(file=>fs.readFile(path.join(root,file),'utf8')));
 const before = await snapshot(), savedBefore = await saved();
 refreshWith({a:['new'],b:['new']});
 requests.length = 0;
 await assert.rejects(b.updateSubscriptions(), /没有你勾选/);
 assert.deepEqual(await snapshot(), before);
 assert.deepEqual(await saved(), savedBefore);
 assert.equal(requests.length, 0);
 const fresh = await sub.catalog(b);
 assert.deepEqual(fresh.sources.map(s => s.nodes.map(n => n.name)), [['new'], ['new']]);
 await sub.run(b, {fingerprint: fresh.fingerprint, current: fresh.current, selected: {a:['new'],b:[]}});
 assert.equal(state.entry, 'new');
 assert.deepEqual((await saved()).selected_nodes, {a:['new']});
 assert.deepEqual(YAML.parse(await fs.readFile(path.join(root, 'profiles/a.yaml'), 'utf8')).proxies, [node('new')]);
});

for (const scenario of ['preview Save', 'first-run Sync', 'ordinary Save']) {
 for (const operation of ['Save', 'Sync']) test(`${scenario} journal does not block switching and a new ${operation}`, async t => {
  const fx = await fixture(t);
  const {b, data, policy, state, apply, requests, saved, refreshWith, write} = fx;
  const fresh = {a:['current','fast'], b:['other']};
  refreshWith(fresh);
  let journalSelection;
  if (scenario === 'first-run Sync') {
   await write('profiles/a.yaml', {proxies:[node('current')]});
   await crashDuringSave(fx, null, policy, {...fresh,a:['fast']});
   journalSelection = {a:['fast']};
  } else {
   await apply({a:['current','fast'], b:[]});
   const pendingName = scenario === 'preview Save' ? 'new' : 'quick';
   if (scenario === 'preview Save') {
    refreshWith({...fresh, a:['new']});
    await assert.rejects(b.updateSubscriptions(), /管理节点/);
   }
   await crashDuringSave(fx, {a:[pendingName], b:[]}, policy);
   journalSelection = {a:[pendingName]};
   if (scenario === 'ordinary Save') await write('profiles/a.yaml', {proxies:fresh.a.map(name => node(name))});
  }
  const before = await fixtureFiles(data);
  assert.deepEqual((await saved()).pending_update.selection, journalSelection);
  requests.length = 0;
  const validate = b.validateConfig;
  if (scenario === 'preview Save') b.validateConfig = async () => { throw Error('fixture'); };
  await assert.rejects(sub.initialize(b), /管理节点|配置校验失败/);
  assert.deepEqual(requests, []);
  assert.deepEqual(await fixtureFiles(data), before);

  const observe = b.state;
  delete b.state;
  assert.equal((await b.switchNode('fast','current')).entry, 'fast');
  state.entry = 'current';
  b.settings.autoRelay = true;
  b.network = async () => ({interface:'fixture'});
  b.corePath = async () => '/mock';
  b.testNode = async relay => ({delay:relay.name === 'current' ? 400 : 100});
  assert.equal((await b.benchmark('chain', () => true)).switchedTo, 'fast');
  assert.deepEqual(requests.map(({route}) => route), [ENTRY_ROUTE, ENTRY_ROUTE]);
  assert.deepEqual(await fs.readFile(policy), before[policy]);

  b.state = observe;
  assert.deepEqual(await sub.startup(b), {changed:false, recoveryHint:'上次订阅更新未完成，可刷新重试，或在管理节点重新保存'});
  b.validateConfig = validate;
  const journals = [], controller = b.request;
  b.request = async (...args) => {
   if (args[2] === '/configs?force=false') journals.push((await saved()).pending_update);
   return controller(...args);
  };
  if (operation === 'Save') {
   const name = scenario === 'preview Save' ? 'new' : 'current';
   await apply({a:[name], b:[]});
   assert.deepEqual((await saved()).selected_nodes, {a:[name]});
  } else {
   refreshWith(fresh);
   if (scenario !== 'first-run Sync') {
    await assert.rejects(b.updateSubscriptions(), /管理节点/);
    assert.deepEqual((await saved()).pending_update.selection, journalSelection);
    refreshWith({...fresh,a:[...fresh.a, ...journalSelection.a]});
   }
   await b.updateSubscriptions();
   assert.deepEqual((await saved()).selected_nodes, journalSelection);
  }
  const final = await saved();
  assert.deepEqual(journals, [{root:fx.root, selection:final.selected_nodes}]);
  assert.equal(final.pending_update, undefined);
 });
}

test('Refresh recovers a preview Save with its downloaded cache', async t => {
 const fx = await fixture(t);
 const {b, root, apply, refreshWith, state, saved} = fx;
 await apply({a:['current','fast'], b:[]});
 refreshWith({a:['new'], b:['other']});
 await assert.rejects(b.updateSubscriptions(), /管理节点/);
 await crashDuringSave(fx, {a:['new'], b:[]}, fx.policy);

 assert.equal(await sub.initialize(b), true);
 assert.equal(state.entry, 'new');
 const policy = await saved();
 assert.deepEqual(policy.selected_nodes, {a:['new']});
 assert.equal(policy.pending_update, undefined);
 assert.deepEqual(YAML.parse(await fs.readFile(path.join(root, 'profiles/a.yaml'), 'utf8')).proxies, [node('new')]);
});

test('other group keeps its static reference and ENTRY uses the selected owner once', async t => {
 const {b, root, config, write, apply, state, requests} = await fixture(t);
 config['proxy-groups'][0].proxies = ['current'];
 config['proxy-groups'].push({name:'secondary',type:'select',proxies:['current']});
 await write('clash-verge.yaml', config);
 await write('profiles/a.yaml', {proxies:[node('current')]});
 if (process.env.LINKBOX_TEST_CORE) b.validateConfig = file => {
  execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', file]);
 };
 await apply({a:['current'],b:[]});
 const payload = YAML.parse(requests[0].body.payload);
 assert.deepEqual(payload.proxies.find(n => n.name === 'current'), node('current'));
 assert.deepEqual(payload['proxy-groups'][1].proxies, ['current']);
 assert.deepEqual(state.live, ['current']);
 assert.deepEqual(payload['proxy-providers'].a.payload.map(n => n.name), ['current']);
});

for (const reference of [{use:['b']}, {'include-all':true}, {'include-all-providers':true}]) {
 test('other group retains a deselected provider through ' + Object.keys(reference)[0], async t => {
  const {b, root, write, apply, requests} = await fixture(t);
  await apply({a:['current'],b:['other']});
  const config = await b.config(), previous = config['proxy-providers'].b;
  config['proxy-groups'].push({name:'secondary',type:'select',...reference,filter:'^other$'});
  await write('clash-verge.yaml', config);
  if (process.env.LINKBOX_TEST_CORE) b.validateConfig = file => {
   execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', file]);
  };
  await apply({a:['current'],b:[]});
  const live = YAML.parse(requests.at(-1).body.payload);
  assert.deepEqual(live['proxy-groups'][0].use, ['a']);
  assert.equal(live['proxy-providers'].b.filter, '^other$');
  assert.deepEqual((await b.config())['proxy-providers'].b, previous);
  const script = await fs.readFile(path.join(root,'profiles/Script.js'),'utf8');
  const context = require('node:vm').createContext({input:{'proxy-groups':config['proxy-groups']}});
  assert.deepEqual(JSON.parse(require('node:vm').runInContext(script + "\nJSON.stringify(main(input))", context))['proxy-providers'].b, previous);
 });
}

test('partial deselection filters a provider shared with another group', async t => {
 const {b, config, write, apply, requests} = await fixture(t);
 const secondary = {name:'secondary', type:'select', use:['a'], filter:'^slow$'};
 config['proxy-groups'].push(secondary);
 await write('clash-verge.yaml', config);
 await write('profiles/a.yaml', {proxies:['fast`relay','fast extra','slow'].map(name => node(name))});
 await apply({a:['fast`relay','slow'], b:[]});
 await apply({a:['fast`relay'], b:[]});
 const payload = YAML.parse(requests.at(-1).body.payload);
 assert.deepEqual(payload['proxy-groups'][1], secondary);
 assert.equal(payload['proxy-providers'].a.filter, '^fast\\x60relay$');
 assert.deepEqual(payload['proxy-providers'].a.payload.map(row => row.name), ['fast`relay']);
});

test('validation failure and external state change cancel before any reload', async t => {
 const {b, root, apply, state, requests} = await fixture(t);
 const file = path.join(root,'clash-verge.yaml'), original = await fs.readFile(file);
 b.validateConfig = async () => {throw Error('invalid');};
 await assert.rejects(apply({a:['fast'],b:[]}), /校验/);
 b.validateConfig = async () => {state.entry='changed';};
 await assert.rejects(apply({a:['fast'],b:[]}), /改变/);
 assert.equal(requests.length, 0);
 assert.deepEqual(await fs.readFile(file), original);
});

test('explicit reload rejection restores the files even when readback is unavailable', async t => {
 const {b, root, policy, apply} = await fixture(t);
 const file = path.join(root,'clash-verge.yaml'), original = await fs.readFile(file);
 const requests = [];
 b.request = async (_endpoint, method, route) => {
  requests.push(route);
  if (method === 'PUT') throw new ClashHTTPError(400, true);
  throw Error('offline');
 };
 await assert.rejects(apply({a:['fast'],b:[]}), /文件已回退/);
 assert.deepEqual(requests, ['/configs?force=false']);
 assert.deepEqual(await fs.readFile(file), original);
 await assert.rejects(fs.access(path.join(root,'profiles/Script.js')));
 await assert.rejects(fs.access(policy));
 assert.equal(b.busy, false);
});

test('empty HTTP error response cannot trigger rollback', async t => {
 const {b, apply, saved} = await fixture(t);
 const controller = b.request, writes = [];
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') {
   writes.push(args[3]);
   throw new ClashHTTPError(500, false);
  }
  return controller(...args);
 };
 await assert.rejects(apply({a:['quick'],b:[]}), /尚未确认/);
 assert.equal(writes.length, 1);
 assert.deepEqual((await saved()).pending_update.selection, {a:['quick']});
});

test('remove applies the same selection and refuses the current, stale or unknown entries', async t => {
 const {b, state, apply, saved, requests} = await fixture(t);
 await apply({a:['current','fast'],b:['other']});
 requests.length = 0;
 for(const [names,entry] of [[['current'],'current'],[['fast'],'stale'],[['unknown'],'current']]){
  await assert.rejects(sub.remove(b,{names,entry}), /当前节点/);
 }
 await sub.remove(b,{names:['fast'],entry:'current'});
 assert.deepEqual((await saved()).selected_nodes, {a:['current'],b:['other']});
 assert.deepEqual(state.live, ['current','other']);
 assert.deepEqual(requests.map(r=>r.route), ['/configs?force=false']);
});

test('unsupported, missing or malformed index and download errors never prune saved selection', async t => {
 const {b, root, write, items, apply, saved, requests} = await fixture(t);
 await apply({a:['current'],b:[]});
 const before = await saved();
 requests.length = 0;
 await write('profiles.yaml',{items:[items[0],{...items[1],url:'http://example.invalid/b'}]});
 assert.deepEqual((await sub.catalog(b)).sources.map(s=>s.name), ['A']);
 await assert.rejects(b.updateSubscriptions(), /HTTPS/);
 await fs.unlink(path.join(root,'profiles.yaml'));
 await assert.rejects(b.updateSubscriptions(), /完整读取/);
 await write('profiles.yaml',{items});
 b.textRequest = async () => {throw Error('offline');};
 await assert.rejects(b.updateSubscriptions(), /下载/);
 assert.deepEqual(await saved(), before);
 assert.equal(requests.length, 0);
});

test('deleted subscriptions disappear from picker and a rotation retains the stable ID', async t => {
 const {b, write, items} = await fixture(t);
 await write('profiles.yaml',{items:[items[1]]});
 assert.deepEqual((await sub.catalog(b)).sources.map(s=>s.name), ['B']);
 assert.equal(sub.sourceKey('https://a.invalid/client/'+'a'.repeat(24)),
  sub.sourceKey('https://b.invalid/client/'+'a'.repeat(24)));
});

test('lost reload response keeps new files even with unchanged group membership', async t => {
 const {b, root, state, apply, refreshWith, requests, saved} = await fixture(t);
 await apply({a:['current','fast'],b:[]});
 const before = structuredClone(state);
 refreshWith({a:['current','fast','new'],b:['other']});
 const controller = b.request;
 b.request = async (...args) => {
  const result = await controller(...args);
  if(args[2] === '/configs?force=false') throw Error('response lost');
  return result;
 };
 requests.length = 0;
 await b.updateSubscriptions();
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false']);
 assert.deepEqual(state.live, before.live);
 assert.equal(state.entry, before.entry);
 assert.equal((await saved()).reload_unconfirmed, undefined);
 assert.match(await fs.readFile(path.join(root, 'profiles/a.yaml'), 'utf8'), /new/);
});

test('unobservable reload keeps new files and requests refresh', async t => {
 const {b, state, apply, saved} = await fixture(t);
 const controller = b.request;
 let offline = false;
 b.request = async (...args) => {
  if(offline) throw Error('offline');
  const result = await controller(...args);
  if(args[2] === '/configs?force=false'){offline = true;throw Error('response lost');}
  return result;
 };
 await assert.rejects(apply({a:['quick'],b:[]}), /已写入新配置，Clash 尚未确认，请刷新状态核对/);
 assert.equal(state.entry, 'quick');
 assert.equal((await saved()).selected_nodes, undefined);
 assert.deepEqual((await saved()).pending_update.selection, {a:['quick']});
});

for(const recover of [true, false]) test('switch retries after reading state, then ' + (recover ? 'recovers' : 'reports failure'), async t => {
 const {b, state, apply, requests, saved, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 b.history = {latestResults: {quick: {chainDelay:20, owner:'a'}}};
 const controller = b.request;
 const calls = [];
 b.request = async (...args) => {
  calls.push(args[2]);
  if(args[2] === ENTRY_ROUTE && (!recover || !requests.some(r => r.route === ENTRY_ROUTE))){
   requests.push({route:args[2], body:args[3]});
   throw Error('switch failed');
  }
  return controller(...args);
 };
 if(recover) await apply({a:['fast','quick'],b:[]});
 else await assert.rejects(apply({a:['fast','quick'],b:[]}), /配置已更新，但无法切换/);
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false', ENTRY_ROUTE, ENTRY_ROUTE]);
 const first = calls.indexOf(ENTRY_ROUTE);
 assert.equal(calls[first + 1], '/configs');
 assert.equal(calls[first + 2], '/proxies');
 assert.equal(state.entry, recover ? 'quick' : 'current');
 const policy = await saved();
 if (recover) {
  assert.deepEqual(policy.selected_nodes, {a:['fast','quick']});
  assert.equal(policy.pending_update, undefined);
 } else {
  assert.equal(policy.selected_nodes, undefined);
  assert.deepEqual(policy.pending_update.selection, {a:['fast','quick']});
 }
});

test('a delayed reload is read back without resending it', async t => {
 const {b, root, state, apply, saved} = await fixture(t);
 await apply({a:['current','fast','quick'],b:[]});
 const controller = b.request, writes = [];
 let reads = 0;
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') {
   writes.push(args);
   throw Error('timeout');
  }
  if (writes.length && args[2] === '/proxies' && ++reads === 2) await controller(...writes[0]);
  return controller(...args);
 };
 await apply({a:['quick'],b:[]});
 assert.equal(writes.length, 1);
 assert.equal(state.entry, 'quick');
 assert.deepEqual((await saved()).selected_nodes, {a:['quick']});
 const config = YAML.parse(await fs.readFile(path.join(root,'clash-verge.yaml'),'utf8'));
 assert.equal(config['proxy-providers'].a.filter, '^quick$');
});

test('upgrade download failure keeps saved relays and tries every source', async t => {
 const {b, root, policy, legacy, requests, downloads, refreshWith} = await fixture(t);
 await legacy({selected_nodes:{a:['fast'],b:['other']}});
 refreshWith({b:['other']});
 const files = [policy, path.join(root,'clash-verge.yaml'), path.join(root,'profiles/a.yaml'), path.join(root,'profiles/Script.js')];
 const before = await Promise.all(files.map(file => fs.readFile(file)));
 await assert.rejects(sub.initialize(b), /订阅下载/);
 assert.equal(downloads.length, 2);
 assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before);
 assert.equal(requests.length, 0);
 refreshWith({a:['fast'],b:['other']});
 assert.equal(await sub.initialize(b), true);
});

test('initialization retries after files are written but reload is unconfirmed', async t => {
 const {b, refreshWith, saved, requests, state} = await fixture(t);
 state.live.push('external');
 refreshWith({a:['current','fast'],b:['other']});
 const controller = b.request, reloads = [];
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') { reloads.push(args); throw Error('timeout'); }
  return controller(...args);
 };
 await assert.rejects(sub.initialize(b), /尚未确认/);
 assert.deepEqual((await saved()).pending_update.selection, {a:['current','fast']});
 await assert.rejects(sub.initialize(b), /尚未确认/);
 assert.equal(reloads.length, 2);
 await controller(...reloads[0]);
 b.request = controller;
 assert.equal(await sub.initialize(b), true);
 assert.equal(await sub.initialize(b), false);
 assert.equal(requests.length, 1);
});

for (const late of [false, true]) test(`Refresh finishes an existing user's pending update (${late ? 'late reload' : 'lost request'})`, async t => {
 const {b, root, apply, requests, state, saved, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 await apply({a:['current','fast','quick'], b:[]});
 b.history = {latestResults:{fast:{chainDelay:10,owner:'a'}}};
 const controller = b.request, pending = [];
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') { pending.push(args); throw Error('timeout'); }
  return controller(...args);
 };
 await assert.rejects(apply({a:['fast','quick'], b:[]}), /尚未确认/);
 assert.equal(pending.length, 1);
 if (late) {
  await controller(...pending[0]);
  assert.equal(state.entry, 'current');
 }
 requests.length = 0;
 b.history = {latestResults:{quick:{chainDelay:10,owner:'a'}}};
 b.request = controller;
 assert.equal(await sub.initialize(b), true);
 assert.equal(state.entry, 'quick');
 assert.deepEqual(requests.map(({route}) => route), late ? [ENTRY_ROUTE] : ['/configs?force=false', ENTRY_ROUTE]);
 const index = YAML.parse(await fs.readFile(path.join(root, 'profiles.yaml'), 'utf8'));
 assert.deepEqual(index.items[0].selected, [{name:ENTRY, now:'quick'}]);
 assert.equal((await saved()).pending_update, undefined);
 assert.equal(await sub.initialize(b), false);
});

test('switches follow disk membership before and after a late reload', async t => {
 const {b, apply, policy, requests, state} = await fixture(t);
 await apply({a:['current','fast'], b:[]});
 const controller = b.request, reloads = [];
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') { reloads.push(args); throw Error('timeout'); }
  return controller(...args);
 };
 await assert.rejects(apply({a:['current','fast','quick'], b:[]}), /已写入新配置，Clash 尚未确认，请刷新状态核对/);
 requests.length = 0;
 const before = await fs.readFile(policy);
 const mismatch = /Clash 配置尚未生效，请刷新、保存或同步订阅/;
 delete b.state;
 await assert.rejects(b.switchNode('fast','current'), mismatch);
 b.settings.autoRelay = true;
 b.network = async () => ({interface:'fixture'});
 b.corePath = async () => '/mock';
 b.testNode = async node => ({delay:node.name === 'current' ? 400 : 100});
 await assert.rejects(b.benchmark('chain', () => true), mismatch);
 assert.deepEqual(requests, []);
 assert.equal(reloads.length, 1);
 await controller(...reloads[0]);
 assert.equal((await b.benchmark('chain', () => true)).switchedTo, 'fast');
 assert.equal(state.entry, 'fast');
 assert.deepEqual(await fs.readFile(policy), before);
});

test('initialization replans from the latest results after a failed switch', async t => {
 const {b, root, legacy, refreshWith, state, saved, requests, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 await legacy({selected_nodes:{a:['current','fast','quick'], b:['other']}});
 refreshWith({a:['fast','quick'], b:['other']});
 b.history = {kind:'chain', latestResults:{quick:{owner:'a', chainDelay:10}}};
 const controller = b.request;
 b.request = async (...args) => {
  if (args[2] === ENTRY_ROUTE) throw Error('switch failed');
  return controller(...args);
 };
 await assert.rejects(sub.initialize(b), /无法切换/);
 assert.equal(state.entry, 'current');
 const policy = await saved();
 assert.deepEqual(policy.pending_update, {root, selection:{a:['fast','quick'], b:['other']}});
 b.history = {kind:'chain', latestResults:{other:{owner:'b', chainDelay:5}}};
 b.request = controller;
 requests.length = 0;
 assert.equal(await sub.initialize(b), true);
 assert.equal(state.entry, 'other');
 assert.deepEqual(requests.map(({route}) => route), [ENTRY_ROUTE]);
 assert.equal(await sub.initialize(b), false);
});

for (const kind of ['chain', 'entrance']) test(`an interrupted ${kind} benchmark cannot rank reconciliation after restart`, async t => {
 const {b, data, root, state, refreshWith, apply} = await fixture(t);
 await apply({a:['current','fast','quick'], b:[]});
 b.history = {kind:'chain', latestResults:{quick:{owner:'a', chainDelay:10}}};
 await fs.writeFile(path.join(data,'results.json'), JSON.stringify(b.history));
 const read = b.state;
 let probed = false;
 b.state = async () => {
  if (probed) throw Error('controller read failed');
  return {...await read(), nodes:[{name:'current', providerId:'a'}]};
 };
 b.network = async () => ({interface:'fixture'});
 b.loadNodes = async () => ({nodes:new Map([['current',node('current')]]),exit:node(EXIT)});
 b.corePath = async () => '/mock';
 b.testNode = async () => { probed = true; return {status:'done',delay:120}; };
 await assert.rejects(b.benchmark(kind), /controller read failed/);
 assert.equal(probed, true);
 b.state = read;
 await b.init();
 b.settings.configDir = root;
 refreshWith({a:['fast','quick'], b:['other']});
 await b.updateSubscriptions();
 assert.equal(state.entry, 'fast');
});

test('a switch is verified again after a short delay', async t => {
 const {b, apply, requests, state, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 b.history = {latestResults:{quick:{chainDelay:10}}};
 let readsAfterSwitch = 0;
 const read = b.relayState.bind(b);
 b.relayState = async () => {
  if (requests.some(request => request.route === ENTRY_ROUTE) && ++readsAfterSwitch === 2) state.entry = 'fast';
  return read();
 };
 await assert.rejects(apply({a:['fast','quick'], b:[]}), /无法切换/);
 assert.equal(readsAfterSwitch, 2);
 assert.deepEqual(timers.setTimeout.mock.calls.map(call => call.arguments), [[300]]);
});

test('no live match requires the picker without retrying initialization', async t => {
 const {b, policy, refreshWith, downloads, requests, apply} = await fixture(t);
 refreshWith({a:['new'],b:['other']});
 await assert.rejects(sub.initialize(b), /管理节点/);
 await assert.rejects(sub.initialize(b), /管理节点/);
 assert.equal(downloads.length, 2);
 assert.equal(requests.length, 0);
 await assert.rejects(fs.access(policy), {code:'ENOENT'});
 await apply({a:['new'],b:[]});
 assert.equal(await sub.initialize(b), false);
});

test('missing relay cannot win reconciliation on an old benchmark delay', async t => {
 const {inputs, expected} = JSON.parse(await fs.readFile(
  path.join(__dirname,'../../fixtures/reconcile/latest-benchmark-only.json'), 'utf8'));
 const {b, state, policy, refreshWith, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 await fs.writeFile(policy, JSON.stringify({selected_nodes:inputs.selection}));
 b.settings.metric = inputs.metric;
 b.history = {results:{stale:{owner:'a',entranceDelay:10,chainDelay:100}}};
 Object.assign(state, {entry:inputs.current,live:inputs.live,
  nodes:inputs.selection.a.map(name => ({name,providerId:'a'}))});
 b.loadNodes = async () => ({nodes:new Map([['fresh',node('fresh')]]),exit:node(EXIT)});
 b.network = async () => ({interface:'fixture'});
 b.corePath = async () => '/mock';
 b.testNode = async () => ({status:'done',delay:120,entranceDelay:50});
 const result = await b.benchmark();
 assert.equal(result.latestResults.stale.entranceDelay, null);
 refreshWith({a:inputs.sources[0].nodes,b:['other']});
 await b.updateSubscriptions();
 assert.equal(state.entry, expected.entry);
});

test('an already-saved failed chain row cannot win reconciliation on an older entrance delay', async t => {
 const {b, state, policy, refreshWith, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 await fs.writeFile(policy, JSON.stringify({selected_nodes:{a:['current','stale','fresh']}}));
 b.settings.metric = 'entrance';
 b.history = {kind:'chain',latestResults:{
  stale:{owner:'a',entranceDelay:10,chainDelay:null,status:'failed'},
  fresh:{owner:'a',entranceDelay:50,chainDelay:120,status:'done'},
 }};
 refreshWith({a:['stale','fresh'],b:['other']});
 await b.updateSubscriptions();
 assert.equal(state.entry, 'fresh');
});

test('post-switch verification rejects an added ENTRY member', async t => {
 const {b, apply, requests, saved, state, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 const controller = b.request;
 b.request = async (...args) => {
  const result = await controller(...args);
  if (args[2] === ENTRY_ROUTE) state.live.push('external');
  return result;
 };
 b.history = {latestResults:{other:{chainDelay:20,owner:'b'}}};
 await assert.rejects(apply({a:['quick'],b:['other']}), /配置已更新，但无法切换/);
 assert.deepEqual(requests.map(r=>r.route), ['/configs?force=false', ENTRY_ROUTE]);
 assert.deepEqual((await saved()).pending_update.selection, {a:['quick'],b:['other']});
});
