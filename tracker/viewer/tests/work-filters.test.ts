import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { projectFilterOptions } from '../src/route-data';
import { normalizeTrackerSnapshot } from '../src/snapshot';
import { parseWorkSearch } from '../src/routing-state';
import { projectFilteredWork, workFilterOptions } from '../src/work-filters';
import { buildWorkProjection, selectWorkRows } from '../src/work-activity.mjs';

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

function snapshot(items: ReturnType<typeof workItem>[], teamProjection = false) {
  return normalizeTrackerSnapshot({
    source: teamProjection ? { layout: 'team-projection-v1' } : undefined,
    items,
    team: [], plans: [], decisions: [], releases: [],
  });
}

test('team projection search keeps only actual task matches and restores context-only ancestors', () => {
  const data = snapshot([
    workItem('grandparent-task', null, { title: 'Grandparent task', childIds: ['project-context'] }),
    workItem('project-context', 'grandparent-task', { type: 'project', contextOnly: true, status: '', childIds: ['workstream-context'] }),
    workItem('workstream-context', 'project-context', { type: 'workstream', contextOnly: true, status: '', childIds: ['child-task', 'task-context'] }),
    workItem('child-task', 'workstream-context', { title: 'Retry notification delivery', childIds: [] }),
    workItem('task-context', 'workstream-context', { type: 'task', contextOnly: true, status: '', title: 'Retry notification context', childIds: [] }),
    workItem('unrelated-task', null, { title: 'Unrelated work', childIds: [] }),
  ], true);
  const search = parseWorkSearch({ q: 'retry notification' }, projectFilterOptions(data));
  const result = projectFilteredWork(data, search);

  assert.equal(result.matchCount, 1);
  assert.deepEqual(result.items.map(item => item.id), ['grandparent-task', 'project-context', 'workstream-context', 'child-task']);
  assert.deepEqual([...result.contextualIds].sort(), ['grandparent-task', 'project-context', 'workstream-context']);
  assert.deepEqual(result.roots.map(item => item.id), ['grandparent-task']);
  assert.deepEqual(workFilterOptions(data), {
    owners: [{ value: 'don', label: 'Don Masakayan' }],
    statuses: [{ value: 'active', label: 'Active' }],
  });

  const activity = buildWorkProjection({ items: data.items, evidence: [] });
  const activityRows = selectWorkRows({
    projection: activity,
    eligibleIds: result.items.filter(item => !item.contextOnly && !result.contextualIds.has(item.id)).map(item => item.id),
    activityFilter: 'all',
  });
  assert.deepEqual([...activityRows.matchIds], ['child-task']);
  assert.deepEqual([...activityRows.contextIds], ['workstream-context', 'project-context', 'grandparent-task']);

  const parentAndChildData = snapshot(data.items.map(item => item.id === 'grandparent-task'
    ? { ...item, title: 'Retry notification parent' }
    : item), true);
  const parentAndChild = projectFilteredWork(parentAndChildData, parseWorkSearch({ q: 'retry notification' }, projectFilterOptions(parentAndChildData)));
  assert.equal(parentAndChild.matchCount, 2);
  assert.deepEqual(parentAndChild.items.map(item => item.id), ['grandparent-task', 'project-context', 'workstream-context', 'child-task']);
  assert.deepEqual([...parentAndChild.contextualIds].sort(), ['project-context', 'workstream-context']);
  const parentAndChildActivity = buildWorkProjection({ items: parentAndChildData.items, evidence: [] });
  const parentAndChildRows = selectWorkRows({
    projection: parentAndChildActivity,
    eligibleIds: parentAndChild.items.filter(item => !item.contextOnly && !parentAndChild.contextualIds.has(item.id)).map(item => item.id),
    activityFilter: 'all',
  });
  assert.deepEqual([...parentAndChildRows.matchIds], ['grandparent-task', 'child-task']);
  assert.deepEqual([...parentAndChildRows.contextIds], ['workstream-context', 'project-context']);
});

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
