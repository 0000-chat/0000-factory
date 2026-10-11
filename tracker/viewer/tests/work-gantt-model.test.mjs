import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  addCalendarDay,
  approvedPlanMarkForWorkEntry,
  buildWorkGanttModel,
  chartDateForDay,
  clampGanttZoom,
  directMarksForWorkEntry,
  fitZoomForGanttDateRange,
  formatGanttZoom,
  ganttDateTickInterval,
  hasForecastMarks,
  paddedGanttDateRange,
  GANTT_DEFAULT_ZOOM,
  GANTT_MAX_ZOOM,
  GANTT_MIN_ZOOM,
  manilaTodayForChart,
  marksForWorkEntry,
  primaryWorkMark,
  shortWorkDate,
  workGanttDepthExpansion,
  workMarkLabel,
} from '../src/work-gantt-model.mjs';
import {
  placeWorkGanttRollups,
  WORK_GANTT_APPROVED_MARK_HEIGHT,
  WORK_GANTT_COLLAPSED_PARENT_LANES,
  WORK_GANTT_LANES,
  WORK_GANTT_ROLLUP_BAND_HEIGHT,
  WORK_GANTT_ROLLUP_TRACK_COUNT,
  WORK_GANTT_ROLLUP_TRACK_HEIGHT,
  WORK_GANTT_ROW_HEIGHT,
  WORK_GANTT_SECONDARY_MARK_HEIGHT,
} from '../src/work-gantt-layout.mjs';

test('Gantt zoom stays within the supported range and defaults invalid values', () => {
  assert.equal(clampGanttZoom(-10), GANTT_MIN_ZOOM);
  assert.equal(clampGanttZoom(GANTT_MAX_ZOOM + 20), GANTT_MAX_ZOOM);
  assert.equal(clampGanttZoom('not-a-number'), GANTT_DEFAULT_ZOOM);
  assert.equal(formatGanttZoom(GANTT_MIN_ZOOM), '0.001%');
  assert.equal(formatGanttZoom(2.17), '2.17%');
  assert.equal(formatGanttZoom(100), '100%');
});

test('fit zoom includes date padding and can scale long ranges below 25 percent', () => {
  assert.deepEqual(paddedGanttDateRange('2026-10-10', '2026-10-12'), {
    startDay: '2026-10-08',
    endDay: '2026-10-14',
    days: 7,
  });
  assert.equal(fitZoomForGanttDateRange('2026-01-01', '2027-12-31', 800), 2.179);
  assert.equal(fitZoomForGanttDateRange('2026-10-10', '2026-10-12', 800), GANTT_MAX_ZOOM);
  assert.equal(fitZoomForGanttDateRange('2026-01-01', '2045-12-31', 220), 0.06);
  assert.equal(fitZoomForGanttDateRange('2026-01-01', '2100-12-31', 220), 0.016);
  assert.equal(fitZoomForGanttDateRange('not-a-date', '2026-10-12', 800), null);
});

test('daily date ticks keep a readable minimum width as fit all changes zoom', () => {
  assert.equal(ganttDateTickInterval(100), 1);
  assert.equal(ganttDateTickInterval(50), 2);
  assert.equal(ganttDateTickInterval(22.537), 5);
  assert.equal(ganttDateTickInterval(0.001), 93334);
});

function entry(id, timeline, overrides = {}) {
  return {
    id,
    parentId: null,
    childIds: [],
    title: id,
    status: 'active',
    completed: false,
    owner: null,
    ownerName: null,
    own: { state: 'unknown', firstDate: null, lastDate: null },
    descendants: { recentIds: [], quietIds: [], unknownIds: [], ownerIds: [], streaks: [] },
    timeline: {
      ownPlannedStart: null,
      ownPlannedDue: null,
      plannedStart: null,
      plannedDue: null,
      observedStart: null,
      observedEnd: null,
      inferredStart: null,
      forecastStart: null,
      forecastEnd: null,
      proposedStart: null,
      proposedEnd: null,
      partial: false,
      overdueCalendarDays: 0,
      ...timeline,
    },
    attentionReasons: [],
    ...overrides,
  };
}

