import { describe, expect, test } from 'bun:test';
import {
  buildReportsProjection,
  reportFilterOptions,
} from '../src/reports-model';
import { UNASSIGNED_OWNER } from '../src/routing-state';
import type { TrackerItem, TrackerSnapshot } from '../src/snapshot';

function item(id: string, overrides: Partial<TrackerItem> = {}): TrackerItem {
  return {
    id,
    title: id,
    type: 'task',
    status: 'active',
    parent: null,
    childIds: [],
    dependsOn: [],
    completed: false,
    commitment: 'accepted',
    plan: null,
    sections: { outcome: '', completionCondition: '', nextStep: '', evidence: '', blocker: null },
    progress: { scoped: false, percent: null, milestones: [], approvedAt: null, evidenceReviewedAt: null },
    health: { state: 'unknown', reason: '', missingInformation: '', suggestedAction: '', actor: '', reviewedAt: null },
    schedule: { plannedStart: null, plannedEnd: null, forecastStart: null, forecastEndMin: null, forecastEndMax: null, provisional: false, approved: false },
    effort: null,
    priority: null,
    linked: { decisions: [], releases: [], updates: [] },
    childSummary: { done: 0, total: 0 },
    approval: {},
    acceptance: {},
    blockers: [],
    owner: 'unassigned',
    ownerName: 'Unassigned',
    ...overrides,
  } as TrackerItem;
}

function snapshot(items: TrackerItem[], team: TrackerSnapshot['team'] = []): TrackerSnapshot {
  return {
    schemaVersion: 4,
    items,
    itemById: new Map(items.map(record => [record.id, record])),
    rootsByBucket: {},
    bucketOrder: [],
    defaultExpanded: [],
    plans: [],
    decisions: [],
    team,
    history: [],
    migrations: [],
    capacities: [],
    releases: [],
    source: {},
  };
}

function itemIds(records: readonly { id: string }[]): string[] {
  return records.map(record => record.id);
}

