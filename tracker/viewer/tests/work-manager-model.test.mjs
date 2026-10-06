import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { buildManagerProjection, selectManagerMatches } from '../src/work-manager-model.mjs';

const people = [
  { id: 'fxa', githubHandle: 'fixture-alpha', name: 'fxb', status: 'active' },
  { id: 'fxc', githubHandle: 'fixture-beta', fullName: 'FixtureAlpha Person', status: 'active' },
  { id: 'fxd', githubHandle: 'fixture-gamma', name: 'fxe', status: 'active' },
  { id: 'fixture-delta', githubHandle: 'fixture-epsilon', name: 'FixtureBeta', status: 'fixture-delta' },
];

function task(id, extra = {}) {
  return {
    id,
    title: id,
    type: 'task',
    status: 'queued',
    commitment: 'accepted',
    owner: 'fixture-alpha',
    dependsOn: [],
    acceptance: { accepted: true, approved: true, approvedParts: ['task', 'assignment'] },
    ...extra,
  };
}

function brief(itemId, extra = {}) {
  return {
    id: `brief-${itemId}`,
    type: 'brief',
    itemId,
    updatedAt: '2026-10-02T00:00:00Z',
    executorKind: 'human',
    executorRef: 'fxc',
    assignmentDecision: 'assign-fxc',
    nextDecision: 'next-fxc',
    approved: true,
    nextApproved: true,
    sections: {
      outcome: 'Execute the synthetic acceptance path.',
      context: 'This fixture covers synthetic coordination.',
      'completion evidence': 'Synthetic verification evidence is linked.',
      dependencies: 'Synthetic dependencies are recorded.',
      'next action': 'Run the synthetic verification.',
      handoff: 'Return the fixture result to Don.',
    },
    ...extra,
  };
}

const own = (state, summary = null, lastDate = null) => ({ own: { state, summary, lastDate } });

test('fixture parent current activity, approved DRI and human executor roles, and one task per person', () => {
  const items = [
    { id: 'fxf', type: 'project', status: 'active', commitment: 'accepted', childIds: ['ready'] },
    task('ready', { parent: 'fxf', status: 'queued' }),
  ];
  const projection = buildManagerProjection({
    items,
    activityProjection: new Map([['ready', own('recent', 'Synthetic verification update.', '2026-10-02')]]),
    deliveryRecords: [brief('ready')],
    decisions: [],
    people,
  });
  const ready = projection.byId.get('ready');
  assert.equal(ready.current, true);
  assert.equal(ready.upcoming, false);
  assert.deepEqual(ready.movement, { state: 'recent', summary: 'Synthetic verification update.', date: '2026-10-02' });
  assert.equal(ready.readiness, 'ready');
  assert.equal(ready.nextApproved, true);
  assert.deepEqual(ready.personRoles, [
    { personId: 'fxa', role: 'dri' },
    { personId: 'fxc', role: 'executor' },
  ]);
  assert.equal(projection.byId.get('fxf').readiness, 'not-assessed');
  assert.equal(projection.coverage.find(row => row.personId === 'fxa').taskTypeCounts.task, 1);
  assert.equal(projection.coverage.find(row => row.personId === 'fxc').taskTypeCounts.task, 1);
});

test('blocked work is current and waits on incomplete dependencies', () => {
  const blocked = task('blocked', { status: 'blocked', dependsOn: ['dependency'] });
  const projection = buildManagerProjection({
    items: [blocked, task('dependency', { status: 'active' })],
    deliveryRecords: [brief('blocked'), brief('dependency')],
    people,
  });
  const entry = projection.byId.get('blocked');
  assert.equal(entry.current, true);
  assert.equal(entry.upcoming, false);
  assert.equal(entry.readiness, 'waiting');
  assert.match(entry.reasons.join(' '), /Dependencies are incomplete/);
});

