const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const http = require('node:http');
const vm = require('node:vm');
const YAML = require('yaml');
const {Backend} = require('../backend.cjs');
const {Clash, ClashHTTPError, ENTRY, EXIT} = require('../clash.cjs');
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
 b.clash = new Clash(()=>b.settings, script=>b.powershell(script), {
  endpoint: {}, transport: (...args)=>b.request(...args), validate: file=>b.validateConfig(file),
 });
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

test('unmanaged switching uses live names with an unsupported group filter', async t => {
 const {b, root, config, state, write, requests} = await fixture(t);
 config.proxies.splice(0, 2, node('入口甲'), node('入口乙'));
 config['proxy-groups'][0] = {name:ENTRY, type:'select', 'include-all-proxies':true, filter:'\\p{Han}'};
 await write('clash-verge.yaml', config);
 if (process.env.LINKBOX_TEST_CORE) {
  execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', path.join(root, 'clash-verge.yaml')]);
 }
 Object.assign(state, {entry:'入口甲', live:['入口甲','入口乙']});
 delete b.state;
 await assert.rejects(b.switchNode(EXIT,'入口甲'), /节点状态已变化/);
 assert.equal((await b.switchNode('入口乙','入口甲')).entry,'入口乙');
 assert.deepEqual(requests.map(r => r.route), [ENTRY_ROUTE]);
});

test('unmanaged ENTRY uses live relays with a native HTTP provider', async t => {
 const {b, config, state, write, setProviders} = await fixture(t);
 config['proxy-groups'][0].use = ['native'];
 config['proxy-providers'] = {native:{type:'http', url:'https://example.invalid/native'}};
 await write('clash-verge.yaml', config);
 const names = ['current','fast','native-relay'];
 state.live = names;
 setProviders({native:{proxies:[node('native-relay')]}});
 delete b.state;
 await t.test('lists live relays', async () => {
  assert.deepEqual((await b.state()).nodes.map(row => row.name), names);
 });
 await t.test('benchmarks available live relay credentials', async () => {
  const probes = [];
  b.network = async () => ({name:'fixture'});
  b.clash.corePath = async () => 'fixture';
  b.testNode = async node => {probes.push(node.name);return {delay:100,status:'done'};};
  const {results} = await b.benchmark();
  assert.deepEqual(probes.sort(), ['current','fast']);
  assert.deepEqual(Object.keys(results).sort(), [...names].sort());
 });
 await t.test('switches between live relays', async () => {
  assert.equal((await b.switchNode('fast','current')).entry, 'fast');
  assert.equal((await b.switchNode('native-relay','fast')).entry, 'native-relay');
 });
});

test('saved selection controls relays with a reused inline provider', async t => {
 const {b, root, config, policy, state, requests, write, apply, saved} = await fixture(t);
 const inline = {type:'inline', payload:[node('current'), node('fast')]};
 config['proxy-providers'] = {a:inline};
 await write('clash-verge.yaml', config);
 await fs.writeFile(policy, JSON.stringify({selected_nodes:{a:['current']}}));
 await fs.writeFile(path.join(root, 'profiles/a.yaml'), 'proxies: [');
 delete b.state;

 await apply({a:[], b:[]});
 assert.deepEqual((await saved()).selected_nodes, {a:['current']});
 assert.deepEqual(YAML.parse(requests[0].body.payload)['proxy-providers'].a, inline);
 assert.deepEqual(state.live, ['current','fast']);

 await t.test('lists only saved relays and their owners', async () => {
  assert.deepEqual((await b.state()).nodes.map(({name, providerId}) => [name, providerId]), [['current','a']]);
 });
 const probes = [];
 b.network = async () => ({name:'fixture'});
 b.clash.corePath = async () => 'fixture';
 b.testNode = async ({name}) => {
  probes.push(name);
  return {delay:name === 'fast' ? 10 : 100, status:'done'};
 };
 await b.saveSettings({autoRelay:true});
 const result = await b.benchmark('chain', () => true);
 await t.test('benchmarks only saved relays', async () => {
  const {nodes} = await b.loadNodes();
  assert.deepEqual([...nodes.keys()], ['current']);
  assert.deepEqual(probes, ['current']);
  assert.deepEqual(Object.keys(result.latestResults), ['current']);
  assert.equal(result.latestResults.current.owner, 'a');
 });
 await t.test('auto-switch leaves the entry unchanged', () => {
  assert.equal(result.switchedTo, undefined);
  assert.equal(state.entry, 'current');
 });
 await t.test('manual switch rejects an unchecked live relay', async () => {
  state.entry = 'current';
  await assert.rejects(b.switchNode('fast','current'), /节点状态已变化/);
 });
 assert.deepEqual(requests.map(({route}) => route), ['/configs?force=false']);
});

