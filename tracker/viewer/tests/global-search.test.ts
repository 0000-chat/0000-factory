import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { searchSnapshot } from '../src/global-search';
import { normalizeTrackerSnapshot } from '../src/snapshot';

interface SnapshotFixture {
  items?: Record<string, unknown>[];
  plans?: Record<string, unknown>[];
  decisions?: Record<string, unknown>[];
  team?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
}

function snapshot(fixture: SnapshotFixture = {}) {
  return normalizeTrackerSnapshot({
    schemaVersion: 4,
    items: fixture.items ?? [],
    plans: fixture.plans ?? [],
    decisions: fixture.decisions ?? [],
    team: fixture.team ?? [],
    history: fixture.history ?? [],
  });
}

function item(id: string, title: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title, ...fields };
}

function groupResults(query: string, fixture: SnapshotFixture, kind: string) {
  return searchSnapshot(snapshot(fixture), query).find(group => group.kind === kind)?.results ?? [];
}

test('ranks exact identities before title prefixes and requires every query token', () => {
  const data = snapshot({
    items: [
      item('finance', 'Unrelated work'),
      item('finance-prefix', 'Finance launch readiness'),
      item('finance-substring', 'Launch finance readiness'),
      item('release-finance', 'Release safeguards', { ownerName: 'Finance operations' }),
      item('release-partial', 'Release safeguards', { ownerName: 'Mikhail' }),
    ],
    team: [{ id: 'ada', slug: 'ada', name: 'Ada Lovelace', handle: 'ada-lovelace' }],
  });

  const work = searchSnapshot(data, 'FINANCE').find(group => group.kind === 'work');
  assert.ok(work);
  assert.deepEqual(work.results.map(result => result.id), [
    'finance',
    'finance-prefix',
    'finance-substring',
    'release-finance',
  ]);

  const allTokens = searchSnapshot(data, 'release finance').find(group => group.kind === 'work');
  assert.ok(allTokens);
  assert.deepEqual(allTokens.results.map(result => result.id), ['release-finance']);
  assert.equal(searchSnapshot(data, 'ADA-LOVELACE').find(group => group.kind === 'person')?.results[0]?.id, 'ada');
});

test('uses stable IDs for duplicate title ties and creates encoded canonical links', () => {
  const itemId = 'task/one ?#';
  const planId = 'plan/one ?#';
  const decisionId = 'decision/one ?#';
  const memberSlug = 'member/one ?#';
  const data = snapshot({
    items: [item('z-duplicate', 'Same title'), item('a-duplicate', 'Same title'), item(itemId, 'Unique work result')],
    plans: [{ id: planId, title: 'Unique plan result' }],
    decisions: [{ id: decisionId, title: 'Unique decision result' }],
    team: [{ id: 'member-id', slug: memberSlug, name: 'Unique person result' }],
  });

  assert.deepEqual(groupResults('same title', { items: [item('z-duplicate', 'Same title'), item('a-duplicate', 'Same title')] }, 'work').map(result => result.id), [
    'a-duplicate',
    'z-duplicate',
  ]);

  const groups = searchSnapshot(data, 'unique');
  assert.equal(groups.find(group => group.kind === 'work')?.results[0]?.href, `/work/${encodeURIComponent(itemId)}`);
  assert.equal(groups.find(group => group.kind === 'plan')?.results[0]?.href, `/plans/${encodeURIComponent(planId)}`);
  assert.equal(groups.find(group => group.kind === 'decision')?.results[0]?.href, `/decisions/${encodeURIComponent(decisionId)}`);
  assert.equal(groups.find(group => group.kind === 'person')?.results[0]?.href, `/team/${encodeURIComponent(memberSlug)}`);
});

test('handles missing optional metadata and gives work lifecycle states explicit subtitles', () => {
  const data = snapshot({
    items: [
      item('draft-item', 'Lifecycle draft', { status: 'queued', commitment: 'draft' }),
      item('planned-item', 'Lifecycle planned', { status: 'queued', commitment: 'planned' }),
      item('completed-item', 'Lifecycle completed', { status: 'done', commitment: 'accepted' }),
      item('archived-item', 'Lifecycle archived', { status: 'done', commitment: 'accepted', archived: true }),
      { id: 'ownerless', title: 'Missing owner metadata' },
    ],
    plans: [{ id: 'plan-without-extra-metadata' }],
    decisions: [{ id: 'decision-without-owner', title: 'Decision without owner metadata' }],
    team: [{ id: 'person-without-handle', name: 'Ada Lovelace' }],
  });

  const lifecycle = searchSnapshot(data, 'lifecycle').find(group => group.kind === 'work');
  assert.ok(lifecycle);
  assert.deepEqual(Object.fromEntries(lifecycle.results.map(result => [result.id, result.subtitle])), {
    'archived-item': 'Archived',
    'completed-item': 'Completed',
    'draft-item': 'Draft',
    'planned-item': 'Planned',
  });
  assert.equal(groupResults('missing owner', { items: [{ id: 'ownerless', title: 'Missing owner metadata' }] }, 'work')[0]?.subtitle, 'Work');
  assert.equal(groupResults('ada lovelace', { team: [{ id: 'person-without-handle', name: 'Ada Lovelace' }] }, 'person')[0]?.title, 'Ada Lovelace');
  assert.equal(groupResults('plan-without-extra-metadata', { plans: [{ id: 'plan-without-extra-metadata' }] }, 'plan')[0]?.subtitle, 'Proposed');
});

test('returns no groups for empty queries or empty snapshots and excludes retired history', () => {
  const empty = snapshot({ history: [{ id: 'retired-id', title: 'Retired search phrase' }] });
  assert.deepEqual(searchSnapshot(empty, 'retired'), []);
  assert.deepEqual(searchSnapshot(snapshot({ items: [item('current', 'Current work')] }), '  \t '), []);
  assert.deepEqual(searchSnapshot(snapshot(), 'anything'), []);
});

test('reports total matches while limiting every group to eight results', () => {
  const data = snapshot({
    items: Array.from({ length: 9 }, (_, index) => item(`work-${index + 1}`, `Shared work ${index + 1}`)),
    plans: Array.from({ length: 9 }, (_, index) => ({ id: `plan-${index + 1}`, title: `Shared plan ${index + 1}` })),
    decisions: Array.from({ length: 9 }, (_, index) => ({ id: `decision-${index + 1}`, title: `Shared decision ${index + 1}` })),
    team: Array.from({ length: 9 }, (_, index) => ({ id: `person-${index + 1}`, slug: `person-${index + 1}`, name: `Shared person ${index + 1}` })),
  });

  const groups = searchSnapshot(data, 'shared');
  assert.deepEqual(groups.map(group => group.kind), ['work', 'plan', 'decision', 'person']);
  assert.ok(groups.every(group => group.total === 9 && group.results.length === 8));
});
