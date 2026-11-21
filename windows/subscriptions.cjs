'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),YAML=require('yaml'),exec=require('node:util').promisify(require('node:child_process').execFile);
const {reconcile, sameEntryMembers, selectionOwners}=require('./reconcile.cjs');
const {isDeepStrictEqual}=require('node:util');
const timers=require('node:timers/promises');
const {signature: sig, ClashHTTPError, RELOAD_PENDING}=require('./backend.cjs');
const ENTRY='中转入口',EXIT='美国静态家宽',MARK='// BEGIN LINKBOX MANAGED PROVIDERS',NOTICE=/剩余流量|重置剩余|套餐到期|官网续费|务必加Q群/;
const PREVIEW='subscription-preview.yaml', NO_SELECTION='订阅里已没有你勾选的节点，请先在管理节点里勾选';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest=raw=>raw && crypto.createHash('sha256').update(raw).digest('hex');
async function read(p){try{return await fs.readFile(p)}catch(e){if(e.code==='ENOENT')return null;throw e}}
async function doc(p){const r=await read(p);return r?YAML.parse(r.toString())||{}:{}}
async function policy(b){return doc(path.join(b.dataDir,'node-policy.json'))}
function parseProfile(raw){
 try { return raw ? YAML.parse(raw.toString()) : null; }
 catch (error) { if (!(error instanceof YAML.YAMLParseError)) throw error; return null; }
}
async function atomic(p,data){await fs.mkdir(path.dirname(p),{recursive:true});const t=p+'.linkbox-'+crypto.randomUUID();try{await fs.writeFile(t,data,{mode:0o600});await fs.rename(t,p)}finally{await fs.rm(t,{force:true})}}
function sourceKey(url){const u=new URL(url);return /\/(client|subscribe)\/[A-Za-z0-9_-]{20,}$/.test(u.pathname)?u.pathname+'?'+u.search.slice(1):url}
function clean(document) {
 if (!Array.isArray(document?.proxies)) return null;
 const seen = new Set(), proxies = [];
 for (const node of document.proxies) {
  if (typeof node?.name !== 'string' || !['name','type','server','port'].every(key => node[key])) return null;
  if ([ENTRY,EXIT,'DIRECT','REJECT'].includes(node.name) || NOTICE.test(node.name)) continue;
  if (seen.has(node.name)) return null;
  seen.add(node.name);
  proxies.push(node);
 }
 return {...document, proxies};
}
async function discover(b, forUpdate = false) {
 await b.config(); // Resolve the local Verge configuration directory.
 const profiles = await doc(path.join(b.root, 'profiles.yaml'));
 if (!Array.isArray(profiles.items) || profiles.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
  throw Error('无法完整读取 Clash Verge 订阅，未删除节点');
 }
 // Keep saved IDs across updates without using old entries as sources.
 const registry = (await doc(path.join(b.dataDir, 'subscriptions.json'))).sources || [];
 const saved = new Map(registry.filter(source => source.url).map(source => [sourceKey(source.url), source]));
 const sources = [];
 const seen = new Set();
 for (const item of profiles.items) {
  if (item.type !== 'remote') continue;
  const {url, file} = item;
  if (typeof url !== 'string' || !url.startsWith('https://') ||
      typeof file !== 'string' || !file || file === '.' || file === '..' || path.basename(file) !== file || file.includes('/') || file.includes('\\')) {
   if (forUpdate) throw Error('Clash Verge 订阅需要 HTTPS 地址及有效本地文件，未更新节点');
   continue;
  }
  const key = sourceKey(url);
  if (seen.has(key)) continue;
  seen.add(key);
  const name = saved.get(key)?.name || 'verge_' + hash(item.uid || file).slice(0, 12);
  const source = {name, display_name: item.name || name, url, profile_file: file};
  let raw;
  try { raw = await read(path.join(b.root, 'profiles', file)); }
  catch (error) { if (!error.code) throw error; raw = null; }
  sources.push({source, raw});
 }
 if (new Set(sources.map(entry => entry.source.name)).size !== sources.length) {
  throw Error('订阅标识冲突，请先整理 Clash Verge 订阅');
 }
 const revisions = sources.map(({source, raw}) => [source, digest(raw)]);
 const revision = hash([b.root, revisions, await policy(b)]);
 if (forUpdate) return {sources: sources.map(({source}) => ({source})), fingerprint: revision};
 const rawPreview = await read(path.join(b.dataDir, PREVIEW));
 const preview = parseProfile(rawPreview);
 const usePreview = preview?.revision === revision;
 const inventory = sources.map(({source, raw}) => ({
  source, document: usePreview ? preview.documents[source.name] : clean(parseProfile(raw)),
 }));
 return {sources: inventory, fingerprint: hash([revision, usePreview ? digest(rawPreview) : null]), usePreview};
}
function inventoryFor(sources) {
 return sources.map(({source, document}) => document ?
  {id: source.name, nodes: document.proxies.map(n => n.name)} : {id: source.name, nodes: [], unreadable: true});
}

