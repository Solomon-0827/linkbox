"""LinkBox's operations on the local Clash controller and Verge files."""
import datetime
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from urllib.parse import quote, urlencode

import yaml

ENTRY = '中转入口'
EXIT = '美国静态家宽'
CORE = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'
CONFIG_DIR = Path(os.environ.get('LINKBOX_CONFIG_DIR', Path.home() /
                                 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev'))
_SOCKET = f'/var/run/clash-verge-service/users/{os.getuid()}/verge-mihomo.sock'
_ENTRY_ROUTE = '/proxies/' + quote(ENTRY, safe='')
_VALIDATION_FAILED = '配置校验失败，未改动当前代理'
_RELOAD_NOT_SENT = '无法连接 Clash 控制接口，未发送重载请求'
_RELOAD_UNCERTAIN = '已写入新配置，Clash 未确认，请刷新状态核对'


class ClashHTTPError(RuntimeError):
    def __init__(self, status, *, expected_status=None):
        super().__init__(f'Clash API HTTP {status}' if expected_status == 200 else f'Clash API 返回 {status}')
        self.rejected = 400 <= status < 600


class ClashRequestNotSent(OSError):
    pass


def _request(method, path, payload=None, *, timeout=6, expected_status=None):
    class Connection(http.client.HTTPConnection):
        def connect(self):
            try:
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(timeout)
                self.sock.connect(_SOCKET)
            except OSError as error:
                if expected_status == 200:
                    raise
                raise ClashRequestNotSent('无法连接 Clash 控制接口') from error

    conn = Connection('localhost')
    try:
        conn.request(method, path, json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
                     {'Content-Type': 'application/json'})
        response = conn.getresponse()
        if not 200 <= response.status < 300 or expected_status not in (None, response.status):
            raise ClashHTTPError(response.status, expected_status=expected_status)
        body = response.read()
        return json.loads(body) if body or expected_status == 200 else None
    finally:
        conn.close()


def state(*, timeout=6, expected_status=None):
    config = _request('GET', '/configs', timeout=timeout, expected_status=expected_status)
    proxies = _request('GET', '/proxies', timeout=timeout, expected_status=expected_status)['proxies']
    return config, proxies


def providers():
    return _request('GET', '/providers/proxies')


def connections(*, timeout=6, expected_status=None):
    return _request('GET', '/connections', timeout=timeout, expected_status=expected_status)


def entry_delay(name, provider):
    route = ('/providers/proxies/' + quote(provider, safe='') + '/' + quote(name, safe='') + '/healthcheck'
             if provider else '/proxies/' + quote(name, safe='') + '/delay')
    query = urlencode({'url': 'https://www.gstatic.com/generate_204', 'timeout': 3000, 'expected': '204'})
    return _request('GET', route + '?' + query).get('delay')


def switch_entry(name):
    _request('PUT', _ENTRY_ROUTE, {'name': name})


def reload(payload, prepare, rollback):
    try:
        with tempfile.TemporaryDirectory(prefix='linkbox-update-', dir=CONFIG_DIR) as folder:
            file = Path(folder) / 'config.yaml'
            file.write_bytes(payload)
            subprocess.run([CORE, '-t', '-d', str(CONFIG_DIR), '-f', str(file)],
                           capture_output=True, timeout=30, check=True)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError(_VALIDATION_FAILED) from None

    # Recheck the snapshots and install the files only after validation succeeds.
    prepare()
    try:
        _request('PUT', '/configs?force=false', {'payload': payload.decode()})
    except Exception as error:
        unsent = isinstance(error, ClashRequestNotSent)
        if unsent or (isinstance(error, ClashHTTPError) and error.rejected):
            rollback()
            message = _RELOAD_NOT_SENT if unsent else str(error)
            raise RuntimeError(message + '，文件已回退；请刷新状态后重试') from None
        message = f'{error}。{_RELOAD_UNCERTAIN}' if isinstance(error, ClashHTTPError) else _RELOAD_UNCERTAIN
        raise RuntimeError(message) from None


def config_file():
    return CONFIG_DIR / 'clash-verge.yaml'


def profiles_file():
    return CONFIG_DIR / 'profiles.yaml'


def script_file():
    return profile_file('Script.js')


def profile_file(filename):
    if not isinstance(filename, str) or not filename or Path(filename).name != filename or filename in {'.', '..'} or '\\' in filename:
        raise ValueError('Clash Verge 订阅路径无效，未删除节点')
    return CONFIG_DIR / 'profiles' / filename


def managed_cache_file(owner):
    return CONFIG_DIR / 'providers/linkbox' / (owner + '.yaml')


def provider_file(path):
    return CONFIG_DIR / path


def read_file(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def read_config(*, text=True):
    path = config_file()
    return yaml.safe_load(path.read_text() if text else path.read_bytes())


def write_file(path, data, *, expected=None, conflict=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.linkbox-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
        if conflict is not None and read_file(path) != expected:
            raise RuntimeError(conflict)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def restore_files(written, originals):
    for path in reversed(written):
        if originals[path] is None:
            path.unlink(missing_ok=True)
        else:
            write_file(path, originals[path])


def update_selector(index, name, *, include_exit=False):
    current = index.get('current')
    profile = next((item for item in index.get('items', [])
                    if (include_exit or current) and item.get('uid') == current), None)
    if profile is None:
        if include_exit:
            raise RuntimeError('找不到当前订阅，未修改持久化设置')
        return False
    choices = profile.setdefault('selected', [])
    changed = False
    for group, target in ((ENTRY, name), ('GLOBAL', EXIT)) if include_exit else ((ENTRY, name),):
        choice = next((item for item in choices if item.get('name') == group), None)
        if choice is None:
            choices.append({'name': group, 'now': target})
            changed = True
        elif choice.get('now') != target:
            choice['now'] = target
            changed = True
    return changed


def persist_selection(name, *, backup_dir=None):
    path = profiles_file()
    original = path.read_bytes()
    index = yaml.safe_load(original)
    if not update_selector(index, name, include_exit=backup_dir is not None) and backup_dir is None:
        return
    output = yaml.safe_dump(index, allow_unicode=True, sort_keys=False).encode()
    if backup_dir is not None:
        backup_dir.mkdir(exist_ok=True, mode=0o700)
        backup = backup_dir / ('profiles-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.yaml')
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
            file.write(original)
    write_file(path, output, expected=original,
               conflict='Clash 同时更新了订阅文件，跳过持久化，避免覆盖' if backup_dir is not None
               else '配置或节点已被其他操作改变，已取消更新')
