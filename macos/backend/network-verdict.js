'use strict';

const networkSameIP = typeof module === 'object' ? require('../../windows/ip-address.js').sameIP : sameIP;

function assessNetworkIPv6(native) {
 const addresses = native.global_ipv6_addresses;
 const probes = [native.ipv6_google, native.ipv6_cloudflare];
 if (probes.some(probe => probe?.connected === true)) {
  return {status: 'warn', text: '存在可用 IPv6 通路，需核实其出口；不能仅凭连接成功认定泄漏'};
 }
 if (!Array.isArray(addresses) || probes.some(probe => probe?.connected !== false)) {
  return {status: 'warn', text: 'IPv6 检查未完整取得结果，未验证'};
 }
 if (addresses.length) {
  return {status: 'warn', text: '发现公网 IPv6 地址，但两次连接未成功，仍需核对'};
 }
 return {status: 'ok', text: '无公网 IPv6 地址，两个独立 IPv6 目标均连接失败；本轮未发现绕过通路'};
}

function networkVerdict({expected_ip: expected, native, browser}) {
 const exit = '美国静态家宽';
 const entry = '中转入口';
 const badges = {ok: '符合预期', bad: '出口异常', warn: '待核对'};
 const cards = [];
 const add = (title, status, detail) => cards.push({
  title, status, badge: badges[status],
  detail: String(detail).replaceAll('TimeoutError', '请求超时').replaceAll('TypeError: Failed to fetch', '浏览器请求失败'),
 });
 const ipCard = (title, result, missing) => {
  const ip = result?.ip;
  add(title, ip ? (networkSameIP(ip, expected) ? 'ok' : 'bad') : 'warn', ip || '未验证 · ' + missing);
 };

 let ipv6Assessment;
 if (!native) {
  add('系统与 Claude 连接', 'warn', '检测中…');
 } else {
  for (const [key, title] of [
   ['https_tun', '系统 HTTPS 出口'], ['https_proxy', 'Clash 显式代理出口'],
   ['stun_google', '系统 Google STUN'], ['stun_cloudflare', '系统 Cloudflare STUN'],
  ]) {
   ipCard(title, native[key], native[key]?.error || '无结果');
  }
  const clash = native.clash;
  const groups = clash?.groups;
  const clashReady = clash?.mode === 'global' && clash.tun && groups?.GLOBAL?.now === exit &&
   groups?.[exit]?.['dialer-proxy'] === entry;
  add('Clash', clashReady ? 'ok' : 'warn', clash?.error ||
   `${clash?.mode} / TUN ${clash?.tun ? '开启' : '关闭'} / 入口 ${groups?.[entry]?.now || '未知'} / GLOBAL ${groups?.GLOBAL?.now || '未知'}`);

  ipv6Assessment = assessNetworkIPv6(native);
  add('本地 IPv6 绕过检查', ipv6Assessment.status, ipv6Assessment.text);

  const claude = native.claude;
  const matched = claude?.matched || [];
  const verified = matched.filter(connection => connection.chains?.includes(exit)).length;
  const other = claude?.other_sockets?.length || 0;
  const mismatch = matched.some(({chains}) => Array.isArray(chains) && chains.length && !chains.includes(exit));
  const proven = verified > 0 && verified === matched.length && !other && networkSameIP(native.https_proxy?.ip, expected);
  let detail = claude?.error;
  if (!detail) {
   if (!claude?.process_count) {
    detail = '当前没有 Claude Code 进程，未验证';
   } else if (!matched.length && !other) {
    detail = '进程当前没有可核验的网络连接，未验证';
   } else {
    detail = `${verified}/${matched.length} 条代理连接匹配美国静态家宽；${other} 条其他连接待核对。` +
     (proven ? '同一代理实测出口 ' + expected : '仅快照证据，未匹配的连接不判定为泄漏');
   }
  }
  add('Claude Code 现有连接', mismatch ? 'bad' : proven ? 'ok' : 'warn', detail);
 }

 if (!browser) {
  add('浏览器 WebRTC / IP', 'warn', '检测中…');
 } else {
  ipCard('浏览器普通网页出口', browser.http4, browser.http4?.error);
  ipCard('浏览器访问 Claude 出口', browser.claude, browser.claude?.error || '未取得结果');
  const candidates = browser.webrtc?.public_ips || [];
  const other = candidates.filter(ip => !networkSameIP(ip, expected));
  add('浏览器 WebRTC', other.length ? 'bad' : candidates.length ? 'ok' : 'warn',
   other.length ? '发现非预期公网地址 ' + other.join(', ') :
    candidates.length ? '公网候选只有预期美国出口 ' + expected :
     '未验证：没有公网 ICE 候选；' + (browser.webrtc?.error || '可能被阻止或网络超时'));
  const ipv6 = browser.http6?.ip;
  add('浏览器 IPv6 专用请求', 'warn', ipv6 ? '返回 ' + ipv6 + '，需核对是否属于代理出口' :
   '未获得 IPv6 地址；浏览器请求失败，需结合系统结果判断');
 }

 let headline = '正在检测…';
 if (native && browser) {
  if (cards.some(card => card.status === 'bad')) {
   headline = '发现出口不一致，请查看红色项目';
  } else if (cards.some(card => card.status === 'warn')) {
   headline = '检测完成：部分项目需核对或未验证';
  } else {
   headline = '检测完成：本次未发现出口异常';
  }
 }
 const passed = cards.filter(card => card.status === 'ok').length;
 return {cards, headline, counts: `${passed} 项符合预期 / ${cards.length - passed} 项待核对`, ipv6Assessment};
}

if (typeof module === 'object') module.exports = {networkVerdict};
