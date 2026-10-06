import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { normalizeTrackerSnapshot } from '../src/snapshot.ts';

test('snapshot normalization preserves complete activity evidence and supports legacy snapshots', () => {
  const evidence = {
    id: 'update-7',
    originalItemId: 'fixture-beta',
    originalUpdateId: 'github-123',
    itemId: 'task-b',
    sourceEventId: 'github:123',
    occurredAt: '2026-10-02T03:00:00.000Z',
    discoveredAt: '2026-10-02T04:00:00.000Z',
    kind: 'result',
    summary: 'Synthetic report evidence recorded.',
    attributionBasis: 'linked-pr',
    evidenceRef: 'https://example.test/pull/123',
    included: true,
    amendmentIds: ['amendment-1'],
    approvalDecisionIds: ['decision-1'],
    preservedMetadata: { source: 'github' },
  };
  const snapshot = normalizeTrackerSnapshot({ items: [], activityEvidence: [evidence] });
  assert.deepEqual(snapshot.activityEvidence, [evidence]);

  const legacySnapshot = normalizeTrackerSnapshot({ items: [] });
  assert.deepEqual(legacySnapshot.activityEvidence, []);
  assert.deepEqual(legacySnapshot.deliveryRecords, []);
  assert.deepEqual(legacySnapshot.people, []);
});

test('delivery normalization exposes only canonical roster fields and suppresses duplicate discovery links', () => {
  const fixturePerson = {
    id: 'fxa',
    name: 'FixtureAlpha',
    fullName: 'FixtureBeta Person',
    aliases: ['FixtureBeta Person', 'FixtureGamma Person', 'fixture-alpha@example.test'],
    status: 'active',
    githubHandle: 'fxa',
    avatar: 'fixture-alpha.png',
    email: 'fixture-alpha@example.test',
    slackId: 'SLACK-FIXTURE-ALPHA',
    capacityPath: '/capacity/fixture-alpha-synthetic-hours.md',
  };
  const activityEvidence = [{
    id: 'evidence-a',
    itemId: 'fixture-beta',
    sourceEventId: 'github:commit-a',
    evidenceRef: 'https://example.test/commit/a',
    included: true,
  }];
  const deliveryRecords = ['one', 'two'].map(id => ({
    id: `discovery-${id}`,
    type: 'discovery',
    itemId: 'fixture-beta',
    updatedAt: '2026-10-03',
    sourcePath: `tracker/delivery/discovery-${id}.md`,
    sections: { observation: 'Synthetic source observation.' },
    attribution: 'clear',
    observedExecutor: 'fxa',
    evidenceIds: id === 'one' ? [] : ['evidence-a'],
    sourceRefs: id === 'one' ? ['github:commit-a'] : [],
    email: 'must-not-cross-the-snapshot-boundary@example.test',
  }));

  const snapshot = normalizeTrackerSnapshot({ items: [], people: [fixturePerson], activityEvidence, deliveryRecords });
  assert.deepEqual(snapshot.people, [{
    id: 'fxa',
    name: 'FixtureAlpha',
    fullName: 'FixtureBeta Person',
    status: 'active',
    githubHandle: 'fxa',
    avatar: 'fixture-alpha.png',
    aliases: ['FixtureBeta Person', 'FixtureGamma Person'],
  }]);
  assert.equal(snapshot.deliveryRecords.every(record => record.observedExecutor === null), true);
  assert.equal(Object.hasOwn(snapshot.deliveryRecords[0], 'email'), false);

  const assignedAgent = normalizeTrackerSnapshot({
    items: [{ id: 'fixture-beta', owner: 'fxa' }],
    people: [{ id: 'fxa', name: 'FixtureAlpha', githubHandle: 'fxa', status: 'active' }],
    decisions: [
      {
        id: 'assign-agent', state: 'approved', approvedBy: 'don', approvedAt: '2026-10-03',
        affects: ['fixture-beta'], executorItem: 'fixture-beta', executorKind: 'agent', executorRef: 'fixture-alpha',
      },
      {
        id: 'next-dri', state: 'approved', approvedBy: 'don', approvedAt: '2026-10-03',
        affects: ['fixture-beta'], nextItem: 'fixture-beta', nextActor: 'fxa',
      },
    ],
    deliveryRecords: [{
      id: 'brief-agent-fixture-beta', type: 'brief', itemId: 'fixture-beta', sections: {},
      executorKind: 'agent', executorRef: 'fixture-alpha',
      assignmentDecision: 'assign-agent', nextDecision: 'next-dri',
      approved: true, nextApproved: true,
    }],
  });
  assert.equal(assignedAgent.deliveryRecords[0].approved, true);
  assert.equal(assignedAgent.deliveryRecords[0].nextApproved, true);
});
