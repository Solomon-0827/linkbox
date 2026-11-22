"""Normalize local preferences independently of their storage."""
from benchmark_policy import PARAMETERS


def bounded(low, high):
    return lambda value: type(value) in (int, float) and low <= value <= high and int(value) == value


BENCHMARK_FIELDS = {
    'hourly': (True, lambda value: type(value) is bool, '无效动态测速设置'),
    'interval': (PARAMETERS['interval_default_minutes'], bounded(*PARAMETERS['interval_range_minutes']), '测速间隔须为 1–1440 分钟。'),
    'concurrency': (PARAMETERS['concurrency_default'], bounded(*PARAMETERS['concurrency_range']), '并发测速量须为 1–10 条。'),
    'autoRelay': (False, lambda value: type(value) is bool, '无效动态测速设置'),
    'metric': (PARAMETERS['default_metric'], lambda value: value in PARAMETERS['metrics'], '无效动态测速设置'),
}


class SettingsError(ValueError):
    def __init__(self, field, message):
        super().__init__(message)
        self.field = field


def benchmark_value(field, value, *, strict=False):
    default, test, message = BENCHMARK_FIELDS[field]
    if test(value):
        return int(value) if type(default) is int else value
    if strict:
        raise SettingsError(field, message)
    return default


def benchmark_settings(values, *, strict=False):
    if not isinstance(values, dict):
        values = {}
    return {field: benchmark_value(field, values.get(field), strict=strict and (field != 'hourly' or field in values))
            for field in BENCHMARK_FIELDS}
