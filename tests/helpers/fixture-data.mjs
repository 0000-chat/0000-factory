/**
 * Authored, data-only tracker fixtures for engine and hosting tests.
 *
 * The fixture writer deliberately keeps settings and static assets beside the
 * selected data inputs and never imports an application module from the
 * repository it writes.  All paths below are canonical tracker paths until
 * they are passed through the instance path contract.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parseInstanceConfig } from '../../tooling/instance/config.mjs';
import { repositoryPath } from '../../tooling/instance/paths.mjs';
import {
  acceptedTaskDigest,
  milestonePlanApprovalDigest,
  taskApprovalDigest,
} from '../../tooling/tracker/planning.mjs';

const SYNTHETIC_DOMAIN = 'fixture.test';
const SYNTHETIC_DATE = '2026-10-03';
const SYNTHETIC_TIMESTAMP = `${SYNTHETIC_DATE}T00:00:00Z`;
const SYNTHETIC_MIGRATION_COMMIT = 'b'.repeat(40);
const DEFAULT_ID = 'fixture';
const DEFAULT_MODE = 'empty';

const RETAINED_ACCEPTED_IDS = Object.freeze([
  'fixture-foundation-task',
  'fixture-dependent-task',
  'fixture-delivery-task',
  'fixture-review-task',
]);

const SUPPORTED_MODES = new Set(['empty', 'populated']);
const SUPPORTED_EVIDENCE = new Set(['none', 'grok-bot-v1']);
const SUPPORTED_ACCESS = new Set(['unconfigured', 'ready']);
const SUPPORTED_PUBLISH = new Set(['disabled', 'enabled', 'github-app']);

/** @param {unknown} value @param {string} name */
function optionText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name}: expected a non-empty string`);
  return value;
}

/** @param {string} value */
function boundedId(value) {
  const normalized = value.toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 63) {
    throw new TypeError('id: expected a lowercase kebab-case synthetic identifier of at most 63 characters');
  }
  return normalized;
}

/** @param {unknown} value @param {string} name */
function option(value, name, allowed, fallback) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'string' || !allowed.has(selected)) {
    throw new TypeError(`${name}: expected one of ${[...allowed].join(', ')}`);
  }
  return selected;
}

/** @param {string} id @param {number} max */
function shortId(id, max) {
  return id.length <= max ? id : id.slice(0, max).replace(/-+$/u, '');
}

/**
 * Build validated synthetic site settings.  The defaults intentionally model
 * an empty, read-only site.  `publishKind: 'enabled'` is an alias for the
 * versioned `github-app` setting and requires explicit ready Access.
 *
 * @param {{id?: string, folderPath?: string, evidenceKind?: string, accessKind?: string, publishKind?: string, weeklyPlanning?: boolean}} [options]
 */
export function fixtureInstance({
  id = DEFAULT_ID,
  folderPath = '',
  evidenceKind = 'none',
  accessKind = 'unconfigured',
  publishKind = 'disabled',
  weeklyPlanning = true,
} = {}) {
  const instanceId = boundedId(optionText(id, 'id'));
  if (typeof folderPath !== 'string') throw new TypeError('folderPath: expected a repository-relative path string');
  const folder = folderPath;
  const evidence = option(evidenceKind, 'evidenceKind', SUPPORTED_EVIDENCE, 'none');
  const access = option(accessKind, 'accessKind', SUPPORTED_ACCESS, 'unconfigured');
  const publish = option(publishKind, 'publishKind', SUPPORTED_PUBLISH, 'disabled');
  if (typeof weeklyPlanning !== 'boolean') throw new TypeError('weeklyPlanning: expected a boolean');
  const publishingEnabled = publish === 'enabled' || publish === 'github-app';
  if (publishingEnabled && access !== 'ready') {
    throw new TypeError('publishKind: enabled publishing requires accessKind: ready');
  }

  const idPrefix = shortId(instanceId, 48);
  const workerId = shortId(instanceId, 53);
  const readerEmail = `reader-${idPrefix}@${SYNTHETIC_DOMAIN}`;
  const publisherEmail = `publisher-${idPrefix}@${SYNTHETIC_DOMAIN}`;
  const accessDomain = `https://access-${shortId(instanceId, 52)}.${SYNTHETIC_DOMAIN}`;
  const instance = {
    schemaVersion: 1,
    id: instanceId,
    branding: {
      name: `Synthetic ${instanceId}`,
      title: `Synthetic ${instanceId} tracker`,
      description: 'Authored synthetic tracker fixture data.',
      markText: 'SYN',
      homeLabel: `Synthetic ${instanceId} tracker home`,
      loadingLabel: 'Loading synthetic tracker data…',
      faviconPath: 'assets/favicon.svg',
    },
    github: {
      owner: `fixture-${shortId(instanceId, 76)}`,
      repo: `tracker-${shortId(instanceId, 80)}`,
      branch: 'synthetic-main',
    },
    data: {
      folderPath: folder,
      layout: 'tracker-v1',
      evidence: { kind: evidence },
    },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: instanceId,
      storeId: `${instanceId}-fixture-store`,
      themeKey: `${instanceId}-fixture-theme`,
      editLockPrefix: `${instanceId}-fixture-edit-lock`,
      publishLockName: `${instanceId}-fixture-publish-lock`,
      unscheduledCollapsedKey: `${instanceId}.fixture.unscheduledCollapsed`,
      activityPausedKey: `${instanceId}.fixture.activityPaused`,
    },
    access: access === 'ready'
      ? {
        kind: 'ready',
        teamDomain: accessDomain,
        audience: `audience-${idPrefix}`,
        readerEmails: [readerEmail, publisherEmail],
        service: { kind: 'disabled' },
      }
      : { kind: 'unconfigured' },
    publish: publishingEnabled
      ? {
        kind: 'github-app',
        publisherEmail,
        recordActorId: `fixture-publisher-${idPrefix}`,
        operations: 'existing-task-edits-v1',
      }
      : { kind: 'disabled' },
    deployment: {
      accountBinding: `fixture-account-${idPrefix}`,
      workerName: `tracker-${workerId}`,
      customDomain: `tracker-${workerId}.${SYNTHETIC_DOMAIN}`,
      compatibilityDate: '2026-09-30',
      compatibilityFlags: ['nodejs_compat'],
    },
    features: { weeklyPlanning },
  };
  return parseInstanceConfig(instance);
}