test('forecast availability is independent of the forecast visibility toggle', () => {
  const projection = new Map([
    ['approved-only', entry('approved-only', { plannedStart: '2026-10-01', plannedDue: '2026-10-03' })],
    ['forecasted', entry('forecasted', { forecastStart: '2026-10-04', forecastEnd: '2026-10-07' })],
  ]);
  assert.equal(hasForecastMarks(projection, ['approved-only']), false);
  assert.equal(hasForecastMarks(projection, ['forecasted']), true);
  assert.equal(hasForecastMarks(projection, []), false);
});

test('direct grouping marks exclude descendant rollups while preserving an own plan', () => {
  const parent = entry('parent', {
    plannedStart: '2026-10-01',
    plannedDue: '2026-10-12',
    proposedStart: '2026-10-01',
    proposedEnd: '2026-10-12',
    ownPlannedStart: '2026-10-04',
    ownPlannedDue: '2026-10-08',
  }, { childIds: ['child'] });
  const child = entry('child', {
    plannedStart: '2026-10-10',
    plannedDue: '2026-10-12',
    proposedStart: '2026-10-10',
    proposedEnd: '2026-10-12',
  }, { parentId: 'parent' });
  const direct = directMarksForWorkEntry(parent);
  assert.deepEqual(direct.map(mark => mark.sourceKind), ['approved']);
  assert.deepEqual([direct[0].startDay, direct[0].endDay], ['2026-10-04', '2026-10-08']);
  assert.equal(direct.some(mark => mark.startDay === '2026-10-10'), false);
  assert.equal(marksForWorkEntry(child).some(mark => mark.sourceKind === 'proposed'), true);
  assert.deepEqual([approvedPlanMarkForWorkEntry(parent).startDay, approvedPlanMarkForWorkEntry(parent).endDay], ['2026-10-04', '2026-10-08']);
});

test('projected rows retain approved bars and lifecycle metadata without commitment text', () => {
  const projected = entry('shared-scheduled', {
    plannedStart: '2026-10-10',
    plannedDue: '2026-10-12',
  }, {
    status: 'active',
    owner: 'fixture-owner',
    ownerName: 'Fixture Owner',
  });
  const model = buildWorkGanttModel({
    projection: new Map([[projected.id, projected]]),
    visibleIds: new Set([projected.id]),
    expandedIds: new Set(),
    itemsById: new Map([[projected.id, { id: projected.id, title: projected.title, commitment: null }]]),
  });
  const row = model.rows[0];
  const mark = row.marks.find(candidate => candidate.sourceKind === 'approved');
  assert.deepEqual([mark?.startDay, mark?.endDay, mark?.point], ['2026-10-10', '2026-10-12', false]);
  assert.equal(row.entry.status, 'active');
  assert.equal(row.entry.owner, 'fixture-owner');
});

test('context parents aggregate child dates without inventing a status or owner', () => {
  const parent = entry('context-parent', {
    plannedStart: null,
    plannedDue: null,
  }, {
    title: 'Context parent',
    status: '',
    owner: null,
    childIds: ['shared-child'],
  });
  const child = entry('shared-child', {
    plannedStart: '2026-10-10',
    plannedDue: '2026-10-12',
  }, {
    title: 'Shared child',
    parentId: 'context-parent',
    status: 'active',
    owner: 'fixture-owner',
  });
  const model = buildWorkGanttModel({
    projection: new Map([[parent.id, parent], [child.id, child]]),
    visibleIds: new Set([parent.id, child.id]),
    expandedIds: new Set([parent.id]),
    contextualIds: new Set([parent.id]),
    itemsById: new Map([
      [parent.id, { id: parent.id, title: parent.title, contextOnly: true }],
      [child.id, { id: child.id, title: child.title, commitment: null }],
    ]),
  });
  const row = model.rows.find(candidate => candidate.id === parent.id);
  assert.equal(row.contextual, true);
  assert.deepEqual([row.parentEnvelope.startDay, row.parentEnvelope.endDay], ['2026-10-10', '2026-10-12']);
  assert.equal(row.entry.status, '');
  assert.equal(row.entry.owner, null);
});