test('completed tasks are not current or upcoming', () => {
  const projection = buildManagerProjection({
    items: [task('complete', { status: 'done', completed: true })],
    activityProjection: new Map([['complete', own('recent', 'Synthetic completion evidence.', '2026-10-02')]]),
    people,
  });
  const entry = projection.byId.get('complete');
  assert.equal(entry.current, false);
  assert.equal(entry.upcoming, false);
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'team' })], []);
});

test('missing activity stays unknown without an updatedAt fallback', () => {
  const active = task('active', { status: 'active', updatedAt: '2026-10-02T00:00:00Z' });
  const queued = task('queued', { id: 'queued', owner: 'unassigned', acceptance: { accepted: true, approved: true, approvedParts: ['task'] } });
  const projection = buildManagerProjection({ items: [active, queued], people });
  const activeEntry = projection.byId.get('active');
  const queuedEntry = projection.byId.get('queued');
  assert.deepEqual(activeEntry.movement, { state: 'unknown', summary: null, date: null });
  assert.equal(activeEntry.current, true);
  assert.equal(queuedEntry.current, false);
  assert.equal(queuedEntry.upcoming, true);
  const fixtureAlphaCoverage = projection.coverage.find(row => row.personId === 'fxa');
  assert.deepEqual(fixtureAlphaCoverage.unknownCurrentIds, ['active']);
});

test('moving keeps a fixture project with own recent activity visible without counting it as task work', () => {
  const projection = buildManagerProjection({
    items: [
      { id: 'fxf', type: 'project', status: 'active' },
      task('child', { parent: 'fxf', status: 'queued' }),
    ],
    activityProjection: new Map([['fxf', own('recent', 'Synthetic parent activity.', '2026-10-03')]]),
    people,
  });
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'moving' })], ['fxf']);
  const fixtureAlphaCoverage = projection.coverage.find(row => row.personId === 'fxa');
  assert.equal(fixtureAlphaCoverage.counts.tasks, 1);
  assert.deepEqual(fixtureAlphaCoverage.movingIds, []);
});

test('fixture source-backed discoveries create observed roles and delivery matches', () => {
  const discovered = task('discovered', {
    commitment: 'draft',
    owner: 'unassigned',
    acceptance: { accepted: false, approved: false, approvedParts: [] },
  });
  const projection = buildManagerProjection({
    items: [discovered],
    deliveryRecords: [{
      id: 'discovery-1', type: 'discovery', itemId: 'discovered', origin: 'self-initiated',
      observedExecutor: 'fxd', sourceRefs: ['github:issue/12'], evidenceIds: ['evidence-12'],
      attribution: 'clear', approved: false,
    }],
    people,
  });
  assert.equal(projection.byId.get('discovered').unreviewed, true);
  assert.deepEqual(projection.byId.get('discovered').personRoles, [{ personId: 'fxd', role: 'observed' }]);
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'delivery', people: ['fxd'] })], ['discovered']);
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'delivery', people: ['fixture-delta'] })], []);
});

