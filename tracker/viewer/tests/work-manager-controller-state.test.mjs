import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { parseWorkSearch } from '../src/routing-state.ts';
import {
  clearManagerPreset,
  createWorkManagerRouteState,
  enterManagerPreset,
  hasManagerAdvancedRefinements,
  workManagerExpansionFingerprint,
} from '../src/work-manager-controller-state.ts';

const options = {
  projectIds: new Set(['project-alpha', 'milestone-stream']),
  ownerValues: new Set(['don', '__unassigned__']),
  statusValues: new Set(['active', 'queued']),
  managerPersonValues: new Set(['don', 'juan', '__unassigned__']),
};

test('entering a preset saves advanced filters once, preserves navigation, and clear restores them', () => {
  const original = parseWorkSearch({
    scope: 'milestone-stream', mode: 'tree', date: '2026-10-21', item: 'task-7',
    activity: 'quiet', completed: true, planned: false, drafts: false,
    q: 'invoice', owners: ['don'], statuses: ['queued'], from: '2026-10-01', to: '2026-10-20', undated: 'exclude',
    people: ['juan'],
  }, options);
  const first = enterManagerPreset(createWorkManagerRouteState(), original, 'team', options);

  assert.deepEqual({
    scope: first.search.scope, mode: first.search.mode, date: first.search.date, item: first.search.item,
    preset: first.search.preset, people: first.search.people, activity: first.search.activity,
    completed: first.search.completed, planned: first.search.planned, drafts: first.search.drafts,
    q: first.search.q, owners: first.search.owners, statuses: first.search.statuses,
    from: first.search.from, to: first.search.to, undated: first.search.undated,
  }, {
    scope: 'milestone-stream', mode: 'tree', date: '2026-10-21', item: 'task-7',
    preset: 'team', people: ['juan'], activity: 'all', completed: false, planned: true, drafts: true,
    q: '', owners: [], statuses: [], from: undefined, to: undefined, undated: 'include',
  });

  const nextPreset = enterManagerPreset(first.state, { ...first.search, scope: 'project-alpha', mode: 'gantt', date: '2026-10-22' }, 'delivery', options);
  const restored = clearManagerPreset(nextPreset.state, nextPreset.search, options).search;
  assert.deepEqual({
    scope: restored.scope, mode: restored.mode, date: restored.date, item: restored.item,
    preset: restored.preset, people: restored.people, activity: restored.activity,
    completed: restored.completed, planned: restored.planned, drafts: restored.drafts,
    q: restored.q, owners: restored.owners, statuses: restored.statuses,
    from: restored.from, to: restored.to, undated: restored.undated,
  }, {
    scope: 'project-alpha', mode: 'gantt', date: '2026-10-22', item: 'task-7',
    preset: 'none', people: ['juan'], activity: 'quiet', completed: true, planned: false, drafts: false,
    q: 'invoice', owners: ['don'], statuses: ['queued'], from: '2026-10-01', to: '2026-10-20', undated: 'exclude',
  });
});

test('direct manager URLs preserve encoded refinements and clear to standard Work defaults', () => {
  const direct = parseWorkSearch({
    scope: 'milestone-stream', mode: 'gantt', preset: 'moving', people: ['don'], date: '2026-10-14', item: 'task-3',
    q: 'invoice', owners: ['don'], statuses: ['active'], from: '2026-10-01', activity: 'quiet', completed: true, drafts: false,
  }, options);
  assert.deepEqual({
    preset: direct.preset, people: direct.people, activity: direct.activity,
    completed: direct.completed, planned: direct.planned, drafts: direct.drafts,
    q: direct.q, owners: direct.owners, statuses: direct.statuses, from: direct.from,
  }, {
    preset: 'moving', people: ['don'], activity: 'quiet', completed: true, planned: true, drafts: false,
    q: 'invoice', owners: ['don'], statuses: ['active'], from: '2026-10-01',
  });

  const cleared = clearManagerPreset(createWorkManagerRouteState(), direct, options).search;
  assert.deepEqual({
    preset: cleared.preset, people: cleared.people, activity: cleared.activity,
    completed: cleared.completed, planned: cleared.planned, drafts: cleared.drafts,
    q: cleared.q, owners: cleared.owners, statuses: cleared.statuses,
    from: cleared.from, to: cleared.to, undated: cleared.undated,
  }, {
    preset: 'none', people: [], activity: 'all', completed: false, planned: true, drafts: false,
    q: '', owners: [], statuses: [], from: undefined, to: undefined, undated: 'include',
  });
  assert.equal(cleared.scope, 'milestone-stream');
  assert.equal(cleared.mode, 'gantt');
  assert.equal(cleared.date, '2026-10-14');
});

test('manager expansion fingerprints use the shared matching state but ignore view and navigation mode', () => {
  const base = parseWorkSearch({ preset: 'team', people: ['don'], q: 'invoice', activity: 'all' }, options);
  const sameView = { ...base, mode: 'gantt', date: '2026-10-14' };
  assert.equal(workManagerExpansionFingerprint(base), workManagerExpansionFingerprint(sameView));
  assert.notEqual(workManagerExpansionFingerprint(base), workManagerExpansionFingerprint({ ...base, people: ['juan'] }));
  assert.notEqual(workManagerExpansionFingerprint(base), workManagerExpansionFingerprint({ ...base, q: 'risk' }));
  assert.notEqual(workManagerExpansionFingerprint(base), workManagerExpansionFingerprint({ ...base, preset: 'delivery' }));
  const peopleOnly = parseWorkSearch({ people: ['juan'] }, options);
  assert.notEqual(workManagerExpansionFingerprint(peopleOnly), '');
  assert.notEqual(workManagerExpansionFingerprint(peopleOnly), workManagerExpansionFingerprint(parseWorkSearch({ people: ['don'] }, options)));
  assert.equal(workManagerExpansionFingerprint(parseWorkSearch({}, options)), '');
});

test('modified preset state reflects only advanced refinements', () => {
  const team = parseWorkSearch({ preset: 'team', drafts: true, activity: 'all' }, options);
  assert.equal(hasManagerAdvancedRefinements(team), false);
  assert.equal(hasManagerAdvancedRefinements({ ...team, q: 'invoice' }), true);
  assert.equal(hasManagerAdvancedRefinements({ ...team, people: ['don'] }), false);
  assert.equal(hasManagerAdvancedRefinements(parseWorkSearch({ preset: 'moving', activity: 'recent', drafts: true }, options)), false);
  assert.equal(hasManagerAdvancedRefinements(parseWorkSearch({ preset: 'moving', activity: 'quiet', drafts: true }, options)), true);
});
