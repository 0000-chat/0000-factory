import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { normalizeTrackerSnapshot } from '../src/snapshot';
import { projectedAssigneeChoices, isTeamProjection } from '../src/team-mode';
import { projectedTeamProfiles } from '../src/team-model.mjs';
import { workFilterOptions } from '../src/work-filters';

function projection(items: Record<string, unknown>[]) {
  return normalizeTrackerSnapshot({
    source: {
      commit: 'projection-commit',
      layout: 'team-projection-v1',
      projectionId: 'team-weekly',
      week: '2026-W41',
      revision: '7',
      policyRevision: '3',
    },
    items,
    team: [],
    plans: [],
    decisions: [],
    releases: [],
  });
}

function item(id: string, owner: string | null, ownerName: string | null = owner) {
  return {
    id,
    title: id,
    owner,
    ownerName,
    status: 'active',
    commitment: 'accepted',
    completed: false,
    childIds: [],
    dependsOn: [],
  };
}

test('recognizes the public team projection marker and preserves only explicit person labels', () => {
  const data = projection([
    item('task-a', 'person-1'),
    item('task-b', 'person-1', 'Verified Person'),
    item('task-c', 'person-2'),
    item('task-d', null),
  ]);

  assert.equal(isTeamProjection(data), true);
  assert.deepEqual(projectedAssigneeChoices(data), [
    { value: 'person-2', label: 'person-2', verifiedLabel: false },
    { value: 'person-1', label: 'Verified Person', verifiedLabel: true },
  ]);
  assert.deepEqual(workFilterOptions(data, { teamProjection: true }).owners, [
    { value: '__unassigned__', label: 'Unassigned' },
    { value: 'person-1', label: 'Verified Person' },
    { value: 'person-2', label: 'person-2' },
  ]);
  assert.deepEqual(projectedTeamProfiles(data.items).map(profile => ({
    id: profile.id,
    name: profile.name,
    verifiedLabel: profile.verifiedLabel,
  })), [
    { id: 'person-2', name: 'person-2', verifiedLabel: false },
    { id: 'person-1', name: 'Verified Person', verifiedLabel: true },
  ]);
});

test('an older snapshot without a layout marker remains private-mode data', () => {
  const data = normalizeTrackerSnapshot({ source: { commit: 'private-commit' }, items: [] });
  assert.equal(isTeamProjection(data), false);
});

test('uses the safe companion directory for names and local avatar assets', () => {
  const data = projection([item('task-a', 'person-1')]);
  const profiles = projectedTeamProfiles(data.items, [
    { id: 'person-1', displayName: 'Synthetic Shared Person', avatar: 'person-1.png' },
    { id: 'person-2', displayName: 'Synthetic No Work Person', avatar: 'person-2.webp' },
    { id: 'person-3', displayName: 'Synthetic Unsafe Asset', avatar: '../private.png' },
  ]);
  assert.deepEqual(profiles.map(profile => ({ id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl })), [
    { id: 'person-2', name: 'Synthetic No Work Person', avatarUrl: '/avatars/person-2.webp' },
    { id: 'person-1', name: 'Synthetic Shared Person', avatarUrl: '/avatars/person-1.png' },
    { id: 'person-3', name: 'Synthetic Unsafe Asset', avatarUrl: null },
  ]);
});
