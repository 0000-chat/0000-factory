import { createHash } from 'node:crypto';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EMPTY_SOURCE_DIGEST = `sha256:${'0'.repeat(64)}`;

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalValue));
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function digestText(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function htmlText(value) {
  // The archive HTML boundary disallows URL-looking text and double slashes,
  // including when they occur inside otherwise harmless task descriptions.
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/(https?|file|javascript|vbscript|data):/giu, '$1&#58;')
    .replaceAll('//', '/&#47;');
}

function taskSummary(task) {
  const fields = [
    ['Projection task', task.taskId],
    ['Task', task.title],
    ['Status', task.status],
    ['Assignee', task.assignee ?? 'Unassigned'],
    ['Reviewer', task.reviewer ?? 'Unassigned'],
    ['Scope', task.scope ?? 'Not recorded'],
    ['Completion', task.completionCondition ?? 'Not recorded'],
    ['Next step', task.nextStep ?? 'Not recorded'],
    ['Checkpoint', task.checkpoint ?? 'Not recorded'],
    ['Forecast', task.forecastDate ?? 'Not recorded'],
    ['Dependencies', task.dependencies.length ? task.dependencies.map(({ summary }) => summary).join(' · ') : 'None recorded'],
    ['Evidence', task.evidenceLinks.length ? task.evidenceLinks.join(' · ') : 'None recorded'],
  ];
  return `<article class="team-projection-task"><h2>${htmlText(task.title ?? task.taskId)}</h2><dl>${fields.map(([label, value]) => `<div><dt>${htmlText(label)}</dt><dd>${htmlText(value)}</dd></div>`).join('')}</dl></article>`;
}

/**
 * Build a presentation-only planning archive from one validated projection.
 *
 * The result intentionally has blocked status and no current draft, approved
 * revision, canonical task references, or approval receipts. This lets the
 * existing weekly gallery show the team's public delivery view while keeping
 * canonical planning controls empty.
 */
export function buildTeamProjectionPlanningArchive(projection) {
  if (!projection || !DIGEST.test(projection.sourcePlanDigest)) throw new TypeError('projection.sourcePlanDigest must be a digest');
  if (projection.sourcePlanDigest === EMPTY_SOURCE_DIGEST && projection.tasks.length === 0) {
    return Object.freeze({ schemaVersion: 1, entries: Object.freeze([]), currentDraftId: null, latestApprovedId: null });
  }
  const id = `${projection.week}/${projection.revision}`;
  const paths = {
    manifest: `planning/weeks/${projection.week}/${projection.revision}/manifest.json`,
    plan: `planning/weeks/${projection.week}/${projection.revision}/plan.json`,
    presentation: `planning/weeks/${projection.week}/${projection.revision}/presentation.html`,
  };
  const presentationHtml = `<section class="team-projection" data-layout="team-projection-v1"><h1>Team work for ${htmlText(projection.week)} · ${htmlText(projection.revision)}</h1><p>Shared on ${htmlText(projection.generatedAt)}. This view contains the public team projection.</p>${projection.tasks.length ? projection.tasks.map(taskSummary).join('') : '<p>No public tasks are recorded for this projection.</p>'}</section>`;
  const outcomes = projection.tasks.map((task) => ({
    projectionTaskId: task.taskId,
    title: task.title,
    scope: task.scope,
    completionCondition: task.completionCondition,
    owner: task.assignee == null ? null : { personId: task.assignee },
    reviewer: task.reviewer,
    status: task.status,
    nextStep: task.nextStep,
    approvedDate: task.approvedDate,
    forecastDate: task.forecastDate,
    checkpoint: task.checkpoint,
    dependencies: task.dependencies,
    evidenceLinks: task.evidenceLinks,
  }));
  const plan = {
    schemaVersion: 1,
    kind: 'weekly-plan',
    id,
    week: projection.week,
    revision: projection.revision,
    status: 'blocked',
    presentationKind: 'team-projection',
    presentationOnly: true,
    timezone: 'Asia/Manila',
    asOf: projection.generatedAt,
    source: {
      sourceCommit: `team-projection:${projection.projectionId}`,
      contentRevision: projection.sourcePlanDigest,
      policyRevision: projection.policyRevision,
      generatorVersion: 'team-projection-presentation/1',
      producerRevision: 'projection-adapter-v1',
      inputDigest: projection.sourcePlanDigest,
    },
    coverage: {
      from: projection.generatedAt,
      to: projection.generatedAt,
      timezone: 'Asia/Manila',
      complete: false,
      gaps: [{ code: 'projection-only', message: 'The team projection does not include canonical weekly coverage.', sourceIds: [] }],
    },
    outcomes,
    queues: [],
    gaps: [],
    proposals: [],
    approvalRefs: [],
  };
  const planDigest = digest(plan);
  const htmlDigest = digestText(presentationHtml);
  const manifestBase = {
    schemaVersion: 1,
    kind: 'weekly-plan-manifest',
    id,
    week: projection.week,
    revision: projection.revision,
    status: 'blocked',
    presentationKind: 'team-projection',
    presentationOnly: true,
    generatedAt: projection.generatedAt,
    generatorVersion: plan.source.generatorVersion,
    producerRevision: plan.source.producerRevision,
    sourceCommit: plan.source.sourceCommit,
    sourceContentRevision: plan.source.contentRevision,
    policyRevision: plan.source.policyRevision,
    inputDigest: plan.source.inputDigest,
    planDigest,
    htmlDigest,
    artifactPaths: { manifest: paths.manifest, plan: paths.plan, html: paths.presentation },
    artifactDigests: { manifest: null, plan: planDigest, html: htmlDigest },
    immutable: true,
    outcomeTaskIds: [],
  };
  const manifestDigest = digest({ ...manifestBase, artifactDigests: { ...manifestBase.artifactDigests, manifest: null } });
  const manifest = { ...manifestBase, artifactDigests: { ...manifestBase.artifactDigests, manifest: manifestDigest } };
  return Object.freeze({
    schemaVersion: 1,
    entries: Object.freeze([Object.freeze({
      id,
      week: projection.week,
      date: projection.generatedAt.slice(0, 10),
      revision: projection.revision,
      status: 'blocked',
      reviewStatus: 'blocked',
      presentationKind: 'team-projection',
      presentationOnly: true,
      coverage: plan.coverage,
      hash: planDigest,
      paths,
      manifest,
      plan,
      presentationHtml,
    })]),
    currentDraftId: null,
    latestApprovedId: null,
  });
}