test('Save and switch with identical names loaded by an include-all group', async t => {
 const {b, config, write, apply, saved, requests} = await fixture(t);
 config['proxy-providers'] = {b:{type:'inline', payload:['current','fast'].map(n => node(n))}};
 config['proxy-groups'].push({name:'secondary', type:'select', 'include-all':true});
 await write('clash-verge.yaml', config);
 await apply({a:['current','fast'], b:[]});
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
 const relayState = b.clash.relayState.bind(b.clash);
 b.clash = new Clash(()=>b.settings, script=>b.powershell(script), {
  endpoint: {}, validate: file=>b.validateConfig(file),
 });
 b.clash.relayState = relayState;
 for (code of ['ECONNREFUSED','ENOENT','ENOTFOUND','ETIMEDOUT']) {
  await assert.rejects(apply({a:[], b:['current','fast']}), /未发送重载请求.*文件已回退/);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))), before);
  await assert.rejects(fs.access(path.join(root,'providers/linkbox/b.yaml')), {code:'ENOENT'});
 }
 assert.equal(connections,4);
 assert.deepEqual(state,active);
 assert.deepEqual(YAML.parse(requests[0].body.payload)['proxy-groups'][0].use, ['a']);
});

test('saving another subscription keeps unreadable cache selection and provider', async t => {
 const {b, root, write, apply, saved, refreshWith} = await fixture(t);
 await apply({a:['current','fast'], b:['same','other']});
 const before = (await b.clash.config())['proxy-providers'].b;
 await write('profiles/a.yaml', {proxies:['current','fast','same'].map(n => node(n))});
 await fs.writeFile(path.join(root, 'profiles/b.yaml'), 'proxies: [');
 const {sources:[, unreadable]} = await sub.catalog(b);
 assert.deepEqual(unreadable.nodes, []);
 await apply({a:['current','fast','same'], b:[]});
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast'], b:['same','other']});
 await sub.remove(b, {entry:'current', names:['fast']});
 assert.deepEqual((await saved()).selected_nodes, {a:['current'], b:['same','other']});
 assert.deepEqual((await b.clash.config())['proxy-providers'].b, before);
 assert.match(unreadable.warning, /保留原勾选/);
 refreshWith({a:['fast']});
 const original = await saved();
 await assert.rejects(b.updateSubscriptions(), /下载/);
 assert.deepEqual(await saved(), original);
 assert.deepEqual((await b.clash.config())['proxy-providers'].b, before);
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
 const {b, data, root, downloads, refreshWith, saved, requests, legacy, state} = await fixture(t);
 await legacy({blocked_providers:['a'], excluded_nodes:{'*':['fast']}});
 await fs.writeFile(path.join(root, 'profiles/a.yaml'), 'proxies: [');
 refreshWith({a:['current','fast','new'], b:['fast']});
 assert.equal(await sub.initialize(b), true);
 assert.equal(await sub.initialize(b), false);
 assert.equal(downloads.length, 2);
 assert.deepEqual(await saved(), {selected_nodes:{a:['current','fast']}, provider_labels:{a:'A',b:'B'}});
 assert.ok(!(await fs.readdir(path.join(data, 'backups'), {recursive:true})).some(name => name.endsWith('node-policy.json')));
 assert.deepEqual(YAML.parse(requests[0].body.payload).proxies.find(n => n.name === 'current'), node('current'));
 assert.deepEqual(state.live, ['current','fast']);
});

