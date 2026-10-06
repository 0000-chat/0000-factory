import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createWorkExpansionState,
  initializeGanttExpansionState,
  setWorkExpansionState,
  toggleWorkExpansionState,
  transitionWorkExpansionState,
  visibleExpandedIds,
} from '../src/work-activity-controller-state.ts';
import { buildWorkProjection, selectWorkRows } from '../src/work-activity.mjs';

test('activity filters reveal paths temporarily and restore unfiltered expansion', () => {
  const original = createWorkExpansionState(['project-alpha', 'milestone-stream']);
  const recentPath = new Set(['project-alpha', 'milestone-stream', 'recent-task']);
  const filtered = transitionWorkExpansionState(original, 'recent', recentPath);

  assert.deepEqual([...visibleExpandedIds(filtered, 'recent', recentPath)].sort(), [
    'milestone-stream', 'project-alpha', 'recent-task',
  ]);

  const manuallyCollapsed = toggleWorkExpansionState(filtered, 'recent', 'milestone-stream', recentPath);
  assert.equal(visibleExpandedIds(manuallyCollapsed, 'recent', recentPath).has('milestone-stream'), false);
  assert.equal(visibleExpandedIds(manuallyCollapsed, 'recent', recentPath).has('recent-task'), true);

  const stillCollapsedAfterProjectionRefresh = transitionWorkExpansionState(manuallyCollapsed, 'recent', new Set([...recentPath, 'new-ancestor']));
  assert.equal(visibleExpandedIds(stillCollapsedAfterProjectionRefresh, 'recent', recentPath).has('milestone-stream'), false);
  assert.equal(visibleExpandedIds(stillCollapsedAfterProjectionRefresh, 'recent', new Set([...recentPath, 'new-ancestor'])).has('new-ancestor'), true);

  const quietPath = new Set(['project-alpha', 'quiet-task']);
  const switched = transitionWorkExpansionState(stillCollapsedAfterProjectionRefresh, 'quiet', quietPath);
  assert.equal(visibleExpandedIds(switched, 'quiet', quietPath).has('milestone-stream'), true);
  assert.equal(visibleExpandedIds(switched, 'quiet', quietPath).has('quiet-task'), true);

  const restored = transitionWorkExpansionState(switched, 'all', new Set());
  assert.deepEqual([...visibleExpandedIds(restored, 'all', new Set())].sort(), ['milestone-stream', 'project-alpha']);
});

test('bulk expansion replaces only controlled ids in the unfiltered state', () => {
  const original = createWorkExpansionState(['controlled-open', 'outside', 'controlled-close']);
  const updated = setWorkExpansionState(
    original,
    'all',
    new Set(['controlled-open', 'also-outside']),
    new Set(['controlled-open', 'controlled-close']),
    new Set(),
  );

  assert.deepEqual([...visibleExpandedIds(updated, 'all', new Set())].sort(), ['controlled-open', 'outside']);
  assert.equal(updated.hasManualExpansionInteraction, true);
});

test('filtered bulk collapse blocks auto-reveal and leaves the unfiltered choice intact', () => {
  const original = createWorkExpansionState(['root', 'outside', 'branch']);
  const firstPath = new Set(['root', 'branch', 'leaf']);
  const filtered = transitionWorkExpansionState(original, 'recent', firstPath);
  const bulkCollapsed = setWorkExpansionState(
    filtered,
    'recent',
    new Set(['root']),
    new Set(['root', 'branch']),
    firstPath,
  );

  assert.equal(visibleExpandedIds(bulkCollapsed, 'recent', firstPath).has('branch'), false);
  assert.equal(visibleExpandedIds(bulkCollapsed, 'recent', firstPath).has('leaf'), true);
  assert.equal([...bulkCollapsed.filteredByFingerprint.values()].find(scope => scope.filter === 'recent')?.manuallyCollapsedIds.has('branch'), true);

  const refreshedPath = new Set([...firstPath, 'new-leaf']);
  const refreshed = transitionWorkExpansionState(bulkCollapsed, 'recent', refreshedPath);
  assert.equal(visibleExpandedIds(refreshed, 'recent', refreshedPath).has('branch'), false);
  assert.equal(visibleExpandedIds(refreshed, 'recent', refreshedPath).has('new-leaf'), true);

  const otherFilter = transitionWorkExpansionState(refreshed, 'quiet', new Set(['root', 'quiet-leaf']));
  assert.equal(visibleExpandedIds(otherFilter, 'quiet', new Set(['root', 'quiet-leaf'])).has('branch'), true);
  const restored = transitionWorkExpansionState(otherFilter, 'all', new Set());
  assert.deepEqual([...visibleExpandedIds(restored, 'all', new Set())].sort(), ['branch', 'outside', 'root']);
});