test('legacy fixture names and optional person aliases resolve to canonical active people', () => {
  const roster = [
    { id: 'fxa', githubHandle: 'fixture-alpha', name: 'fxb', fullName: 'fixture-zeta', aliases: ['FixtureGamma Person'], status: 'active' },
    { id: 'fxc', handle: 'fixture-eta', name: 'FixtureDelta', fullName: 'FixtureEpsilon Person', aliases: ['fxg'], status: 'active' },
    { id: 'fxd', name: 'fxe', aliases: ['FixtureZeta Person'], status: 'active' },
    { id: 'fxh', name: 'fxh', aliases: ['FixtureEta Person'], status: 'active' },
    { id: 'fixture-theta', name: 'FixtureTheta Person', aliases: ['fixture-iota'], status: 'active' },
  ];
  const items = [
    task('by-id', { owner: 'fxa' }),
    task('by-github-handle', { owner: 'fixture-alpha' }),
    task('by-handle', { owner: 'fixture-eta' }),
    task('by-name', { owner: 'fxe' }),
    task('by-full-name', { owner: 'fixture-zeta' }),
    task('by-alias', { owner: 'fxg' }),
    task('same-id-and-name', { owner: 'fxh' }),
    task('optional-snapshot-alias', { owner: 'fixture-iota' }),
    task('multiple-roles', { owner: 'fxb', status: 'active' }),
  ];
  const projection = buildManagerProjection({
    items,
    deliveryRecords: [
      brief('multiple-roles', { executorRef: 'fxg' }),
      {
        id: 'discovery-multiple-roles', type: 'discovery', itemId: 'multiple-roles',
        attribution: 'clear', observedExecutor: 'FixtureZeta Person',
        sourceRefs: ['github:issue/16'], evidenceIds: ['evidence-16'],
      },
    ],
    people: roster,
  });

  for (const [itemId, personId] of [
    ['by-id', 'fxa'],
    ['by-github-handle', 'fxa'],
    ['by-handle', 'fxc'],
    ['by-name', 'fxd'],
    ['by-full-name', 'fxa'],
    ['by-alias', 'fxc'],
    ['same-id-and-name', 'fxh'],
    ['optional-snapshot-alias', 'fixture-theta'],
  ]) {
    assert.deepEqual(projection.byId.get(itemId).personRoles, [{ personId, role: 'dri' }], itemId);
  }
  assert.deepEqual(projection.byId.get('multiple-roles').personRoles, [
    { personId: 'fxa', role: 'dri' },
    { personId: 'fxc', role: 'executor' },
    { personId: 'fxd', role: 'observed' },
  ]);
  assert.equal(projection.byId.get('multiple-roles').executor, 'FixtureEpsilon Person');
  assert.equal(projection.coverage.find(row => row.personId === 'fxa').taskTypeCounts.task, 4);
  assert.equal(projection.coverage.find(row => row.personId === 'fxc').taskTypeCounts.task, 3);
  assert.equal(projection.coverage.find(row => row.personId === 'fxd').taskTypeCounts.task, 2);
  assert.equal(projection.coverage.find(row => row.personId === 'fxh').taskTypeCounts.task, 1);
  assert.equal(projection.coverage.find(row => row.personId === 'fixture-theta').taskTypeCounts.task, 1);
});

test('identity collisions across people do not assign ambiguous names to any person', () => {
  const roster = [
    { id: 'fxi', name: 'FixtureIota Person', fullName: 'FixtureKappa Person', aliases: ['fixture-kappa'], status: 'active' },
    { id: 'fxj', name: 'FixtureLambda Person', fullName: 'FixtureMu Person Extended', aliases: ['FixtureKappa Person', 'fixture-kappa'], status: 'active' },
    { id: 'fxk', name: 'FixtureNu Person', status: 'active' },
  ];
  const projection = buildManagerProjection({
    items: [
      task('ambiguous-dri', { owner: 'fixture-kappa' }),
      task('ambiguous-executor', { owner: 'fxk', status: 'active' }),
    ],
    deliveryRecords: [
      brief('ambiguous-executor', { executorRef: 'FixtureKappa Person' }),
      {
        id: 'discovery-ambiguous-executor', type: 'discovery', itemId: 'ambiguous-executor',
        attribution: 'clear', observedExecutor: 'fixture-kappa',
        sourceRefs: ['github:issue/17'], evidenceIds: ['evidence-17'],
      },
    ],
    people: roster,
  });

  assert.deepEqual(projection.byId.get('ambiguous-dri').personRoles, []);
  assert.equal(projection.byId.get('ambiguous-executor').executor, 'FixtureKappa Person');
  assert.equal(projection.byId.get('ambiguous-executor').executorApproved, true);
  assert.deepEqual(projection.byId.get('ambiguous-executor').personRoles, [{ personId: 'fxk', role: 'dri' }]);
  assert.equal(projection.coverage.find(row => row.personId === 'fxi').taskTypeCounts.task, 0);
  assert.equal(projection.coverage.find(row => row.personId === 'fxj').taskTypeCounts.task, 0);
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'team', people: ['fxi', 'fxj'] })], []);
});

