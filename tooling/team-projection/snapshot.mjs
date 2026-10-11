/**
 * Adapt the validated public team projection to the existing viewer snapshot
 * shape. The adapter deliberately leaves canonical-only collections empty and
 * does not synthesize approval, decision, history, or publication records.
 */
const EMPTY_SOURCE_DIGEST = `sha256:${'0'.repeat(64)}`;

export function buildTeamProjectionSnapshot(projection, source = {}) {
  const initialized = projection.sourcePlanDigest !== EMPTY_SOURCE_DIGEST || projection.tasks.length > 0;
  const taskIds = projection.tasks.map(task => task.taskId);
  const items = projection.tasks.map(task => {
    const evidence = task.evidenceLinks.join('\n');
    const plannedEnd = task.approvedDate ?? null;
    const forecastEnd = task.forecastDate ?? null;
    return {
      id: task.taskId,
      title: task.title ?? task.taskId,
      type: 'task',
      status: task.status,
      phase: null,
      owner: task.assignee ?? null,
      ownerName: task.assignee ?? null,
      parent: null,
      dependsOn: [],
      // Projection generation is freshness metadata for the whole export. It
      // is not evidence that an individual task changed or completed.
      updatedAt: null,
      completedAt: null,
      target: plannedEnd,
      bucket: 'other',
      archived: false,
      completed: task.status === 'done',
      commitment: null,
      plan: null,
      sourcePath: null,
      sections: {
        outcome: task.scope ?? '',
        completionCondition: task.completionCondition ?? '',
        nextStep: task.nextStep ?? '',
        evidence,
        reviewer: task.reviewer ?? '',
        checkpoint: task.checkpoint ?? '',
        dependencies: task.dependencies.map(({ summary }) => summary).join('\n'),
        blocker: task.status === 'blocked' ? (task.nextStep ?? 'Blocked') : null,
      },
      teamProjection: {
        taskId: task.taskId,
        assignee: task.assignee ?? null,
        reviewer: task.reviewer ?? null,
        approvedDate: task.approvedDate ?? null,
        forecastDate: task.forecastDate ?? null,
        checkpoint: task.checkpoint ?? null,
        dependencies: task.dependencies.map(({ summary }) => summary),
        evidenceLinks: [...task.evidenceLinks],
      },
      childIds: [],
      childSummary: { done: 0, archived: 0, total: 0 },
      linked: { decisions: [], releases: [], updates: [] },
      progress: { scoped: false, percent: null, milestones: [] },
      health: {
        state: task.status === 'blocked' ? 'blocked' : 'unknown',
        reason: 'Team projection has no health assessment.',
        missingInformation: 'Health evidence is outside this projection.',
        suggestedAction: 'Coordinate the next step with the assigned owner.',
        actor: 'team',
        reviewedAt: null,
      },
      schedule: {
        plannedStart: null,
        plannedEnd,
        forecastStart: null,
        forecastEndMin: forecastEnd,
        forecastEndMax: forecastEnd,
        provisional: true,
        approved: false,
      },
      effort: { min: null, max: null, remainingMin: null, remainingMax: null },
      priority: { value: null, rationale: null },
      proposal: null,
      approval: {},
      acceptance: { state: 'team-projection', accepted: false, approved: false, eligible: false, held: false, blockers: [] },
      blockers: task.status === 'blocked' ? [{ id: task.taskId, reason: task.nextStep ?? 'Blocked' }] : [],
    };
  });

  return {
    schemaVersion: 4,
    source: {
      commit: source.commit ?? 'unknown',
      shortCommit: source.commit && source.commit !== 'unknown' ? source.commit.slice(0, 10) : 'unknown',
      committedAt: source.committedAt ?? null,
      dirty: Boolean(source.dirty),
      builtAt: initialized ? (source.builtAt ?? null) : null,
      layout: 'team-projection-v1',
      projectionId: projection.projectionId,
      week: projection.week,
      revision: projection.revision,
      policyRevision: projection.policyRevision,
      projectionState: initialized ? 'exported' : 'uninitialized',
      exportedAt: initialized ? projection.generatedAt : null,
      projectionGeneratedAt: initialized ? projection.generatedAt : null,
      projectionDigest: source.projectionDigest ?? null,
    },
    defaultExpanded: [],
    bucketOrder: ['other'],
    rootsByBucket: { other: taskIds },
    items,
    plans: [],
    deliveryRecords: [],
    people: [],
    history: [],
    migrations: [],
    capacities: [],
    decisions: [],
    releases: [],
    updates: [],
    activityEvidence: [],
    team: [],
  };
}
