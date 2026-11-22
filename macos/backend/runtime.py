"""Local settings only. No subscriptions, credentials or user IPs ship with the app."""
import json
import os
from pathlib import Path
import yaml
import settings

BASE = Path(os.environ.get('LINKBOX_DATA_DIR', Path.home()/'Library/Application Support/ProxyToolbox'))
BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
CONFIG_DIR = Path(os.environ.get('LINKBOX_CONFIG_DIR', Path.home()/'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev'))
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
            if config is None:config=yaml.safe_load((CONFIG_DIR/'clash-verge.yaml').read_text())
            value=next(n.get('server','') for n in config.get('proxies',[]) if n.get('name')=='美国静态家宽')
        except (OSError,ValueError,StopIteration,AttributeError):return ''
    return settings.expected_ip(value)

def ssl_context():
    import ssl,certifi
    return ssl.create_default_context(cafile=certifi.where())

def provider_label(provider):
    return read_json('node-policy.json').get('provider_labels',{}).get(provider,provider)