test('date-only values map to local chart cells without shifting Manila days', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const chartDate = chartDateForDay('2026-10-02');
    assert.equal(chartDate.getFullYear(), 2026);
    assert.equal(chartDate.getMonth(), 9);
    assert.equal(chartDate.getDate(), 2);
    assert.equal(addCalendarDay('2026-10-31'), '2026-11-01');
    assert.equal(addCalendarDay('not-a-date'), null);

    const today = manilaTodayForChart('2026-10-01T16:00:00.000Z');
    assert.equal(today.getFullYear(), 2026);
    assert.equal(today.getMonth(), 9);
    assert.equal(today.getDate(), 2);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('approved and observed end dates include their final calendar cell', () => {
  const projected = entry('one-day', {
    plannedStart: '2026-10-02',
    plannedDue: '2026-10-02',
    observedStart: '2026-10-03',
    observedEnd: '2026-10-03',
  });
  const marks = marksForWorkEntry(projected);
  const approved = marks.find(mark => mark.sourceKind === 'approved');
  const observed = marks.find(mark => mark.sourceKind === 'observed');

  assert.equal(approved.startDay, '2026-10-02');
  assert.equal(approved.endDay, '2026-10-02');
  assert.equal(approved.endAt.getDate(), 3);
  assert.equal(observed.startDay, '2026-10-03');
  assert.equal(observed.endDay, '2026-10-03');
  assert.equal(observed.endAt.getDate(), 4);
  assert.equal(workMarkLabel(approved), '10/2');
  assert.equal(shortWorkDate('2026-10-03'), '10/3');
});

test('missing approved due does not create a plan and keeps an explicit forecast source-backed', () => {
  const projected = entry('without-due', {
    plannedStart: '2026-10-01',
    forecastStart: '2026-10-04',
    forecastEnd: '2026-10-08',
  });

  const marks = marksForWorkEntry(projected);
  assert.equal(marks.some(mark => mark.sourceKind === 'approved'), false);
  assert.equal(marks.find(mark => mark.sourceKind === 'forecast').startDay, '2026-10-04');
});

test('missing dated evidence creates no observed mark', () => {
  const projected = entry('unknown', {
    own: { state: 'unknown', firstDate: null, lastDate: null },
  });

  assert.equal(marksForWorkEntry(projected).some(mark => mark.sourceKind === 'observed'), false);
});

test('due-only plans remain point marks and observed work after due is an overrun', () => {
  const projected = entry('late-start', {
    plannedDue: '2026-10-02',
    inferredStart: '2026-10-04',
    observedStart: '2026-10-04',
    observedEnd: '2026-10-05',
  }, {
    own: { state: 'recent', firstDate: '2026-10-04', lastDate: '2026-10-05' },
  });
  const marks = marksForWorkEntry(projected);
  const due = marks.find(mark => mark.sourceKind === 'approved');
  const observed = marks.find(mark => mark.sourceKind === 'observed');

  assert.equal(due.point, true);
  assert.equal(due.startDay, '2026-10-02');
  assert.equal(due.endDay, '2026-10-02');
  assert.equal(observed.observedOverrun, true);
  assert.equal(primaryWorkMark(marks), due);
});

test('approved deadline-only data stays a point until an approved start is recorded', () => {
  const deadlineOnly = entry('deadline-only', {
    plannedDue: '2026-10-12',
    ownPlannedDue: '2026-10-12',
  });
  const approvedRange = entry('approved-range', {
    plannedStart: '2026-10-10',
    plannedDue: '2026-10-12',
    ownPlannedStart: '2026-10-10',
    ownPlannedDue: '2026-10-12',
  });

  const point = marksForWorkEntry(deadlineOnly).find(mark => mark.sourceKind === 'approved');
  const range = marksForWorkEntry(approvedRange).find(mark => mark.sourceKind === 'approved');
  const ownPoint = approvedPlanMarkForWorkEntry(deadlineOnly);
  const ownRange = approvedPlanMarkForWorkEntry(approvedRange);

  assert.deepEqual([point?.startDay, point?.endDay, point?.point, point?.inferred], ['2026-10-12', '2026-10-12', true, false]);
  assert.deepEqual([range?.startDay, range?.endDay, range?.point], ['2026-10-10', '2026-10-12', false]);
  assert.deepEqual([ownPoint?.startDay, ownPoint?.endDay, ownPoint?.point], ['2026-10-12', '2026-10-12', true]);
  assert.deepEqual([ownRange?.startDay, ownRange?.endDay, ownRange?.point], ['2026-10-10', '2026-10-12', false]);
});

test('collapsed rows retain full-projection rollups when filtered rows are hidden', () => {
  const child = entry('child', {
    plannedStart: '2026-10-03',
    plannedDue: '2026-10-05',
    observedStart: '2026-10-04',
    observedEnd: '2026-10-06',
  }, { parentId: 'parent' });
  const parent = entry('parent', {
    plannedStart: '2026-10-01',
    plannedDue: '2026-10-05',
    observedStart: '2026-10-04',
    observedEnd: '2026-10-06',
  }, { childIds: ['child'] });
  parent.descendants.recentIds.push('child');
  const projection = new Map([['parent', parent], ['child', child]]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['parent']),
    expandedIds: new Set(),
    now: '2026-10-07',
  });

  assert.deepEqual(model.rows.map(row => row.id), ['parent']);
  assert.equal(model.rows[0].collapsed, true);
  assert.deepEqual(model.rows[0].visibleDescendantIds, []);
  assert.equal(model.rows[0].marks.find(mark => mark.sourceKind === 'approved').endDay, '2026-10-05');
  assert.equal(model.rows[0].marks.find(mark => mark.sourceKind === 'observed').endDay, '2026-10-06');
  assert.equal(parent.descendants.recentIds.length, 1);
  assert.equal(model.dateRange.endAt.getMonth() >= 10, true);
});

