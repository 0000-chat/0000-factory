import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  buildWorkProjection,
  businessDayAge,
  calendarDayAge,
  manilaDay,
  millisecondsUntilManilaMidnight,
  selectWorkRows,
} from '../src/work-activity.mjs';

function item(id, overrides = {}) {
  return {
    id,
    title: id,
    status: 'queued',
    completed: false,
    owner: 'unassigned',
    parent: null,
    childIds: [],
    commitment: 'accepted',
    schedule: { approved: false },
    ...overrides,
  };
}

function event(id, itemId, occurredAt, overrides = {}) {
  return {
    id,
    originalItemId: itemId,
    originalUpdateId: id,
    itemId,
    sourceEventId: `source-${id}`,
    occurredAt,
    discoveredAt: '2026-10-02T00:00:00.000Z',
    kind: 'work',
    summary: `Summary ${id}`,
    attributionBasis: 'task-id',
    evidenceRef: `https://example.test/${id}`,
    included: true,
    amendmentIds: [],
    approvalDecisionIds: [],
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('Manila dates and business ages ignore the host timezone', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(manilaDay('2026-10-01T16:00:00.000Z'), '2026-10-02');
    assert.equal(manilaDay('2026-10-02T23:30:00'), '2026-10-02');
    assert.equal(manilaDay('2026-10-02'), '2026-10-02');
    assert.equal(manilaDay('not-a-date'), null);
    assert.equal(businessDayAge('2026-10-02', '2026-10-02'), 0);
    assert.equal(businessDayAge('2026-10-02', '2026-10-06'), 2);
    assert.equal(businessDayAge('2026-10-02', '2026-10-07'), 3);
    assert.equal(businessDayAge('2026-10-03', '2026-10-04'), 0);
    assert.equal(businessDayAge('2026-10-03', '2026-10-05'), 1);
    assert.equal(calendarDayAge('2026-10-02', '2026-10-05'), 3);
    assert.equal(millisecondsUntilManilaMidnight('2026-10-02T15:59:59.900Z'), 100);
    assert.equal(millisecondsUntilManilaMidnight('2026-10-02T16:00:00.000Z'), 24 * 60 * 60 * 1000);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('activity uses source occurrence, ignores discovery and discussion, and deduplicates task/source pairs', () => {
  const items = [item('late', { status: 'active', updatedAt: '2026-10-07' }), item('talk'), item('other-task')];
  const evidence = [
    event('late-update', 'late', '2026-10-01T12:00:00.000Z', { discoveredAt: '2026-10-07T00:00:00.000Z' }),
    event('talk-update', 'talk', '2026-10-06T00:00:00.000Z', { kind: 'discussion' }),
    event('first-copy', 'late', '2026-10-02T04:00:00.000Z', { sourceEventId: 'same-event', summary: 'first copy' }),
    event('retry-copy', 'late', '2026-10-02T04:00:00.000Z', { sourceEventId: 'same-event', summary: 'retry copy' }),
    event('same-event-on-other-task', 'other-task', '2026-10-02T04:00:00.000Z', { sourceEventId: 'same-event' }),
  ];
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-07' });

  assert.equal(projection.get('late').own.lastDate, '2026-10-02');
  assert.equal(projection.get('late').own.ageBusinessDays, 3);
  assert.equal(projection.get('late').own.state, 'quiet');
  assert.equal(projection.get('late').own.evidenceIds.includes('retry-copy'), false);
  assert.equal(projection.get('late').own.summary, 'first copy');
  assert.equal(projection.get('talk').own.state, 'unknown');
  assert.equal(projection.get('talk').own.firstDate, null);
  assert.equal(projection.get('talk').timeline.observedStart, null);
  assert.deepEqual(projection.get('other-task').own.evidenceIds, ['same-event-on-other-task']);
});

test('approved attribution corrections use effective task IDs and excluded originals add no dates', () => {
  const evidence = [
    event('original-update', 'wrong-task', '2026-10-01T00:00:00.000Z', { sourceEventId: 'source-shared', included: false }),
    event('amended-update', 'right-task', '2026-10-03T00:00:00.000Z', {
      sourceEventId: 'source-shared',
      originalItemId: 'wrong-task',
      amendmentIds: ['amendment-1'],
      approvalDecisionIds: ['decision-1'],
    }),
  ];
  const projection = buildWorkProjection({ items: [item('wrong-task'), item('right-task')], evidence, now: '2026-10-05' });
  assert.equal(projection.get('wrong-task').own.state, 'unknown');
  assert.equal(projection.get('wrong-task').timeline.observedStart, null);
  assert.deepEqual(projection.get('right-task').own.evidenceIds, ['amended-update']);
  assert.equal(projection.get('right-task').timeline.observedStart, '2026-10-03');
});

test('activity age and streaks are per task, count weekdays once, and skip weekends', () => {
  const items = [item('parent'), item('child', { parent: 'parent' }), item('hole'), item('weekend-streak')];
  const evidence = [
    event('parent-mon', 'parent', '2026-10-05T04:00:00.000Z'),
    event('child-tue', 'child', '2026-10-06T04:00:00.000Z'),
    event('hole-mon', 'hole', '2026-10-05T04:00:00.000Z'),
    event('hole-wed', 'hole', '2026-10-07T04:00:00.000Z'),
    event('hole-weekend', 'hole', '2026-10-10T04:00:00.000Z'),
    event('weekend-streak-fri', 'weekend-streak', '2026-10-09T04:00:00.000Z'),
    event('weekend-streak-sat', 'weekend-streak', '2026-10-10T04:00:00.000Z'),
    event('weekend-streak-mon', 'weekend-streak', '2026-10-12T04:00:00.000Z'),
  ];
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-12' });

  assert.deepEqual(projection.get('parent').own.streak, { days: 1, endDate: '2026-10-05' });
  assert.deepEqual(projection.get('child').own.streak, { days: 1, endDate: '2026-10-06' });
  assert.equal(projection.get('parent').descendants.streaks[0].days, 1);
  assert.deepEqual(projection.get('hole').own.streak, { days: 1, endDate: '2026-10-07' });
  assert.equal(projection.get('hole').own.ageBusinessDays, 1);
  assert.deepEqual(projection.get('weekend-streak').own.streak, { days: 2, endDate: '2026-10-12' });
});

test('subtree summaries count each unfinished descendant once and retain direct activity separately', () => {
  const items = [
    item('root', { status: 'active', owner: 'juan', childIds: ['middle', 'done-leaf'] }),
    item('middle', { parent: 'root', status: 'active', owner: 'mark', childIds: ['recent-leaf', 'unknown-leaf'] }),
    item('recent-leaf', { parent: 'middle', status: 'blocked', owner: 'juan' }),
    item('unknown-leaf', { parent: 'middle', status: 'queued', owner: 'adrian' }),
    item('another-mark', { parent: 'root', status: 'queued', owner: 'mark' }),
    item('done-leaf', { parent: 'root', status: 'done', completed: true, owner: 'mikhail' }),
  ];
  const evidence = [
    event('root-event', 'root', '2026-10-07T04:00:00.000Z'),
    event('middle-event', 'middle', '2026-09-28T04:00:00.000Z'),
    event('leaf-event', 'recent-leaf', '2026-10-07T04:00:00.000Z'),
    event('done-event', 'done-leaf', '2026-10-07T04:00:00.000Z'),
  ];
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-07' });
  const root = projection.get('root');

  assert.equal(root.own.state, 'recent');
  assert.deepEqual(root.descendants.recentIds, ['recent-leaf']);
  assert.deepEqual(root.descendants.quietIds, ['middle']);
  assert.deepEqual(root.descendants.unknownIds, ['unknown-leaf', 'another-mark']);
  assert.deepEqual(root.descendants.ownerIds, ['mark', 'adrian']);
  assert.deepEqual(root.descendants.streaks.map(({ id }) => id), ['middle', 'recent-leaf']);
  assert.deepEqual(projection.get('middle').descendants.recentIds, ['recent-leaf']);
  assert.deepEqual(projection.get('middle').descendants.ownerIds, ['juan', 'adrian']);
  assert.deepEqual(projection.get('root').childIds, ['middle', 'done-leaf', 'another-mark']);
});

test('ancestor owner stacks retain unfinished owners below completed intermediates', () => {
  const items = [
    item('root', { owner: 'OwnerA', childIds: ['completed-middle'] }),
    item('completed-middle', {
      parent: 'root',
      childIds: ['grandchild'],
      owner: 'OwnerB',
      status: 'done',
      completed: true,
      schedule: { approved: true, plannedStart: '2026-10-01', plannedEnd: '2026-10-03' },
    }),
    item('grandchild', { parent: 'completed-middle', owner: 'OwnerB', status: 'active' }),
    item('case-container', { owner: 'owner', childIds: ['handle-upper', 'handle-lower'] }),
    item('handle-upper', { parent: 'case-container', owner: 'MangKong-coder' }),
    item('handle-lower', { parent: 'case-container', owner: 'mangkong-coder' }),
    item('same-identity-root', { owner: 'MangKong-coder', childIds: ['same-identity-child'] }),
    item('same-identity-child', { parent: 'same-identity-root', owner: 'mangkong-coder' }),
  ];
  const evidence = [
    event('completed-work', 'completed-middle', '2026-10-01T04:00:00.000Z'),
    event('grandchild-work', 'grandchild', '2026-10-02T04:00:00.000Z'),
  ];
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-07' });

  assert.deepEqual(projection.get('completed-middle').descendants.ownerIds, []);
  assert.deepEqual(projection.get('root').descendants.ownerIds, ['ownerb']);
  assert.deepEqual(projection.get('root').descendants.quietIds, ['grandchild']);
  assert.equal(projection.get('completed-middle').own.lastDate, '2026-10-01');
  assert.equal(projection.get('root').timeline.plannedStart, '2026-10-01');
  assert.equal(projection.get('root').timeline.plannedDue, '2026-10-03');
  assert.equal(projection.get('root').timeline.observedStart, '2026-10-01');
  assert.equal(projection.get('root').timeline.observedEnd, '2026-10-02');
  assert.deepEqual(projection.get('case-container').descendants.ownerIds, ['mangkong-coder']);
  assert.deepEqual(projection.get('same-identity-root').descendants.ownerIds, []);
  assert.equal(projection.get('same-identity-root').owner, 'mangkong-coder');
  assert.equal(items.find(candidate => candidate.id === 'same-identity-root').owner, 'MangKong-coder');
});

test('approved schedules roll up independently from observed, proposed, and explicit forecast dates', () => {
  const items = [
    item('parent', {
      status: 'active',
      owner: 'juan',
      schedule: { approved: true, plannedStart: '2026-10-10', plannedEnd: '2026-10-15', forecastStart: '2026-10-16', forecastEndMax: '2026-10-20' },
    }),
    item('early-child', {
      parent: 'parent',
      status: 'active',
      schedule: { approved: true, plannedStart: '2026-10-05', plannedEnd: '2026-10-12', forecastStart: '2026-10-13', forecastEndMin: '2026-10-14' },
    }),
    item('completed-child', {
      parent: 'parent',
      status: 'done',
      completed: true,
      schedule: { approved: true, plannedStart: '2026-10-01', plannedEnd: '2026-10-30' },
    }),
    item('proposal', {
      parent: 'parent',
      commitment: 'planned',
      schedule: { approved: false, plannedStart: '2026-11-01', plannedEnd: '2026-11-02', forecastStart: '2026-11-03', forecastEndMax: '2026-11-04' },
    }),
  ];
  const evidence = [
    event('early-work', 'early-child', '2026-10-04T04:00:00.000Z'),
    event('done-work', 'completed-child', '2026-10-31T04:00:00.000Z', { kind: 'result' }),
  ];
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-20' });
  const parent = projection.get('parent').timeline;

  assert.equal(projection.get('parent').timeline.ownPlannedStart, '2026-10-10');
  assert.equal(projection.get('parent').timeline.ownPlannedDue, '2026-10-15');
  assert.equal(parent.plannedStart, '2026-10-01');
  assert.equal(parent.plannedDue, '2026-10-30');
  assert.equal(parent.observedStart, '2026-10-04');
  assert.equal(parent.observedEnd, '2026-10-31');
  assert.equal(parent.forecastStart, '2026-10-13');
  assert.equal(parent.forecastEnd, '2026-11-04');
  assert.equal(parent.proposedStart, '2026-11-01');
  assert.equal(parent.proposedEnd, '2026-11-02');
  assert.equal(parent.inferredStart, null);
  assert.equal(projection.get('proposal').timeline.plannedStart, null);
  assert.equal(projection.get('proposal').timeline.forecastStart, '2026-11-03');
});

test('accepted tasks retain explicit proposed spans and checkpoints separately from approved dates', () => {
  const projection = buildWorkProjection({
    items: [
      item('accepted-proposal', {
        schedule: {
          approved: true,
          plannedStart: '2026-10-01',
          plannedEnd: '2026-10-05',
          proposedStart: '2026-10-08',
          proposedEnd: '2026-10-08',
          proposedScheduleKind: 'checkpoint',
          proposedExplicit: true,
        },
      }),
    ],
    evidence: [],
    now: '2026-10-01',
  });
  const timeline = projection.get('accepted-proposal').timeline;
  assert.deepEqual([
    timeline.ownPlannedStart,
    timeline.ownPlannedDue,
    timeline.ownProposedStart,
    timeline.ownProposedDue,
    timeline.ownProposedScheduleKind,
    timeline.ownProposedExplicit,
  ], ['2026-10-01', '2026-10-05', '2026-10-08', '2026-10-08', 'checkpoint', true]);
  assert.equal(timeline.plannedStart, '2026-10-01');
  assert.equal(timeline.proposedStart, '2026-10-08');
  assert.equal(timeline.proposedEnd, '2026-10-08');
});

test('separately approved draft schedules count as planned while missing endpoints remain partial', () => {
  const projection = buildWorkProjection({
    items: [
      item('draft', { commitment: 'draft', schedule: { approved: true, plannedStart: '2026-10-10', plannedEnd: '2026-10-12' } }),
      item('partial', { schedule: { approved: true, plannedStart: '2026-10-10', plannedEnd: null } }),
      item('explicit-proposal', { commitment: 'planned', schedule: { approved: true, proposed: true, plannedStart: '2026-10-11', plannedEnd: '2026-10-13' } }),
      item('forecast-only', { status: 'active', schedule: { approved: false, forecastStart: '2026-10-12', forecastEndMax: '2026-10-14' }, updatedAt: '2026-10-19' }),
    ],
    evidence: [event('forecast-only-activity', 'forecast-only', null, { discoveredAt: '2026-10-20T00:00:00.000Z' })],
    now: '2026-10-20',
  });

  assert.equal(projection.get('draft').timeline.plannedStart, '2026-10-10');
  assert.equal(projection.get('partial').timeline.partial, true);
  assert.equal(projection.get('partial').timeline.plannedDue, null);
  assert.equal(projection.get('explicit-proposal').timeline.plannedStart, null);
  assert.equal(projection.get('explicit-proposal').timeline.proposedStart, '2026-10-11');
  assert.equal(projection.get('forecast-only').timeline.forecastEnd, '2026-10-14');
  assert.equal(projection.get('forecast-only').timeline.plannedDue, null);
  assert.equal(projection.get('forecast-only').timeline.observedStart, null);
  assert.equal(projection.get('forecast-only').own.state, 'unknown');
});

test('shared scheduled rows keep approved dates when commitment metadata is absent', () => {
  const projection = buildWorkProjection({
    items: [item('shared-scheduled', {
      commitment: null,
      status: 'active',
      owner: 'fixture-owner',
      ownerName: 'Fixture Owner',
      schedule: { approved: true, plannedStart: '2026-10-10', plannedEnd: '2026-10-12' },
    })],
    evidence: [],
    now: '2026-10-09',
  });

  const entry = projection.get('shared-scheduled');
  assert.equal(entry.status, 'active');
  assert.equal(entry.owner, 'fixture-owner');
  assert.equal(entry.ownerName, 'Fixture Owner');
  assert.equal(entry.timeline.plannedStart, '2026-10-10');
  assert.equal(entry.timeline.plannedDue, '2026-10-12');
  assert.equal(entry.timeline.partial, false);
});

test('structural context keeps neutral metadata while child schedules and owners roll up', () => {
  const projection = buildWorkProjection({
    items: [
      item('context-parent', {
        status: '',
        owner: null,
        contextOnly: true,
        childIds: ['shared-child'],
      }),
      item('shared-child', {
        parent: 'context-parent',
        status: 'started',
        owner: 'fixture-owner',
        schedule: { approved: true, plannedStart: '2026-10-01', plannedEnd: '2026-10-02' },
      }),
    ],
    evidence: [],
    now: '2026-09-30',
  });

  const context = projection.get('context-parent');
  assert.equal(context.status, '');
  assert.equal(context.owner, null);
  assert.deepEqual(context.timeline.plannedStart, '2026-10-01');
  assert.deepEqual(context.timeline.plannedDue, '2026-10-02');
  assert.deepEqual(context.descendants.ownerIds, ['fixture-owner']);
});

test('inferred starts and overdue age use only dated evidence and approved effective due dates', () => {
  const projection = buildWorkProjection({
    items: [
      item('overdue', { status: 'active', schedule: { approved: true, plannedEnd: '2026-10-04' } }),
      item('child', { parent: 'overdue', schedule: { approved: true, plannedEnd: '2026-10-02' } }),
      item('no-dates', { status: 'queued', updatedAt: '2026-10-20', observed_at: '2026-10-01' }),
      item('done-overdue', { status: 'done', completed: true, schedule: { approved: true, plannedEnd: '2026-10-01' } }),
    ],
    evidence: [
      event('before-plan', 'child', '2026-10-01T04:00:00.000Z'),
      event('undated', 'no-dates', null, { discoveredAt: '2026-10-19T04:00:00.000Z' }),
    ],
    now: '2026-10-07',
  });

  assert.equal(projection.get('overdue').timeline.plannedDue, '2026-10-04');
  assert.equal(projection.get('overdue').timeline.overdueCalendarDays, 3);
  assert.equal(projection.get('overdue').timeline.observedEnd, '2026-10-01');
  assert.ok(projection.get('overdue').attentionReasons.includes('overdue'));
  assert.equal(projection.get('no-dates').timeline.inferredStart, null);
  assert.equal(projection.get('no-dates').own.lastDate, null);
  assert.equal(projection.get('done-overdue').timeline.overdueCalendarDays, 0);
});

test('hierarchy uses canonical IDs, avoids cycles, and exposes match paths as context', () => {
  const items = [
    item('scope', { childIds: ['branch'] }),
    item('branch', { parent: 'scope', childIds: ['recent', 'quiet', 'blocked', 'unknown', 'active-unknown', 'done', 'listed'] }),
    item('recent', { parent: 'branch', status: 'active' }),
    item('quiet', { parent: 'branch', status: 'active' }),
    item('blocked', { parent: 'branch', status: 'blocked' }),
    item('unknown', { parent: 'branch', status: 'queued' }),
    item('active-unknown', { parent: 'branch', status: 'active' }),
    item('done', { parent: 'branch', status: 'done', completed: true }),
    item('listed', { status: 'queued' }),
    item('outside', { status: 'active' }),
  ];
  const evidence = [
    event('recent-event', 'recent', '2026-10-07T04:00:00.000Z'),
    event('quiet-event', 'quiet', '2026-09-30T04:00:00.000Z'),
    event('done-event', 'done', '2026-10-07T04:00:00.000Z'),
    event('outside-event', 'outside', '2026-10-07T04:00:00.000Z'),
  ];
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-07' });
  assert.equal(projection.get('listed').parentId, null);
  assert.equal(projection.get('branch').childIds.includes('listed'), false);
  const recent = selectWorkRows({ projection, eligibleIds: [...projection.keys()], activityFilter: 'recent', scopeRootId: 'scope' });
  assert.deepEqual([...recent.matchIds], ['recent']);
  assert.deepEqual([...recent.contextIds], ['branch', 'scope']);
  assert.deepEqual([...recent.visibleIds], ['recent', 'branch', 'scope']);
  assert.deepEqual([...recent.revealAncestorIds], ['branch', 'scope']);

  const quiet = selectWorkRows({ projection, eligibleIds: [...projection.keys()], activityFilter: 'quiet', scopeRootId: 'scope' });
  assert.deepEqual([...quiet.matchIds], ['quiet']);
  const attention = selectWorkRows({ projection, eligibleIds: [...projection.keys()], activityFilter: 'attention', scopeRootId: 'scope' });
  assert.deepEqual([...attention.matchIds], ['quiet', 'blocked', 'active-unknown']);
  assert.equal(attention.matchIds.has('active-unknown'), true);
  assert.equal(attention.matchIds.has('unknown'), false);
  assert.equal(attention.matchIds.has('done'), false);
  assert.equal(attention.matchIds.has('outside'), false);

  const all = selectWorkRows({ projection, eligibleIds: ['recent', 'done'], activityFilter: 'not-a-filter', scopeRootId: 'scope' });
  assert.deepEqual([...all.matchIds], ['recent', 'done']);
  assert.deepEqual([...all.contextIds], ['branch', 'scope']);
  assert.deepEqual([...all.revealAncestorIds], []);

  const managerSelected = selectWorkRows({
    projection,
    eligibleIds: ['recent'],
    activityFilter: 'all',
    revealAncestors: true,
    scopeRootId: 'scope',
  });
  assert.deepEqual([...managerSelected.matchIds], ['recent']);
  assert.deepEqual([...managerSelected.contextIds], ['branch', 'scope']);
  assert.deepEqual([...managerSelected.revealAncestorIds], ['branch', 'scope']);

  const cyclic = buildWorkProjection({
    items: [item('cycle-a', { parent: 'cycle-b' }), item('cycle-b', { parent: 'cycle-a' })],
    now: '2026-10-07',
  });
  assert.equal(cyclic.size, 2);
  assert.equal(cyclic.get('cycle-a').parentId, 'cycle-b');
  assert.equal(cyclic.get('cycle-b').parentId, null);
});

test('filter predicates remain direct and context does not inflate the match set', () => {
  const projection = buildWorkProjection({
    items: [item('parent', { status: 'active' }), item('child', { parent: 'parent', status: 'active' })],
    evidence: [event('child-event', 'child', '2026-10-07T04:00:00.000Z')],
    now: '2026-10-07',
  });
  const selected = selectWorkRows({ projection, eligibleIds: ['parent', 'child'], activityFilter: 'recent' });
  assert.deepEqual([...selected.matchIds], ['child']);
  assert.deepEqual([...selected.contextIds], ['parent']);
  assert.equal(selected.matchIds.size, 1);
  assert.equal(selected.visibleIds.size, 2);
});

test('projection and selectors do not mutate frozen inputs', () => {
  const items = deepFreeze([
    item('parent', { childIds: ['child'], schedule: { approved: true, plannedStart: '2026-10-01', plannedEnd: '2026-10-03' } }),
    item('child', { parent: 'parent' }),
  ]);
  const evidence = deepFreeze([event('frozen-event', 'child', '2026-10-02T04:00:00.000Z')]);
  const projection = buildWorkProjection({ items, evidence, now: '2026-10-07' });
  const before = JSON.stringify({ items, evidence });
  selectWorkRows({ projection, eligibleIds: ['child'], activityFilter: 'recent' });
  assert.equal(JSON.stringify({ items, evidence }), before);
  assert.deepEqual(projection.get('parent').childIds, ['child']);
});

test('stale childIds never override a canonical root or a child’s different parent', () => {
  const projection = buildWorkProjection({
    items: [
      item('parent-a', { childIds: ['root-child', 'owned-by-b'] }),
      item('parent-b', { childIds: ['owned-by-b'] }),
      item('root-child', { parent: null, status: 'active', schedule: { approved: true, plannedStart: '2026-10-01', plannedEnd: '2026-10-03' } }),
      item('owned-by-b', { parent: 'parent-b', status: 'active', schedule: { approved: true, plannedStart: '2026-10-04', plannedEnd: '2026-10-06' } }),
    ],
    evidence: [
      event('root-child-work', 'root-child', '2026-10-02T04:00:00.000Z'),
      event('other-parent-work', 'owned-by-b', '2026-10-05T04:00:00.000Z'),
    ],
    now: '2026-10-07',
  });

  assert.deepEqual(projection.get('parent-a').childIds, []);
  assert.equal(projection.get('root-child').parentId, null);
  assert.equal(projection.get('owned-by-b').parentId, 'parent-b');
  assert.equal(projection.get('parent-a').timeline.plannedStart, null);
  assert.equal(projection.get('parent-a').timeline.observedStart, null);
  assert.equal(projection.get('parent-b').timeline.plannedStart, '2026-10-04');
  assert.equal(projection.get('parent-b').timeline.observedStart, '2026-10-05');
  const scoped = selectWorkRows({
    projection,
    eligibleIds: [...projection.keys()],
    activityFilter: 'recent',
    scopeRootId: 'parent-a',
  });
  assert.deepEqual([...scoped.matchIds], []);
});