for (const mode of ['first run', 'Save from Sync preview']) {
 test(`${mode} keeps the downloaded Verge chain`, async t => {
  const {b, root, policy, apply} = await fixture(t);
  const chain = YAML.parse(await fs.readFile(path.join(__dirname, '../../examples/chain.example.yaml'), 'utf8'));
  chain.proxies[0].name = 'current';
  chain.proxies.push(node('剩余流量'));
  chain['proxy-groups'][1].proxies = ['current'];
  const other = {proxies: [ENTRY, 'DIRECT', 'REJECT', 'other'].map(name => node(name))};
  b.textRequest = async url => YAML.stringify(url.endsWith('/a') ? chain : other);
  if (mode === 'first run') {
   assert.equal(await sub.initialize(b), true);
  } else {
   await fs.writeFile(policy, JSON.stringify({selected_nodes: {a:['fast']}}));
   await assert.rejects(b.updateSubscriptions(), /管理节点/);
   await apply({a:['current'], b:[]});
  }

  const cached = YAML.parse(await fs.readFile(path.join(root, 'profiles/a.yaml'), 'utf8'));
  assert.deepEqual(cached, chain);
  assert.deepEqual(YAML.parse(await fs.readFile(path.join(root, 'profiles/b.yaml'), 'utf8')), other);
  const provider = YAML.parse(await fs.readFile(path.join(root, 'providers/linkbox/a.yaml'), 'utf8'));
  assert.deepEqual(provider.proxies.map(n => n.name), ['current']);
  assert.deepEqual((await sub.catalog(b)).sources[0].nodes.map(n => n.name), ['current']);
  if (process.env.LINKBOX_TEST_CORE) {
   const script = await fs.readFile(path.join(root, 'profiles/Script.js'), 'utf8');
   const regenerated = vm.runInNewContext(script + '\nmain(profile)', {profile: cached});
   const config = path.join(root, 'regenerated.yaml');
   await fs.writeFile(config, JSON.stringify(regenerated));
   execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', config]);
  }
 });
}

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

test('first run unmappable provider claims names before a mapped provider', async t => {
 const {b, config, write, items, saved, setProviders, requests} = await fixture(t);
 Object.assign(config['proxy-groups'][0], {use:['Verge cache','b'], proxies:[]});
 config['proxy-providers'] = {
  'Verge cache':{type:'file', path:'profiles/a.yaml'},
  b:{type:'http', url:items[1].url},
 };
 await write('clash-verge.yaml', config);
 setProviders({'Verge cache':{vehicleType:'File', proxies:[node('current')]},
  b:{proxies:[node('current'),node('fast')]}});
 b.textRequest = async url => YAML.stringify({proxies:['current','fast'].map(name =>
  node(name, url.split('/').at(-1) + '.example.invalid'))});

 assert.equal(await sub.initialize(b), true);
 assert.deepEqual((await saved()).selected_nodes, {a:['current'],b:['fast']});
 assert.equal(YAML.parse(requests[0].body.payload)['proxy-providers'].a.payload[0].server, 'a.example.invalid');
});