test('parent envelopes include hidden descendant sources and honor forecast visibility', () => {
  const parent = entry('parent', {
    plannedStart: '2026-10-02',
    plannedDue: '2026-10-04',
  }, { childIds: ['child'] });
  const child = entry('child', {
    observedStart: '2026-10-05',
    observedEnd: '2026-10-08',
    forecastStart: '2026-10-10',
    forecastEnd: '2026-10-12',
  }, { parentId: 'parent' });
  const projection = new Map([['parent', parent], ['child', child]]);

  const hiddenForecast = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['parent']),
    expandedIds: new Set(),
    showForecast: false,
    now: '2026-10-03',
  });
  const shownForecast = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['parent']),
    expandedIds: new Set(),
    showForecast: true,
    now: '2026-10-03',
  });

  const hiddenRow = hiddenForecast.rows[0];
  const shownRow = shownForecast.rows[0];
  assert.equal(hiddenRow.collapsed, true);
  assert.deepEqual(hiddenRow.parentEnvelope.sourceKinds, ['approved', 'observed']);
  assert.deepEqual([hiddenRow.envelopeStartDay, hiddenRow.envelopeEndDay], ['2026-10-02', '2026-10-08']);
  assert.deepEqual(hiddenRow.childSummaryIntervals.map(mark => mark.sourceKind), ['observed']);
  assert.equal(hiddenRow.lastVisibleDescendantRowIndex, 0);
  assert.deepEqual(shownRow.parentEnvelope.sourceKinds, ['approved', 'observed', 'forecast']);
  assert.deepEqual([shownRow.envelopeStartDay, shownRow.envelopeEndDay], ['2026-10-02', '2026-10-12']);
  assert.deepEqual(shownRow.childSummaryIntervals.map(mark => mark.sourceKind), ['observed', 'forecast']);
});

test('expanded nested parents expose contiguous visible row spans', () => {
  const root = entry('root', { plannedStart: '2026-10-01', plannedDue: '2026-10-10' }, { childIds: ['branch'] });
  const branch = entry('branch', { plannedStart: '2026-10-03', plannedDue: '2026-10-08' }, {
    parentId: 'root',
    childIds: ['leaf'],
  });
  const leaf = entry('leaf', { plannedStart: '2026-10-05', plannedDue: '2026-10-06' }, { parentId: 'branch' });
  const projection = new Map([['root', root], ['branch', branch], ['leaf', leaf]]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(projection.keys()),
    expandedIds: new Set(['root', 'branch']),
    now: '2026-10-03',
  });
  const rows = new Map(model.rows.map(row => [row.id, row]));

  assert.deepEqual(model.rows.map(row => row.id), ['root', 'branch', 'leaf']);
  assert.deepEqual(model.parentContainers.map(container => [container.id, container.rowIndex, container.lastVisibleDescendantRowIndex]), [
    ['root', 0, 2],
    ['branch', 1, 2],
  ]);
  assert.equal(rows.get('root').isExpanded, true);
  assert.equal(rows.get('branch').isExpanded, true);
  assert.equal(rows.get('leaf').lastVisibleDescendantRowIndex, 2);
});

