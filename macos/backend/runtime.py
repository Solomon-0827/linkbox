"""Local settings only. No subscriptions, credentials or user IPs ship with the app."""
from ipaddress import ip_address
import json
import os
from pathlib import Path
import clash
import settings

BASE = Path(os.environ.get('LINKBOX_DATA_DIR', Path.home()/'Library/Application Support/ProxyToolbox'))
BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
CONCURRENCY = settings.benchmark_value('concurrency', None)

def read_json(name):
    try:
        value=json.loads((BASE/name).read_text())
        return value if isinstance(value,dict) else {}
    except (OSError,ValueError):return {}

def expected_ip(config=None):
    value=read_json('settings.json').get('expected_ip','')
    if not value:
        try:
            if config is None:config=clash.read_yaml(clash.config_file(clash.CONFIG_DIR))
            value=next(n.get('server','') for n in config.get('proxies',[]) if n.get('name')==clash.EXIT)
        except (OSError,ValueError,StopIteration,AttributeError):return ''
    try:return str(ip_address(value))
    except (ValueError, TypeError):return ''

def same_ip(left, right):
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    try:
        return ip_address(left) == ip_address(right)
    except ValueError:
        return False

def ssl_context():
    import ssl,certifi
    return ssl.create_default_context(cafile=certifi.where())

def provider_label(provider):
    return read_json('node-policy.json').get('provider_labels',{}).get(provider,provider)
