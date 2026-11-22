'use strict';

const networkSameIP = typeof module === 'object' ? require('./ip-address.js').sameIP : sameIP;

function ipv6Assessment(addresses, probes) {
 if (probes?.some(probe => probe?.connected)) {
  return {status: 'warn', detail: '存在 IPv6 通路，需核实出口；连接成功本身不等于泄漏'};
 }
 if (!Array.isArray(addresses) || !probes || probes.some(probe => probe?.connected !== false)) {
  return {status: 'warn', detail: '结果不完整，IPv6 未验证'};
 }
 if (addresses.length) {
  return {status: 'warn', detail: '网卡有公网 IPv6 地址，探测未连通，仍需核对'};
 }
 return {status: 'ok', detail: '无公网 IPv6 地址，两个公网目标均连接失败；本轮未发现绕过通路'};
}

function assessClaude({error, matched = [], other = []} = {}, proxyIP, expected) {
 if (error) return {status: 'warn', detail: 'Claude Code 连接未验证：' + error};
 const exit = '美国静态家宽';
 const total = matched.length + other.length;
 const good = matched.filter(connection => connection.chains.includes(exit)).length;
 const bad = matched.some(connection => connection.chains.length && !connection.chains.includes(exit));
 const proven = good > 0 && good === total && networkSameIP(proxyIP, expected);
 return {
  status: bad ? 'bad' : proven ? 'ok' : 'warn',
  detail: total ? `${good}/${total} 条 Claude Code 连接匹配美国静态家宽；${other.length} 条未匹配` :
   '当前无可核验的 Claude Code 连接，未验证',
  matched, other,
 };
}

function networkVerdict({native, browser, expectedAtStart, finishedAt}) {
 const expected = native?.expected ?? expectedAtStart;
 const badges = {ok: '符合预期', bad: '出口不一致', warn: '未验证 / 待核对'};
 const cards = [];
 const add = (title, status, detail) => cards.push({title, status, badge: badges[status], detail});
 const ipCard = (title, result) => {
  const ip = result?.ip;
  add(title, ip ? (networkSameIP(ip, expected) ? 'ok' : 'bad') : 'warn', ip || result?.error || '未取得结果');
 };

 let nativeAssessments;
 if (!native || native.error) {
  add('系统检查', 'warn', native?.error || '未取得结果');
 } else {
  if (native.stable === false) {
   add('检查期间网络变化', 'warn', '网络或所选节点已变化，请在连接稳定后重新检查');
  }
  ipCard('系统 TUN 出口', native.tun);
  ipCard('Clash 显式代理出口', native.proxy);
  if (native.ipv6 == null) {
   // Preview mode returns a message in place of the native report.
   return {
    cards,
    summary: "Cannot read properties of " + native.ipv6 + " (reading 'status')",
    downloadable: false,
   };
  }
  const {addresses, probes} = native.ipv6;
  const ipv6 = {...ipv6Assessment(addresses, probes), addresses, probes};
  const claude = assessClaude(native.claude, native.proxy?.ip, native.expected);
  add('本地 IPv6 绕过', ipv6.status, ipv6.detail);
  add('Claude Code 当前连接', claude.status, claude.detail);
  nativeAssessments = {ipv6, claude};
 }

 ipCard('本应用浏览器出口', browser?.http4);
 ipCard('本应用访问 Claude 出口', browser?.claude);
 const ipv6 = browser?.http6?.ip;
 add('浏览器 IPv6', 'warn', ipv6 ? '返回 ' + ipv6 + '，需核对出口归属' : '未取得 IPv6 地址，请结合本地检查判断');
 const candidates = browser?.webrtc?.ips || [];
 const other = candidates.filter(ip => !networkSameIP(ip, expected));
 add('浏览器 WebRTC', other.length ? 'bad' : candidates.length ? 'ok' : 'warn',
  candidates.length ? candidates.join('、') : '没有公网候选，未验证');

 const summary = cards.some(card => card.status === 'bad') ? '检测完成：发现出口不一致，请核对。' :
  '检测完成 · ' + finishedAt + ' · 未验证不等于通过';
 return {cards, summary, nativeAssessments, downloadable: true};
}

if (typeof module === 'object') module.exports = {networkVerdict, ipv6Assessment, assessClaude};
