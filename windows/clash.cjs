'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const YAML = require('yaml');
const exec = require('node:util').promisify(require('node:child_process').execFile);

const ENTRY = '中转入口', EXIT = '美国静态家宽';
const ENTRY_ROUTE = '/proxies/' + encodeURIComponent(ENTRY);
const RELOAD_NOT_SENT = '无法连接 Clash 控制接口，未发送重载请求';
const RELOAD_UNCERTAIN = '已写入新配置，Clash 未确认，请刷新状态核对';

class ClashHTTPError extends Error {
 constructor(status){
  super('Clash 控制接口返回 '+status);
  this.rejected = status >= 400 && status < 600;
 }
}
class ClashRequestNotSent extends Error {}

function request(endpoint, method, route, body, timeout = 6000) {
 return new Promise((resolve, reject) => {
  const {secret, ...options} = endpoint;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {
   ...(secret ? {Authorization: 'Bearer ' + secret} : {}),
   ...(payload ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)} : {}),
  };
  let req;
  try {
   req = http.request({...options, method, path: route, headers}, response => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
     response.on('error', () => {});
     response.resume();
     reject(new ClashHTTPError(response.statusCode));
     return;
    }
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
     size += chunk.length;
     if (size > 12e6) req.destroy(Error('响应过大'));
     else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => {
     try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
     catch { reject(Error('Clash 返回无效数据')); }
    });
   });
  } catch (error) {
   reject(new ClashRequestNotSent(error.message, {cause: error}));
   return;
  }
  let connected = false;
  req.on('socket', socket => {
   if (socket.connecting) socket.once('connect', () => { connected = true; });
   else connected = true;
  });
  const timer = setTimeout(() => req.destroy(Error('Clash 控制接口超时')), timeout);
  req.on('close', () => clearTimeout(timer));
  req.on('error', error => reject(connected ? error : new ClashRequestNotSent('无法连接 Clash 控制接口', {cause: error})));
  if (payload) req.write(payload);
  req.end();
 });
}