test('undated parent envelopes stay empty instead of inventing a display range', () => {
  const parent = entry('undated-parent', {}, { childIds: ['undated-child'] });
  const child = entry('undated-child', {}, { parentId: 'undated-parent' });
  const model = buildWorkGanttModel({
    projection: new Map([['undated-parent', parent], ['undated-child', child]]),
    visibleIds: new Set(['undated-parent']),
    expandedIds: new Set(),
    showForecast: false,
    now: '2026-10-03',
  });

  assert.equal(model.rows[0].parentEnvelope, null);
  assert.equal(model.rows[0].envelopeStartDay, null);
  assert.equal(model.rows[0].envelopeEndDay, null);
  assert.deepEqual(model.parentContainers, []);
});

test('a scoped visible subtree becomes its own Gantt root', () => {
  const portfolio = entry('portfolio', {}, { childIds: ['project'] });
  const project = entry('project', {}, { parentId: 'portfolio', childIds: ['task'] });
  const task = entry('task', { plannedStart: '2026-10-02', plannedDue: '2026-10-04' }, { parentId: 'project' });
  const projection = new Map([
    ['portfolio', portfolio],
    ['project', project],
    ['task', task],
  ]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['project', 'task']),
    expandedIds: new Set(['project']),
    now: '2026-10-02',
  });

  assert.deepEqual(model.rows.map(row => [row.id, row.depth]), [['project', 0], ['task', 1]]);
});

test('row metadata follows eligible sibling paths and reports only rendered descendants', () => {
  const root = entry('root', { plannedStart: '2026-10-01', plannedDue: '2026-10-10' }, { childIds: ['alpha', 'beta'] });
  const alpha = entry('alpha', {}, { parentId: 'root', childIds: ['alpha-child'] });
  const beta = entry('beta', {}, { parentId: 'root' });
  const alphaChild = entry('alpha-child', {}, { parentId: 'alpha', childIds: ['leaf'] });
  const leaf = entry('leaf', {}, { parentId: 'alpha-child' });
  const projection = new Map([
    ['root', root],
    ['alpha', alpha],
    ['beta', beta],
    ['alpha-child', alphaChild],
    ['leaf', leaf],
  ]);
  const fullModel = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['root', 'alpha', 'beta', 'alpha-child', 'leaf']),
    expandedIds: new Set(['root', 'alpha', 'alpha-child']),
    now: '2026-10-03',
  });
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['leaf', 'alpha-child', 'root', 'alpha']),
    expandedIds: new Set(['root', 'alpha', 'alpha-child']),
    now: '2026-10-03',
  });
  const rows = new Map(model.rows.map(row => [row.id, row]));
  const fullRows = new Map(fullModel.rows.map(row => [row.id, row]));

  assert.deepEqual(model.rows.map(row => row.id), ['root', 'alpha', 'alpha-child', 'leaf']);
  assert.equal(fullRows.get('alpha').isLastSibling, false);
  assert.deepEqual(fullRows.get('leaf').ancestorContinuation, [true, false, false]);
  assert.deepEqual(rows.get('leaf').ancestorIds, ['root', 'alpha', 'alpha-child']);
  assert.deepEqual(rows.get('leaf').ancestorContinuation, [false, false, false]);
  assert.equal(rows.get('alpha').isLastSibling, true);
  assert.deepEqual(rows.get('root').visibleDescendantIds, ['alpha', 'alpha-child', 'leaf']);
  assert.equal(rows.get('leaf').shadeAncestorId, 'root');
  assert.equal(rows.get('root').eligibleChildCount, 1);
});

