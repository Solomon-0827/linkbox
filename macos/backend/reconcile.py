"""Plan changes to the selection from a picker-ordered subscription inventory."""


def reconcile(sources, selection, live, current, metric='chain', results=None):
    """Return the surviving selection, ordered candidates, and desired entry."""
    seed = selection is None
    live = set(live) if seed else set()
    selection = selection or {}
    results = results or {}
    selected = {}
    candidates = []
    owners = {}
    occurrences = {}
    for source in sources:
        owner = source['id']
        requested = live if seed else set(selection.get(owner, []))
        for name in source['nodes']:
            occurrences[name] = occurrences.get(name, 0) + 1
            if name in requested and name not in owners:
                selected.setdefault(owner, []).append(name)
                candidates.append({'name': name, 'owner': owner})
                owners[name] = owner

    entry = current if current in owners else None
    if entry is None and candidates:
        # Older measurements carry no owner. Only use them for unambiguous names.
        best = float('inf')
        entry = candidates[0]['name']
        for name, owner in owners.items():
            row = results.get(name, {})
            measured_owner = row.get('owner')
            if measured_owner != owner and not (measured_owner is None and occurrences[name] == 1):
                continue
            delay = row.get('entrance' if metric == 'entrance' else 'chain')
            if type(delay) in (int, float) and 0 < delay < best:
                best, entry = delay, name
    return {'selection': selected, 'candidates': candidates, 'entry': entry}


def selection_owners(selection):
    owners = {}
    for owner, names in (selection or {}).items():
        for name in names:
            owners.setdefault(name, owner)
    return owners
