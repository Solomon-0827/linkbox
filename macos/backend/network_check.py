#!/usr/bin/env python3
"""Read-only network diagnostics. No proxy changes, signals, authenticated requests, or process restarts."""
import concurrent.futures as cf
import datetime as dt
import http.client
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import socketserver
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import runtime
BASE = runtime.BASE/'proxy-self-check'
ASSETS = Path(__file__).resolve().parent
EXPECTED = runtime.expected_ip()
SOCKET = f'/var/run/clash-verge-service/users/{os.getuid()}/verge-mihomo.sock'

def core(path):
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(4)
            self.sock.connect(SOCKET)
    c = Connection('localhost', timeout=4)
    try:
        c.request('GET', path)
        r = c.getresponse()
        if r.status != 200:
            raise RuntimeError('Clash API HTTP ' + str(r.status))
        return json.loads(r.read())
    finally:
        c.close()

def safe(fn):
    try:
        return fn()
    except Exception as e:
        return {'error': str(e)}

def http_exit(proxy=None):
    handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {})
    with urllib.request.build_opener(handler,urllib.request.HTTPSHandler(context=runtime.ssl_context())).open('https://www.cloudflare.com/cdn-cgi/trace', timeout=12) as r:
        data = dict(x.split('=', 1) for x in r.read(16384).decode().splitlines() if '=' in x)
    return {k: data.get(k) for k in ('ip', 'loc')}

