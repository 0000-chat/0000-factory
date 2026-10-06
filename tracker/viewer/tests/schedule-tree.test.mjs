import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { buildScheduleTree } from '../src/schedule-tree.mjs';

function accepted(id, parent = null, schedule = {}) {
  return {
    id,
    title: id,
    parent,
    commitment: 'accepted',
    planned: false,
    status: 'active',
    schedule,
  };
}

function planned(id, parent = null, schedule = {}) {
  return {
    id,
    title: id,
    parent,
    commitment: 'planned',
    planned: true,
    status: 'queued',
    schedule: { ...schedule, approved: false },
  };
}

function rowById(rows, id) {
  return rows.find(row => row.id === id);
}

function featureByKind(row, kind) {
  return row.features.find(feature => feature.kind === kind);
}

function range(feature) {
  return [feature.startAt.toISOString().slice(0, 10), feature.endAt.toISOString().slice(0, 10)];
}

test('rolls arbitrary-depth schedules into derived parent spans, including the parent record', () => {
  const items = [
    accepted('portfolio'),
    accepted('stream', 'portfolio', { plannedStart: '2026-10-01', plannedEnd: '2026-10-10', approved: true }),
    accepted('subproject', 'stream', { plannedStart: '2026-10-03', plannedEnd: '2026-10-12', approved: true }),
    accepted('deep-task', 'subproject', { plannedStart: '2026-09-28', plannedEnd: '2026-10-16', approved: true }),
  ];
  const result = buildScheduleTree({ items, expandedIds: new Set(['portfolio', 'stream', 'subproject']) });
  const portfolio = rowById(result.rows, 'portfolio');
  const stream = rowById(result.rows, 'stream');
  const summary = featureByKind(stream, 'baseline');

  assert.deepEqual(result.rows.map(row => [row.id, row.depth]), [
    ['portfolio', 0], ['stream', 1], ['subproject', 2], ['deep-task', 3],
  ]);
  assert.deepEqual(range(summary), ['2026-09-28', '2026-10-16']);
  assert.deepEqual(range(featureByKind(portfolio, 'baseline')), ['2026-09-28', '2026-10-16']);
  assert.equal(summary.summary, true);
  assert.equal(summary.synthetic, true);
  assert.equal(summary.summaryLabel, 'Derived summary');
  assert.equal(summary.status.name, 'Derived summary');
  assert.equal(summary.status.id, 'summary-baseline');
  assert.equal(summary.itemId, 'stream');
  assert.equal(portfolio.features[0].itemId, 'portfolio');
  assert.equal(portfolio.summaryLabel, 'Derived summary');
  assert.equal(result.unscheduledItems.length, 0);
  assert.deepEqual(range(result.dateRange), ['2026-09-28', '2026-10-16']);
});

test('collapse changes visible rows without changing rollups or full date extrema', () => {
  const items = [
    accepted('root'),
    accepted('branch', 'root'),
    accepted('leaf', 'branch', { forecastStart: '2026-11-02', forecastEndMax: '2026-11-08' }),
    accepted('other', 'root', { forecastStart: '2026-10-30', forecastEndMax: '2026-11-01' }),
  ];
  const collapsed = buildScheduleTree({ items });
  const branchOpen = buildScheduleTree({ items, expandedIds: ['root'] });
  const allOpen = buildScheduleTree({ items, expandedIds: ['root', 'branch'] });

  assert.deepEqual(collapsed.rows.map(row => row.id), ['root']);
  assert.deepEqual(branchOpen.rows.map(row => row.id), ['root', 'branch', 'other']);
  assert.deepEqual(allOpen.rows.map(row => row.id), ['root', 'branch', 'leaf', 'other']);
  assert.deepEqual(range(featureByKind(rowById(collapsed.rows, 'root'), 'forecast')), ['2026-10-30', '2026-11-08']);
  assert.deepEqual(range(featureByKind(rowById(branchOpen.rows, 'root'), 'forecast')), ['2026-10-30', '2026-11-08']);
  assert.deepEqual(range(collapsed.dateRange), ['2026-10-30', '2026-11-08']);
  assert.deepEqual(range(allOpen.dateRange), range(collapsed.dateRange));
  assert.equal(rowById(branchOpen.rows, 'branch').hasChildren, true);
});