test('first run falls back when the live provider endpoint fails', async t => {
 const {b, config, write, refreshWith, saved} = await fixture(t);
 config['proxy-groups'][0].use = ['b','a'];
 await write('clash-verge.yaml', config);
 refreshWith({a:['current','fast'], b:['current','fast']});
 const controller = b.request;
 b.request = async (...args) => {
  if (args[1] === 'GET' && args[2] === '/providers/proxies') throw new ClashHTTPError(404);
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

test('sync after upgrade keeps the pin and switches once', async t => {
 const {b, root, state, legacy, downloads, requests, saved, refreshWith} = await fixture(t);
 await legacy({selected_nodes:{a:['fast'],b:['other']}});
 await fs.writeFile(path.join(root, 'profiles/a.yaml'), 'proxies: [');
 refreshWith({a:['fast'],b:['other']});
 assert.equal(await sub.initialize(b), false);
 assert.equal(downloads.length, 0);
 await b.updateSubscriptions();
 assert.equal(state.entry, 'fast');
 assert.deepEqual(YAML.parse(requests.at(-1).body.payload).proxies.find(n => n.name === 'current'), node('current'));
 assert.deepEqual(state.live, ['fast','other']);
 assert.equal((await saved()).pinned_entry, undefined);
 assert.equal(await sub.initialize(b), false);
 assert.equal(requests.filter(r => r.route === '/configs?force=false').length, 1);
 assert.equal(downloads.length, 2);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast'],b:['other']});
});

test('upgrade saving B switches off a pin excluded by unreadable A', async t => {
 const {b, root, data, config, state, legacy, requests, saved, refreshWith, downloads, write, apply} = await fixture(t);
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
 const originalFiles = await fixtureFiles(data);
 await assert.rejects(b.updateSubscriptions(), /下载或解析失败/);
 assert.equal(downloads.length, 2);
 assert.deepEqual(await fixtureFiles(data), originalFiles);
 b.history = {latestResults:{other:{owner:'b', chainDelay:10}}};
 if (process.env.LINKBOX_TEST_CORE) b.validateConfig = file => {
  execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', file]);
 };
 await apply({a:[], b:['other']});
 assert.deepEqual(state.live, ['fast','other']);
 assert.equal(state.entry, 'other');
 assert.deepEqual(requests.map(({route}) => route), ['/configs?force=false', ENTRY_ROUTE]);
 assert.deepEqual(YAML.parse(requests[0].body.payload).proxies.find(n => n.name === 'current'), node('current'));
 const index = YAML.parse(await fs.readFile(path.join(root,'profiles.yaml'),'utf8'));
 assert.deepEqual(index.items[0].selected, [{name:ENTRY, now:'other'}]);
 const selection = {a:['current','fast'], b:['other']};
 assert.deepEqual((await saved()).selected_nodes, selection);
 refreshWith({a:['current','fast'], b:['other']});
 await b.updateSubscriptions();
 assert.deepEqual((await saved()).selected_nodes, selection);
 assert.deepEqual((await sub.catalog(b)).sources[0].nodes.filter(n => n.selected).map(n => n.name), ['current','fast']);
});

test('Save ranks selected relays using legacy benchmark results until latestResults is written', async t => {
 const results = {fast:{chainDelay:80}, quick:{chainDelay:20}};
 for (const [history, expected] of [[{kind:'chain', results}, 'quick'],
  [{kind:'chain', results, latestResults:{}}, 'fast']]) {
  const {b, data, root, state, apply} = await fixture(t);
  await fs.writeFile(path.join(data, 'results.json'), JSON.stringify(history));
  await b.init();
  b.settings.configDir = root;
  await apply({a:['fast','quick'], b:[]});
  assert.equal(state.entry, expected);
 }
});

for (const flag of ['include-all-proxies', 'include-all']) {
 test(`legacy pin survives ${flag} group filters`, async t => {
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
    assert.deepEqual(reload.proxies.find(n => n.name === 'current'), node('current'));
    assert.deepEqual(state.live, ['fast']);
   });
  }
 });
}