test('exact canonical IDs win over colliding aliases and fixture-mu IDs fail closed', () => {
  const roster = [
    { id: 'fxa', name: 'FixtureXi Person', fullName: 'fixture-lambda', status: 'active' },
    { id: 'fxc', name: 'FixtureOmicron Person', fullName: 'fixture-lambda', aliases: ['fxa'], status: 'active' },
    { id: 'fixture-mu', name: 'FixturePi Person', status: 'active' },
    { id: 'fixture-mu', name: 'FixtureRho Person', status: 'active' },
  ];
  const projection = buildManagerProjection({
    items: [
      task('exact-canonical-id', { owner: 'fxa' }),
      task('mixed-case-archived-name', { owner: 'fxl' }),
      task('ambiguous-full-name', { owner: 'fixture-lambda' }),
      task('fixture-mu-canonical-id', { owner: 'fixture-mu' }),
    ],
    people: roster,
  });

  assert.deepEqual(projection.byId.get('exact-canonical-id').personRoles, [{ personId: 'fxa', role: 'dri' }]);
  assert.deepEqual(projection.byId.get('mixed-case-archived-name').personRoles, []);
  assert.deepEqual(projection.byId.get('ambiguous-full-name').personRoles, []);
  assert.deepEqual(projection.byId.get('fixture-mu-canonical-id').personRoles, []);
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'team', people: ['fxa'] })], ['exact-canonical-id']);
});

test('coverage includes active people and an empty unassigned bucket without counting fixture-nus', () => {
  const projection = buildManagerProjection({
    items: [{ id: 'fixture-nu', type: 'project', status: 'active', childIds: [] }],
    people,
  });
  assert.deepEqual(projection.coverage.map(row => row.personId), ['fxa', 'fxc', 'fxd', '__unassigned__']);
  assert.ok(projection.coverage.every(row => row.taskTypeCounts.task === 0 && row.counts.tasks === 0));
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'team' })], []);
});

test('a task parent and its child each count once without descendant rollup duplication', () => {
  const projection = buildManagerProjection({
    items: [
      task('parent-coordination', { status: 'active', childIds: ['child-task'] }),
      task('child-task', { parent: 'parent-coordination', status: 'active' }),
    ],
    people,
  });
  const fixtureAlphaCoverage = projection.coverage.find(row => row.personId === 'fxa');
  assert.equal(fixtureAlphaCoverage.taskTypeCounts.task, 2);
  assert.deepEqual(fixtureAlphaCoverage.notAssessedIds, ['child-task', 'parent-coordination']);
});

test('coverage counts only upcoming ready tasks and quiet current tasks', () => {
  const itemList = [
    task('active-quiet', { status: 'active' }),
    task('queued-quiet', { id: 'queued-quiet' }),
    task('fixture-xi', { id: 'fixture-xi', status: 'active' }),
    task('queued-ready', { id: 'queued-ready' }),
  ];
  const projection = buildManagerProjection({
    items: itemList,
    activityProjection: new Map([
      ['active-quiet', own('quiet', 'Synthetic prior current evidence.', '2026-09-01')],
      ['queued-quiet', own('quiet', 'Synthetic prior queued evidence.', '2026-09-01')],
      ['fixture-xi', own('recent', 'Synthetic current activity.', '2026-10-03')],
    ]),
    deliveryRecords: itemList.map(item => brief(item.id)),
    people,
  });
  const fixtureAlphaCoverage = projection.coverage.find(row => row.personId === 'fxa');
  assert.deepEqual(fixtureAlphaCoverage.movingIds, ['fixture-xi']);
  assert.deepEqual(fixtureAlphaCoverage.quietIds, ['active-quiet']);
  assert.deepEqual(fixtureAlphaCoverage.readyIds, ['queued-quiet', 'queued-ready']);
});