test('keeps baseline, forecast, and proposed envelopes separate and carries provisional state', () => {
  const items = [
    accepted('root', null, { plannedStart: '2026-10-05', plannedEnd: '2026-10-08', approved: true }),
    accepted('forecast-child', 'root', { forecastStart: '2026-11-01', forecastEndMax: '2026-11-05', provisional: true }),
    planned('proposal-child', 'root', {
      plannedStart: '2026-12-01', plannedEnd: '2026-12-03',
      forecastStart: '2026-11-15', forecastEndMax: '2026-11-17',
    }),
  ];
  const { rows } = buildScheduleTree({ items });
  const root = rowById(rows, 'root');
  const baseline = featureByKind(root, 'baseline');
  const forecast = featureByKind(root, 'forecast');
  const proposed = featureByKind(root, 'proposed');

  assert.deepEqual(root.features.map(feature => feature.kind), ['baseline', 'forecast', 'proposed']);
  assert.deepEqual(range(baseline), ['2026-10-05', '2026-10-08']);
  assert.deepEqual(range(forecast), ['2026-11-01', '2026-11-05']);
  assert.deepEqual(range(proposed), ['2026-11-15', '2026-12-03']);
  assert.equal(baseline.proposed, false);
  assert.equal(forecast.provisional, true);
  assert.equal(proposed.proposed, true);
  assert.equal(proposed.provisional, null);
  assert.ok(root.features.every(feature => feature.summaryLabel === 'Derived summary'));
});

test('marks partial summaries and exposes only undated non-context rows as unscheduled', () => {
  const items = [
    accepted('root', null, { plannedStart: '2026-10-01', plannedEnd: '2026-10-05', approved: true }),
    accepted('dated-child', 'root', { forecastStart: '2026-10-06', forecastEndMax: '2026-10-08' }),
    accepted('undated-child', 'root'),
    planned('planned-context', null, { plannedStart: '2026-10-09', plannedEnd: '2026-10-11' }),
  ];
  const result = buildScheduleTree({
    items,
    expandedIds: ['root'],
    contextualIds: new Set(['planned-context']),
  });
  const root = rowById(result.rows, 'root');
  const undated = rowById(result.rows, 'undated-child');

  assert.equal(root.hasUnscheduledDescendants, true);
  assert.equal(root.summaryPartial, true);
  assert.equal(root.features.length, 2);
  assert.equal(undated.features.length, 0);
  assert.deepEqual(result.unscheduledItems.map(item => item.id), ['undated-child']);
  assert.deepEqual(range(result.dateRange), ['2026-10-01', '2026-10-08']);
});

test('suppresses contextual proposed dates while retaining accepted descendants in ancestor summaries', () => {
  const items = [
    planned('planned-parent', null, { plannedStart: '2026-12-01', plannedEnd: '2026-12-10' }),
    accepted('accepted-child', 'planned-parent', { plannedStart: '2026-10-01', plannedEnd: '2026-10-04', approved: true }),
    planned('planned-child', 'planned-parent', { plannedStart: '2026-11-01', plannedEnd: '2026-11-05' }),
    planned('planned-prerequisite', null, { plannedStart: '2026-09-01', plannedEnd: '2026-09-03' }),
  ];
  const result = buildScheduleTree({
    items,
    expandedIds: ['planned-parent'],
    contextualIds: ['planned-parent', 'planned-child', 'planned-prerequisite'],
  });
  const parent = rowById(result.rows, 'planned-parent');

  assert.deepEqual(parent.features.map(feature => feature.kind), ['baseline']);
  assert.deepEqual(range(parent.features[0]), ['2026-10-01', '2026-10-04']);
  assert.equal(parent.features[0].proposed, false);
  assert.equal(parent.contextual, true);
  assert.deepEqual(range(result.dateRange), ['2026-10-01', '2026-10-04']);
  assert.deepEqual(result.unscheduledItems, []);
});

test('shows unscheduled rows when no valid source date pair exists', () => {
  const items = [
    accepted('empty-parent'),
    accepted('empty-child', 'empty-parent', { plannedStart: '2026-10-01', plannedEnd: null, approved: true }),
  ];
  const result = buildScheduleTree({ items, expandedIds: ['empty-parent'] });

  assert.deepEqual(result.rows.map(row => [row.id, row.features.length]), [['empty-parent', 0], ['empty-child', 0]]);
  assert.deepEqual(result.unscheduledItems.map(item => item.id), ['empty-parent', 'empty-child']);
  assert.equal(result.dateRange, null);
});

test('keeps stable summary IDs and does not mutate frozen source snapshots', () => {
  const deepFreeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  const items = deepFreeze([
    accepted('root'),
    accepted('child', 'root', { forecastStart: '2026-10-01', forecastEndMax: '2026-10-03' }),
  ]);
  const first = buildScheduleTree({ items });
  const second = buildScheduleTree({ items, expandedIds: ['root'] });
  const firstSummary = rowById(first.rows, 'root').features[0];
  const secondSummary = rowById(second.rows, 'root').features[0];

  assert.equal(firstSummary.id, 'summary:root:forecast');
  assert.equal(secondSummary.id, firstSummary.id);
  assert.equal(firstSummary.itemId, 'root');
  assert.deepEqual(range(firstSummary), range(secondSummary));
  assert.ok(Object.isFrozen(items[0].schedule));
});
