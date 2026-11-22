'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),YAML=require('yaml');
const {reconcile, selectionOwners}=require('./reconcile.cjs');
const {isDeepStrictEqual}=require('node:util');
const {signature: sig, providerNodes}=require('./backend.cjs');
const {ENTRY, EXIT, equal, readFile, writeFile, restoreFiles, updateSelector}=require('./clash.cjs');
const MARK='// BEGIN LINKBOX MANAGED PROVIDERS',NOTICE=/剩余流量|重置剩余|套餐到期|官网续费|务必加Q群/;
const PREVIEW='subscription-preview.yaml', NO_SELECTION='订阅里已没有你勾选的节点，请先在管理节点里勾选';
const INVALID_CONFIG = '无法读取 Clash Verge 配置，未修改';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest=raw=>raw && crypto.createHash('sha256').update(raw).digest('hex');
async function doc(p){const r=await readFile(p);return r?YAML.parse(r.toString())||{}:{}}
async function policy(b){return doc(path.join(b.dataDir,'node-policy.json'))}
function parseProfile(raw){
 try { return raw ? YAML.parse(raw.toString()) : null; }
 catch (error) { if (!(error instanceof YAML.YAMLParseError)) throw error; return null; }
}
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
 await b.clash.config(); // Resolve the local Verge configuration directory.
 const profiles = parseProfile(await readFile(b.clash.profilesFile()));
 if (!Array.isArray(profiles?.items) || profiles.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
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
  let profile;
  try {
   if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw Error('Clash Verge 订阅需要 HTTPS 地址及有效本地文件，未更新节点');
   }
   profile = b.clash.profileFile(file);
  } catch (error) {
   if (forUpdate) throw error;
   continue;
  }
  const key = sourceKey(url);
  if (seen.has(key)) continue;
  seen.add(key);
  const name = saved.get(key)?.name || 'verge_' + hash(item.uid || file).slice(0, 12);
  const source = {name, display_name: item.name || name, url, profile_file: file};
  let raw;
  try { raw = await readFile(profile); }
  catch (error) { if (!error.code) throw error; raw = null; }
  sources.push({source, raw});
 }
 if (new Set(sources.map(entry => entry.source.name)).size !== sources.length) {
  throw Error('订阅标识冲突，请先整理 Clash Verge 订阅');
 }
 const revisions = sources.map(({source, raw}) => [source, digest(raw)]);
 const revision = hash([b.clash.root, revisions, (await policy(b)).selected_nodes]);
 if (forUpdate) return {sources: sources.map(({source}) => ({source})), fingerprint: revision};
 const rawPreview = await readFile(path.join(b.dataDir, PREVIEW));
 const preview = parseProfile(rawPreview);
 const previewProfiles = preview?.revision === revision ? preview.profiles : null;
 const previewId = previewProfiles ? digest(rawPreview) : null;
 const inventory = sources.map(({source, raw}) => ({
  source, document: clean(previewProfiles && Object.hasOwn(previewProfiles, source.name) ?
   previewProfiles[source.name] : parseProfile(raw)),
 }));
 return {sources: inventory, fingerprint: hash([revision, previewId]), previewProfiles};
}
function inventoryFor(sources) {
 return sources.map(({source, document}) => document ?
  {id: source.name, nodes: document.proxies.map(n => n.name)} : {id: source.name, nodes: [], unreadable: true});
}

function nameFilter(definition, mode = '') {
 function patterns(value) {
  return (value || '').split('`').filter(Boolean).map(pattern => {
   const flags = pattern.match(/^\(\?([ims]+)\)/);
   return flags ? new RegExp(pattern.slice(flags[0].length), flags[1] + mode) : new RegExp(pattern, mode);
  });
 }
 const include = patterns(definition.filter), exclude = patterns(definition['exclude-filter']);
 return name => (!include.length || include.some(re => re.test(name))) && !exclude.some(re => re.test(name));
}

function groupFilter(group) {
 try { return nameFilter(group, 'u'); }
 catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  // Mihomo accepts expressions that JavaScript cannot compile.
  return () => true;
 }
}

