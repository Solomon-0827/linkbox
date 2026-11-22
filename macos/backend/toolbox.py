#!/usr/bin/env python3
from contextlib import contextmanager
import fcntl
import os
import subprocess
import sys

import clash
from clash import ENTRY, EXIT, state
from runtime import BASE
from reconcile import selection_owners


def relay_state(**request_options):
    config, proxies = state(**request_options)
    group = proxies.get(ENTRY, {})
    return {'mode': config.get('mode'), 'tun': bool(config.get('tun', {}).get('enable')),
            'entry': group.get('now'), 'exit': proxies.get('GLOBAL', {}).get('now'),
            'dialer': proxies.get(EXIT, {}).get('dialer-proxy'), 'live': sorted(set(group.get('all', [])))}


@contextmanager
def switch_lock():
    with open(BASE / 'latency.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有测速或订阅更新正在运行') from None
        yield


def relay_owners(selection, live):
    if selection is not None:
        return selection_owners(selection)

    from subscription_update import entry_plan

    try:
        config = clash.read_config()
    except (OSError, ValueError):
        config = None
    if not isinstance(config, dict):
        config = {}
    plan = entry_plan(config) or {}
    return {name: plan.get(name, (None, None))[0] for name in live}


def switch_owners(live):
    import runtime
    owners = relay_owners(runtime.read_json('node-policy.json').get('selected_nodes'), live)
    return {name: owner for name, owner in owners.items() if name in live}


def provider_nodes(response):
    providers = response.get('providers') if isinstance(response, dict) else None
    if not isinstance(providers, dict):
        return {}
    return {owner: [node for node in provider['proxies']
                    if isinstance(node, dict) and isinstance(node.get('name'), str) and node['name']]
            for owner, provider in providers.items()
            if isinstance(provider, dict) and isinstance(provider.get('proxies'), list)}


def node_inventory(proxies, owners):
    result = {name: (value, value.get('provider-name')) for name, value in proxies.items()
              if name not in owners or owners[name] is None}
    try:
        providers = provider_nodes(clash.providers())
    except RuntimeError:
        providers = {}
    for provider, data in providers.items():
        for value in data:
            name = value['name']
            if name not in owners or owners[name] == provider:
                result.setdefault(name, (value, provider))
    return result


def show():
    c, p = state()
    print(f'\n模式：{c.get("mode")}；TUN：{"开启" if c.get("tun", {}).get("enable") else "关闭"}')
    print('GLOBAL：' + str(p.get('GLOBAL', {}).get('now')))
    print('中转入口：' + str(p.get(ENTRY, {}).get('now')))
    print('美国出口的上游：' + str(p.get(EXIT, {}).get('dialer-proxy')))
    return c, p

def switch():
    c, p = show()
    if c.get('mode') != 'global' or p.get('GLOBAL', {}).get('now') != EXIT or p.get(EXIT, {}).get('dialer-proxy') != ENTRY:
        print('\n当前链式配置与预期不符。为避免改变出口，本工具不会切换。请先在 Clash 恢复全局 → 美国静态家宽。')
        return
    live = p.get(ENTRY, {}).get('all', [])
    owners = switch_owners(live)
    nodes = list(owners)
    if not nodes:
        raise RuntimeError('中转入口没有可选节点')
    current = p[ENTRY].get('now')
    for i, name in enumerate(nodes, 1):
        provider = owners[name]
        print(f'{i:2}. ' + (f'[{provider}] ' if provider else '') + name + ('  ← 当前' if name == current else ''))
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
    with switch_lock():
        switch_entry(current, target)


def switch_entry(current, target):
    # Recheck immediately before the one live mutation.
    fresh_c, fresh_p = state()
    if fresh_c.get('mode') != 'global' or fresh_p['GLOBAL'].get('now') != EXIT or fresh_p[EXIT].get('dialer-proxy') != ENTRY or fresh_p[ENTRY].get('now') != current:
        raise RuntimeError('选择期间代理状态发生变化，取消切换，请重新选择')
    owners = switch_owners(fresh_p[ENTRY].get('all', []))
    if target not in owners:
        raise RuntimeError('选择期间代理状态发生变化，取消切换，请重新选择')
    clash.switch_entry(target)
    after_c, after_p = state()
    after_owners = switch_owners(after_p[ENTRY].get('all', []))
    if (after_p[ENTRY].get('now') != target or after_p['GLOBAL'].get('now') != EXIT
            or after_p[EXIT].get('dialer-proxy') != ENTRY or after_c.get('mode') != 'global'
            or target not in after_owners or after_owners[target] != owners[target]):
        raise RuntimeError('切换后的状态与预期不符，请查看 Clash；本工具不会继续改动')
    print('\n已确认当前入口：' + target + '；全局出口：' + EXIT)
    try:
        clash.persist_selection(target, backup_dir=BASE / 'backups')
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