test('Gantt initial expansion is scope-idempotent and preserves uncontrolled ids', () => {
  const original = createWorkExpansionState(['tree-default', 'outside']);
  const controlledIds = new Set(['tree-default', 'gantt-root', 'gantt-child']);
  const initialized = initializeGanttExpansionState(
    original,
    new Set(['gantt-root', 'gantt-child', 'outside']),
    controlledIds,
    'all',
    new Set(),
  );

  assert.deepEqual([...visibleExpandedIds(initialized, 'all', new Set())].sort(), ['gantt-child', 'gantt-root', 'outside']);
  assert.equal(initialized.hasManualExpansionInteraction, false);
  assert.equal(initialized.ganttExpansionInitialized, true);

  const returnedToGantt = initializeGanttExpansionState(
    initialized,
    new Set(),
    controlledIds,
    'all',
    new Set(),
  );
  assert.deepEqual([...visibleExpandedIds(returnedToGantt, 'all', new Set())].sort(), ['gantt-child', 'gantt-root', 'outside']);
});

test('Gantt initialization does not overwrite an earlier manual choice', () => {
  const original = createWorkExpansionState(['tree-default', 'branch', 'outside']);
  const recentPath = new Set(['root', 'branch', 'leaf']);
  const manuallyChosen = toggleWorkExpansionState(original, 'recent', 'branch', recentPath);
  assert.equal(manuallyChosen.hasManualExpansionInteraction, true);

  const initialized = initializeGanttExpansionState(
    manuallyChosen,
    new Set(['gantt-default', 'branch']),
    new Set(['branch', 'root', 'gantt-default']),
    'recent',
    recentPath,
  );

  assert.equal(visibleExpandedIds(initialized, 'recent', recentPath).has('branch'), false);
  assert.equal(visibleExpandedIds(initialized, 'recent', recentPath).has('leaf'), true);
  assert.equal(initialized.hasManualExpansionInteraction, true);
  assert.equal(initialized.ganttExpansionInitialized, true);

  const repeatedInitialization = initializeGanttExpansionState(
    initialized,
    new Set(),
    new Set(['branch', 'root', 'gantt-default']),
    'recent',
    recentPath,
  );
  assert.equal(visibleExpandedIds(repeatedInitialization, 'recent', recentPath).has('branch'), false);
  const restored = transitionWorkExpansionState(repeatedInitialization, 'all', new Set());
  assert.deepEqual([...visibleExpandedIds(restored, 'all', new Set())].sort(), ['branch', 'outside', 'tree-default']);
});

test('filtered toggles do not modify another scope’s saved expansion set', () => {
  const business = createWorkExpansionState(['project-alpha']);
  const stream = createWorkExpansionState(['milestone-stream']);
  const businessFiltered = toggleWorkExpansionState(business, 'attention', 'project-alpha', new Set(['project-alpha']));
  const streamFiltered = transitionWorkExpansionState(stream, 'quiet', new Set(['milestone-stream', 'quiet-task']));

  assert.deepEqual([...visibleExpandedIds(businessFiltered, 'all', new Set())], ['project-alpha']);
  assert.deepEqual([...visibleExpandedIds(streamFiltered, 'all', new Set())], ['milestone-stream']);
  assert.equal(visibleExpandedIds(streamFiltered, 'quiet', new Set(['milestone-stream', 'quiet-task'])).has('quiet-task'), true);
});