test('the same person in multiple roles contributes only one task to each coverage row', () => {
  const projection = buildManagerProjection({
    items: [task('multi-role', { status: 'active' })],
    activityProjection: new Map([['multi-role', own('recent', 'Synthetic evidence note.', '2026-10-03')]]),
    deliveryRecords: [
      brief('multi-role', { executorRef: 'fxa', executorKind: 'human' }),
      {
        id: 'discovery-multi', type: 'discovery', itemId: 'multi-role', attribution: 'clear',
        observedExecutor: 'fxa', sourceRefs: ['github:issue/15'], evidenceIds: ['evidence-15'], approved: true,
      },
    ],
    people,
  });
  assert.deepEqual(projection.byId.get('multi-role').personRoles, [
    { personId: 'fxa', role: 'dri' },
    { personId: 'fxa', role: 'executor' },
    { personId: 'fxa', role: 'observed' },
  ]);
  const fixtureAlphaCoverage = projection.coverage.find(row => row.personId === 'fxa');
  assert.equal(fixtureAlphaCoverage.taskTypeCounts.task, 1);
  assert.deepEqual(fixtureAlphaCoverage.movingIds, ['multi-role']);
});

test('proposed human executors stay display-only while approved executors filter directly', () => {
  const projection = buildManagerProjection({
    items: [task('proposed', { status: 'active' }), task('fixture-omicron', { id: 'fixture-omicron', status: 'active' })],
    deliveryRecords: [
      brief('proposed', { approved: false }),
      brief('fixture-omicron', { id: 'brief-fixture-omicron', approved: true }),
    ],
    people,
  });
  assert.equal(projection.byId.get('proposed').executor, 'FixtureAlpha Person');
  assert.equal(projection.byId.get('proposed').executorApproved, false);
  assert.deepEqual(projection.byId.get('proposed').personRoles, [{ personId: 'fxa', role: 'dri' }]);
  assert.equal(projection.byId.get('fixture-omicron').executorApproved, true);
  assert.ok(projection.byId.get('fixture-omicron').personRoles.some(role => role.personId === 'fxc' && role.role === 'executor'));
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'team', people: ['fxc'] })], ['fixture-omicron']);
});

test('an approved agent executor can be ready while the human accountability bucket stays unassigned', () => {
  const projection = buildManagerProjection({
    items: [task('agent-ready', {
      owner: 'unassigned',
      acceptance: { accepted: true, approved: true, approvedParts: ['task'] },
    })],
    deliveryRecords: [brief('agent-ready', { executorKind: 'agent', executorRef: 'fixture-pi' })],
    people,
  });
  const entry = projection.byId.get('agent-ready');
  assert.equal(entry.readiness, 'ready');
  assert.equal(entry.executorApproved, true);
  assert.deepEqual(entry.personRoles, []);
  assert.ok(entry.gaps.some(gap => gap.includes('human DRI')));
  assert.deepEqual(projection.coverage.find(row => row.personId === '__unassigned__').readyIds, ['agent-ready']);
});

test('an unsequenced queue can be ready and is labeled as unsequenced', () => {
  const projection = buildManagerProjection({
    items: [task('unsequenced', { status: 'active' })],
    deliveryRecords: [brief('unsequenced', { nextApproved: false })],
    people,
  });
  const entry = projection.byId.get('unsequenced');
  assert.equal(entry.readiness, 'ready');
  assert.ok(entry.gaps.includes('Queue is not explicitly sequenced.'));
});

