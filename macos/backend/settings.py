"""Normalize local preferences independently of their storage."""
def bounded(low, high):
    return lambda value: type(value) in (int, float) and low <= value <= high and int(value) == value


BENCHMARK_FIELDS = {
    'hourly': (True, lambda value: type(value) is bool, '无效动态测速设置'),
    'interval': (60, bounded(1, 1440), '测速间隔须为 1–1440 分钟。'),
    'concurrency': (5, bounded(1, 10), '并发测速量须为 1–10 条。'),
    'autoRelay': (False, lambda value: type(value) is bool, '无效动态测速设置'),
    'metric': ('chain', lambda value: value in ('chain', 'entrance'), '无效动态测速设置'),
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
