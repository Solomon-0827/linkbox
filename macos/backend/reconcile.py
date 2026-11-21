"""Plan changes to the selection from a picker-ordered subscription inventory."""


def reconcile(sources, selection, live, current, metric='chain', results=None, *, seed_owners=None):
    """Return the surviving selection, ordered candidates, and desired entry."""
    seed = selection is None
    live = set(live) if seed else set()
    selection = selection or {}
    results = results or {}
    seed_owners = seed_owners or {}
    selected = {}
    candidates = []
    owners = {}
    occurrences = {}
    reserved = {name: source['id'] for source in sources if source.get('unreadable')
                for name in selection.get(source['id'], [])}
    for source in sources:
        owner = source['id']
        requested = ({name for name in live if seed_owners.get(name, owner) == owner}
                     if seed else set(selection.get(owner, [])))
        unreadable = source.get('unreadable')
        if unreadable and owner in selection:
            selected[owner] = selection[owner]
        for name in selection.get(owner, []) if unreadable else source['nodes']:
            occurrences[name] = occurrences.get(name, 0) + 1
            if name in requested and name not in owners and reserved.get(name, owner) == owner:
                if not unreadable:
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
            if measured_owner != owner and not (measured_owner is None and occurrences[name] == 1 and name not in reserved):
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