test('only unresolved proposed decisions owned by Don match needs-me', () => {
  const items = [
    { id: 'fxm', type: 'project', status: 'active', childIds: ['child-task'] },
    task('child-task', { parent: 'fxm' }),
    task('don-choice'),
    task('other-choice', { id: 'other-choice' }),
    task('approved-choice', { id: 'approved-choice' }),
  ];
  const projection = buildManagerProjection({
    items,
    decisions: [
      { id: 'don-proposed', state: 'proposed', owner: 'owner', affects: ['don-choice'], sections: { question: 'Choose the synthetic option.' } },
      { id: 'parent-proposed', state: 'proposed', owner: 'don', affects: ['fxm'] },
      { id: 'other-proposed', state: 'proposed', owner: 'fixture-alpha', affects: ['other-choice'] },
      { id: 'don-approved', state: 'approved', owner: 'don', affects: ['approved-choice'] },
    ],
    people,
  });
  const donChoice = projection.byId.get('don-choice');
  assert.equal(donChoice.decisions[0].question, 'Choose the synthetic option.');
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'needs-me' })].sort(), ['don-choice', 'fxm']);
});

test('coordination approval decisions are inspectable and outstanding delivery gaps are specific', () => {
  const projection = buildManagerProjection({
    items: [task('coordination-task', { status: 'active' })],
    deliveryRecords: [
      brief('coordination-task'),
      {
        id: 'send-note', type: 'coordination', itemId: 'coordination-task',
        approvalDecision: 'approve-message', messageApproved: false, dispatchState: 'draft',
      },
      {
        id: 'uncertain-note', type: 'coordination', itemId: 'coordination-task',
        approvalDecision: null, messageApproved: true, dispatchState: 'uncertain',
      },
      {
        id: 'receipt-only', type: 'coordination', itemId: 'coordination-task',
        approvalDecision: null, messageApproved: true, dispatchState: 'sent',
        deliveryReceipt: 'receipt-1', deliveryRef: null,
      },
    ],
    decisions: [{
      id: 'approve-message', state: 'proposed', owner: 'don', affects: [],
      sections: { question: 'Approve this exact message?' }, sourcePath: 'tracker/decisions/approve-message.md',
    }],
    people,
  });
  const entry = projection.byId.get('coordination-task');
  assert.ok(entry.gaps.some(gap => gap.includes('send-note') && gap.includes('Don approval')));
  assert.ok(entry.gaps.some(gap => gap.includes('uncertain-note') && gap.includes('receipt before retrying')));
  assert.ok(entry.gaps.some(gap => gap.includes('receipt-only') && gap.includes('lacks delivery proof')));
  assert.equal(entry.decisions[0].question, 'Approve this exact message?');
  assert.deepEqual([...selectManagerMatches({ managerProjection: projection, preset: 'needs-me' })], ['coordination-task']);
});