async function entrySeedOwners(b, config, sources) {
 const available = sources.filter(({document}) => document).map(({source}) => source);
 const byID = new Map(available.map(source => [source.name, source]));
 const byURL = new Map(available.map(source => [sourceKey(source.url), source]));
 const use = config['proxy-groups']?.find(g => g.name === ENTRY)?.use || [];
 const owners = new Map();
 if (!use.length) return owners;
 let liveProviders;
 try { liveProviders = providerNodes(await b.clash.providers()); }
 catch { return owners; }
 const providers = config['proxy-providers'] || {};
 for (const name of use) {
  const url = Object.hasOwn(providers, name) ? providers[name]?.url : undefined;
  let source;
  try {
   if (url == null || url === '') source = byID.get(name);
   else if (typeof url === 'string') source = byURL.get(sourceKey(url));
  } catch { /* Unmappable provider. */ }
  // An unmappable first provider still reserves the name for picker fallback.
  for (const {name: relay} of liveProviders.get(name) || []) {
   if (!owners.has(relay)) owners.set(relay, source?.name);
  }
 }
 return new Map([...owners].filter(([, owner]) => owner !== undefined));
}

function mergeSelectionDraft(catalog, changes){
 if(!Array.isArray(changes)||changes.some(row=>!Array.isArray(row)||row.length!==3||
    typeof row[0]!=='string'||typeof row[1]!=='string'||typeof row[2]!=='boolean')){
  throw Error('节点选择无效，请重新打开管理节点');
 }
 const edits=new Map(),explicit=new Map();
 for(const [source,name,selected] of changes){
  if(!edits.has(source))edits.set(source,new Map());
  edits.get(source).set(name,selected);
 }
 const sources=catalog.sources.map(source=>({...source,nodes:source.nodes.map(node=>{
  const changed=edits.get(source.id)?.get(node.name);
  const row={...node,initialSelected:node.selected,selected:changed??node.selected};
  if(changed===true)explicit.set(node.name,row);
  return row;
 })}));
 for(const {nodes} of sources){
  for(const node of nodes){
   const owner=explicit.get(node.name);
   if(owner)node.selected=node===owner;
  }
 }
 return {...catalog,sources};
}

