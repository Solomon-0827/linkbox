"""Pure decisions for entrance and chain benchmarks and automatic switching."""
from statistics import median


PARAMETERS = {
    'chain_modes': ('global',),
    'metrics': ('chain', 'entrance'),
    'default_metric': 'chain',
    'interval_default_minutes': 60,
    'interval_range_minutes': (1, 1440),
    'concurrency_default': 5,
    'concurrency_range': (1, 10),
    'entrance_timeout_seconds': 3,
    'entrance_deadline_seconds': 4,
    'entrance_poll_seconds': .05,
    'entrance_wait_seconds': .2,
    'chain_connect_seconds': 8,
    'chain_timeout_seconds': 12,
    'chain_deadline_seconds': 14,
    'chain_poll_seconds': .1,
    'chain_wait_seconds': .3,
    'chain_probes': 3,
    'chain_min_successes': 2,
    'probe_pause_seconds': .25,
    'interface_timeout_seconds': 5,
    'startup_attempts': 40,
    'startup_poll_seconds': .1,
    'listener_timeout_seconds': 3,
    'child_stop_seconds': 2,
    'improvement_ms': 20,
    'improvement_fraction': .10,
}


def chain_allowed(state, expected_exit, expected_dialer):
    return (state['mode'] in PARAMETERS['chain_modes'] and
            state['exit'] == expected_exit and state['dialer'] == expected_dialer)


def stop_reason(cancelled, unchanged):
    if cancelled:
        return '已停止，保留已完成结果'
    if not unchanged:
        return '检测到网络或当前链路变化，已停止；没有恢复或改动用户配置'
    return ''


def run_complete(reason, unchanged):
    return not reason and unchanged


def entrance_delay_accepted(delay):
    return isinstance(delay, (int, float)) and not delay <= 0


def stop_after_probe_failure(samples):
    return not samples


def sample_delay(samples, minimum=PARAMETERS['chain_min_successes']):
    if len(samples) < minimum:
        return None
    return round(median(sample['ms'] for sample in samples))


def _positive_delay(row, key):
    value = row.get(key)
    return value if type(value) is int and value > 0 else None


def auto_candidate(results, current, metric):
    if metric not in PARAMETERS['metrics'] or current not in results:
        return None
    key = 'delay' if metric == 'entrance' else 'chain_delay'
    choices = [(_positive_delay(row, key), name) for name, row in results.items()
               if name != current and _positive_delay(row, 'chain_delay') and _positive_delay(row, key)]
    if not choices:
        return None
    fastest, name = min(choices)
    baseline = _positive_delay(results[current], key)
    if not _positive_delay(results[current], 'chain_delay'):
        return name
    if baseline and baseline - fastest >= max(PARAMETERS['improvement_ms'], baseline * PARAMETERS['improvement_fraction']):
        return name
    return None


def recommendation(record, metric):
    if metric in PARAMETERS['metrics'] and run_complete(record['reason'], record['selection_unchanged']):
        return auto_candidate(record['results'], record['before']['entry'], metric)
    return None


def switch_allowed(routing_unchanged, *, cancelled=False):
    return routing_unchanged and not cancelled


def target_available(current, previous, target, owners):
    return current == previous and target in owners


def target_owner_matches(owners, target, owner):
    return target in owners and owners[target] == owner