const regexRule = 'DOMAIN-REGEX,^foo{1,3}$,current';
for (const reference of ['selector', 'include-all-proxies', 'MATCH,current', 'DOMAIN,example.invalid,current',
 'IP-CIDR,203.0.113.0/24,current,no-resolve', 'AND,((DOMAIN,example.invalid),(NETWORK,TCP)),current',
 regexRule, 'regex and selector', 'unreferenced']) {
 test(`legacy pin survives Save and Verge regeneration with ${reference}`, async t => {
  const {b, root, config, write, apply, legacy, state} = await fixture(t);
  await legacy({selected_nodes:{a:['current','fast']}});
  if (reference === 'selector' || reference === 'regex and selector') {
   config['proxy-groups'].push({name:'secondary', type:'select', proxies:['current']});
  } else if (reference === 'include-all-proxies') {
   config['proxy-groups'].push({name:'secondary', type:'select', [reference]:true});
  }
  if (reference === 'regex and selector') {
   config.rules = [regexRule];
  } else if (reference.includes(',')) {
   config.rules = [reference];
  }
  await write('clash-verge.yaml', config);
  if (process.env.LINKBOX_TEST_CORE) b.validateConfig = file => {
   execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', file]);
  };
  for (let save = 0; save < 2; save++) {
   await apply({a:['fast'], b:[]});
   assert.deepEqual((await b.clash.config()).proxies.find(n => n.name === 'current'), node('current'));
   const script = await fs.readFile(path.join(root, 'profiles/Script.js'), 'utf8');
   const profile = {...structuredClone(config), proxies:config.proxies.slice(1)};
   const regenerated = JSON.parse(vm.runInNewContext(script + '\nJSON.stringify(main(profile))', {profile}));
   assert.deepEqual(regenerated.proxies.filter(n => n.name === 'current'), [node('current')], `Save ${save + 1}`);
   const file = path.join(root, 'regenerated.yaml');
   await fs.writeFile(file, JSON.stringify(regenerated));
   await b.validateConfig(file);
   assert.deepEqual(state.live, ['fast']);
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
  const config = await b.clash.config(), previous = config['proxy-providers'].b;
  config['proxy-groups'].push({name:'secondary',type:'select',...reference,filter:'^other$'});
  await write('clash-verge.yaml', config);
  if (process.env.LINKBOX_TEST_CORE) b.validateConfig = file => {
   execFileSync(process.env.LINKBOX_TEST_CORE, ['-t', '-d', root, '-f', file]);
  };
  await apply({a:['current'],b:[]});
  const live = YAML.parse(requests.at(-1).body.payload);
  assert.deepEqual(live['proxy-groups'][0].use, ['a']);
  assert.equal(live['proxy-providers'].b.filter, '^other$');
  assert.deepEqual((await b.clash.config())['proxy-providers'].b, previous);
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

test('successful reload reports an external change between selected entries', async t => {
 const {b, apply, state, requests, saved} = await fixture(t);
 const controller = b.request;
 b.request = async (...args) => {
  const result = await controller(...args);
  if (args[2] === '/configs?force=false') state.entry = 'fast';
  return result;
 };
 await assert.rejects(apply({a:['current','fast'],b:[]}), /更新后检测到外部链路或节点变化/);
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false']);
 assert.deepEqual((await saved()).selected_nodes, {a:['current','fast']});
});

test('explicit reload rejection restores the files even when readback is unavailable', async t => {
 const {b, root, policy, apply} = await fixture(t);
 const file = path.join(root,'clash-verge.yaml'), original = await fs.readFile(file);
 const requests = [];
 b.request = async (_endpoint, method, route) => {
  requests.push(route);
  if (method === 'PUT') throw new ClashHTTPError(400);
  throw Error('offline');
 };
 await assert.rejects(apply({a:['fast'],b:[]}), /400.*文件已回退/);
 assert.deepEqual(requests, ['/configs?force=false']);
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

test('redirected reload reports HTTP status and keeps the new files', async t => {
 const {b, root, apply, saved} = await fixture(t);
 const file = path.join(root, 'clash-verge.yaml'), original = await fs.readFile(file);
 const controller = b.request;
 b.request = async (...args) => {
  if (args[2] === '/configs?force=false') throw new ClashHTTPError(302);
  return controller(...args);
 };
 await assert.rejects(apply({a:['fast'], b:[]}), {message: 'Clash 控制接口返回 302。已写入新配置，Clash 未确认，请刷新状态核对'});
 assert.notDeepEqual(await fs.readFile(file), original);
 assert.deepEqual((await saved()).selected_nodes, {a:['fast']});
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
 await assert.rejects(b.updateSubscriptions(), /已写入新配置，Clash 未确认，请刷新状态核对/);
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false']);
 assert.deepEqual(state.live, before.live);
 assert.equal(state.entry, before.entry);
 assert.match(await fs.readFile(path.join(root, 'profiles/a.yaml'), 'utf8'), /new/);
});

test('lost Save response keeps the new owner and allows a fresh update', async t => {
 const {b, state, write, apply, saved, requests, refreshWith} = await fixture(t);
 await apply({a:['current','fast'],b:[]});
 await write('profiles/b.yaml', {proxies:[node('fast'),node('other')]});
 requests.length = 0;
 const controller = b.request;
 b.request = async (_endpoint, method, route, body) => {
  assert.equal(route, '/configs?force=false');
  requests.push({route, body});
  throw Error('response lost');
 };
 await assert.rejects(apply({a:[],b:['fast','other']}), /已写入新配置，Clash 未确认，请刷新状态核对/);
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false']);
 assert.deepEqual(await saved(), {selected_nodes:{b:['fast','other']},provider_labels:{a:'A',b:'B'}});
 assert.deepEqual((await b.clash.config())['proxy-groups'][0].use, ['b']);
 assert.equal(state.entry, 'current');
 assert.equal(b.busy, false);

 b.request = controller;
 requests.length = 0;
 assert.deepEqual(await sub.startup(b), {changed:false});
 assert.equal(requests.length, 0);
 refreshWith({a:['current','fast'],b:['other']});
 await b.updateSubscriptions();
 assert.deepEqual(requests.map(r => r.route), ['/configs?force=false']);
 assert.deepEqual((await saved()).selected_nodes, {b:['other']});
 await apply({a:['current'],b:[]});
 assert.deepEqual((await saved()).selected_nodes, {a:['current']});
});

for(const recover of [true, false]) test('switch retries after reading state, then ' + (recover ? 'recovers' : 'reports failure'), async t => {
 const {b, state, apply, requests, saved, keepStaleEntryOnReload} = await fixture(t);
 keepStaleEntryOnReload();
 b.history = {latestResults: {quick: {chainDelay:20, owner:'a'}}};
 const controller = b.request;
 const calls = [];
 let lostRead = false;
 b.request = async (...args) => {
  calls.push(args[2]);
  if(args[2] === ENTRY_ROUTE && (!recover || !requests.some(r => r.route === ENTRY_ROUTE))){
   requests.push({route:args[2], body:args[3]});
   throw Error('switch failed');
  }
  if(recover && args[2] === '/configs' && calls.at(-2) === ENTRY_ROUTE && !lostRead){
   lostRead = true;
   throw Error('first switch read-back lost');
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
 assert.deepEqual((await saved()).selected_nodes, {a:['fast','quick']});
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
 b.clash.corePath = async () => '/mock';
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

test('no live match offers the picker and retries until a selection exists', async t => {
 const {b, policy, refreshWith, downloads, requests, apply} = await fixture(t);
 refreshWith({a:['new'],b:['other']});
 await assert.rejects(sub.initialize(b), /管理节点/);
 await assert.rejects(sub.initialize(b), /管理节点/);
 assert.equal(downloads.length, 4);
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
 b.clash.corePath = async () => '/mock';
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