/** @param {Record<string, string>} data */
function frontmatter(data) {
  return Object.entries(data)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** @param {string} title @param {{outcome?:string,completion?:string,next?:string,evidence?:string}} [sections] */
function itemBody(title, sections = {}) {
  return [
    `# ${title}`,
    '',
    '## Outcome',
    sections.outcome ?? `Deliver the synthetic ${title.toLowerCase()} scenario.`,
    '',
    '## Completion condition',
    sections.completion ?? 'The authored synthetic fixture is validated by the tracker model.',
    '',
    '## Next step',
    sections.next ?? 'Review the next synthetic fixture step.',
    '',
    '## Evidence',
    sections.evidence ?? 'Synthetic fixture evidence is recorded in this repository.',
    '',
  ].join('\n');
}

/** @param {string} title @param {string[]} sections */
function sectionBody(title, sections) {
  return [`# ${title}`, '', ...sections.flatMap(([heading, body]) => [`## ${heading}`, body, ''])].join('\n');
}

/** @param {Record<string, string>} data @param {string} body */
function markdown(data, body) {
  return `---\n${frontmatter(data)}\n---\n\n${body}`;
}

/**
 * Create the common item fields.  The returned object is intentionally kept
 * in the same shape as `loadTrackerFromFiles` records so digest helpers can be
 * applied before serializing it to Markdown.
 *
 * @param {{id:string,type?:string,status?:string,phase?:string,owner?:string,parent?:string,dependsOn?:string,project?:string,commitment?:string,acceptedFrom?:string,plan?:string,path:string,title?:string,approved?:boolean,plannedStart?:string,plannedEnd?:string}}
 */
function itemRecord({
  id,
  type = 'task',
  status = 'queued',
  phase = 'build',
  owner = 'unassigned',
  parent = 'fixture-project',
  dependsOn = '-',
  project = 'fixture-project',
  commitment = 'draft',
  acceptedFrom = '-',
  plan = '-',
  path,
  title = `Synthetic ${id}`,
  approved = false,
  plannedStart = '-',
  plannedEnd = '-',
}) {
  const accepted = commitment === 'accepted';
  const body = itemBody(title, {
    outcome: `Deliver the observable synthetic outcome for ${id}.`,
    completion: `The synthetic ${id} behavior is validated from data-only files.`,
    next: `Review the next authored step for ${id}.`,
  });
  const data = {
    id,
    type,
    status,
    phase,
    owner,
    parent,
    depends_on: dependsOn,
    project,
    commitment,
    accepted_from: acceptedFrom,
    plan,
    updated_at: SYNTHETIC_DATE,
    revision: 'r1',
    health_state: 'on-track',
    health_reason: 'Synthetic fixture state is intentionally controlled.',
    missing_information: 'none',
    suggested_action: 'Review the synthetic fixture.',
    suggested_actor: 'don',
    health_reviewed_at: SYNTHETIC_TIMESTAMP,
    planned_start: plannedStart,
    planned_end: plannedEnd,
    forecast_start: '-',
    forecast_end_min: '-',
    forecast_end_max: '-',
    schedule_provisional: accepted ? 'true' : '-',
    effort_min: '1',
    effort_max: '2',
    remaining_effort_min: accepted ? '1' : 'unknown',
    remaining_effort_max: accepted ? '1' : 'unknown',
    priority: 'unknown',
    priority_rationale: '-',
    target: '-',
    owner_proposed: accepted ? owner : '-',
    owner_proposal_rationale: accepted ? 'Synthetic fixture assignment is reviewed.' : '-',
  };
  const record = { data, body, path, name: id };
  if (approved) {
    Object.assign(data, {
      approval_state: 'approved',
      approved_by: 'don',
      approved_at: SYNTHETIC_TIMESTAMP,
      approval_ref: `fixture-approval-${id}`,
      approved_revision: 'r1',
      reviewed_detail: 'The exact synthetic fixture scope was reviewed.',
      approval_source: 'codex-chat',
      approved_parts: 'task,assignment,schedule',
    });
    data.approval_digest = taskApprovalDigest(record);
  }
  return record;
}

/** @param {string} id @param {string} supersededBy */
function historyRecord(id, supersededBy) {
  return {
    data: { id, superseded_by: supersededBy },
    body: itemBody(`Historical ${id}`, {
      outcome: 'Retain the synthetic historical record for migration coverage.',
      completion: 'The historical record points at its synthetic replacement.',
      next: 'Review migration provenance.',
    }),
    path: `tracker/history/${id}.md`,
    name: id,
  };
}

/** @param {string} id */
function renderRecord(record) {
  return markdown(record.data, record.body);
}

function syntheticRegistry() {
  return `${JSON.stringify({
    schemaVersion: 1,
    organizations: [{
      id: 'fixture-organization',
      name: 'Synthetic Fixture Organization',
    }],
    people: [
      {
        id: 'fixture-don',
        name: 'Fixture Don',
        fullName: 'Fixture Don Synthetic',
        email: 'fixture.don@fixture.test',
        status: 'active',
        aliases: ['owner', 'don'],
        githubHandle: 'fixture-don',
        organizationIds: ['fixture-organization'],
      },
      {
        id: 'fixture-builder',
        name: 'Fixture Builder',
        fullName: 'Fixture Builder Synthetic',
        email: 'fixture.builder@fixture.test',
        status: 'active',
        aliases: ['builder'],
        githubHandle: 'fixture-builder',
        organizationIds: ['fixture-organization'],
      },
    ],
  }, null, 2)}\n`;
}

function syntheticTeamGuide() {
  return `---\nrepo: synthetic-fixture\nstatus: current\n---\n\n# Synthetic fixture team guide\n\nThis guide is authored test data for the synthetic tracker fixture.\n\n## Fixture Don · [@fixture-don](https://fixture.test/people/fixture-don)\n- **Person ID:** fixture-don\n- **Full Name:** Fixture Don Synthetic\n- **Name Aliases:** don, owner\n- **Current:** Owns synthetic approvals.\n\n## Fixture Builder · [@fixture-builder](https://fixture.test/people/fixture-builder)\n- **Person ID:** fixture-builder\n- **Full Name:** Fixture Builder Synthetic\n- **Current:** Supplies synthetic execution observations.\n\nThe fixture has no production roster or external identities.\n`;
}

function changelog() {
  return `---\nrepo: synthetic-fixture\nstatus: current\n---\n\n# Synthetic fixture changelog\n\n- **${SYNTHETIC_DATE}:** Added the authored populated fixture for model and build tests.\n`;
}

/** @returns {{plan: object, milestone: object}} */
function approvedPlanRecords() {
  const plan = {
    data: {
      id: 'fixture-plan',
      project: 'fixture-project',
      status: 'approved',
      owner: 'unassigned',
      scope: 'Synthetic project delivery scope.',
      updated_at: SYNTHETIC_DATE,
      revision: 'p1',
      approved_by: 'don',
      approved_at: SYNTHETIC_TIMESTAMP,
      approval_ref: 'fixture-plan-approval',
      approved_revision: 'p1',
      reviewed_detail: 'The synthetic milestone scope was reviewed.',
      approval_source: 'codex-chat',
    },
    body: sectionBody('Synthetic fixture plan', [
      ['Objective', 'Exercise approved synthetic plan and milestone rendering.'],
      ['Evidence', 'The plan and milestone are authored in the fixture repository.'],
    ]),
    path: 'tracker/plans/fixture-plan.md',
    name: 'fixture-plan',
  };
  const milestone = {
    data: {
      id: 'fixture-milestone',
      item: 'fixture-foundation-task',
      plan_id: 'fixture-plan',
      weight: '1',
      status: 'approved',
      updated_at: SYNTHETIC_DATE,
      approval_state: 'approved',
      approved_by: 'don',
      approved_at: SYNTHETIC_TIMESTAMP,
      approval_ref: 'fixture-milestone-approval',
      approved_revision: 'p1',
      reviewed_detail: 'The synthetic milestone was reviewed.',
      approval_source: 'codex-chat',
      confirmation_state: 'pending',
    },
    body: sectionBody('Synthetic fixture milestone', [
      ['Outcome', 'Reach the first synthetic delivery milestone.'],
      ['Completion condition', 'The model validates the milestone against the approved plan.'],
      ['Evidence', 'Synthetic milestone evidence is present in the data repository.'],
    ]),
    path: 'tracker/milestones/fixture-milestone.md',
    name: 'fixture-milestone',
  };
  const digest = milestonePlanApprovalDigest(plan, [milestone]);
  plan.data.approval_digest = digest;
  milestone.data.approval_digest = digest;
  return { plan, milestone };
}

function capacityRecord() {
  return {
    data: {
      id: 'fixture-builder-capacity',
      person: 'fixture-builder',
      updated_at: SYNTHETIC_DATE,
      as_of: SYNTHETIC_DATE,
      provisional: 'false',
      weekly_days: '5',
      scheduled_days: '2',
      free_days: '3',
    },
    body: sectionBody('Synthetic builder capacity', [
      ['Context', 'Synthetic builder availability for fixture scheduling.'],
      ['Evidence', 'The capacity values are authored test data.'],
    ]),
    path: 'tracker/capacities/fixture-builder-capacity.md',
    name: 'fixture-builder-capacity',
  };
}

function updateRecord() {
  return {
    data: {
      id: 'initial-observation',
      item: 'fixture-foundation-task',
      source: 'synthetic-review',
      observed_at: SYNTHETIC_TIMESTAMP,
    },
    body: '# Synthetic observation\n\nThe fixture task has a source-backed synthetic observation.\n',
    path: 'tracker/updates/fixture-foundation-task/initial-observation.md',
    name: 'initial-observation',
  };
}

function deliveryRecord() {
  return {
    data: {
      id: 'fixture-delivery-brief',
      type: 'brief',
      item: 'fixture-delivery-task',
      updated_at: SYNTHETIC_DATE,
      executor_kind: 'agent',
      executor_ref: '-',
      assignment_decision: '-',
      next_decision: '-',
    },
    body: sectionBody('Synthetic delivery brief', [
      ['Outcome', 'Describe the synthetic delivery outcome.'],
      ['Context', 'The brief belongs to the authored populated fixture.'],
      ['Completion Evidence', 'The data-only fixture is loaded and validated.'],
      ['Dependencies', 'The synthetic foundation task is the only prerequisite.'],
      ['Next Action', 'Review the generated snapshot.'],
      ['Handoff', 'Hand the synthetic result to the fixture test.'],
    ]),
    path: 'tracker/delivery/fixture-delivery-brief.md',
    name: 'fixture-delivery-brief',
  };
}

function botEvidence() {
  const id = 'fixture-observation';
  return [
    {
      path: `grok-bot/inbox/synthetic-bot/${id}.md`,
      text: markdown({
        id,
        created_at: SYNTHETIC_TIMESTAMP,
        sender: 'fixture-builder',
        channel: 'synthetic',
      }, '# Synthetic bot observation\n\nThis message is authored evidence for the fixture only.\n'),
    },
    {
      path: `grok-bot/receipts/synthetic-bot/${id}.md`,
      text: markdown({
        id,
        status: 'done',
        updated_at: SYNTHETIC_TIMESTAMP,
        delivery_state: 'sent',
        request_digest: createHash('sha256').update('synthetic-fixture-bot-observation').digest('hex'),
        delivery_ref: 'https://bot.fixture.test/delivery/fixture-observation',
      }, '# Synthetic bot receipt\n\nThe synthetic bot evidence was recorded.\n'),
    },
  ];
}

/**
 * Build all canonical files for an empty or populated fixture.  The
 * populated fixture intentionally mirrors the current migration grammar: 94
 * live items and four historical replacement records produce 98 mappings.
 *
 * @param {Readonly<{data:{folderPath:string,evidence:{kind:string}}}>} instance
 * @param {'empty'|'populated'} mode
 * @returns {Map<string,string>}
 */
function canonicalFixtureFiles(instance, mode) {
  const files = new Map([
    ['team.md', syntheticTeamGuide()],
    ['tracker/people.json', syntheticRegistry()],
  ]);
  if (mode === 'empty') return files;

  const records = [];
  records.push(itemRecord({
    id: 'fixture-project',
    type: 'project',
    parent: '-',
    project: '-',
    path: 'tracker/items/fixture/fixture-project.md',
    title: 'Synthetic fixture project',
  }));

  const foundation = itemRecord({
    id: RETAINED_ACCEPTED_IDS[0],
    status: 'active',
    phase: 'build',
    owner: 'fixture-don',
    parent: 'fixture-project',
    dependsOn: '-',
    commitment: 'accepted',
    acceptedFrom: 'planned',
    plan: 'fixture-plan',
    path: `tracker/items/fixture/${RETAINED_ACCEPTED_IDS[0]}.md`,
    title: 'Synthetic foundation task',
    approved: true,
    plannedStart: '2026-10-04',
    plannedEnd: '2026-10-06',
  });
  const dependent = itemRecord({
    id: RETAINED_ACCEPTED_IDS[1],
    status: 'active',
    phase: 'build',
    owner: 'fixture-don',
    parent: 'fixture-project',
    dependsOn: RETAINED_ACCEPTED_IDS[0],
    commitment: 'accepted',
    acceptedFrom: 'planned',
    plan: 'fixture-plan',
    path: `tracker/items/fixture/${RETAINED_ACCEPTED_IDS[1]}.md`,
    title: 'Synthetic dependent task',
    approved: true,
    plannedStart: '2026-10-07',
    plannedEnd: '2026-10-09',
  });
  const delivery = itemRecord({
    id: RETAINED_ACCEPTED_IDS[2],
    status: 'active',
    phase: 'verify',
    owner: 'fixture-don',
    parent: 'fixture-project',
    dependsOn: RETAINED_ACCEPTED_IDS[1],
    commitment: 'accepted',
    acceptedFrom: 'planned',
    plan: 'fixture-plan',
    path: `tracker/items/fixture/${RETAINED_ACCEPTED_IDS[2]}.md`,
    title: 'Synthetic delivery task',
    approved: true,
    plannedStart: '2026-10-10',
    plannedEnd: '2026-10-12',
  });
  const review = itemRecord({
    id: RETAINED_ACCEPTED_IDS[3],
    status: 'active',
    phase: 'verify',
    owner: 'fixture-don',
    parent: 'fixture-project',
    dependsOn: RETAINED_ACCEPTED_IDS[2],
    commitment: 'accepted',
    acceptedFrom: 'planned',
    plan: 'fixture-plan',
    path: `tracker/items/fixture/${RETAINED_ACCEPTED_IDS[3]}.md`,
    title: 'Synthetic review task',
    approved: true,
    plannedStart: '2026-10-13',
    plannedEnd: '2026-10-15',
  });
  records.push(foundation, dependent, delivery, review);

  const additionalIds = [
    'fixture-draft-task',
    'fixture-planned-task',
    'fixture-unassigned-task',
  ];
  for (const id of additionalIds) {
    records.push(itemRecord({
      id,
      commitment: id === 'fixture-planned-task' ? 'planned' : 'draft',
      parent: 'fixture-project',
      dependsOn: id === 'fixture-unassigned-task' ? RETAINED_ACCEPTED_IDS[0] : '-',
      plan: id === 'fixture-planned-task' ? 'fixture-plan' : '-',
      path: `tracker/items/fixture/${id}.md`,
      title: `Synthetic ${id}`,
    }));
  }

  while (records.length < 94) {
    const index = records.length + 1;
    const id = `fixture-support-${String(index).padStart(3, '0')}`;
    records.push(itemRecord({
      id,
      parent: 'fixture-project',
      path: `tracker/items/fixture/${id}.md`,
      title: `Synthetic support task ${index}`,
    }));
  }

  for (const record of records) files.set(record.path, renderRecord(record));

  const histories = RETAINED_ACCEPTED_IDS.map((targetId, index) => {
    const id = `fixture-legacy-${String(index + 1).padStart(3, '0')}`;
    const record = historyRecord(id, targetId);
    files.set(record.path, renderRecord(record));
    return record;
  });
  const { plan, milestone } = approvedPlanRecords();
  files.set(plan.path, renderRecord(plan));
  files.set(milestone.path, renderRecord(milestone));
  const capacity = capacityRecord();
  files.set(capacity.path, renderRecord(capacity));
  const update = updateRecord();
  files.set(update.path, renderRecord(update));
  const deliveryRecordValue = deliveryRecord();
  files.set(deliveryRecordValue.path, renderRecord(deliveryRecordValue));
  files.set('tracker/changelog/2026-10-03.md', changelog());

  const migrationMappings = records.map(record => ({
    sourceId: record.data.id,
    sourcePath: RETAINED_ACCEPTED_IDS.includes(record.data.id)
      ? `tracker/active/${record.data.id}.md`
      : record.path,
    targetId: record.data.id,
    targetPath: record.path,
    historyPath: null,
  }));
  for (const [index, targetId] of RETAINED_ACCEPTED_IDS.entries()) {
    const sourceId = histories[index].data.id;
    const targetPath = `tracker/items/fixture/${targetId}.md`;
    migrationMappings.push({
      sourceId,
      sourcePath: `tracker/archive/${sourceId}.md`,
      targetId,
      targetPath,
      historyPath: histories[index].path,
    });
  }
  const recordsById = new Map(records.map(record => [record.data.id, record]));
  const migration = {
    schemaVersion: 1,
    sourceCommit: SYNTHETIC_MIGRATION_COMMIT,
    mappings: migrationMappings,
    legacyApprovals: Object.fromEntries(RETAINED_ACCEPTED_IDS.map(id => [
      id,
      {
        digest: acceptedTaskDigest(recordsById.get(id)),
        decision: 'project-alpha-delivery-schedule-2026-09-30',
      },
    ])),
  };
  files.set('tracker/decisions/project-alpha-delivery-schedule-2026-09-30.md', markdown({
    id: 'project-alpha-delivery-schedule-2026-09-30',
    state: 'approved',
    owner: 'don',
    affects: RETAINED_ACCEPTED_IDS.join(','),
    updated_at: SYNTHETIC_DATE,
    approved_by: 'don',
    approved_at: SYNTHETIC_DATE,
  }, '# Synthetic delivery approval\n\nThe retained synthetic tasks are approved for migration coverage.\n'));
  files.set('tracker/migrations/unified-work.json', `${JSON.stringify(migration, null, 2)}\n`);

  if (instance.data.evidence.kind === 'grok-bot-v1') {
    for (const evidence of botEvidence()) files.set(evidence.path, evidence.text);
  }
  return files;
}

/** @param {string} root @param {string} path */
function physicalPath(root, path) {
  return join(root, ...path.split('/'));
}

/** @param {string} path */
function mkdirOwned(path, ownedDirs) {
  const missing = [];
  let cursor = path;
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new TypeError(`fixture path must not traverse a symlink: ${cursor}`);
      if (!stat.isDirectory()) throw new TypeError(`fixture path must be a directory: ${cursor}`);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  mkdirSync(path, { recursive: true });
  for (const created of missing) ownedDirs.add(created);
}

/** @param {string} root @param {string} path @param {string} text @param {Set<string>} ownedFiles @param {Set<string>} ownedDirs */
function writeOwned(root, path, text, ownedFiles, ownedDirs) {
  const destination = physicalPath(root, path);
  try {
    const stat = lstatSync(destination);
    if (stat.isSymbolicLink()) throw new TypeError(`fixture output must not replace a symlink: ${path}`);
    throw new Error(`fixture output already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mkdirOwned(dirname(destination), ownedDirs);
  writeFileSync(destination, text, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  ownedFiles.add(destination);
}

/** @param {string} path */
function removeEmptyDirectory(path) {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Cleanup is idempotent and should not mask the test's primary failure.
  }
}

/** @param {string} root @param {Set<string>} ownedFiles @param {Set<string>} ownedDirs @param {boolean} rootCreated */
function cleanupOwned(root, ownedFiles, ownedDirs, rootCreated) {
  for (const file of [...ownedFiles].sort((left, right) => right.length - left.length)) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Cleanup is intentionally best effort and idempotent.
    }
  }
  for (const directory of [...ownedDirs].sort((left, right) => right.length - left.length)) {
    if (directory !== root) removeEmptyDirectory(directory);
  }
  if (rootCreated) removeEmptyDirectory(root);
}

/**
 * Write a complete data-only fixture and return its explicit repository and
 * settings paths.  If `repositoryPath` is omitted a uniquely owned temporary
 * repository is created under TMPDIR; when a caller supplies an existing
 * directory, cleanup removes only files/directories created by this call.
 *
 * @param {{repositoryPath?:string,instance:object,mode?:'empty'|'populated'}} options
 */
export function writeFixtureData({ repositoryPath: repositoryRoot, instance, mode = DEFAULT_MODE }) {
  const parsedInstance = parseInstanceConfig(instance);
  const selectedMode = option(mode, 'mode', SUPPORTED_MODES, DEFAULT_MODE);
  const tmpRoot = resolve(process.env.TMPDIR || tmpdir());
  mkdirSync(tmpRoot, { recursive: true });
  let dataRepo;
  let rootCreated = false;
  if (repositoryRoot === undefined) {
    dataRepo = mkdtempSync(join(tmpRoot, 'tracker-fixture-'));
    rootCreated = true;
  } else {
    if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) throw new TypeError('repositoryPath: expected a non-empty path');
    dataRepo = resolve(repositoryRoot);
    if (existsSync(dataRepo) && !lstatSync(dataRepo).isDirectory()) throw new TypeError('repositoryPath: expected a directory');
    if (!existsSync(dataRepo)) {
      mkdirOwned(dataRepo, new Set());
      rootCreated = true;
    }
  }

  const ownedFiles = new Set();
  const ownedDirs = new Set();
  const canonicalFiles = canonicalFixtureFiles(parsedInstance, selectedMode);
  const dataPath = parsedInstance.data.folderPath
    ? join(dataRepo, ...parsedInstance.data.folderPath.split('/'))
    : dataRepo;
  try {
    const settingsRepositoryPath = repositoryPath(parsedInstance, 'settings.json');
    const assetRepositoryPath = repositoryPath(parsedInstance, parsedInstance.branding.faviconPath);
    const settingsPath = join(dataPath, 'settings.json');
    const assetPath = join(dataPath, ...parsedInstance.branding.faviconPath.split('/'));
    writeOwned(dataRepo, settingsRepositoryPath, `${JSON.stringify(parsedInstance, null, 2)}\n`, ownedFiles, ownedDirs);
    writeOwned(dataRepo, assetRepositoryPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Synthetic fixture</title><rect width="32" height="32" fill="#5b6cff"/><text x="16" y="21" fill="#fff" font-size="14" text-anchor="middle">S</text></svg>\n', ownedFiles, ownedDirs);
    for (const [canonical, text] of canonicalFiles) {
      writeOwned(dataRepo, repositoryPath(parsedInstance, canonical), text, ownedFiles, ownedDirs);
    }
    return {
      dataRepo,
      dataPath,
      instance: parsedInstance,
      instancePath: settingsPath,
      settingsPath,
      assetPath,
      mode: selectedMode,
      files: canonicalFiles,
      cleanup: () => cleanupOwned(dataRepo, ownedFiles, ownedDirs, rootCreated),
    };
  } catch (error) {
    cleanupOwned(dataRepo, ownedFiles, ownedDirs, rootCreated);
    throw error;
  }
}

export const SYNTHETIC_FIXTURE_IDENTITIES = Object.freeze({
  domain: SYNTHETIC_DOMAIN,
  migrationCommit: SYNTHETIC_MIGRATION_COMMIT,
  retainedAcceptedIds: RETAINED_ACCEPTED_IDS,
});