async function readFile(file) {
 try { return await fs.readFile(file); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeFile(file, data) {
 await fs.mkdir(path.dirname(file), {recursive: true});
 const temp = file + '.linkbox-' + crypto.randomUUID();
 try {
  await fs.writeFile(temp, data, {mode: 0o600, flag: 'wx'});
  await fs.rename(temp, file);
 } finally {
  await fs.rm(temp, {force: true});
 }
}

const equal = (a, b) => a === null || b === null ? a === b : a.equals(b);

async function restoreFiles(written, originals) {
 for (const file of [...written].reverse()) {
  const data = originals.get(file);
  if (data === null) await fs.rm(file, {force: true});
  else await writeFile(file, data);
 }
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

class Clash {
 #settings;
 #powershell;
 #transport;
 #validate;
 #endpoint;
 #generation = 0;
 #resolveConfig;
 constructor(settings, powershell, {transport = request, validate, endpoint, resolveConfig = () => this.config()} = {}) {
  this.#settings = settings;
  this.#powershell = powershell;
  this.#transport = transport;
  this.#validate = validate;
  this.#endpoint = endpoint;
  this.#resolveConfig = resolveConfig;
 }

 resetConnection() { this.#endpoint = null; this.#generation += 1; }

 async #call(method, route, body, timeout) {
  if (!this.#endpoint) await this.#discover();
  return this.#transport(this.#endpoint, method, route, body, timeout);
 }

 async providers(timeout) { return this.#call('GET', '/providers/proxies', undefined, timeout); }
 async connections(timeout) { return this.#call('GET', '/connections', undefined, timeout); }
 async switchEntry(name) { await this.#call('PUT', ENTRY_ROUTE, {name}); }

 async reload(root, payload, prepare, rollback, validationRoot = () => root) {
  const endpoint = this.#endpoint, generation = this.#generation;
  const temp = await fs.mkdtemp(path.join(root, 'linkbox-validate-'));
  try {
   const file = path.join(temp, 'config.yaml');
   await fs.writeFile(file, payload, {mode: 0o600});
   if (this.#validate) await this.#validate(file);
   // The core lookup can yield to another config resolution before -d is read.
   else await exec(await this.corePath(), ['-t', '-d', validationRoot(), '-f', file],
    {windowsHide: true, timeout: 30000, maxBuffer: 2e6});
  } catch {
   throw Error('配置校验失败，未改动当前代理');
  } finally {
   await fs.rm(temp, {recursive: true, force: true});
  }

  // Recheck the snapshots and install the files only after validation succeeds.
  await prepare();
  // A settings save can invalidate the controller while the files are being installed.
  // Only a settings reset invalidates it; a rediscovery since then is the current controller.
  if (!endpoint || this.#generation !== generation) throw Error(RELOAD_UNCERTAIN);
  try {
   await this.#transport(this.#endpoint || endpoint, 'PUT', '/configs?force=false', {payload}, 30000);
  } catch (error) {
   const unsent = error instanceof ClashRequestNotSent ||
    ['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error?.code);
   if (unsent || (error instanceof ClashHTTPError && error.rejected)) {
    await rollback();
    const message = unsent ? RELOAD_NOT_SENT : error.message;
    throw Error(message + '，文件已回退；请刷新状态后重试');
   }
   const message = error instanceof ClashHTTPError ? error.message + '。' + RELOAD_UNCERTAIN : RELOAD_UNCERTAIN;
   throw Error(message);
  }
 }

 profilesFile(root) { return path.join(root, 'profiles.yaml'); }
 scriptFile(root) { return this.profileFile(root, 'Script.js'); }
 validProfileFilename(filename) {
  return typeof filename === 'string' && filename !== '' && filename !== '.' && filename !== '..' &&
   path.basename(filename) === filename && !filename.includes('/') && !filename.includes('\\');
 }
 profileFile(root, filename) { return path.join(root, 'profiles', filename); }
 managedCacheFile(root, owner) { return path.join(root, 'providers', 'linkbox', owner + '.yaml'); }
 providerFile(root, filename) { return path.resolve(root, filename); }

 async persistSelection(file, name) {
  const original = await readFile(file);
  const index = YAML.parse(original.toString());
  if (updateSelector(index, name)) {
   if (!equal(original, await readFile(file))) throw Error('配置或节点已被其他操作改变，已取消更新');
   await writeFile(file, YAML.stringify(index));
  }
 }

 connectionPath(key) {
  const value = this.#settings()[key];
  return typeof value === 'string' ? value : '';
 }

 async config() {
  const configured = this.connectionPath('configDir');
  const directory = 'io.github.clash-verge-rev.clash-verge-rev';
  const roots = configured ? [configured] : process.platform === 'win32'
   ? [process.env.APPDATA, process.env.LOCALAPPDATA].map(base => path.join(base || '', directory))
   : [path.join(os.homedir(), 'Library/Application Support', directory)];
  for (const root of roots) {
   for (const name of ['clash-verge.yaml', 'config.yaml']) {
    const file = path.join(root, name);
    try {
     const config = YAML.parse((await readFile(file))?.toString() || '');
     if (Array.isArray(config?.proxies)) return {root, file, config};
    } catch {}
   }
  }
  throw Error('未找到 Clash Verge 配置。请先启用链式配置，或在设置中选择配置目录。');
 }

 async #discover() {
  let config;
  try { ({config} = await this.#resolveConfig()); }
  catch (error) { throw new ClashRequestNotSent(error.message); }
  const endpoints = [];
  // Clash Verge service uses an owner-scoped endpoint, overriding the sidecar path in YAML.
  if (process.platform === 'darwin') {
   endpoints.push({socketPath: `/var/run/clash-verge-service/users/${process.getuid()}/verge-mihomo.sock`});
  }
  if (process.platform === 'win32') {
   const pipePrefix = '\\\\.\\pipe\\';
   try {
    const sid = await this.#powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    if (/^S-1-[0-9-]+$/.test(sid)) {
     const key = crypto.createHash('sha256').update(sid).digest('hex');
     for (const prefix of ['verge-mihomo-production-', 'verge-mihomo-sidecar-release-']) {
      endpoints.push({socketPath: pipePrefix + prefix + key});
     }
    }
   } catch {}
   const pipe = config['external-controller-pipe'];
   if (typeof pipe === 'string' && pipe.startsWith(pipePrefix)) endpoints.push({socketPath: pipe});
  }
  if (process.platform === 'darwin' && config['external-controller-unix']) {
   endpoints.push({socketPath: config['external-controller-unix']});
  }
  if (config['external-controller']) {
   try {
    const address = new URL('http://' + config['external-controller']);
    if (['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '[::]'].includes(address.hostname)) {
     endpoints.push({hostname: '127.0.0.1', port: Number(address.port), secret: config.secret});
    }
   } catch (error) {
    throw new ClashRequestNotSent(error.message, {cause: error});
   }
  }
  for (const endpoint of endpoints) {
   try {
    await this.#transport(endpoint, 'GET', '/version');
    this.#endpoint = endpoint;
    return;
   } catch {}
  }
  throw new ClashRequestNotSent('无法连接 Clash Verge 本机控制接口。请确认 Clash Verge 正在运行；无需开启局域网控制。');
 }

 async relayState(timeout){
  const read=route=>this.#call('GET',route,undefined,timeout);
  const [c,p]=await Promise.all([read('/configs'),read('/proxies')]);
  const all=p.proxies||{},g=all[ENTRY]||{};
  return {mode:c.mode,tun:!!c.tun?.enable,ipv6:c.ipv6,mixedPort:c['mixed-port']||7897,
   entry:g.now,exit:all.GLOBAL?.now,dialer:all[EXIT]?.['dialer-proxy'],live:g.all||[]};
 }

 async corePath() {
  const configured = this.connectionPath('corePath');
  if (configured) {
   await fs.access(configured);
   return configured;
  }
  if (process.platform === 'darwin') return '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
  try {
   const raw = await this.#powershell("@(Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(verge-mihomo|mihomo|clash-meta)(-alpha)?\\.exe$'} | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress");
   const found = JSON.parse(raw || '[]');
   for (const file of [found].flat().filter(Boolean)) {
    await fs.access(file);
    return file;
   }
  } catch {}
  const roots = [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  for (const root of roots.filter(Boolean)) {
   for (const suffix of ['Clash Verge/verge-mihomo.exe', 'Clash Verge/resources/verge-mihomo.exe']) {
    const file = path.join(root, suffix);
    try {
     await fs.access(file);
     return file;
    } catch {}
   }
  }
  throw Error('未找到 Mihomo 内核，请在设置中选择 Clash Verge 自带的 verge-mihomo.exe');
 }
}
module.exports = {Clash, ClashHTTPError, ENTRY, EXIT, equal, readFile, writeFile, restoreFiles, updateSelector};