async function catalog(b, changes=[]) {
 const {sources, fingerprint} = await discover(b);
 const state = await b.state();
 const owners = selectionOwners(reconcile({sources: inventoryFor(sources),
  selection: (await policy(b)).selected_nodes, live: state.live, current: state.entry}).selection);
 const current = state.entry;
 const currentOwner = owners.get(current) ?? sources.find(({document}) =>
  document?.proxies.some(n => n.name === current))?.source.name;
 const fresh = {fingerprint, current, sources: sources.map(({source, document}) => ({
  id: source.name, name: source.display_name,
  warning: document ? (document.proxies.length ? '' : '本地暂无可用缓存，请先在 Clash Verge 更新此订阅') :
   '本地缓存暂不可读，保留原勾选',
  nodes: (document?.proxies || []).map(n => ({
   name: n.name, type: n.type, current: n.name === current && source.name === currentOwner,
   selected: owners.get(n.name) === source.name,
  })),
 }))};
 return mergeSelectionDraft(fresh,changes);
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

// Mihomo separates filter expressions at literal backticks.
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('`', '\\x60');
const EXTERNAL_CHANGE = '配置或节点已被其他操作改变，已取消更新';
const POST_RELOAD_CHANGE = '更新后检测到外部链路或节点变化，请刷新并核对 Clash';
const SWITCH_FAILED = '配置已更新，但无法切换中转入口，请刷新并核对 Clash';
const CHAIN_KEYS = ['mode', 'tun', 'exit', 'dialer'];

function configureEntry(groups, use) {
 const group = groups.find(g => g.name === ENTRY);
 if (!group) throw Error('缺少中转入口组');
 group.proxies = [];
 group.use = use;
 for (const key of ['url', 'include-all', 'include-all-proxies', 'include-all-providers', 'filter', 'exclude-filter', 'exclude-type']) delete group[key];
}

function transform(config, managed) {
 const updated = structuredClone(config);
 const groups = updated['proxy-groups'] || [];
 const providers = updated['proxy-providers'] || {};
 for (const [name, definition] of Object.entries(managed.retired)) {
  if (groups.some(g => g.name !== ENTRY && (g.use?.includes(name) || g['include-all'] || g['include-all-providers']))) {
   providers[name] = definition;
  } else delete providers[name];
 }
 updated['proxy-providers'] = {...providers, ...managed.providers};
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
  if(m.pin)r.proxies=[...(r.proxies||[]).filter(p=>p.name!==m.pin.name),m.pin];
  const g=groups.find(g=>g.name==="中转入口");
  if(g){g.proxies=[];g.use=m.use;
    for(const k of ["url","include-all","include-all-proxies","include-all-providers","filter","exclude-filter","exclude-type"])delete g[k];}
  r.dns=r.dns||{};
  for(const k of ["nameserver-policy","proxy-server-nameserver-policy"])r.dns[k]={...(r.dns[k]||{}),...m.dns};
  return r;
};
`;
}

function legacyPin(original, config, savedName) {
 const wrapper = original?.toString().split(MARK)[1];
 if (!wrapper) return null;
 const embedded = wrapper.match(/const m=(\{.*?\});(?:r\[(?:"proxy-providers"|'proxy-providers')\]|$)/m);
 let pin;
 try { pin = JSON.parse(embedded?.[1]).pin; } catch { return null; }
 if (!pin?.name || (savedName && pin.name !== savedName) ||
     !config.proxies?.some(node => isDeepStrictEqual(node, pin))) return null;
 return pin;
}

async function selectAfterReload(b, before, selected, desired) {
 async function observe() {
  const state = await b.clash.relayState().catch(() => null);
  if (state && CHAIN_KEYS.some(key => state[key] !== before[key])) throw Error(POST_RELOAD_CHANGE);
  return state;
 }

 let after = await observe();
 if (after && selected.has(after.entry) && after.live.includes(after.entry) &&
     (selected.has(before.entry) || after.entry === desired)) {
  if (selected.has(before.entry) && after.entry !== before.entry) throw Error(POST_RELOAD_CHANGE);
  return after.entry;
 }
 for (let attempt = 0; attempt < 2; attempt++) {
  after ??= await observe();
  if (after?.live.includes(desired)) {
   if (after.entry === desired) return desired;
   try { await b.clash.switchEntry(desired); }
   catch { /* The switch may have applied before the response was lost. */ }
  }
  after = await observe();
  if (after?.entry === desired && after.live.includes(desired)) return desired;
 }
 throw Error(SWITCH_FAILED);
}

function benchmarkResults(b) {
 const history = b.history || {};
 const results = Object.hasOwn(history, 'latestResults') ? history.latestResults : history.results;
 return Object.fromEntries(Object.entries(history.reason ? {} : results ?? {})
  .filter(([, row]) => history.kind !== 'chain' || (typeof row?.chainDelay === 'number' && row.chainDelay > 0))
  .map(([name, row]) => [name, {
   chain: history.kind === 'entrance' ? undefined : row?.chainDelay, entrance: row?.entranceDelay, owner: row?.owner,
  }]));
}

function managedCache(clash, owner, definition) {
 return definition.path && clash.providerFile(definition.path) === clash.managedCacheFile(owner);
}

async function providerPayload(definition, clash, readCache, filtered) {
 let {payload} = definition;
 if (definition.path) payload = parseProfile(await readCache(clash.providerFile(definition.path)))?.proxies;
 if (!Array.isArray(payload)) throw Error('代理缓存不完整，未修改');
 if (!filtered) return payload;
 const accepts = nameFilter(definition);
 return payload.filter(node => accepts(node.name));
}

async function entryPlan(config, clash) {
 const entry = config['proxy-groups']?.find(group => group.name === ENTRY);
 if (!entry) throw Error('缺少中转入口组');
 const staticNodes = new Map((config.proxies || []).map(node => [node.name, node]));
 const members = new Map((entry.proxies || []).map(name => [name, {owner:null, node:staticNodes.get(name)}]));
 const accepts = groupFilter(entry);
 const includeAll = entry['include-all'];
 if (includeAll || entry['include-all-proxies']) {
  for (const [name, node] of staticNodes) {
   if (accepts(name) && !members.has(name)) members.set(name, {owner:null, node});
  }
 }
 const providers = config['proxy-providers'] || {};
 const use = includeAll || entry['include-all-providers'] ? Object.keys(providers).sort() : entry.use || [];
 for (const owner of use) {
  let payload;
  try { payload = await providerPayload(providers[owner], clash, readFile, true); }
  catch { continue; }
  for (const node of payload) {
   if (accepts(node.name) && !members.has(node.name)) members.set(node.name, {owner, node});
  }
 }
 return members;
}

async function reloadPayload(config, clash, updates, baselines) {
 // The service cannot read LinkBox's user-owned provider cache files.
 const live = structuredClone(config);
 const entry = live['proxy-groups'].find(group => group.name === ENTRY);
 const use = new Set(entry.use || []), members = new Set(entry.proxies || []);
 const readCache = async file => {
  if (!updates.has(file) && !baselines.has(file)) baselines.set(file, await readFile(file));
  return updates.get(file) ?? baselines.get(file);
 };
 for (const [owner, definition] of Object.entries(live['proxy-providers'])) {
  const managed = managedCache(clash, owner, definition);
  if (!managed && !use.has(owner)) continue;
  const payload = await providerPayload(definition, clash, readCache, use.has(owner));
  if (use.has(owner)) {
   for (const node of payload) members.add(node.name);
  }
  if (managed) {
   Object.assign(definition, {type: 'inline', payload});
   delete definition.url;
   delete definition.path;
  }
 }
 return {payload: YAML.stringify(live), members};
}

async function run(b, request = null, {removal = null, initialize = false} = {}) {
 if (b.busy) throw Error('已有操作正在运行');
 b.busy = true;
 const update = (async () => {
  const saved = await policy(b);
  const policyFile = path.join(b.dataDir, 'node-policy.json');
  let selection = saved.selected_nodes;
  if (initialize && selection != null) return false;
  const before = await b.state();
  b.assertChain(before);
  await b.clash.config();
  const syncing = request === null && removal === null;
  const previewFile = path.join(b.dataDir, PREVIEW);
  const configFile = b.clash.configFile, script = b.clash.scriptFile();
  const profiles = b.clash.profilesFile();
  const baselines = new Map();
  for (const file of [configFile, script, profiles, policyFile]) baselines.set(file, await readFile(file));
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
  let downloadedProfiles = request !== null ? discovered.previewProfiles : null;
  if (syncing) {
   const refreshed = [];
   const downloads = new Map();
   for (const {source} of sources) {
    try {
     const raw = YAML.parse(await b.textRequest(source.url, before.mixedPort, {timeout: 45000, max: 8*1024*1024}));
     const document = clean(raw);
     if (!document) throw Error();
     refreshed.push({source, document});
     downloads.set(source.name, raw);
    } catch {
     // Still attempt the remaining subscriptions before refusing the update.
    }
   }
   if (refreshed.length !== sources.length) throw Error('订阅下载或解析失败，未改动当前配置');
   sources = refreshed;
   downloadedProfiles = Object.fromEntries(downloads);
   if (sig(await b.state()) !== sig(before) ||
       (await discover(b, true)).fingerprint !== discovered.fingerprint) throw Error(EXTERNAL_CHANGE);
  }
  if (downloadedProfiles) {
   for (const {source} of sources) {
    if (Object.hasOwn(downloadedProfiles, source.name)) {
     updates.set(b.clash.profileFile(source.profile_file), YAML.stringify(downloadedProfiles[source.name]));
    }
   }
  }
  const config = parseProfile(baselines.get(configFile));
  if (!config || !Array.isArray(config.proxies)) throw Error(INVALID_CONFIG);
  if (config.proxies.find(node => node.name === EXIT)?.['dialer-proxy'] !== ENTRY) {
   throw Error('固定出口的链式上游已变化，未修改');
  }
  const inventory = inventoryFor(sources);
  const registry = sources.map(({source}) => source);
  const labels = Object.fromEntries(registry.map(source => [source.name, source.display_name]));
  const seedOwners = selection == null ? await entrySeedOwners(b, config, sources) : undefined;
  const plan = reconcile({sources:inventory, selection, live:before.live, current:before.entry, seedOwners});
  if (!plan.candidates.length) {
   if (syncing) {
    await writeFile(previewFile, YAML.stringify({
     revision: discovered.fingerprint, profiles: downloadedProfiles,
    }));
   }
   throw Error(NO_SELECTION);
  }

  const registryFile = path.join(b.dataDir, 'subscriptions.json');
  const pin = legacyPin(baselines.get(script), config, saved.pinned_entry);
  const definitions = new Map(), dns = {}, existing = config['proxy-providers'] || {};
  for (const {source, document} of sources) {
   const owner = source.name;
   const keep = Object.hasOwn(plan.selection, owner) && plan.selection[owner];
   if (!document) {
    if (Object.hasOwn(existing, owner)) definitions.set(owner, existing[owner]);
    else if (keep?.length) throw Error('本地缓存暂不可读，保留原勾选，请在管理节点里重新勾选');
    continue;
   }
   if (!keep?.length) continue;
   if (!/^[A-Za-z0-9_-]{1,60}$/.test(owner)) throw Error('订阅标识需使用字母、数字或短横线');
   const file = b.clash.managedCacheFile(owner);
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
   !definitions.has(name) && managedCache(b.clash, name, definition)));
  const managed = {providers: Object.fromEntries(definitions), retired, dns, use};
  if (pin) managed.pin = pin;
  const updated = transform(config, managed);
  updates.set(configFile, YAML.stringify(updated));
  updates.set(script, scriptText(baselines.get(script), managed));
  const {payload, members} = await reloadPayload(updated, b.clash, updates, baselines);
  // A saved relay can be absent from the live group while its subscription cache is unreadable.
  const selected = Object.fromEntries(Object.entries(plan.selection).map(([owner, names]) =>
   [owner, names.filter(name => members.has(name))]));
  const {entry: desired} = reconcile({sources:inventory, selection:selected, live:[], current:null,
   metric:b.settings.metric, results:benchmarkResults(b)});
  if (desired === null) throw Error(NO_SELECTION);
  const selectedNames = selectionOwners(selected);
  const plannedEntry = selectedNames.has(before.entry) ? before.entry : desired;
  const index = YAML.parse(baselines.get(profiles).toString());
  if (updateSelector(index, plannedEntry)) {
   updates.set(profiles, YAML.stringify(index));
  }
  const nextPolicy = {
   selected_nodes: plan.selection,
   provider_labels: labels,
  };
  updates.set(registryFile, JSON.stringify({sources:registry}, null, 2));
  updates.set(policyFile, JSON.stringify(nextPolicy, null, 2));
  const originals = new Map();
  for (const file of updates.keys()) originals.set(file, baselines.has(file) ? baselines.get(file) : await readFile(file));

  const written = [];
  const rollback = () => restoreFiles(written, originals);
  await b.clash.reload(payload, async () => {
   if ((await discover(b, syncing)).fingerprint !== discovered.fingerprint) throw Error(EXTERNAL_CHANGE);
   if (sig(await b.state()) !== sig(before)) {
    throw Error(EXTERNAL_CHANGE);
   }
   for (const [file, raw] of new Map([...originals, ...baselines])) {
    if (!equal(raw, await readFile(file))) throw Error(EXTERNAL_CHANGE);
   }

   const changes = [...updates].filter(([file, data]) => !equal(Buffer.from(data), originals.get(file)));
   // Keep obsolete policy data only in memory for rollback during this update.
   const backupFiles = changes.map(([file]) => file).filter(file => originals.get(file) !== null &&
    (file !== policyFile || Object.keys(saved).every(key => Object.hasOwn(nextPolicy, key))));
   if (backupFiles.length) {
    const backup = path.join(b.dataDir, 'backups', 'update-' + crypto.randomUUID());
    await fs.mkdir(backup, {recursive: true});
    for (const [i, file] of backupFiles.entries()) {
     await fs.writeFile(path.join(backup, i + '-' + path.basename(file)), originals.get(file), {mode: 0o600});
    }
   }
   try {
    for (const [file, data] of changes) {
     await writeFile(file, data);
     written.push(file);
    }
   } catch (error) {
    await rollback();
    throw error;
   }
  }, rollback);
  const entry = await selectAfterReload(b, before, selectedNames, desired);
  if (entry !== plannedEntry) await b.clash.persistSelection(entry);
  if (initialize) return true;
  return {message: syncing ? '已同步 Clash Verge 订阅。' : '已保存节点选择。'};
 })();
 b.subscriptionUpdate = update;
 try {
  return await update;
 } finally {
  b.subscriptionUpdate = null;
  b.busy = false;
 }
}

async function initialize(b) {
 return run(b, null, {initialize: true});
}

async function startup(b, ready = true) {
 return {changed: ready && await initialize(b)};
}

async function remove(b, request) {
 if (!request || typeof request !== 'object') throw Error('请选择要移除的节点');
 return run(b, null, {removal: request});
}

module.exports = {discover, catalog, mergeSelectionDraft, run, remove, initialize, startup, validateSelection, sourceKey, entryPlan};