def stun(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(5)
    try:
        tid = os.urandom(12)
        s.sendto(struct.pack('!HHI', 1, 0, 0x2112a442) + tid, (host, port))
        data, _ = s.recvfrom(2048)
        if len(data) < 20 or data[8:20] != tid:
            raise RuntimeError('STUN response mismatch')
        off = 20
        while off + 4 <= len(data):
            kind, size = struct.unpack('!HH', data[off:off + 4])
            val = data[off + 4:off + 4 + size]
            off += 4 + (size + 3) // 4 * 4
            if kind in (1, 32) and len(val) >= 8 and val[1] == 1:
                addr = val[4:8]
                if kind == 32:
                    addr = bytes(a ^ b for a, b in zip(addr, struct.pack('!I', 0x2112a442)))
                return {'ip': socket.inet_ntoa(addr)}
        raise RuntimeError('No IPv4 mapped address')
    finally:
        s.close()

def ipv6_probe(ip):
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    s.settimeout(4)
    try:
        s.connect((ip, 443))
        return {'target': ip, 'connected': True, 'local': s.getsockname()[0]}
    except OSError as e:
        return {'target': ip, 'connected': False, 'reason': str(e)}
    finally:
        s.close()

def run(command):
    return subprocess.run(command, capture_output=True, text=True, timeout=8).stdout

def local_state():
    conf, proxies = core('/configs'), core('/proxies')['proxies']
    selected = {n: {k: proxies.get(n, {}).get(k) for k in ('now', 'dialer-proxy', 'type')} for n in ('GLOBAL', '中转入口', '美国静态家宽')}
    return {'mode': conf.get('mode'), 'tun': conf.get('tun', {}).get('enable'), 'ipv6': conf.get('ipv6'), 'groups': selected}

def claude_connections():
    import re
    processes = run(['ps', '-axo', 'pid=,comm='])
    pids = [line.strip().split(None, 1)[0] for line in processes.splitlines()
            if len(line.strip().split(None, 1)) == 2
            and Path(line.strip().split(None, 1)[1]).name == 'claude']
    if not pids:
        return {'process_count': 0, 'matched': [], 'other_sockets': [], 'note': '未发现 Claude Code 进程，未验证'}
    lines = run(['/usr/sbin/lsof', '-nP', '-a', '-p', ','.join(pids), '-i'])
    connections = core('/connections').get('connections', [])
    byport = {}
    for x in connections:
        m = x.get('metadata', {})
        byport.setdefault(str(m.get('sourcePort')), []).append(x)
    matches, other = [], []
    for line in lines.splitlines():
        if '->' not in line and 'UDP' not in line:
            continue
        fields = line.split()
        local = re.search(r'(?:127\.0\.0\.1|\[::1\]):(\d+)->', line)
        # Only correlate loopback proxy sockets; other sockets remain unverified.
        if local and re.search(r'->(?:127\.0\.0\.1|\[::1\]):7897\b', line):
            candidates = byport.get(local[1], [])
            item = candidates[0] if len(candidates) == 1 else None
            matches.append({'pid': fields[1], 'port': local[1],
                            'host': item['metadata'].get('host') if item else None,
                            'chains': item.get('chains') if item else None})
        else:
            other.append(line)
    return {'process_count': len(pids), 'matched': matches, 'other_sockets': other,
            'note': '仅核对现有 socket 与 Clash 连接记录；空闲或无法匹配不算通过。未向 Claude Code 注入请求。'}


def ipv6_assessment(results):
    addresses = results.get('global_ipv6_addresses')
    probes = [results.get('ipv6_google', {}), results.get('ipv6_cloudflare', {})]
    if any(p.get('connected') is True for p in probes):
        return {'status': 'warn', 'text': '存在可用 IPv6 通路，需核实其出口；不能仅凭连接成功认定泄漏'}
    if not isinstance(addresses, list) or any(p.get('connected') is not False for p in probes):
        return {'status': 'warn', 'text': 'IPv6 检查未完整取得结果，未验证'}
    if addresses:
        return {'status': 'warn', 'text': '发现公网 IPv6 地址，但两次连接未成功，仍需核对'}
    return {'status': 'ok', 'text': '无公网 IPv6 地址，两个独立 IPv6 目标均连接失败；本轮未发现绕过通路'}

def native_checks():
    jobs = {'clash': local_state, 'https_tun': http_exit,
            'https_proxy': lambda: http_exit('http://127.0.0.1:7897'),
            'stun_google': lambda: stun('stun.l.google.com', 19302),
            'stun_cloudflare': lambda: stun('stun.cloudflare.com', 3478),
            'ipv6_cloudflare': lambda: ipv6_probe('2606:4700:4700::1111'),
            'ipv6_google': lambda: ipv6_probe('2001:4860:4860::8888'),
            'claude': claude_connections,
            'system_proxy': lambda: run(['/usr/sbin/scutil', '--proxy']),
            'network_state': lambda: run(['/usr/sbin/scutil', '--nwi']),
            'ipv6_routes': lambda: run(['/usr/sbin/netstat', '-rn', '-f', 'inet6'])}
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        tasks = {k: pool.submit(safe, fn) for k, fn in jobs.items()}
        results = {k: f.result() for k, f in tasks.items()}
    addresses = []
    interface_result = subprocess.run(['/sbin/ifconfig'], capture_output=True, text=True, timeout=8)
    for line in interface_result.stdout.splitlines():
        if line.strip().startswith('inet6 '):
            value = line.split()[1].split('%')[0]
            if ipaddress.ip_address(value).is_global:
                addresses.append(value)
    results['global_ipv6_addresses'] = addresses if interface_result.returncode == 0 else None
    results['ipv6_assessment'] = ipv6_assessment(results)
    return results

def main():
    os.umask(0o077)
    token = secrets.token_urlsafe(24)
    report = {'time': dt.datetime.now().astimezone().isoformat(), 'expected_ip': EXPECTED, 'native': None, 'browser': None}
    directory = BASE / 'reports'
    directory.mkdir(parents=True,exist_ok=True)
    output = directory / (dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3) + '.json')
    lock = threading.Lock()
    done = threading.Event()
    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def send(self, data, typ='application/json', status=200):
            self.send_response(status)
            self.send_header('Content-Type', typ + '; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            if self.path == '/' + token + '/':
                self.send((ASSETS / 'check.html').read_text().replace('__EXPECTED_IP__',EXPECTED).encode(), 'text/html')
            elif self.path == '/' + token + '/results':
                with lock:
                    self.send(json.dumps(report, ensure_ascii=False).encode())
            else:
                self.send(b'Not found', 'text/plain', 404)
        def do_POST(self):
            if self.path != '/' + token + '/browser':
                return self.send(b'Not found', 'text/plain', 404)
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 65536:
                    raise ValueError('invalid size')
                data = json.loads(self.rfile.read(size))
                with lock:
                    report['browser'] = data
                    save()
                done.set()
                self.send(b'{}')
            except (ValueError, json.JSONDecodeError):
                self.send(b'Bad request', 'text/plain', 400)
    class LocalServer(ThreadingHTTPServer):
        def server_bind(self):
            socketserver.TCPServer.server_bind(self)
            self.server_name = '127.0.0.1'
            self.server_port = self.server_address[1]
    server = LocalServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/{token}/'
    print('只读检查：不更改代理、不重启应用、不终止连接。', flush=True)
    print('浏览器检测页面：' + url, flush=True)
    print('报告：' + str(output), flush=True)
    save()
    if '--no-open' not in __import__('sys').argv:
        subprocess.run(['/usr/bin/open', url], check=False)
    with lock:
        pass
    result = native_checks()
    with lock:
        report['native'] = result
        save()
    print('系统检查完成，等待浏览器 WebRTC 测试（最长 180 秒）。', flush=True)
    done.wait(180)
    print('检查完成。浏览器未返回的项目会保留为“未验证”。报告：' + str(output), flush=True)
    # Give the page time to fetch the finished native report before closing localhost.
    time.sleep(10)
    server.shutdown()
    server.server_close()

if __name__ == '__main__':
    main()