test('tree guide continuation follows each next path child through singleton root and sibling levels', () => {
  const root = entry('root', {}, { childIds: ['alpha', 'beta'] });
  const alpha = entry('alpha', {}, { parentId: 'root', childIds: ['alpha-one', 'alpha-two'] });
  const beta = entry('beta', {}, { parentId: 'root' });
  const alphaOne = entry('alpha-one', {}, { parentId: 'alpha', childIds: ['leaf'] });
  const alphaTwo = entry('alpha-two', {}, { parentId: 'alpha' });
  const leaf = entry('leaf', {}, { parentId: 'alpha-one' });
  const projection = new Map([
    ['root', root],
    ['alpha', alpha],
    ['beta', beta],
    ['alpha-one', alphaOne],
    ['alpha-two', alphaTwo],
    ['leaf', leaf],
  ]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(projection.keys()),
    expandedIds: new Set(['root', 'alpha', 'alpha-one']),
    now: '2026-10-03',
  });
  const rows = new Map(model.rows.map(row => [row.id, row]));

  assert.deepEqual(model.rows.map(row => row.id), ['root', 'alpha', 'alpha-one', 'leaf', 'alpha-two', 'beta']);
  assert.equal(rows.get('root').isLastSibling, true);
  assert.equal(rows.get('alpha').isLastSibling, false);
  assert.equal(rows.get('alpha-one').isLastSibling, false);
  assert.equal(rows.get('leaf').isLastSibling, true);
  assert.deepEqual(rows.get('leaf').ancestorContinuation, [true, true, false]);
  assert.deepEqual(rows.get('alpha-two').ancestorContinuation, [true, false]);
  assert.deepEqual(rows.get('beta').ancestorContinuation, [false]);
});

test('child rollups include due points and summary children while counting undated eligible children', () => {
  const root = entry('root', {}, { childIds: ['late', 'summary', 'undated', 'earlier'] });
  const late = entry('late', { plannedDue: '2026-10-07' }, { parentId: 'root' });
  const summary = entry('summary', { plannedStart: '2026-10-03', plannedDue: '2026-10-06' }, {
    parentId: 'root',
    childIds: ['grandchild'],
  });
  const undated = entry('undated', { partial: true }, { parentId: 'root' });
  const earlier = entry('earlier', { plannedStart: '2026-10-01', plannedDue: '2026-10-04' }, { parentId: 'root' });
  const grandchild = entry('grandchild', { plannedDue: '2026-10-09' }, { parentId: 'summary' });
  const projection = new Map([
    ['root', root], ['late', late], ['summary', summary], ['undated', undated], ['earlier', earlier], ['grandchild', grandchild],
  ]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(projection.keys()),
    expandedIds: new Set(['root']),
    now: '2026-10-03',
  });
  const rootRow = model.rows.find(row => row.id === 'root');

  assert.equal(rootRow.eligibleChildCount, 4);
  assert.equal(rootRow.undatedChildCount, 1);
  assert.deepEqual(rootRow.childRollups.map(({ childId, startDay, point }) => [childId, startDay, point]), [
    ['earlier', '2026-10-01', false],
    ['summary', '2026-10-03', false],
    ['late', '2026-10-07', true],
  ]);
});

test('filters and collapse do not shrink source marks or complete-projection date bounds', () => {
  const root = entry('root', {
    plannedStart: '2026-10-01',
    plannedDue: '2026-10-05',
    observedStart: '2026-10-03',
    observedEnd: '2026-10-04',
  }, { childIds: ['child'] });
  const child = entry('child', {
    plannedStart: '2035-02-10',
    plannedDue: '2035-02-12',
    proposedStart: '2036-04-02',
    proposedEnd: '2036-04-08',
  }, { parentId: 'root' });
  const projection = new Map([['root', root], ['child', child]]);
  const collapsed = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['root']),
    expandedIds: new Set(),
    now: '2026-10-03',
  });
  const filtered = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['root']),
    expandedIds: new Set(['root']),
    now: '2026-10-03',
  });

  assert.deepEqual(collapsed.rows[0].marks.map(mark => mark.id), ['root:approved', 'root:observed']);
  assert.equal(collapsed.rows[0].marks.find(mark => mark.sourceKind === 'approved').endDay, '2026-10-05');
  assert.equal(collapsed.dateRange.endAt.valueOf(), filtered.dateRange.endAt.valueOf());
  assert.equal(collapsed.dateRange.endAt.getFullYear(), 2036);
});