describe('reports cohort projection', () => {
  test('excludes accepted parents through planned and draft intermediates using the full graph', () => {
    const parent = item('project-alpha', { type: 'project', childIds: ['planned'] });
    const planned = item('planned', { commitment: 'planned', parent: 'project-alpha', childIds: ['draft'] });
    const draft = item('draft', { commitment: 'draft', parent: 'planned', childIds: ['leaf'] });
    const leaf = item('leaf', { parent: 'draft' });
    const projection = buildReportsProjection(snapshot([parent, planned, draft, leaf]));

    expect(projection.filters.scope).toBe('all');
    expect(itemIds(projection.records)).toEqual(['leaf']);
    expect(itemIds(projection.excludedAcceptedParents)).toEqual(['project-alpha']);
    expect(projection.excludedAcceptedParentCount).toBe(1);
  });

  test('planned and draft descendants alone do not disqualify an accepted terminal record', () => {
    const parent = item('project-alpha', { type: 'project', childIds: ['planned'] });
    const planned = item('planned', { commitment: 'planned', parent: 'project-alpha', childIds: ['draft'] });
    const draft = item('draft', { commitment: 'draft', parent: 'planned' });
    const projection = buildReportsProjection(snapshot([parent, planned, draft]));

    expect(itemIds(projection.records)).toEqual(['project-alpha']);
    expect(projection.excludedAcceptedParentCount).toBe(0);
  });

  test('terminal classification uses the full hierarchy before scope, completion, and owner filters', () => {
    const parent = item('project-alpha', { type: 'project', owner: 'parent-owner', ownerName: 'Parent Owner', childIds: ['leaf'] });
    const leaf = item('leaf', { parent: 'project-alpha', owner: 'leaf-owner', ownerName: 'Leaf Owner' });
    const data = snapshot([parent, leaf]);
    const leafProjection = buildReportsProjection(data, { scope: 'project-alpha', completed: false, owners: ['leaf-owner'] });
    const parentProjection = buildReportsProjection(data, { scope: 'project-alpha', completed: true, owners: ['parent-owner'] });

    expect(itemIds(leafProjection.records)).toEqual(['leaf']);
    expect(leafProjection.excludedAcceptedParentCount).toBe(0);
    expect(parentProjection.records).toHaveLength(0);
    expect(itemIds(parentProjection.excludedAcceptedParents)).toEqual(['project-alpha']);
  });

  test('safely handles empty graphs, missing parent records, and cycles', () => {
    expect(buildReportsProjection(snapshot([])).recordCount).toBe(0);
    const first = item('first', { parent: 'second' });
    const second = item('second', { parent: 'first' });
    const orphan = item('orphan', { parent: 'missing-id' });
    const projection = buildReportsProjection(snapshot([first, second, orphan]), { scope: 'all', completed: false, owners: [] });

    expect(itemIds(projection.records)).toEqual(['orphan']);
    expect(itemIds(projection.excludedAcceptedParents)).toEqual(['first', 'second']);
  });

  test('counts the blocked union once without treating health-only blocked as a blocker', () => {
    const explicit = item('explicit', {
      status: 'blocked',
      sections: { outcome: '', completionCondition: '', nextStep: '', evidence: '', blocker: 'Waiting for a key' },
      blockers: [{ reason: 'Waiting for a key' }],
      health: { state: 'blocked', reason: 'Blocked health reason', missingInformation: '', suggestedAction: '', actor: '', reviewedAt: null },
    });
    const healthOnly = item('health-only', {
      health: { state: 'blocked', reason: 'Health assessment only', missingInformation: '', suggestedAction: '', actor: '', reviewedAt: null },
    });
    const unknownHealth = item('unknown-health', {
      health: { state: 'new-value', reason: '', missingInformation: '', suggestedAction: '', actor: '', reviewedAt: null },
    });
    const projection = buildReportsProjection(snapshot([explicit, healthOnly, unknownHealth]), { scope: 'all', completed: false, owners: [] });

    expect(projection.blockedCount).toBe(1);
    expect(projection.healthCounts).toEqual({ 'on-track': 0, 'at-risk': 0, blocked: 2, unknown: 1 });
  });

  test('keeps missing and unmatched owners visible and attaches roster identity only by unique stable match', () => {
    const roster = [{ id: 'alex-id', slug: 'alex', name: 'Alex Roster Name', handle: 'alex-handle', githubHandle: 'alex-handle' }];
    const matched = item('matched', { owner: 'alex-handle', ownerName: 'Wrong Display Name' });
    const unmatched = item('unmatched', { owner: 'mystery-handle', ownerName: 'Alex Roster Name' });
    const missing = item('missing-owner', { owner: null, ownerName: null });
    const data = snapshot([matched, unmatched, missing], roster);
    const options = reportFilterOptions(data);
    const projection = buildReportsProjection(data, { scope: 'all', completed: false, owners: [] });
    const rows = new Map(projection.assignments.map(row => [row.ownerKey, row]));

    expect(options.ownerValues).toEqual(new Set(['alex-handle', 'mystery-handle', UNASSIGNED_OWNER]));
    expect(options.ownerChoices).toContainEqual({ value: 'alex-handle', label: 'Alex Roster Name' });
    expect(options.ownerChoices).toContainEqual({ value: 'mystery-handle', label: 'mystery-handle' });
    expect(projection.unassignedCount).toBe(1);
    expect(rows.get('alex-handle')).toMatchObject({ profileName: 'Alex Roster Name', profileSlug: 'alex' });
    expect(rows.get('mystery-handle')).toMatchObject({ ownerLabel: 'mystery-handle', profileName: null, profileSlug: null });
    expect(rows.get(UNASSIGNED_OWNER)).toMatchObject({ ownerLabel: 'Unassigned', recordCount: 1 });
  });

  test('preserves punctuation in stable roster matching and rejects ambiguous identities', () => {
    const roster = [
      { id: 'known-person', slug: 'known-person', name: 'Known Person', handle: 'known-person', githubHandle: 'known-person' },
      { id: 'first', slug: 'first', name: 'First Person', handle: 'shared-handle', githubHandle: 'shared-handle' },
      { id: 'second', slug: 'second', name: 'Second Person', handle: 'shared-handle', githubHandle: 'shared-handle' },
    ];
    const nearMatch = item('near-match', { owner: 'knownperson', ownerName: 'Known Person' });
    const exactMatch = item('exact-match', { owner: 'known-person' });
    const ambiguous = item('ambiguous', { owner: 'shared-handle', ownerName: 'First Person' });
    const projection = buildReportsProjection(snapshot([nearMatch, exactMatch, ambiguous], roster), { scope: 'all', completed: false, owners: [] });
    const records = new Map(projection.records.map(record => [record.id, record]));

    expect(records.get('near-match')).toMatchObject({ ownerLabel: 'knownperson', profileName: null, profileSlug: null });
    expect(records.get('exact-match')).toMatchObject({ ownerLabel: 'Known Person', profileName: 'Known Person', profileSlug: 'known-person' });
    expect(records.get('ambiguous')).toMatchObject({ ownerLabel: 'shared-handle', profileName: null, profileSlug: null });
  });

  test('classifies only valid approved baseline and forecast intervals', () => {
    const both = item('both', { schedule: { plannedStart: '2026-01-01', plannedEnd: '2026-01-02', forecastStart: '2026-01-03', forecastEndMin: '2026-01-04', forecastEndMax: '2026-01-05', provisional: false, approved: true } });
    const baseline = item('baseline', { schedule: { plannedStart: '2026-02-01', plannedEnd: '2026-02-02', forecastStart: null, forecastEndMin: null, forecastEndMax: null, provisional: false, approved: true } });
    const unapproved = item('unapproved', { schedule: { plannedStart: '2026-03-01', plannedEnd: '2026-03-02', forecastStart: null, forecastEndMin: null, forecastEndMax: null, provisional: false, approved: false } });
    const forecast = item('forecast', { schedule: { plannedStart: null, plannedEnd: null, forecastStart: '2026-04-01', forecastEndMin: '2026-04-02', forecastEndMax: '2026-04-03', provisional: false, approved: false } });
    const incomplete = item('incomplete', { schedule: { plannedStart: '2026-05-01', plannedEnd: null, forecastStart: '2026-05-01', forecastEndMin: null, forecastEndMax: null, provisional: false, approved: true } });
    const reversed = item('reversed', { schedule: { plannedStart: '2026-06-02', plannedEnd: '2026-06-01', forecastStart: '2026-06-02', forecastEndMin: null, forecastEndMax: '2026-06-01', provisional: false, approved: true } });
    const projection = buildReportsProjection(snapshot([both, baseline, unapproved, forecast, incomplete, reversed]), { scope: 'all', completed: false, owners: [] });

    expect(projection.scheduleCounts).toEqual({ 'approved-baseline-only': 1, 'forecast-only': 1, both: 1, none: 3 });
    expect(new Map(projection.records.map(record => [record.id, record.scheduleCoverage])).get('unapproved')).toBe('none');
    expect(projection.assignments.reduce((sum, row) => sum + row.unscheduledCount, 0)).toBe(3);
  });

  test('counts only scoped finite progress and reconciles every cohort dimension', () => {
    const items = [
      item('scoped', { progress: { scoped: true, percent: 42, milestones: [], approvedAt: null, evidenceReviewedAt: null } }),
      item('unscoped-with-percent', { progress: { scoped: false, percent: 70, milestones: [], approvedAt: null, evidenceReviewedAt: null } }),
      item('scoped-without-percent', { progress: { scoped: true, percent: null, milestones: [], approvedAt: null, evidenceReviewedAt: null } }),
      item('unscoped'),
    ];
    const projection = buildReportsProjection(snapshot(items), { scope: 'all', completed: false, owners: [] });
    const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, count) => total + count, 0);

    expect(projection.progressCounts).toEqual({ scoped: 1, unknown: 3 });
    expect(projection.records.find(record => record.id === 'scoped')).toMatchObject({ progressScoped: true, progressPercent: 42 });
    expect(projection.records.find(record => record.id === 'unscoped-with-percent')).toMatchObject({ progressScoped: false, progressPercent: null });
    expect(projection.records.every(record => record.href === `/work/${encodeURIComponent(record.id)}`)).toBe(true);
    expect(projection.recordCount).toBe(4);
    expect(projection.statusCounts.reduce((total, row) => total + row.count, 0)).toBe(projection.recordCount);
    expect(sum(projection.healthCounts)).toBe(projection.recordCount);
    expect(sum(projection.scheduleCounts)).toBe(projection.recordCount);
    expect(projection.progressCounts.scoped + projection.progressCounts.unknown).toBe(projection.recordCount);
    expect(projection.assignments.reduce((total, row) => total + row.recordCount, 0)).toBe(projection.recordCount);
  });
});
