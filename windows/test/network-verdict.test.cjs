'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const macVerdict = require('../../macos/backend/network-verdict.js').networkVerdict;
const windowsVerdict = require('../network-verdict.js').networkVerdict;

const root = path.join(__dirname, '../..');
const fixtures = path.join(root, 'fixtures/network-verdict');
const read = filename => JSON.parse(fs.readFileSync(path.join(fixtures, filename), 'utf8'));
const baseline = read('all-pass.json');

const titles = {
 macos: {
  nativePending: '系统与 Claude 连接',
  tun: '系统 HTTPS 出口',
  proxy: 'Clash 显式代理出口',
  stunGoogle: '系统 Google STUN',
  stunCloudflare: '系统 Cloudflare STUN',
  clash: 'Clash',
  ipv6: '本地 IPv6 绕过检查',
  claude: 'Claude Code 现有连接',
  browserPending: '浏览器 WebRTC / IP',
  http4: '浏览器普通网页出口',
  browserClaude: '浏览器访问 Claude 出口',
  webrtc: '浏览器 WebRTC',
  http6: '浏览器 IPv6 专用请求',
 },
 windows: {
  systemError: '系统检查',
  unstable: '检查期间网络变化',
  tun: '系统 TUN 出口',
  proxy: 'Clash 显式代理出口',
  ipv6: '本地 IPv6 绕过',
  claude: 'Claude Code 当前连接',
  http4: '本应用浏览器出口',
  browserClaude: '本应用访问 Claude 出口',
  http6: '浏览器 IPv6',
  webrtc: '浏览器 WebRTC',
 },
};
const badges = {
 macos: {ok: '符合预期', warn: '待核对', bad: '出口异常'},
 windows: {ok: '符合预期', warn: '未验证 / 待核对', bad: '出口不一致'},
};

function expectedCards(platform, expected) {
 const values = {...baseline.expected.shared, ...baseline.expected[platform], ...expected.shared,
  ...expected[platform]};
 return Object.entries(titles[platform]).filter(([key]) => values[key]).map(([key, title]) => {
  const [status, detail] = values[key];
  return {title, status, detail, badge: badges[platform][status]};
 });
}

function macEvidence(evidence) {
 const expected_ip = evidence.expected;
 if (evidence.macosPending) return {expected_ip, native: null, browser: null};
 const native = {
  https_tun: evidence.tun,
  https_proxy: evidence.proxy,
  stun_google: evidence.stunGoogle,
  stun_cloudflare: evidence.stunCloudflare,
  clash: evidence.macosClashError ? {error: evidence.macosClashError} : {
   mode: 'global', tun: true, groups: {
    GLOBAL: {now: '美国静态家宽'},
    '中转入口': {now: 'fixture relay'},
    '美国静态家宽': {'dialer-proxy': evidence.macosDialer ?? '中转入口'},
   },
  },
  global_ipv6_addresses: evidence.ipv6Addresses,
  ipv6_google: evidence.ipv6Probes[0],
  ipv6_cloudflare: evidence.ipv6Probes[1],
  claude: evidence.claudeError ? {error: evidence.claudeError} : {
   process_count: evidence.processCount,
   matched: evidence.macosMatched ?? evidence.matched,
   other_sockets: evidence.macosOther ?? evidence.other,
  },
 };
 const browser = {
  http4: evidence.macosHttp4 ?? evidence.http4,
  claude: evidence.macosBrowserClaude ?? evidence.browserClaude,
  http6: evidence.http6,
  webrtc: {public_ips: evidence.macosIce ?? evidence.ice, error: evidence.iceError},
 };
 return {expected_ip, native, browser};
}

function windowsEvidence(evidence) {
 let native = {
  expected: evidence.expected,
  stable: evidence.stable,
  tun: evidence.tun,
  proxy: evidence.proxy,
  ipv6: {addresses: evidence.ipv6Addresses, probes: evidence.ipv6Probes},
  claude: evidence.claudeError ? {error: evidence.claudeError} : {matched: evidence.matched, other: evidence.other},
 };
 if (evidence.windowsError) native = {error: evidence.windowsError};
 if (evidence.windowsPreview) native = {message: '预览模式不执行代理操作'};
 const browser = {
  http4: evidence.http4,
  claude: evidence.browserClaude,
  http6: evidence.http6,
  webrtc: {ips: evidence.ice, error: evidence.iceError},
 };
 return {native, browser, expectedAtStart: evidence.expectedAtStart, finishedAt: 'fixture time'};
}

for (const filename of fs.readdirSync(fixtures).sort()) {
 const fixture = read(filename);
 const evidence = {...baseline.evidence, ...fixture.evidence};
 const expected = {...baseline.expected, ...fixture.expected};
 for (const platform of fixture.platform ? [fixture.platform] : ['macos', 'windows']) {
  test(`${platform} network verdict: ${path.basename(filename, '.json')}`, () => {
   const isMac = platform === 'macos';
   const input = isMac ? macEvidence(evidence) : windowsEvidence(evidence);
   const before = structuredClone(input);
   const result = isMac ? macVerdict(input) : windowsVerdict(input);
   assert.deepEqual(input, before);
   assert.deepEqual(result.cards, expectedCards(platform, fixture.expected));
   if (isMac) {
    assert.equal(result.headline, expected.headline);
    assert.equal(result.counts, expected.counts);
   } else {
    assert.equal(result.summary, expected.summary);
    assert.equal(result.downloadable, expected.downloadable ?? true);
   }
  });
 }
}

test('macOS report page renders polled fixture evidence offline', async () => {
 const report = macEvidence(baseline.evidence);
 let poll;
 const elements = new Map();
 const element = () => ({
  children: [],
  append(...nodes) { this.children.push(...nodes); },
  replaceChildren() { this.children.length = 0; },
 });
 const select = key => {
  if (!elements.has(key)) elements.set(key, element());
  return elements.get(key);
 };
 const context = vm.createContext({
  document: {querySelector: select, createElement: element},
  location: {pathname: '/fixture/'},
  URL,
  AbortController,
  setInterval: fn => { poll = fn; },
  clearInterval() {},
  setTimeout() {},
  clearTimeout() {},
  fetch: url => url === '/fixture/results' ? Promise.resolve({json: async () => report}) : new Promise(() => {}),
 });
 const html = fs.readFileSync(path.join(root, 'macos/backend/check.html'), 'utf8');
 const assets = {
  'ip-address.js': 'windows/ip-address.js',
  'network-verdict.js': 'macos/backend/network-verdict.js',
 };
 for (const [, src, inline] of html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
  const code = src ? fs.readFileSync(path.join(root, assets[src]), 'utf8') :
   inline.replace('__EXPECTED_IP__', JSON.stringify(report.expected_ip));
  vm.runInContext(code, context, {filename: src || 'check.html'});
 }
 await poll();
 const cards = select('#checks').children.map(({className: status, children: [head, value]}) => ({
  title: head.children[0].textContent, status, badge: head.children[1].textContent, detail: value.textContent,
 }));
 assert.deepEqual(cards, expectedCards('macos', baseline.expected));
 assert.equal(select('#headline').textContent, baseline.expected.headline);
 assert.equal(select('#counts').textContent, baseline.expected.counts);
 const raw = JSON.parse(select('#raw').textContent);
 const [status, text] = baseline.expected.macos.ipv6;
 assert.deepEqual(raw.native.ipv6_assessment, {status, text});
});
