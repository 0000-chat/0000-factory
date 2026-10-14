import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { projectFilterOptions } from '../src/route-data';
import { normalizeTrackerSnapshot } from '../src/snapshot';
import { parseWorkSearch } from '../src/routing-state';
import { projectFilteredWork, workFilterOptions } from '../src/work-filters';

function workItem(id: string, parent: string | null = null, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    type: 'task',
    parent,
    childIds: [],
    dependsOn: [],
    commitment: 'accepted',
    status: 'active',
    completed: false,
    owner: 'don',
    ownerName: 'Don Masakayan',
    schedule: {},
    ...extra,
  };
}

function snapshot(items: ReturnType<typeof workItem>[]) {
  return normalizeTrackerSnapshot({ items, team: [], plans: [], decisions: [], releases: [] });
}

test('matches all query tokens across fields and restores only needed graph context', () => {
  const data = snapshot([
    workItem('project', null, { type: 'project', childIds: ['planned-parent', 'planned-dependency', 'done-dependency', 'unrelated'] }),
    workItem('planned-parent', 'project', { commitment: 'planned', childIds: ['invoice-task'] }),
    workItem('invoice-task-10', 'planned-parent', {
      title: 'Invoice reconciliation',
      dependsOn: ['planned-dependency', 'done-dependency', 'outside-dependency'],
      schedule: { plannedStart: '2026-10-01', plannedEnd: '2026-10-05', approved: true },
    }),
    workItem('planned-dependency', 'project', { commitment: 'planned' }),
    workItem('done-dependency', 'project', { completed: true, status: 'done' }),
    workItem('unrelated', 'project', { title: 'Another task' }),
    workItem('outside-project', null, { type: 'project', childIds: ['outside-dependency'] }),
    workItem('outside-dependency', 'outside-project'),
  ]);
  const search = parseWorkSearch({
    scope: 'project',
    planned: false,
    drafts: false,
    q: 'INVOICE don 10',
    from: '2026-10-03',
    to: '2026-10-03',
  }, projectFilterOptions(data));

  const result = projectFilteredWork(data, search);

  assert.equal(result.matchCount, 1);
  assert.deepEqual(result.items.map(item => item.id), [
    'project',
    'planned-parent',
    'invoice-task-10',
    'planned-dependency',
    'done-dependency',
  ]);
  assert.deepEqual([...result.contextualIds].sort(), [
    'done-dependency',
    'planned-dependency',
    'planned-parent',
    'project',
  ]);
  assert.deepEqual(result.roots.map(item => item.id), ['project']);
  assert.deepEqual(result.externalItems.map(item => item.id), ['outside-dependency']);
  assert.equal(result.visibleIds.has('outside-dependency'), false);
  assert.deepEqual(result.items[0]?.childSummary, data.itemById.get('project')?.childSummary);
});

test('matches Work search by short reference code', () => {
  const data = snapshot([workItem('fixture-reference-target', null, { referenceCode: 'T-9WAB7B' })]);
  const result = projectFilteredWork(data, parseWorkSearch({ q: 't-9wab7b' }, projectFilterOptions(data)));
  assert.equal(result.matchCount, 1);
  assert.deepEqual(result.items.map(item => item.id), ['fixture-reference-target']);
});