async function catalog(b) {
 const {sources, fingerprint} = await discover(b);
 const state = await b.state();
 const owners = selectionOwners(reconcile({sources: inventoryFor(sources),
  selection: (await policy(b)).selected_nodes, live: state.live, current: state.entry}).selection);
 const current = state.entry;
 const currentOwner = owners.get(current) ?? sources.find(({document}) =>
  document?.proxies.some(n => n.name === current))?.source.name;
 return {fingerprint, current, sources: sources.map(({source, document}) => ({
  id: source.name, name: source.display_name,
  warning: document ? (document.proxies.length ? '' : '本地暂无可用缓存，请先在 Clash Verge 更新此订阅') :
   '本地缓存暂不可读，保留原勾选',
  nodes: (document?.proxies || []).map(n => ({
   name: n.name, type: n.type, current: n.name === current && source.name === currentOwner,
   selected: owners.get(n.name) === source.name,
  })),
 }))};
}

function validateSelection(discovered, request, saved) {
 if (request.fingerprint !== discovered.fingerprint || !Object.hasOwn(request, 'current')) {
  throw Error('订阅或筛选已变化，请重新打开管理节点');
 }
 let {selected} = request;
 if (!selected || typeof selected !== 'object' || Array.isArray(selected) ||
     Object.keys(selected).length !== discovered.sources.length ||
     !discovered.sources.every(({source}) => Object.hasOwn(selected, source.name))) {
  throw Error('节点选择无效，请重新打开管理节点');
 }
 selected = {...selected};
 for (const {source, document} of discovered.sources) {
  if (!document) {
   if (saved && Object.hasOwn(saved, source.name)) {
    Object.defineProperty(selected, source.name, {value:saved[source.name], enumerable:true, configurable:true});
   } else delete selected[source.name];
   continue;
  }
  const values = selected[source.name];
  const available = new Set(document.proxies.map(n => n.name));
  if (!Array.isArray(values) || values.some(n => typeof n !== 'string' || !available.has(n))) {
   throw Error('订阅节点已变化或格式无效');
  }
 }
 return selected;
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
const EXTERNAL_CHANGE = '配置或节点已被其他操作改变，已取消更新';
const POST_RELOAD_CHANGE = '更新后检测到外部链路或节点变化，请刷新并核对 Clash';
const RELOAD_UNCERTAIN = '已写入新配置，Clash 尚未确认，请刷新状态核对';
const SWITCH_FAILED = '配置已更新，但无法切换中转入口，请刷新并核对 Clash';
const ENTRY_ROUTE = '/proxies/' + encodeURIComponent(ENTRY);
const CHAIN_KEYS = ['mode', 'tun', 'exit', 'dialer'];

function configureEntry(groups, use) {
 const group = groups.find(g => g.name === ENTRY);
 if (!group) throw Error('缺少中转入口组');
 group.proxies = [];
 group.use = use;
 for (const key of ['url', 'include-all', 'include-all-proxies', 'include-all-providers', 'filter', 'exclude-filter', 'exclude-type']) delete group[key];
}

function transform(config, managed, replace) {
 const updated = structuredClone(config);
 const groups = updated['proxy-groups'] || [];
 const providers = updated['proxy-providers'] || {};
 for (const [name, definition] of Object.entries(managed.retired)) {
  if (groups.some(g => g.name !== ENTRY && (g.use?.includes(name) || g['include-all'] || g['include-all-providers']))) {
   providers[name] = definition;
  } else delete providers[name];
 }
 updated['proxy-providers'] = {...providers, ...managed.providers};
 updated.proxies = (updated.proxies || []).filter(n => !replace.includes(n.name));
 configureEntry(groups, managed.use);
 updated.dns ||= {};
 for (const key of ['nameserver-policy', 'proxy-server-nameserver-policy']) {
  updated.dns[key] = {...updated.dns[key], ...managed.dns};
 }
 return updated;
}

function scriptText(original, managed) {
 const base = (original?.toString() || 'function main(config) { return config; }').split(MARK)[0].trimEnd();
 return base + `
${MARK}
const linkboxPreviousMain=main;
main=function(config,profileName){
  const r=linkboxPreviousMain(config,profileName);
  const m=${JSON.stringify(managed)};
  const providers=r["proxy-providers"]||{};
  const groups=r["proxy-groups"]||[];
  for(const [name,definition] of Object.entries(m.retired)){
    if(groups.some(g=>g.name!=="中转入口"&&(g.use?.includes(name)||g["include-all"]||g["include-all-providers"])))providers[name]=definition;
    else delete providers[name];}
  r["proxy-providers"]={...providers,...m.providers};
  const g=groups.find(g=>g.name==="中转入口");
  if(g){g.proxies=[];g.use=m.use;
    for(const k of ["url","include-all","include-all-proxies","include-all-providers","filter","exclude-filter","exclude-type"])delete g[k];}
  r.dns=r.dns||{};
  for(const k of ["nameserver-policy","proxy-server-nameserver-policy"])r.dns[k]={...(r.dns[k]||{}),...m.dns};
  return r;
};
`;
}

function updateSelector(index, name) {
 const profile = index.items.find(item => index.current && item.uid === index.current);
 if (!profile) return false;
 const choices = profile.selected ||= [];
 const choice = choices.find(item => item.name === ENTRY);
 if (!choice) choices.push({name: ENTRY, now: name});
 else if (choice.now !== name) choice.now = name;
 else return false;
 return true;
}

function legacyPin(original, config, savedName) {
 const wrapper = original?.toString().split(MARK)[1];
 if (!savedName || !wrapper) return [];
 // The old wrapper embeds a JSON object before its first config assignment.
 const embedded = wrapper.match(/const m=(\{.*\});r\[(?:"proxy-providers"|'proxy-providers')\]/);
 let pin;
 try { pin = JSON.parse(embedded?.[1]).pin; } catch { return []; }
 if (pin?.name !== savedName || !config.proxies.some(node => isDeepStrictEqual(node, pin))) return [];
 if (config['proxy-groups']?.some(g => g.name !== ENTRY && g.proxies?.includes(savedName)) ||
     config.proxies.some(node => node['dialer-proxy'] === savedName)) return [];
 return [savedName];
}

async function observeReload(b) {
 try { return await b.relayState(1000); } catch { return null; }
}

function confirmedState(observed, members) {
 return observed && sameEntryMembers(observed.live, members) ? observed : null;
}

async function waitForReload(b, members) {
 const deadline = performance.now() + 10000;
 for (let attempt = 0; attempt < 6; attempt++) {
  const after = confirmedState(await observeReload(b), members);
  if (after) return after;
  const remaining = deadline - performance.now();
  if (attempt === 5 || remaining <= 0) break;
  await timers.setTimeout(Math.min(2000, remaining));
 }
 throw Error(RELOAD_UNCERTAIN);
}

async function selectAfterReload(b, before, after, members, selection, inventory) {
 const owners = selectionOwners(selection);

 function checkedState(observed, error) {
  if (!observed || CHAIN_KEYS.some(key => observed[key] !== before[key])) {
   throw Error(error);
  }
  return observed;
 }

 after = checkedState(after, POST_RELOAD_CHANGE);
 if (owners.has(after.entry)) return after.entry;
 const plan = reconcile({sources:await inventory(), selection, live:after.live, current:null,
  metric:b.settings.metric, results:benchmarkResults(b)});
 const desired = plan.entry ?? owners.keys().next().value;
 after = checkedState(confirmedState(await observeReload(b), members), SWITCH_FAILED);
 for (let attempt = 0; attempt < 2; attempt++) {
  if (owners.has(after.entry)) return after.entry;
  try { await b.api('PUT', ENTRY_ROUTE, {name: desired}); }
  catch { /* Check whether the switch applied before retrying. */ }
  after = checkedState(confirmedState(await observeReload(b), members), SWITCH_FAILED);
  if (after.entry === desired) {
   await timers.setTimeout(300);
   after = checkedState(confirmedState(await observeReload(b), members), SWITCH_FAILED);
   if (after.entry !== desired) throw Error(SWITCH_FAILED);
   return desired;
  }
 }
 if (owners.has(after.entry)) return after.entry;
 throw Error(SWITCH_FAILED);
}

async function rollback(written, originals) {
 for (const file of written.reverse()) {
  const raw = originals.get(file);
  if (raw === null) await fs.rm(file, {force: true});
  else await atomic(file, raw);
 }
}

function benchmarkResults(b) {
 const history = b.history || {};
 return Object.fromEntries(Object.entries(history.reason ? {} : history.latestResults ?? {})
  .filter(([, row]) => history.kind !== 'chain' || (typeof row?.chainDelay === 'number' && row.chainDelay > 0))
  .map(([name, row]) => [name, {
   chain: history.kind === 'entrance' ? undefined : row?.chainDelay, entrance: row?.entranceDelay, owner: row?.owner,
  }]));
}

async function reloadPayload(config, root, selection, updates) {
 // The service cannot read user-owned provider paths.
 const live = structuredClone(config);
 const {use} = live['proxy-groups'].find(group => group.name === ENTRY);
 for (const [owner, definition] of Object.entries(live['proxy-providers'])) {
  if (!definition.path) continue;
  const file = path.resolve(root, definition.path);
  const raw = updates.has(file) ? updates.get(file) : (await read(file))?.toString();
  let payload = raw ? YAML.parse(raw)?.proxies : null;
  if (!Array.isArray(payload)) throw Error('代理缓存不完整，未修改');
  if (use.includes(owner)) {
   const keep = new Set(selection[owner]);
   payload = payload.filter(node => keep.has(node.name));
  }
  Object.assign(definition, {type: 'inline', payload});
  delete definition.url;
  delete definition.path;
 }
 return YAML.stringify(live);
}

async function finishUpdate(b, policyFile, saved, members, before, after, profiles, inventory) {
 if (saved.reload_unconfirmed) {
  delete saved.reload_unconfirmed;
  await atomic(policyFile, JSON.stringify(saved, null, 2));
 }
 const desired = await selectAfterReload(b, before, after, members, saved.selected_nodes, inventory);
 const original = await read(profiles);
 const index = YAML.parse(original.toString());
 if (updateSelector(index, desired)) {
  if (!equal(original, await read(profiles))) throw Error(EXTERNAL_CHANGE);
  await atomic(profiles, YAML.stringify(index));
 }
 delete saved.initialization_pending;
 delete saved.pending_update;
 await atomic(policyFile, JSON.stringify(saved, null, 2));
}

async function resumeUpdate(b, policyFile, saved, reapply = false) {
 const selection = saved.selected_nodes;
 // Older pending records can recover the planned names from the saved selection.
 const members = saved.pending_update?.members ?? [...selectionOwners(selection).keys()];
 const before = await observeReload(b);
 if (!before) throw Error(RELOAD_PENDING);
 b.assertChain(before);
 if (!b.root) await b.config();
 let after = confirmedState(before, members);
 if (reapply || !after) {
  const config = await b.config();
  if (config.proxies?.find(node => node.name === EXIT)?.['dialer-proxy'] !== ENTRY) {
   throw Error('固定出口的链式上游已变化，未修改');
  }
  const use = Object.entries(selection).filter(([, names]) => names.length).map(([owner]) => owner);
  if (use.some(owner => !Object.hasOwn(config['proxy-providers'] || {}, owner))) {
   throw Error('代理缓存不完整，未修改');
  }
  configureEntry(config['proxy-groups'] || [], use);
  const payload = await reloadPayload(config, b.root, selection, new Map());
  saved.pending_update = {members};
  saved.reload_unconfirmed = true;
  await atomic(policyFile, JSON.stringify(saved, null, 2));
  try { await b.request(b.endpoint, 'PUT', '/configs?force=false', {payload}, 30000); }
  catch (error) {
   if (reapply && error instanceof ClashHTTPError && error.rejected) {
    delete saved.pending_update;
    delete saved.reload_unconfirmed;
    await atomic(policyFile, JSON.stringify(saved, null, 2));
    throw Error('Clash 未更新，请刷新状态后重试');
   }
  }
  after = await waitForReload(b, members);
 }
 const profiles = path.join(b.root, 'profiles.yaml');
 await finishUpdate(b, policyFile, saved, members, before, after, profiles,
  async () => inventoryFor((await discover(b)).sources));
 return true;
}

async function run(b, request = null, {removal = null, initialize = false, refresh = false} = {}) {
 if (b.busy) throw Error('已有操作正在运行');
 b.busy = true;
 try {
  const saved = await policy(b);
  const policyFile = path.join(b.dataDir, 'node-policy.json');
  let selection = saved.selected_nodes;
  const legacy = ['pinned_entry', 'node_providers', 'verge_sync', 'blocked_providers', 'excluded_nodes']
   .some(key => Object.hasOwn(saved, key));
  const needsInitialization = selection == null || legacy || saved.initialization_pending === true;
  if (initialize && (saved.pending_update || saved.reload_unconfirmed)) {
   return await resumeUpdate(b, policyFile, saved);
  }
  if (saved.reload_unconfirmed) throw Error(RELOAD_PENDING);
  if (initialize && !needsInitialization) {
   if (refresh && selectionOwners(selection).size) return await resumeUpdate(b, policyFile, saved, true);
   return false;
  }
  const before = await b.state();
  b.assertChain(before);
  await b.config();
  const syncing = request === null && removal === null;
  const previewFile = path.join(b.dataDir, PREVIEW), initializationPolicy = hash([b.root, saved]);
  if (initialize && parseProfile(await read(previewFile))?.initialization_policy === initializationPolicy) throw Error(NO_SELECTION);
  const configFile = b.configFile, script = path.join(b.root, 'profiles', 'Script.js');
  const profiles = path.join(b.root, 'profiles.yaml');
  const baselines = new Map();
  for (const file of [configFile, script, profiles, policyFile]) baselines.set(file, await read(file));
  const discovered = await discover(b, syncing);
  let {sources} = discovered;
  if (request !== null) {
   selection = validateSelection(discovered, request, selection);
   if (request.current !== before.entry) throw Error(EXTERNAL_CHANGE);
  }
  if (removal !== null) {
   const {names, entry} = removal;
   const owners = selectionOwners(selection);
   if (!Array.isArray(names) || !names.length || entry !== before.entry ||
       names.some(n => n === before.entry || !owners.has(n))) throw Error('节点已变化；当前节点不能移除');
   if (sources.some(({source, document}) => !document && names.some(name => owners.get(name) === source.name))) {
    throw Error('本地缓存暂不可读，保留原勾选');
   }
   selection = Object.fromEntries(Object.entries(selection).map(([owner, items]) =>
    [owner, items.filter(n => !names.includes(n))]));
  }
  const updates = new Map();
  if (syncing) {
   const refreshed = [];
   for (const {source} of sources) {
    try {
     const raw = YAML.parse(await b.textRequest(source.url, before.mixedPort, {timeout: 45000, max: 8*1024*1024}));
     const document = clean(raw);
     if (!document) throw Error();
     refreshed.push({source, document});
    } catch {
     if (!initialize) throw Error('订阅下载或解析失败，未改动当前配置');
    }
   }
   if (refreshed.length !== sources.length) throw Error('订阅下载或解析失败，未改动当前配置');
   sources = refreshed;
   if (sig(await b.state()) !== sig(before) ||
       (await discover(b, true)).fingerprint !== discovered.fingerprint) throw Error(EXTERNAL_CHANGE);
  }
  if (syncing || (request !== null && discovered.usePreview)) {
   for (const {source, document} of sources) {
    updates.set(path.join(b.root, 'profiles', source.profile_file), YAML.stringify(document));
   }
  }
  const inventory = inventoryFor(sources);
  const plan = reconcile({sources:inventory, selection, live:before.live, current:before.entry,
   metric:b.settings.metric, results:benchmarkResults(b)});
  if (!plan.candidates.length) {
   if (syncing) await atomic(previewFile, YAML.stringify({
    revision: discovered.fingerprint, documents: Object.fromEntries(sources.map(({source, document}) => [source.name, document])),
    ...(needsInitialization ? {initialization_policy: initializationPolicy} : {}),
   }));
   throw Error(NO_SELECTION);
  }

  const config = YAML.parse(baselines.get(configFile).toString());
  if (config.proxies?.find(node => node.name === EXIT)?.['dialer-proxy'] !== ENTRY) {
   throw Error('固定出口的链式上游已变化，未修改');
  }
  const registryFile = path.join(b.dataDir, 'subscriptions.json');
  const replace = legacyPin(baselines.get(script), config, saved.pinned_entry);
  const definitions = new Map(), dns = {}, existing = config['proxy-providers'] || {};
  for (const {source, document} of sources) {
   const owner = source.name;
   const keep = Object.hasOwn(plan.selection, owner) && plan.selection[owner];
   if (!document) {
    if (Object.hasOwn(existing, owner)) definitions.set(owner, existing[owner]);
    else if (keep?.length) throw Error('本地缓存暂不可读，保留原勾选');
    continue;
   }
   if (!keep?.length) continue;
   if (!/^[A-Za-z0-9_-]{1,60}$/.test(owner)) throw Error('订阅标识需使用字母、数字或短横线');
   const file = path.join(b.root, 'providers', 'linkbox', owner + '.yaml');
   updates.set(file, YAML.stringify(document));
   definitions.set(owner, {
    type: 'http', url: source.url, path: file, interval: 86400,
    'health-check': {enable: false}, filter: keep.map(n => '^' + escape(n) + '$').join('|'),
   });
   for (const [key, value] of Object.entries(document.dns?.['nameserver-policy'] || {})) {
    if (!/^(geosite:|rule-set:)/.test(key)) Object.defineProperty(dns, key, {value, enumerable: true, configurable: true});
   }
  }
  const use = [...definitions.keys()].filter(owner => Object.hasOwn(plan.selection, owner) && plan.selection[owner].length);
  const retired = Object.fromEntries(Object.entries(existing).filter(([name, definition]) =>
   !definitions.has(name) && definition.path &&
   path.resolve(b.root, definition.path) === path.join(b.root, 'providers', 'linkbox', name + '.yaml')));
  const managed = {providers: Object.fromEntries(definitions), retired, dns, use};
  const updated = transform(config, managed, replace);
  updates.set(script, scriptText(baselines.get(script), managed));
  updates.set(configFile, YAML.stringify(updated));
  const index = YAML.parse(baselines.get(profiles).toString());
  if (updateSelector(index, plan.entry)) updates.set(profiles, YAML.stringify(index));
  const nextPolicy = {
   selected_nodes: plan.selection,
   provider_labels: Object.fromEntries(sources.map(({source}) => [source.name, source.display_name])),
  };
  if (needsInitialization) nextPolicy.initialization_pending = true;
  const members = plan.candidates.map(({name}) => name);
  nextPolicy.pending_update = {members};
  nextPolicy.reload_unconfirmed = true;
  updates.set(policyFile, JSON.stringify(nextPolicy, null, 2));
  updates.set(registryFile, JSON.stringify({sources: sources.map(({source}) => source)}, null, 2));
  const originals = new Map();
  for (const file of updates.keys()) originals.set(file, baselines.has(file) ? baselines.get(file) : await read(file));

  const payload = await reloadPayload(updated, b.root, plan.selection, updates);
  const temp = await fs.mkdtemp(path.join(b.root, 'linkbox-validate-'));
  try {
   const file = path.join(temp, 'config.yaml');
   await fs.writeFile(file, payload, {mode: 0o600});
   if (b.validateConfig) await b.validateConfig(file);
   else await exec(await b.corePath(), ['-t', '-d', b.root, '-f', file], {windowsHide: true, timeout: 30000, maxBuffer: 2e6});
  } catch {
   throw Error('配置校验失败，未改动当前代理');
  } finally {
   await fs.rm(temp, {recursive: true, force: true});
  }
  if ((await discover(b, syncing)).fingerprint !== discovered.fingerprint || sig(await b.state()) !== sig(before)) {
   throw Error(EXTERNAL_CHANGE);
  }
  for (const [file, raw] of new Map([...originals, ...baselines])) {
   if (!equal(raw, await read(file))) throw Error(EXTERNAL_CHANGE);
  }

  const backup = path.join(b.dataDir, 'backups', 'update-' + crypto.randomUUID());
  await fs.mkdir(backup, {recursive: true});
  let i = 0;
  for (const [file, raw] of originals) {
   if (raw !== null && file !== policyFile) await fs.writeFile(path.join(backup, (i++) + '-' + path.basename(file)), raw, {mode: 0o600});
  }
  const written = [];
  try {
   for (const [file, data] of updates) {
    await atomic(file, data);
    written.push(file);
   }
  } catch (error) {
   await rollback(written, originals);
   throw error;
  }
  try {
   await b.request(b.endpoint, 'PUT', '/configs?force=false', {payload}, 30000);
  } catch (error) {
   if (error instanceof ClashHTTPError && error.rejected) {
    await rollback(written, originals);
    throw Error('Clash 未更新，文件已回退；请刷新状态后重试');
   }
  }
  const after = await waitForReload(b, members);
  await finishUpdate(b, policyFile, nextPolicy, members, before, after, profiles, () => inventory);
  if (initialize) return true;
  return {message: syncing ? '已同步 Clash Verge 订阅。' : '已保存节点选择。'};
 } finally {
  b.busy = false;
 }
}

async function initialize(b, {refresh = false} = {}) {
 return run(b, null, {initialize: true, refresh});
}

async function remove(b, request) {
 if (!request || typeof request !== 'object') throw Error('请选择要移除的节点');
 return run(b, null, {removal: request});
}

module.exports = {discover, catalog, run, remove, initialize, validateSelection, sourceKey};
