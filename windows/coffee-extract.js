(() => {
  const text = id => (document.getElementById(id)?.innerText || '').trim();
  const rows = id => Object.fromEntries(Array.from(document.getElementById(id)?.querySelectorAll('.risk-row') || []).map(row => {
    const key=(row.querySelector('.risk-label')?.innerText || '').trim();
    const full=(row.innerText || '').trim();
    const value=row.querySelector('.loading-bar') ? '' : full.slice(key.length).trim().replace(/\s+/g,' ');
    return [key,value];
  }));
  const ip=text('ipAddrClaude');
  const score=text('gaugeScore');
  return {ip,score,props:rows('propsContent'),dns:rows('dnsLeakContent'),udp:rows('udpLeakContent'),security:rows('securityContent')};
})();