test('date ranges overlap separate baseline and forecast features and preserve undated work', () => {
  const data = snapshot([
    workItem('baseline-overlap', null, {
      schedule: { plannedStart: '2026-10-01', plannedEnd: '2026-10-05', approved: true },
    }),
    workItem('forecast-overlap', null, {
      schedule: {
        plannedStart: '2026-10-20',
        plannedEnd: '2026-10-22',
        approved: true,
        forecastStart: '2026-10-02',
        forecastEndMax: '2026-10-04',
      },
    }),
    workItem('outside-range', null, {
      schedule: {
        plannedStart: '2026-10-12',
        plannedEnd: '2026-10-20',
        approved: true,
        forecastStart: '2026-10-24',
        forecastEndMax: '2026-10-26',
      },
    }),
    workItem('incomplete-dates', null, {
      schedule: { plannedStart: '2026-10-03', forecastStart: '2026-10-03' },
    }),
  ]);
  const options = projectFilterOptions(data);
  const range = { from: '2026-10-03', to: '2026-10-03' };

  const included = projectFilteredWork(data, parseWorkSearch(range, options));
  assert.deepEqual(included.items.map(item => item.id), [
    'baseline-overlap', 'forecast-overlap', 'incomplete-dates',
  ]);
  assert.equal(included.matchCount, 3);

  const excluded = projectFilteredWork(data, parseWorkSearch({ ...range, undated: 'exclude' }, options));
  assert.deepEqual(excluded.items.map(item => item.id), ['baseline-overlap', 'forecast-overlap']);

  const onlyUndated = projectFilteredWork(data, parseWorkSearch({
    ...range,
    undated: 'only',
  }, options));
  assert.deepEqual(onlyUndated.items.map(item => item.id), ['incomplete-dates']);
});

test('choice lists include unmatched recorded owners and source statuses, with an explicit unassigned value', () => {
  const data = snapshot([
    workItem('archived-owner', null, { owner: 'unrostered-handle', ownerName: 'Legacy Owner', status: 'in-review' }),
    workItem('unowned', null, { owner: null, ownerName: null, status: 'queued' }),
  ]);

  assert.deepEqual(workFilterOptions(data), {
    owners: [
      { value: '__unassigned__', label: 'Unassigned' },
      { value: 'unrostered-handle', label: 'Legacy Owner' },
    ],
    statuses: [
      { value: 'in-review', label: 'In Review' },
      { value: 'queued', label: 'Queued' },
    ],
  });

  const parsed = parseWorkSearch({
    owners: '["unrostered-handle","unknown","__unassigned__"]',
    statuses: '["in-review","stale-status"]',
  }, projectFilterOptions(data));
  assert.deepEqual(parsed.owners, ['__unassigned__', 'unrostered-handle']);
  assert.deepEqual(parsed.statuses, ['in-review']);
  assert.equal(projectFilteredWork(data, parsed).matchCount, 1);
});

test('owner and status selections are OR within each choice and AND across filters', () => {
  const data = snapshot([
    workItem('invoice-don-active', null, { title: 'Invoice review', owner: 'don', status: 'active' }),
    workItem('invoice-mark-queued', null, { title: 'Invoice payment', owner: 'mark', status: 'queued' }),
    workItem('invoice-don-queued', null, { title: 'Invoice release', owner: 'don', status: 'queued' }),
    workItem('other-unassigned', null, { title: 'Unassigned task', owner: null, status: 'active' }),
  ]);
  const search = parseWorkSearch({
    q: 'invoice',
    owners: ['don', 'mark'],
    statuses: ['active', 'queued'],
  }, projectFilterOptions(data));

  const result = projectFilteredWork(data, search);

  assert.deepEqual(result.items.map(item => item.id), [
    'invoice-don-active', 'invoice-mark-queued', 'invoice-don-queued',
  ]);
  assert.equal(result.matchCount, 3);
});

test('empty snapshots provide empty choices and an empty projection', () => {
  const data = snapshot([]);
  const options = projectFilterOptions(data);
  const search = parseWorkSearch({
    owners: '["unknown"]',
    statuses: ['active'],
    from: '2026-10-03',
  }, options);

  assert.deepEqual(workFilterOptions(data), { owners: [], statuses: [] });
  assert.deepEqual(search.owners, []);
  assert.deepEqual(search.statuses, []);
  assert.deepEqual(projectFilteredWork(data, search), {
    items: [],
    roots: [],
    visibleIds: new Set(),
    contextualIds: new Set(),
    externalItems: [],
    matchCount: 0,
  });

  const selectedNoMatch = parseWorkSearch({ item: 'selected-record', q: 'no matching work' }, options);
  const emptyResults = projectFilteredWork(data, selectedNoMatch);
  assert.equal(emptyResults.items.length, 0);
  assert.equal(selectedNoMatch.item, 'selected-record');
});
