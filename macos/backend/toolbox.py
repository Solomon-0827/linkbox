#!/usr/bin/env python3
import datetime
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import urllib.parse

from runtime import BASE, CONFIG_DIR

SOCKET = f'/var/run/clash-verge-service/users/{os.getuid()}/verge-mihomo.sock'
PROFILES = CONFIG_DIR / 'profiles.yaml'
EXIT = '美国静态家宽'
ENTRY = '中转入口'

def api(method, path, payload=None):
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(6)
            self.sock.connect(SOCKET)
    conn = Connection('localhost')
    try:
        conn.request(method, path, json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None, {'Content-Type': 'application/json'})
        response = conn.getresponse()
        body = response.read()
        if response.status >= 300:
            raise RuntimeError(f'Clash API 返回 {response.status}: {body.decode(errors="replace")[:200]}')
        return json.loads(body) if body else None
    finally:
        conn.close()

def state():
    conf = api('GET', '/configs')
    p = api('GET', '/proxies')['proxies']
    return conf, p

def node_inventory(proxies):
    result={name:(value,value.get('provider-name') or None) for name,value in proxies.items()}
    providers=api('GET','/providers/proxies').get('providers',{})
    for provider,data in providers.items():
        for value in data.get('proxies',[]):
            result[value['name']]=(result.get(value['name'],(value,None))[0],provider)
    return result

def candidate_names(proxies):
    import runtime
    inventory=node_inventory(proxies)
    return [name for name in proxies.get(ENTRY,{}).get('all',[])
            if runtime.allowed(name,inventory.get(name,({},None))[1])]

def show():
    c, p = state()
    print(f'\n模式：{c.get("mode")}；TUN：{"开启" if c.get("tun", {}).get("enable") else "关闭"}')
    print('GLOBAL：' + str(p.get('GLOBAL', {}).get('now')))
    print('中转入口：' + str(p.get(ENTRY, {}).get('now')))
    print('美国出口的上游：' + str(p.get(EXIT, {}).get('dialer-proxy')))
    return c, p

def persist_selection(name):
    # Preserve unrelated fields. Abort if another writer changes the file during preparation.
    import yaml
    original = PROFILES.read_bytes()
    doc = yaml.safe_load(original)
    profile = next((x for x in doc.get('items', []) if x.get('uid') == doc.get('current')), None)
    if profile is None:
        raise RuntimeError('找不到当前订阅，未修改持久化设置')
    selected = profile.setdefault('selected', [])
    for group, choice in [(ENTRY, name), ('GLOBAL', EXIT)]:
        record = next((x for x in selected if x.get('name') == group), None)
        if record is None:
            selected.append({'name': group, 'now': choice})
        else:
            record['now'] = choice
    output = yaml.safe_dump(doc, allow_unicode=True, sort_keys=False).encode()
    backups = BASE / 'backups'
    backups.mkdir(exist_ok=True, mode=0o700)
    backup = backups / ('profiles-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.yaml')
    backup.write_bytes(original)
    backup.chmod(0o600)
    fd, temporary = tempfile.mkstemp(prefix='.toolbox-', dir=PROFILES.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(output)
        if PROFILES.read_bytes() != original:
            raise RuntimeError('Clash 同时更新了订阅文件，跳过持久化，避免覆盖')
        os.replace(temporary, PROFILES)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def switch():
    c, p = show()
    if c.get('mode') != 'global' or p.get('GLOBAL', {}).get('now') != EXIT or p.get(EXIT, {}).get('dialer-proxy') != ENTRY:
        print('\n当前链式配置与预期不符。为避免改变出口，本工具不会切换。请先在 Clash 恢复全局 → 美国静态家宽。')
        return
    nodes = p.get(ENTRY, {}).get('all', [])
    if not nodes:
        raise RuntimeError('中转入口没有可选节点')
    current = p[ENTRY].get('now')
    for i, name in enumerate(nodes, 1):
        provider = 'NekoCat' if name.startswith('[') else 'mmti'
        print(f'{i:2}. [{provider}] {name}' + ('  ← 当前' if name == current else ''))
    print(' 0. 返回（不切换）')
    raw = input('\n输入节点编号：').strip()
    if raw in ('', '0'):
        return
    if not raw.isdigit() or not 1 <= int(raw) <= len(nodes):
        print('编号无效，没有修改。')
        return
    target = nodes[int(raw) - 1]
    if target == current:
        print('已经是该节点，没有修改。')
        return
    print(f'\n将切换：{current} → {target}；出口保持 {EXIT}。')
    print('不会重启代理或主动关闭连接，但新建/重连请求会走新入口，正在工作的 Claude Code 仍可能受网络变化影响。')
    if input('确认切换请输入 y；其他输入取消：').strip().lower() != 'y':
        print('已取消。')
        return
    # Recheck immediately before the one live mutation.
    fresh_c, fresh_p = state()
    if fresh_c.get('mode') != 'global' or fresh_p['GLOBAL'].get('now') != EXIT or fresh_p[EXIT].get('dialer-proxy') != ENTRY or fresh_p[ENTRY].get('now') != current or target not in fresh_p[ENTRY].get('all', []):
        raise RuntimeError('选择期间代理状态发生变化，取消切换，请重新选择')
    api('PUT', '/proxies/' + urllib.parse.quote(ENTRY, safe=''), {'name': target})
    after_c, after_p = state()
    if after_p[ENTRY].get('now') != target or after_p['GLOBAL'].get('now') != EXIT or after_c.get('mode') != 'global':
        raise RuntimeError('切换后的状态与预期不符，请查看 Clash；本工具不会继续改动')
    print('\n已确认当前入口：' + target + '；全局出口：' + EXIT)
    try:
        persist_selection(target)
        print('已保存当前订阅的选择，下次加载时可恢复；原文件已备份。')
    except Exception as e:
        print('注意：实时切换成功，但持久化保存失败：' + str(e))
    print('节点可用性尚需测试。建议返回菜单选择 1 检查完整链路；失败时可重新选择旧入口。')

def main():
    os.umask(0o077)
    if '--status' in sys.argv:
        show()
        return
    while True:
        print('\n====== 代理工具箱 ======\n1. 检查出口 / WebRTC / IPv6 / Claude 连接（只读）\n2. 切换中转入口（保留美国出口）\n3. 查看当前代理状态（只读）\n4. 打开检查报告文件夹\n5. 打开使用说明\n0. 退出')
        try:
            choice = input('\n请选择：').strip()
            if choice == '0':
                return
            if choice == '1':
                subprocess.run([sys.executable, str(BASE / 'proxy-self-check/check.py')], check=False)
            elif choice == '2':
                switch()
            elif choice == '3':
                show()
            elif choice == '4':
                folder = BASE / 'proxy-self-check/reports'
                folder.mkdir(exist_ok=True)
                subprocess.run(['/usr/bin/open', str(folder)], check=False)
            elif choice == '5':
                subprocess.run(['/usr/bin/open', str(BASE / '使用说明.md')], check=False)
            else:
                print('请输入菜单编号。')
        except (EOFError, KeyboardInterrupt):
            print('\n已退出工具箱；没有停止 Claude 或 Clash。')
            return
        except Exception as e:
            print('\n操作未完成：' + str(e) + '\n请确认 Clash Verge 正在运行。未重启任何应用。')

if __name__ == '__main__':
    main()
