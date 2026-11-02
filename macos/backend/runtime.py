"""Local settings only. No subscriptions, credentials or user IPs ship with the app."""
import json
import os
import ipaddress
from pathlib import Path
import yaml

BASE = Path(os.environ.get('LINKBOX_DATA_DIR', Path.home()/'Library/Application Support/ProxyToolbox'))
BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
CONFIG_DIR = Path(os.environ.get('LINKBOX_CONFIG_DIR', Path.home()/'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev'))
CONCURRENCY = 5

def read_json(name):
    try:
        value=json.loads((BASE/name).read_text())
        return value if isinstance(value,dict) else {}
    except (OSError,ValueError):return {}

def expected_ip():
    settings=read_json('settings.json')
    value=settings.get('expected_ip','')
    if not value:
        try:
            config=yaml.safe_load((CONFIG_DIR/'clash-verge.yaml').read_text())
            value=next(n.get('server','') for n in config.get('proxies',[]) if n.get('name')=='美国静态家宽')
        except (OSError,ValueError,StopIteration,AttributeError):return ''
    try:return str(ipaddress.ip_address(value))
    except ValueError:return ''

def provider_for(name, fallback='本地节点'):
    mapping=read_json('node-policy.json').get('node_providers',{})
    return mapping.get(name,fallback) if isinstance(mapping,dict) else fallback

def allowed(name, provider=None):
    policy=read_json('node-policy.json')
    provider=provider_for(name,provider or '本地节点')
    if 'selected_nodes' in policy:
        if name==policy.get('pinned_entry'):return True
        return name in policy['selected_nodes'].get(provider,[])
    if provider.lower() in [str(p).lower() for p in policy.get('blocked_providers',[])]:return False
    excluded=policy.get('excluded_nodes',{})
    return name not in excluded.get(provider,[]) and name not in excluded.get('*',[])

def ssl_context():
    import ssl,certifi
    return ssl.create_default_context(cafile=certifi.where())

def provider_label(provider):
    return read_json('node-policy.json').get('provider_labels',{}).get(provider,provider)
