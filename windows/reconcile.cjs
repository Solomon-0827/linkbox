'use strict';

function reconcile({sources, selection, live, current, metric = 'chain', results = {}, seedOwners = new Map()}) {
 const seed = selection == null;
 const liveNames = new Set(seed ? live : []);
 const selected = new Map(), candidates = [], owners = new Map(), occurrences = new Map();
 const saved = owner => selection && Object.hasOwn(selection, owner) ? selection[owner] : [];
 const reserved = new Map(sources.filter(source => source.unreadable)
  .flatMap(({id}) => saved(id).map(name => [name, id])));
 for (const {id: owner, nodes, unreadable} of sources) {
  const requested = seed ? liveNames : new Set(saved(owner));
  if (unreadable && selection && Object.hasOwn(selection, owner)) selected.set(owner, saved(owner));
  for (const name of unreadable ? saved(owner) : nodes) {
   occurrences.set(name, (occurrences.get(name) || 0) + 1);
   if (requested.has(name) && !owners.has(name) && (reserved.get(name) ?? owner) === owner &&
       (!seed || !seedOwners.has(name) || seedOwners.get(name) === owner)) {
    if (!unreadable) {
     if (!selected.has(owner)) selected.set(owner, []);
     selected.get(owner).push(name);
    }
    candidates.push({name, owner});
    owners.set(name, owner);
   }
  }
 }

 let entry = owners.has(current) ? current : null;
 if (entry === null && candidates.length) {
  // Older measurements carry no owner. Only use them for unambiguous names.
  let best = Infinity;
  entry = candidates[0].name;
  for (const [name, owner] of owners) {
   const row = Object.hasOwn(results, name) ? results[name] : {};
   if (row.owner !== owner && !(row.owner == null && occurrences.get(name) === 1 && !reserved.has(name))) continue;
   const delay = row[metric === 'entrance' ? 'entrance' : 'chain'];
   if (typeof delay === 'number' && delay > 0 && delay < best) {
    best = delay;
    entry = name;
   }
  }
 }
 return {selection: Object.fromEntries(selected), candidates, entry};
}

function selectionOwners(selection) {
 const owners = new Map();
 for (const [owner, names] of Object.entries(selection || {})) {
  for (const name of names) if (!owners.has(name)) owners.set(name, owner);
 }
 return owners;
}

function sameEntryMembers(live, planned) {
 const names = new Set(live), expected = new Set(planned);
 return names.size === expected.size && [...expected].every(name => names.has(name));
}

module.exports = {reconcile, selectionOwners, sameEntryMembers};