test('manager expansion fingerprints share collapsed paths across tree and gantt and restore the prior expansion', () => {
  const original = createWorkExpansionState(['project-alpha']);
  const revealed = new Set(['project-alpha', 'project', 'matching-task']);
  const fingerprint = 'team|people=don|q=invoice';
  const expanded = transitionWorkExpansionState(original, 'all', revealed, fingerprint);
  const collapsed = toggleWorkExpansionState(expanded, 'all', 'project', revealed, fingerprint);

  assert.equal(visibleExpandedIds(collapsed, 'all', revealed, fingerprint).has('project'), false);
  const returnedFromGantt = transitionWorkExpansionState(collapsed, 'all', revealed, fingerprint);
  assert.equal(visibleExpandedIds(returnedFromGantt, 'all', revealed, fingerprint).has('project'), false);

  const changedFingerprint = transitionWorkExpansionState(returnedFromGantt, 'all', revealed, 'team|people=juan|q=invoice');
  assert.equal(visibleExpandedIds(changedFingerprint, 'all', revealed, 'team|people=juan|q=invoice').has('project'), true);

  const restored = transitionWorkExpansionState(changedFingerprint, 'all', new Set());
  assert.deepEqual([...visibleExpandedIds(restored, 'all', new Set())], ['project-alpha']);
});

test('Gantt initialization and bulk expansion stay in the manager fingerprint scope', () => {
  const original = createWorkExpansionState(['tree-default']);
  const fingerprint = 'team|people=don|q=invoice';
  const revealPath = new Set(['project', 'matching-task']);
  const initialized = initializeGanttExpansionState(
    original,
    new Set(['gantt-root', 'project']),
    new Set(['gantt-root', 'project']),
    'all',
    revealPath,
    fingerprint,
  );

  assert.deepEqual(
    [...visibleExpandedIds(initialized, 'all', revealPath, fingerprint)].sort(),
    ['gantt-root', 'matching-task', 'project', 'tree-default'],
  );
  assert.deepEqual([...visibleExpandedIds(initialized, 'all', new Set())], ['tree-default']);
  assert.equal(initialized.hasManualExpansionInteraction, false);
  assert.equal(initialized.ganttExpansionInitialized, true);

  const bulkCollapsed = setWorkExpansionState(
    initialized,
    'all',
    new Set(['project']),
    new Set(['gantt-root', 'project', 'matching-task']),
    new Set(),
    fingerprint,
  );
  assert.deepEqual([...visibleExpandedIds(bulkCollapsed, 'all', new Set(), fingerprint)].sort(), ['project', 'tree-default']);
  assert.deepEqual([...visibleExpandedIds(bulkCollapsed, 'all', new Set())], ['tree-default']);
  assert.equal(bulkCollapsed.hasManualExpansionInteraction, true);
});

test('matching a visible leaf retains context ancestors hidden by visibility controls', () => {
  const items = [
    { id: 'scope-root', title: 'Scope', status: 'active', childIds: ['hidden-parent'] },
    { id: 'hidden-parent', title: 'Hidden planned parent', parent: 'scope-root', childIds: ['visible-leaf'] },
    { id: 'visible-leaf', title: 'Visible accepted leaf', parent: 'hidden-parent', status: 'active' },
  ];
  const projection = buildWorkProjection({
    items,
    evidence: [{
      id: 'evidence-1',
      itemId: 'visible-leaf',
      sourceEventId: 'event-1',
      occurredAt: '2026-10-01T02:00:00.000Z',
      kind: 'work',
      included: true,
    }],
    now: '2026-10-01T03:00:00.000Z',
  });
  const selection = selectWorkRows({
    projection,
    eligibleIds: ['visible-leaf'],
    activityFilter: 'recent',
    scopeRootId: 'scope-root',
  });

  assert.deepEqual([...selection.matchIds], ['visible-leaf']);
  assert.deepEqual([...selection.visibleIds].sort(), ['hidden-parent', 'scope-root', 'visible-leaf']);
  assert.deepEqual([...selection.contextIds].sort(), ['hidden-parent', 'scope-root']);
});