test('results use explicit milestone verification state and leave missing classification visible', () => {
  const unclassifiedResult = task('result-unclassified', {
    linked: { updates: [{
      id: 'result-update', activityKind: 'result', source: 'github:issue/43',
      occurredAt: '2026-10-03T09:00:00Z', evidenceRef: 'github:run/43',
    }] },
  });
  const excludedResult = task('result-excluded');
  const undatedResult = task('result-undated');
  const pendingReportedResult = task('result-pending', {
    progress: { scoped: true, milestones: [
      { id: 'fixture-rho', status: 'needs-reverification', confirmed: false, confirmation: { state: 'pending' } },
      { id: 'fixture-sigma', status: 'complete', confirmed: false, confirmation: { state: 'pending' } },
    ] },
  });
  const ordinaryIncomplete = task('ordinary-milestone', {
    progress: { scoped: true, milestones: [{ id: 'fixture-tau', status: 'approved', included: true, confirmed: false, confirmation: { state: 'pending' } }] },
  });
  const verifiedResult = task('result-verified', {
    linked: { updates: [{
      id: 'verified-update', activityKind: 'result', source: 'github:issue/44',
      occurredAt: '2026-10-03T09:00:00Z', evidenceRef: 'github:run/44',
    }] },
    progress: { scoped: true, allVerified: true, milestones: [{ id: 'fixture-upsilon', status: 'complete', confirmed: true }] },
  });
  const projection = buildManagerProjection({
    items: [unclassifiedResult, excludedResult, undatedResult, pendingReportedResult, ordinaryIncomplete, verifiedResult],
    activityEvidence: [
      { id: 'result-evidence', itemId: 'result-unclassified', kind: 'result', occurredAt: '2026-10-03T09:00:00Z', included: true },
      { id: 'excluded-evidence', itemId: 'result-excluded', kind: 'result', occurredAt: '2026-10-03T09:00:00Z', included: false },
      { id: 'undated-evidence', itemId: 'result-undated', kind: 'result', occurredAt: null, included: true },
      { id: 'pending-evidence', itemId: 'result-pending', kind: 'result', occurredAt: '2026-10-03T09:00:00Z', included: true },
      { id: 'ordinary-evidence', itemId: 'ordinary-milestone', kind: 'result', occurredAt: '2026-10-03T09:00:00Z', included: true },
      { id: 'verified-evidence', itemId: 'result-verified', kind: 'result', occurredAt: '2026-10-03T09:00:00Z', included: true },
    ],
    people,
  });
  assert.ok(projection.byId.get('result-unclassified').gaps.includes('A source-backed result needs a verification assessment.'));
  assert.ok(!projection.byId.get('result-excluded').gaps.some(gap => gap.includes('verification')));
  assert.ok(!projection.byId.get('result-undated').gaps.some(gap => gap.includes('verification')));
  assert.ok(projection.byId.get('result-pending').gaps.some(gap => gap.includes('awaiting verification')));
  assert.ok(!projection.byId.get('ordinary-milestone').gaps.some(gap => gap.includes('verification')));
  assert.ok(!projection.byId.get('result-verified').gaps.some(gap => gap.includes('verification')));
  const rawOnly = buildManagerProjection({ items: [unclassifiedResult], people });
  assert.ok(!rawOnly.byId.get('result-unclassified').gaps.some(gap => gap.includes('verification')));
  const unmatchedEvidence = buildManagerProjection({
    items: [task('unmatched-evidence')],
    activityProjection: new Map([['unmatched-evidence', { own: { evidenceIds: [] } }]]),
    activityEvidence: [{ id: 'unmatched-evidence-ref', itemId: 'unmatched-evidence', kind: 'result', occurredAt: '2026-10-03T09:00:00Z', included: true }],
    people,
  });
  assert.ok(!unmatchedEvidence.byId.get('unmatched-evidence').gaps.some(gap => gap.includes('verification')));
});

test('out-of-scope completed dependencies remain available for readiness facts while coverage stays scoped', () => {
  const projection = buildManagerProjection({
    items: [
      task('in-scope', { parent: 'fixture-phi', dependsOn: ['out-of-scope-done'] }),
      { id: 'fixture-phi', type: 'project', status: 'active' },
      task('out-of-scope-done', { status: 'done', completed: true }),
    ],
    deliveryRecords: [brief('in-scope')],
    scopeIds: ['fixture-phi', 'in-scope'],
    people,
  });
  assert.equal(projection.byId.has('out-of-scope-done'), true);
  assert.equal(projection.byId.get('in-scope').readiness, 'ready');
  assert.equal(projection.coverage.find(row => row.personId === 'fxa').counts.tasks, 1);
});

test('legacy accepted and draft tasks without operational metadata stay not-assessed', () => {
  const projection = buildManagerProjection({
    items: [task('legacy', { acceptance: {} }), task('archived-draft', { commitment: 'draft', acceptance: {} })],
    people,
  });
  const entry = projection.byId.get('legacy');
  assert.equal(entry.readiness, 'not-assessed');
  assert.ok(entry.gaps.some(gap => gap.includes('delivery brief')));
  assert.ok(entry.gaps.some(gap => gap.includes('assignment')));
  assert.equal(entry.nextApproved, false);
  assert.equal(projection.byId.get('archived-draft').readiness, 'not-assessed');
  assert.ok(projection.byId.get('archived-draft').reasons.includes('Task scope is not accepted.'));
});
