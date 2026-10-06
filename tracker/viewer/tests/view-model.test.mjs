import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  externalDependencies,
  formatAsiaManilaDate,
  getExternalDependencies,
  getScopeItems,
  groupAttention,
  plansForScope,
  progressDisplayLabel,
  scheduleFeatures,
  scopeItemIds,
  workVisibility,
} from '../src/view-model.mjs';

function item(id, parent = null, extra = {}) {
  return { id, title: id, parent, commitment: 'accepted', status: 'active', health: { state: 'on-track', reason: 'Recent evidence supports the target.' }, ...extra };
}

test('scopes arbitrary nested project and task types without bucket or depth rules', () => {
  const items = [
    item('portfolio', null, { type: 'project' }),
    item('stream', 'portfolio', { type: 'task' }),
    item('subproject', 'stream', { type: 'project' }),
    item('deep-task', 'subproject', { type: 'milestone' }),
    item('other', null, { type: 'project' }),
  ];

  assert.deepEqual(scopeItemIds(items, 'stream'), ['stream', 'subproject', 'deep-task']);
  assert.deepEqual(getScopeItems(items, 'subproject').map(value => value.id), ['subproject', 'deep-task']);
  assert.deepEqual(scopeItemIds(items, null), items.map(value => value.id));
  assert.deepEqual(scopeItemIds(items, '*'), items.map(value => value.id));
});

test('returns distinct known dependencies outside the selected branch', () => {
  const items = [
    item('root'),
    item('branch', 'root', { dependsOn: ['outside', 'outside'] }),
    item('nested', 'branch', { dependsOn: ['outside', 'other-root'] }),
    item('outside'),
    item('other-root'),
  ];

  assert.deepEqual(externalDependencies(items, 'branch').map(value => value.id), ['outside', 'other-root']);
  assert.deepEqual(getExternalDependencies(items, 'branch').map(value => value.id), ['outside', 'other-root']);
  assert.deepEqual(externalDependencies(items, '*'), []);
});

test('keeps every plan and linked task visible through Work scope filters', () => {
  const plans = [
    { id: 'business-plan', project: 'project-alpha', taskIds: ['project-alpha', 'milestone-task', 'other-task'] },
    { id: 'aws-plan', project: 'aws-k8s-costs', taskIds: ['aws-k8s-costs'] },
  ];
  const scoped = plansForScope(plans, new Set(['milestone-task', 'child-task']));
  assert.deepEqual(scoped, plans);
  assert.deepEqual(plansForScope(plans, null), plans);
});

test('groups urgent health, Don decisions, actions, routine unknown, and excludes completed work', () => {
  const items = [
    item('zeta urgent', null, {
      priority: { level: 'high' },
      health: { state: 'blocked', reason: 'Waiting for a required decision.', suggestedAction: 'Ask Don to decide.', actor: 'Don' },
    }),
    item('alpha risk', null, {
      priority: { level: 'critical' },
      target: '2026-10-31',
      health: { state: 'at-risk', reason: 'Forecast threatens the launch target.', suggestedAction: 'Review the launch tradeoff.', actor: 'agent' },
    }),
    item('queued action', null, { status: 'queued', priority: { level: 'critical' } }),
    item('decision', null, { approvalStatus: 'pending', priority: { level: 'normal' } }),
    item('unknown routine', null, { health: { state: 'unknown', reason: 'Availability is unconfirmed.', suggestedAction: 'Confirm availability.', actor: 'Don' } }),
    item('completed blocked', null, { completed: true, health: { state: 'blocked', reason: 'Old blocker.' } }),
  ];

  const grouped = groupAttention(items, { now: '2026-09-30' });
  assert.deepEqual(grouped.urgent.map(value => value.id), ['alpha risk', 'zeta urgent']);
  assert.deepEqual(grouped.decisions.map(value => value.id), ['decision']);
  assert.deepEqual(grouped.actions.map(value => value.id), ['queued action']);
  assert.deepEqual(grouped.unknown.map(value => value.id), ['unknown routine']);
  assert.equal(grouped.urgent[0].attention.reason, 'Forecast threatens the launch target.');
  assert.equal(grouped.urgent[0].attention.actor, 'agent');
  assert.equal(grouped.urgent[0].attention.suggestedAction, 'Review the launch tradeoff.');
});

test('formats date-only values in the Asia/Manila calendar and keeps unscoped progress honest', () => {
  assert.equal(
    formatAsiaManilaDate('2026-09-30', { locale: 'en-GB', year: 'numeric', month: '2-digit', day: '2-digit' }),
    '30/09/2026'
  );
  assert.equal(progressDisplayLabel({ scoped: false, percent: 0 }), 'Unscoped');
  assert.equal(progressDisplayLabel({ scoped: true, percent: 0 }), '0%');
  assert.equal(progressDisplayLabel({ scoped: true, percent: 42.4 }), '42%');
});

test('hides draft and planned workload while preserving contextual ancestors and prerequisites', () => {
  const items = [
    item('planned-root', null, { commitment: 'draft' }),
    item('accepted-child', 'planned-root', { commitment: 'accepted', dependsOn: ['planned-prerequisite'] }),
    item('planned-prerequisite', null, { commitment: 'planned' }),
    item('planned-unrelated', null, { commitment: 'draft' }),
  ];
  const hidden = workVisibility(items, '*', false, false);
  assert.deepEqual(hidden.items.map(value => value.id), ['planned-root', 'accepted-child', 'planned-prerequisite']);
  assert.deepEqual([...hidden.contextualIds].sort(), ['planned-prerequisite', 'planned-root']);
  assert.deepEqual(hidden.workloadItems.map(value => value.id), ['accepted-child']);
  const shown = workVisibility(items, '*', true, false);
  assert.equal(shown.items.length, 3);
  assert.deepEqual(shown.workloadItems.map(value => value.id), ['accepted-child']);
  assert.deepEqual([...shown.contextualIds].sort(), ['planned-root']);
  const allStages = workVisibility(items, '*', true, true);
  assert.equal(allStages.items.length, 4);
  assert.deepEqual(allStages.workloadItems.map(value => value.id), ['accepted-child']);
  assert.equal(allStages.contextualIds.size, 0);
});

test('builds proposed bars for planned dates and approved bars only for accepted baselines', () => {
  const features = scheduleFeatures([
    item('planned', null, { commitment: 'planned', schedule: { plannedStart: '2026-10-01', plannedEnd: '2026-10-03', approved: false } }),
    item('accepted', null, { commitment: 'accepted', schedule: { plannedStart: '2026-10-01', plannedEnd: '2026-10-03', approved: true } }),
    item('scope-only', null, { commitment: 'accepted', schedule: { plannedStart: '2026-10-01', plannedEnd: '2026-10-03', approved: false } }),
    item('forecast', null, { commitment: 'accepted', schedule: { forecastStart: '2026-10-04', forecastEndMax: '2026-10-06', approved: false } }),
  ]);
  assert.deepEqual(features.map(feature => [feature.itemId, feature.kind, feature.proposed]), [
    ['planned', 'proposed', true],
    ['accepted', 'baseline', false],
    ['forecast', 'forecast', false],
  ]);
  assert.equal(features.some(feature => feature.itemId === 'scope-only' && feature.kind === 'baseline'), false);
  assert.equal(features.find(feature => feature.itemId === 'planned').name.startsWith('Planned proposed'), true);
});