test('dependency edges keep hidden known records and safely retain cycles', () => {
  const projection = new Map([['visible', entry('visible', {})]]);
  const itemsById = new Map([
    ['B', { id: 'B', depends_on: ['A', 'A', 'B', 'missing'] }],
    ['A', { id: 'A', depends_on: 'B' }],
    ['C', { id: 'C', depends_on: ['A', 'missing'] }],
  ]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['visible']),
    itemsById,
    now: '2026-10-03',
  });

  assert.deepEqual(model.dependencyEdges, [
    { id: 'A->B', fromId: 'A', toId: 'B' },
    { id: 'A->C', fromId: 'A', toId: 'C' },
    { id: 'B->A', fromId: 'B', toId: 'A' },
  ]);
});

test('cyclic eligible hierarchies render every row once without looping', () => {
  const alpha = entry('alpha', {}, { parentId: 'beta', childIds: ['beta'] });
  const beta = entry('beta', {}, { parentId: 'alpha', childIds: ['alpha'] });
  const projection = new Map([['beta', beta], ['alpha', alpha]]);
  const model = buildWorkGanttModel({
    projection,
    visibleIds: new Set(['alpha', 'beta']),
    expandedIds: new Set(['alpha', 'beta']),
    now: '2026-10-03',
  });

  assert.deepEqual(model.rows.map(row => row.id), ['beta', 'alpha']);
  assert.deepEqual(model.rows[1].ancestorIds, ['beta']);
  assert.deepEqual(model.rows[0].visibleDescendantIds, ['alpha']);
});

test('depth presets expand eligible hierarchy levels regardless of the current collapse state', () => {
  const root = entry('root', {}, { childIds: ['child'] });
  const child = entry('child', {}, { parentId: 'root', childIds: ['grandchild'] });
  const grandchild = entry('grandchild', {}, { parentId: 'child', childIds: ['great-grandchild'] });
  const greatGrandchild = entry('great-grandchild', {}, { parentId: 'grandchild' });
  const projection = new Map([
    ['root', root], ['child', child], ['grandchild', grandchild], ['great-grandchild', greatGrandchild],
  ]);
  const eligibleIds = new Set(projection.keys());
  const result = depth => workGanttDepthExpansion(projection, eligibleIds, depth);

  assert.deepEqual([...result(1).controlledIds].sort(), ['child', 'grandchild', 'root']);
  assert.deepEqual([...result(1).expandedIds], []);
  assert.deepEqual([...result(2).expandedIds].sort(), ['root']);
  assert.deepEqual([...result(3).expandedIds].sort(), ['child', 'root']);
  assert.deepEqual([...result('all').expandedIds].sort(), ['child', 'grandchild', 'root']);
});

test('rollup layout uses fixed lanes and greedy inclusive two-track placement', () => {
  assert.equal(WORK_GANTT_ROW_HEIGHT, 60);
  assert.equal(WORK_GANTT_APPROVED_MARK_HEIGHT, 22);
  assert.equal(WORK_GANTT_SECONDARY_MARK_HEIGHT, 8);
  assert.equal(WORK_GANTT_ROLLUP_TRACK_HEIGHT, 3);
  assert.equal(WORK_GANTT_ROLLUP_TRACK_COUNT, 2);
  assert.equal(WORK_GANTT_ROLLUP_BAND_HEIGHT, 7.5);
  assert.deepEqual(WORK_GANTT_LANES, {
    approved: { index: 0, count: 2 },
    proposed: { index: 4, count: 8 },
    observed: { index: 5, count: 8 },
    forecast: { index: 6, count: 8 },
  });
  assert.deepEqual(WORK_GANTT_COLLAPSED_PARENT_LANES, {
    approved: { index: 4, count: 10 },
    proposed: { index: 5, count: 10 },
    observed: { index: 6, count: 10 },
    forecast: { index: 7, count: 10 },
  });

  const result = placeWorkGanttRollups([
    { childId: 'span', startDay: '2026-10-02', endDay: '2026-10-04' },
    { childId: 'point', startDay: '2026-10-04', endDay: '2026-10-04', point: true },
    { childId: 'z-overflow', startDay: '2026-10-04', endDay: '2026-10-05' },
    { childId: 'free', startDay: '2026-10-05', endDay: '2026-10-06' },
    { childId: 'invalid', startDay: '2026-02-30', endDay: '2026-03-01' },
  ]);

  assert.deepEqual(result.positionedRollups.map(({ childId, trackIndex }) => [childId, trackIndex]), [
    ['span', 0],
    ['point', 1],
    ['free', 0],
  ]);
  assert.equal(result.overflowCount, 2);
});
