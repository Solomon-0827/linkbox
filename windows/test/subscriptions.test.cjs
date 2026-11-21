const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const {Backend, ENTRY, EXIT} = require('../backend.cjs');
const sub = require('../subscriptions.cjs');

const node = (name, server = 'relay.example.invalid') => ({name, type: 'ss', server, port: 443});
async function fixture(t) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-selection-'));
 t.after(() => fs.rm(dir, {recursive: true, force: true}));
 const root = path.join(dir, 'verge'), data = path.join(dir, 'data');
 await fs.mkdir(path.join(root, 'profiles'), {recursive: true});
 const config = {proxies: [node('current'), {...node(EXIT, '203.0.113.10'), 'dialer-proxy': ENTRY}],
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
 const requests = [], downloads = [];
 let refreshed = {};
 b.state = async () => structuredClone(state);
 b.validateConfig = async file => {
  assert.equal(YAML.parse(await fs.readFile(file, 'utf8'))['proxy-groups'][0].name, ENTRY);
 };
 b.textRequest = async url => {
  downloads.push(url);
  return YAML.stringify({proxies: refreshed[url.split('/').at(-1)].map(n => node(n))});
 };
 b.request = async (_endpoint, method, route, body) => {
  assert.equal(method, 'PUT');
  requests.push({route, body});
  if (route === '/configs?force=false') {
   const payload = YAML.parse(body.payload), group = payload['proxy-groups'][0];
   assert.deepEqual(group.proxies, []);
   state.live = group.use.flatMap(id => payload['proxy-providers'][id].payload.map(n => n.name));
   if (!state.live.includes(state.entry)) state.entry = state.live[0];
  } else {
   assert.equal(route, '/proxies/' + encodeURIComponent(ENTRY));
   assert.ok(state.live.includes(body.name));
   state.entry = body.name;
  }
 };
 const request = async selected => {
  const {fingerprint, current} = await sub.catalog(b);
  return {fingerprint, current, selected};
 };
 const apply = async selected => sub.run(b, await request(selected));
 return {b, root, data, config, policy, state, requests, downloads, items, write, request, apply,
  refreshWith: value => {refreshed = value;}, saved: async () => JSON.parse(await fs.readFile(policy, 'utf8'))};
}

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

test('first run downloads all subscriptions before seeding live names and drops obsolete policy', async t => {
 const {b, data, policy, root, downloads, refreshWith, saved, requests} = await fixture(t);
 await fs.writeFile(policy, JSON.stringify({blocked_providers:['a'], excluded_nodes:{'*':['fast']}, pinned_entry:'current'}));
 await fs.writeFile(path.join(root, 'profiles', 'Script.js'), 'function main(c){return c;}\n// BEGIN LINKBOX MANAGED PROVIDERS');
 refreshWith({a:['current','fast','new'], b:['fast']});
 assert.equal(await sub.initialize(b), true);
 assert.equal(await sub.initialize(b), false);
 assert.equal(downloads.length, 2);
 assert.deepEqual(await saved(), {selected_nodes:{a:['current','fast']}, provider_labels:{a:'A',b:'B'}});
 assert.ok(!(await fs.readdir(path.join(data, 'backups'), {recursive:true})).some(name => name.endsWith('node-policy.json')));
 assert.ok(!YAML.parse(requests[0].body.payload).proxies.some(n => n.name === 'current'));
});

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

test('save reloads valid candidates before switching by configured metric and persists the entry', async t => {
 const {b, state, requests, root, apply, downloads} = await fixture(t);
 b.settings.metric = 'entrance';
 b.history = {latestResults:{fast:{chainDelay:10,entranceDelay:90,owner:'a'}, quick:{chainDelay:30,entranceDelay:20,owner:'a'}}};
 await apply({a:['fast','quick'],b:[]});
 assert.deepEqual(requests.map(r=>r.route), ['/configs?force=false','/proxies/'+encodeURIComponent(ENTRY)]);
 assert.equal(state.entry, 'quick');
 const live = YAML.parse(requests[0].body.payload);
 assert.equal(live['proxy-providers'].a.type, 'inline');
 assert.equal(live['proxy-providers'].a.path, undefined);
 const saved = YAML.parse(await fs.readFile(path.join(root,'clash-verge.yaml'),'utf8'));
 assert.equal(saved['proxy-providers'].a.type, 'http');
 assert.equal(saved['proxy-providers'].a.filter, '^fast$|^quick$');
 const index = YAML.parse(await fs.readFile(path.join(root,'profiles.yaml'),'utf8'));
 assert.deepEqual(index.items[0].selected, [{name:ENTRY, now:'quick'}]);
 assert.equal(downloads.length, 0);
});

test('empty and vanished selections leave config, subscription caches and policy untouched', async t => {
 const {b, root, apply, requests, saved, refreshWith} = await fixture(t);
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

test('failed reload restores the files and does not attempt to switch', async t => {
 const {b, root, policy, apply} = await fixture(t);
 const file = path.join(root,'clash-verge.yaml'), original = await fs.readFile(file);
 let count = 0;
 b.request = async () => {count++;throw Error('timeout');};
 await assert.rejects(apply({a:['fast'],b:[]}), /文件已回退/);
 assert.equal(count, 1);
 assert.deepEqual(await fs.readFile(file), original);
 await assert.rejects(fs.access(path.join(root,'profiles/Script.js')));
 await assert.rejects(fs.access(policy));
 assert.equal(b.busy, false);
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

test('a confirmed reload with an unconfirmed selector change reports the failure', async t => {
 const {b, state, apply, requests, saved} = await fixture(t);
 b.history = {latestResults: {quick: {chainDelay:20, owner:'a'}}};
 const controller = b.request;
 b.request = async (...args) => {
  if(args[2] === '/configs?force=false')await controller(...args);
  else requests.push({route:args[2], body:args[3]});
 };
 await assert.rejects(apply({a:['fast','quick'],b:[]}), /切换后的状态待核对/);
 assert.equal(requests.length, 2);
 assert.equal(state.entry, 'fast');
 assert.deepEqual((await saved()).selected_nodes, {a:['fast','quick']});
});
