import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'bun:test';
import { loadTrackerFromFiles } from '../../tooling/tracker/model-core.mjs';
import { coordinationPayloadDigest } from '../../tooling/tracker/delivery-records.mjs';
import { acceptedTaskDigest, taskApprovalDigest } from '../../tooling/tracker/planning.mjs';
import { parseInstanceConfig } from '../../tooling/instance/config.mjs';
import { canonicalPath, repositoryPath } from '../../tooling/instance/paths.mjs';
import { patchTaskBody } from '../../tooling/tracker/publish-markdown.mjs';
import { readTaskField } from '../../worker/publish-domain.mjs';
import { GitHubApiError } from '../../worker/github-client.mjs';
import { handlePublishRequest as handlePublishRequestWithSettings } from '../../worker/publish-api.mjs';
import {
  isSourceFilePath as isSourceFilePathWithSettings,
  loadCurrentTracker as loadCurrentTrackerWithSettings,
  validateCandidateFiles as validateCandidateFilesWithSettings,
} from '../../worker/publish-source.mjs';
import {
  parseTaskPublishConflictResponse,
  parseTaskPublishPrepareResponse,
  parseTaskPublishReceipt,
} from '../../tracker/viewer/src/task-publishing.ts';

const DON_EMAIL = 'publisher@example.test';
const PUBLISH_AT = new Date(Date.now() + 60_000);
const FIELD_NEXT_STEP = 'sections.nextStep';
const FIELD_OUTCOME = 'sections.outcome';
const initialSha = 'a'.repeat(40);
const DRAFT_TASK_ID = 'fixture-draft-task';
const PLANNED_TASK_ID = 'fixture-planned-task';
const ACCEPTED_TASK_ID = 'fixture-accepted-task';
const ACCEPTED_RUNTIME_TASK_ID = 'fixture-accepted-runtime';
const ACCEPTED_CLOUD_TASK_ID = 'fixture-accepted-cloud';
const ACCEPTED_SUPPORT_TASK_ID = 'fixture-accepted-support';
const EDIT_TASK_ID = 'fixture-edit-task';
const RETAINED_ACCEPTED_IDS = [
  ACCEPTED_TASK_ID,
  ACCEPTED_RUNTIME_TASK_ID,
  ACCEPTED_CLOUD_TASK_ID,
  ACCEPTED_SUPPORT_TASK_ID,
];

const TEST_INSTANCE = parseInstanceConfig({
  schemaVersion: 1,
  id: 'synthetic-publisher',
  branding: {
    name: 'Synthetic Publisher', title: 'Synthetic publisher tracker', description: 'Synthetic publisher test',
    markText: 'SYN', homeLabel: 'Home', loadingLabel: 'Loading', faviconPath: 'assets/favicon.svg',
  },
  github: { owner: 'synthetic-owner', repo: 'synthetic-repo', branch: 'main' },
  data: { folderPath: '', layout: 'tracker-v1', evidence: { kind: 'grok-bot-v1' } },
  model: { approvalProtocol: 'don-v1' },
  browser: {
    namespace: 'synthetic-publisher', storeId: 'synthetic-publisher-store', themeKey: 'synthetic-publisher-theme',
    editLockPrefix: 'synthetic-publisher-edit-lock', publishLockName: 'synthetic-publisher-publish-lock',
    unscheduledCollapsedKey: 'synthetic-publisher.unscheduled', activityPausedKey: 'synthetic-publisher.activity',
  },
  access: {
    kind: 'ready', teamDomain: 'https://access.synthetic.test', audience: 'synthetic-audience',
    readerEmails: [DON_EMAIL], service: { kind: 'disabled' },
  },
  publish: {
    kind: 'github-app', publisherEmail: DON_EMAIL, recordActorId: 'don', operations: 'existing-task-edits-v1',
  },
  deployment: {
    accountBinding: 'synthetic-account', workerName: 'synthetic-publisher-worker', customDomain: 'synthetic-publisher.example.test',
    compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
  },
});

const NESTED_INSTANCE = parseInstanceConfig({
  ...structuredClone(TEST_INSTANCE),
  data: { ...TEST_INSTANCE.data, folderPath: 'sites/synthetic-publisher' },
});

function instanceForPrefix(repositoryPrefix) {
  if (repositoryPrefix === TEST_INSTANCE.data.folderPath) return TEST_INSTANCE;
  if (repositoryPrefix === NESTED_INSTANCE.data.folderPath) return NESTED_INSTANCE;
  throw new TypeError(`Unsupported synthetic repository prefix: ${repositoryPrefix}`);
}

function remotePath(path, repositoryPrefix) {
  return repositoryPath(instanceForPrefix(repositoryPrefix), path);
}

function localPath(path, repositoryPrefix) {
  return canonicalPath(instanceForPrefix(repositoryPrefix), path);
}

function handlePublishRequest(request, actor, env, options = {}) {
  return handlePublishRequestWithSettings(request, actor, env, {
    ...options,
    instance: options.instance ?? TEST_INSTANCE,
  });
}

function isSourceFilePath(path) {
  return isSourceFilePathWithSettings(path, TEST_INSTANCE);
}

function loadCurrentTracker(github, sourceCommit, instance = TEST_INSTANCE) {
  return loadCurrentTrackerWithSettings(github, sourceCommit, instance);
}

function validateCandidateFiles(files) {
  return validateCandidateFilesWithSettings(files, TEST_INSTANCE);
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

function syntheticItem(id, {
  commitment = 'draft',
  status = 'queued',
  owner = 'unassigned',
  ownerProposed = '-',
  plannedStart = '-',
  plannedEnd = '-',
  scheduleProvisional = '-',
  project = 'fixture-project',
  approvedAt = null,
  approvedRevision = '-',
  approvedParts = '-',
} = {}) {
  const accepted = commitment === 'accepted';
  const body = [
    `# Synthetic ${id}`,
    '',
    '## Outcome',
    `Synthetic outcome for ${id}.`,
    '',
    '## Completion condition',
    'The synthetic fixture behavior is verified.',
    '',
    '## Next step',
    `Continue the synthetic ${id} scenario.`,
    '',
    '## Evidence',
    'Synthetic fixture evidence.',
    '',
  ].join('\n');
  const frontmatter = [
    '---',
    `id: ${id}`,
    'type: task',
    `status: ${status}`,
    'phase: build',
    `owner: ${owner}`,
    'parent: -',
    'depends_on: -',
    `project: ${project}`,
    `commitment: ${commitment}`,
    `accepted_from: ${accepted ? 'planned' : '-'}`,
    'plan: -',
    'updated_at: 2026-10-03',
    'revision: r1',
    'health_state: on-track',
    'health_reason: Synthetic fixture is intentionally controlled.',
    'missing_information: none',
    'suggested_action: none',
    'suggested_actor: don',
    'health_reviewed_at: 2026-10-03T00:00:00Z',
    `planned_start: ${plannedStart}`,
    `planned_end: ${plannedEnd}`,
    'forecast_start: -',
    'forecast_end_min: -',
    'forecast_end_max: -',
    `schedule_provisional: ${scheduleProvisional}`,
    'effort_min: unknown',
    'effort_max: unknown',
    'remaining_effort_min: unknown',
    'remaining_effort_max: unknown',
    'priority: unknown',
    'priority_rationale: -',
    'target: -',
    `owner_proposed: ${ownerProposed}`,
    `owner_proposal_rationale: ${ownerProposed === '-' ? '-' : 'Synthetic assignment fixture.'}`,
    ...(approvedAt ? [`approved_at: ${approvedAt}`] : []),
    `approved_revision: ${approvedRevision}`,
    `approved_parts: ${approvedParts}`,
    '---',
    '',
    '',
  ].join('\n');
  return `${frontmatter}${body}`;
}

function syntheticHistory(id, supersededBy) {
  return [
    '---',
    `id: ${id}`,
    `superseded_by: ${supersededBy}`,
    '---',
    '',
    `# Historical ${id}`,
    '',
    '## Outcome',
    'Historical synthetic record.',
    '',
    '## Completion condition',
    'Historical record is retained.',
    '',
    '## Next step',
    'None.',
    '',
    '## Evidence',
    'Synthetic fixture.',
    '',
  ].join('\n');
}

function syntheticMigration(itemRecords) {
  const identityMappings = itemRecords.map(item => ({
    sourceId: item.data.id,
    sourcePath: RETAINED_ACCEPTED_IDS.includes(item.data.id)
      ? `tracker/active/${item.data.id}.md`
      : `tracker/items/fixture/${item.data.id}.md`,
    targetId: item.data.id,
    targetPath: item.path,
    historyPath: null,
  }));
  const historicalMappings = RETAINED_ACCEPTED_IDS.map((targetId, index) => {
    const sourceId = `fixture-legacy-${String(index + 1).padStart(3, '0')}`;
    return {
      sourceId,
      sourcePath: `tracker/archive/${sourceId}.md`,
      targetId,
      targetPath: itemRecords.find(item => item.data.id === targetId).path,
      historyPath: `tracker/history/${sourceId}.md`,
    };
  });
  return {
    schemaVersion: 1,
    sourceCommit: initialSha,
    mappings: [...identityMappings, ...historicalMappings],
    legacyApprovals: {},
  };
}

function currentSourceFiles() {
  const files = new Map([
    ['team.md', '# Synthetic tracker team\n\nThis fixture supplies no external product data.\n'],
    ['tracker/people.json', JSON.stringify({
      schemaVersion: 1,
      organizations: [{ id: 'fixture-org', name: 'Synthetic Fixture Org' }],
      people: [{
        id: 'don',
        name: 'FixtureDon',
        fullName: 'FixtureDon Person',
        status: 'active',
        aliases: ['owner'],
        githubHandle: 'fixture-don',
        organizationIds: ['fixture-org'],
      }],
    }) + '\n'],
  ]);
  const acceptedOptions = {
    commitment: 'accepted',
    status: 'active',
    owner: 'don',
    ownerProposed: 'don',
    plannedStart: '2026-10-10',
    plannedEnd: '2026-10-12',
    scheduleProvisional: 'true',
    approvedAt: '2026-10-03T00:00:00Z',
    approvedRevision: 'r1',
    approvedParts: 'task,assignment,schedule',
  };
  const taskIds = [DRAFT_TASK_ID, PLANNED_TASK_ID, EDIT_TASK_ID, ...RETAINED_ACCEPTED_IDS];
  while (taskIds.length < 94) taskIds.push(`fixture-support-${String(taskIds.length + 1).padStart(3, '0')}`);
  for (const id of taskIds) {
    const options = RETAINED_ACCEPTED_IDS.includes(id) ? acceptedOptions : {};
    files.set(`tracker/items/fixture/${id}.md`, syntheticItem(id, options));
  }
  for (const [index, targetId] of RETAINED_ACCEPTED_IDS.entries()) {
    const sourceId = `fixture-legacy-${String(index + 1).padStart(3, '0')}`;
    files.set(`tracker/history/${sourceId}.md`, syntheticHistory(sourceId, targetId));
  }
  files.set('tracker/decisions/project-alpha-delivery-schedule-2026-09-30.md', [
    '---',
    'id: project-alpha-delivery-schedule-2026-09-30',
    'state: approved',
    'owner: don',
    `affects: ${RETAINED_ACCEPTED_IDS.join(',')}`,
    'updated_at: 2026-10-03',
    'approved_by: don',
    'approved_at: 2026-10-03',
    '---',
    '',
    '# Synthetic approval decision',
    '',
  ].join('\n'));
  const itemRecords = loadTrackerFromFiles(files).items;
  const migration = syntheticMigration(itemRecords);
  migration.legacyApprovals = Object.fromEntries(RETAINED_ACCEPTED_IDS.map(id => {
    const item = itemRecords.find(candidate => candidate.data.id === id);
    return [id, {
      digest: acceptedTaskDigest(item),
      decision: 'project-alpha-delivery-schedule-2026-09-30',
    }];
  }));
  files.set('tracker/migrations/unified-work.json', `${JSON.stringify(migration, null, 2)}\n`);
  return files;
}

function splitItemSource(source) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(source);
  assert.ok(match, 'fixture item has YAML frontmatter and a body');
  return { opening: match[1], frontmatter: match[2], closing: match[3], body: match[4] };
}

function rewriteFrontmatter(source, { set = {}, remove = [] } = {}) {
  const parts = splitItemSource(source);
  const removeKeys = new Set(remove);
  const remaining = new Map(Object.entries(set));
  const lines = parts.frontmatter.split(/\r?\n/).flatMap(line => {
    const match = /^([a-z][a-z0-9_-]*):(?:\s|$)/i.exec(line);
    if (!match) return [line];
    const key = match[1];
    if (removeKeys.has(key)) return [];
    if (!remaining.has(key)) return [line];
    const value = remaining.get(key);
    remaining.delete(key);
    return [`${key}: ${value}`];
  });
  for (const [key, value] of remaining) lines.push(`${key}: ${value}`);
  const eol = parts.opening.endsWith('\r\n') ? '\r\n' : '\n';
  return `${parts.opening}${lines.join(eol)}${parts.closing}${parts.body}`;
}

function patchItemSource(source, fields) {
  const parts = splitItemSource(source);
  return `${parts.opening}${parts.frontmatter}${parts.closing}${patchTaskBody(parts.body, fields)}`;
}

function incrementRevision(revision) {
  const match = /^r([1-9]\d*)$/.exec(String(revision ?? ''));
  assert.ok(match, `fixture uses a supported revision: ${revision}`);
  const current = Number(match[1]);
  assert.ok(Number.isSafeInteger(current + 1), `fixture revision can be incremented: ${revision}`);
  return `r${current + 1}`;
}

test('pure publish-source file maps include canonical people and linked delivery proof', () => {
  assert.equal(isSourceFilePath('tracker/people.json'), true);
  assert.equal(isSourceFilePath('tracker/delivery/coordination-proof.md'), true);
  assert.equal(isSourceFilePath('grok-bot/inbox/0000-cos/20261003T120000Z-delivery-proof.md'), true);
  assert.equal(isSourceFilePath('grok-bot/receipts/0000-cos/20261003T120000Z-delivery-proof.md'), true);

  const files = currentSourceFiles();
  const baseline = loadTrackerFromFiles(files);
  const task = baseline.items.find(record => record.data.type === 'task');
  assert.ok(task);
  const body = 'Please review the verified delivery result.';
  const taskId = task.data.id;
  const digest = coordinationPayloadDigest({ taskId, recipient: 'don', channel: 'slack', body });
  const messageId = '20261003T120000Z-delivery-proof';
  const inboxPath = `grok-bot/inbox/0000-cos/${messageId}.md`;
  const receiptPath = `grok-bot/receipts/0000-cos/${messageId}.md`;
  files.set('tracker/decisions/approve-delivery-proof.md', `---
id: approve-delivery-proof
state: approved
owner: don
affects: ${taskId}
updated_at: 2026-10-03
approved_by: don
approved_at: 2026-10-03
coordination_digest: ${digest}
---

# Exact payload approval
`);
  files.set('tracker/delivery/coordination-proof.md', `---
id: coordination-proof
type: coordination
item: ${taskId}
updated_at: 2026-10-03
recipient: don
channel: slack
approval_decision: approve-delivery-proof
request_digest: ${digest}
dispatch_request: ${inboxPath}
delivery_receipt: ${receiptPath}
delivery_ref: slack:message-proof-1
dispatch_state: sent
---

# Coordination

## Message

${body}
`);
  files.set(inboxPath, `---
id: ${messageId}
to: 0000-cos
from: codex
created_at: 2026-10-03T12:00:00Z
subject: Delivery proof
---

${body}
`);
  files.set(receiptPath, `---
id: ${messageId}
status: done
updated_at: 2026-10-03T12:05:00Z
delivery_state: sent
request_digest: ${digest}
delivery_ref: slack:message-proof-1
---

Provider confirms delivery.
`);

  const loaded = validateCandidateFiles(files);
  assert.equal(loaded.records.delivery.some(record => record.data.id === 'coordination-proof'), true);
  assert.equal(loaded.records.botMessages.some(record => record.path === inboxPath), true);
  assert.equal(loaded.records.botReceipts.some(record => record.path === receiptPath), true);
});

function manilaPublishDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(PUBLISH_AT);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function createEntries(files, previousEntries = [], {
  filesAreRemote = false,
  repositoryPrefix = TEST_INSTANCE.data.folderPath,
} = {}) {
  const entries = new Map(previousEntries.map(entry => [entry.path, { ...entry }]));
  for (const [path, content] of files) {
    const repositoryPath = filesAreRemote
      ? path
      : remotePath(path, repositoryPrefix);
    const segments = repositoryPath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      if (!entries.has(directory)) {
        entries.set(directory, { path: directory, mode: '040000', type: 'tree', sha: sha1(`tree:${directory}`) });
      }
    }
    entries.set(repositoryPath, {
      path: repositoryPath,
      mode: '100644',
      type: 'blob',
      size: Buffer.byteLength(content),
      sha: sha1(content),
    });
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function treeDigest(entries) {
  return sha1(entries.map(entry => `${entry.path}\u0000${entry.mode}\u0000${entry.type}\u0000${entry.sha}`).join('\n'));
}

function createWorld(sourceFiles = currentSourceFiles(), {
  targetTreeLength,
  races = [],
  repositoryPrefix = TEST_INSTANCE.data.folderPath,
} = {}) {
  let serial = 1;
  const snapshots = new Map();
  const treeSnapshots = new Map();
  const pendingTrees = new Map();
  const treeWrites = [];
  const commits = [];
  const raceQueue = [...races];
  let main = initialSha;

  function newSha(seed) {
    serial += 1;
    return sha1(`${serial}:${seed}`).slice(0, 40);
  }

  function registerSnapshot({ sha, parent = null, message = '', files, entries }) {
    const snapshot = { sha, parent, message, files: new Map(files), entries: createEntries(new Map(), entries) };
    const treeSha = treeDigest(snapshot.entries);
    snapshot.treeSha = treeSha;
    snapshots.set(sha, snapshot);
    treeSnapshots.set(treeSha, { entries: snapshot.entries, files: snapshot.files });
    if (parent !== null) commits.push(snapshot);
    return snapshot;
  }

  let initialEntries = createEntries(sourceFiles, [], { repositoryPrefix });
  if (Number.isInteger(targetTreeLength) && targetTreeLength > initialEntries.length) {
    const extraCount = targetTreeLength - initialEntries.length;
    initialEntries = [...initialEntries, ...Array.from({ length: extraCount }, (_, index) => ({
      path: remotePath(`unused-publish-limit-${String(index).padStart(5, '0')}.txt`, repositoryPrefix),
      mode: '100644',
      type: 'blob',
      size: 1,
      sha: sha1(`unused-${index}`),
    }))].sort((left, right) => left.path.localeCompare(right.path));
  }
  registerSnapshot({ sha: initialSha, files: sourceFiles, entries: initialEntries });

  function registerExternalChange(change) {
    const base = snapshots.get(main);
    const files = new Map(base.files);
    let entries;
    if (change.content === null) {
      files.delete(change.path);
      const repositoryPath = remotePath(change.path, repositoryPrefix);
      const paths = new Map(base.entries.map(entry => [entry.path, { ...entry }]));
      paths.delete(repositoryPath);
      const prefixes = repositoryPath.split('/').slice(0, -1).map((_, index) => repositoryPath.split('/').slice(0, index + 1).join('/')).reverse();
      for (const prefix of prefixes) {
        if (![...paths.keys()].some(path => path.startsWith(`${prefix}/`))) paths.delete(prefix);
      }
      entries = [...paths.values()].sort((left, right) => left.path.localeCompare(right.path));
    } else {
      files.set(change.path, change.content);
      entries = createEntries(new Map([[change.path, change.content]]), base.entries, { repositoryPrefix });
    }
    const sha = newSha(`external:${change.path}:${change.content}`);
    const snapshot = registerSnapshot({
      sha,
      parent: main,
      message: 'Concurrent tracker source update',
      files,
      entries,
    });
    main = snapshot.sha;
    return snapshot.sha;
  }

  const github = {
    repositoryPrefix,
    treeWrites,
    commits,
    races: raceQueue,
    get main() { return main; },
    async getRef() { return main; },
    async getCommit(commitSha) {
      const snapshot = snapshots.get(commitSha);
      if (!snapshot) throw new Error(`Unknown test commit ${commitSha}.`);
      return { sha: commitSha, tree: { sha: snapshot.treeSha } };
    },
    async getTree(treeSha) {
      const snapshot = treeSnapshots.get(treeSha);
      if (!snapshot) throw new Error(`Unknown test tree ${treeSha}.`);
      return snapshot.entries;
    },
    async readBlobs(commitSha, paths) {
      const snapshot = snapshots.get(commitSha);
      if (!snapshot) throw new Error(`Unknown test commit ${commitSha}.`);
      return new Map(paths.flatMap(path => {
        const canonical = localPath(path, repositoryPrefix);
        return canonical !== null && snapshot.files.has(canonical)
          ? [[path, snapshot.files.get(canonical)]]
          : [];
      }));
    },
    async createTree(baseTree, entries) {
      const base = treeSnapshots.get(baseTree);
      if (!base) throw new Error(`Unknown base tree ${baseTree}.`);
      for (const entry of entries) {
        assert.equal(entry.type, 'blob');
        assert.equal(entry.mode, '100644');
        assert.equal(typeof entry.content, 'string');
        assert.equal(Object.hasOwn(entry, 'sha'), false);
      }
      treeWrites.push({ baseTree, entries: structuredClone(entries) });
      const files = new Map(base.files);
      for (const entry of entries) {
        const canonical = localPath(entry.path, repositoryPrefix);
        assert.notEqual(canonical, null);
        files.set(canonical, entry.content);
      }
      const treeEntries = createEntries(new Map(entries.map(entry => [entry.path, entry.content])), base.entries, {
        filesAreRemote: true,
        repositoryPrefix,
      });
      const treeSha = treeDigest(treeEntries);
      treeSnapshots.set(treeSha, { entries: treeEntries, files });
      pendingTrees.set(treeSha, { entries: treeEntries, files });
      return treeSha;
    },
    async createCommit(message, treeSha, parent) {
      const tree = pendingTrees.get(treeSha);
      if (!tree || !snapshots.has(parent)) throw new Error('Invalid mocked Git commit input.');
      const sha = newSha(`commit:${message}:${treeSha}:${parent}`);
      registerSnapshot({ sha, parent, message, files: tree.files, entries: tree.entries });
      return sha;
    },
    async advanceMain(commitSha) {
      const candidate = snapshots.get(commitSha);
      if (!candidate) throw new Error('Unknown candidate commit.');
      if (raceQueue.length > 0) {
        const race = raceQueue.shift();
        registerExternalChange(race);
        return null;
      }
      if (candidate.parent !== main) return null;
      main = commitSha;
      return commitSha;
    },
    async compareCommits(baseSha, headSha) {
      if (baseSha === headSha) return { status: 'identical', aheadBy: 0 };
      let cursor = snapshots.get(headSha);
      let aheadBy = 0;
      while (cursor?.parent) {
        aheadBy += 1;
        if (cursor.parent === baseSha) return { status: 'ahead', aheadBy };
        cursor = snapshots.get(cursor.parent);
      }
      return { status: 'diverged', aheadBy: 0 };
    },
    async receiptCommit(requestId, mainSha) {
      let cursor = snapshots.get(mainSha);
      while (cursor) {
        if (cursor.message.split(/\r?\n/).includes(`Publish-Request-ID: ${requestId}`)) {
          return { commit: cursor.sha, message: cursor.message, parent: cursor.parent };
        }
        cursor = cursor.parent ? snapshots.get(cursor.parent) : null;
      }
      return null;
    },
    externalChange: registerExternalChange,
    snapshot(commitSha = main) { return snapshots.get(commitSha); },
  };
  return github;
}

function fieldRequest(sourceFiles, sourceCommit, taskId, values) {
  const records = loadTrackerFromFiles(sourceFiles);
  const item = records.items.find(candidate => candidate.data.id === taskId);
  assert.ok(item, `fixture has task ${taskId}`);
  const fields = Object.fromEntries(Object.entries(values).map(([field, value]) => [field, {
    value,
    baseValue: readTaskField(item, field),
    baseSourceCommit: sourceCommit,
    baseContentRevision: item.data.revision ?? 'r1',
  }]));
  return { id: taskId, fields };
}

function post(path, value) {
  return new Request(`https://tracker.example${path}`, {
    method: 'POST',
    headers: { Origin: 'https://tracker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function statusRequest(requestId, sourceCommit) {
  return new Request(`https://tracker.example/api/publish/${requestId}?sourceCommit=${sourceCommit}`);
}

function preparedEnvelope(requestId, tasks) {
  return { schemaVersion: 1, requestId, tasks };
}

function approvedEnvelope(requestId, tasks, approvals = []) {
  return { schemaVersion: 2, requestId, tasks, approvals };
}

function requestId(digit) {
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

async function prepare(world, requestIdValue, tasks, instance = TEST_INSTANCE) {
  const response = await handlePublishRequest(post('/api/publish/prepare', preparedEnvelope(requestIdValue, tasks)), DON_EMAIL, {}, {
    githubFactory: () => world,
    now: () => new Date(PUBLISH_AT),
    instance,
  });
  return { response, body: await response.json() };
}

async function publish(world, requestIdValue, tasks, approvals = [], instance = TEST_INSTANCE) {
  const response = await handlePublishRequest(post('/api/publish', approvedEnvelope(requestIdValue, tasks, approvals)), DON_EMAIL, {}, {
    githubFactory: () => world,
    now: () => new Date(PUBLISH_AT),
    instance,
  });
  return { response, body: await response.json() };
}

describe('authenticated GitHub task publishing', () => {
  test('reports safe operation and numeric status for GitHub authentication or access failures', async () => {
    const cases = [
      { status: 401, operation: 'installation-token request' },
      { status: 403, operation: 'pinned Markdown batch read' },
    ];
    for (const { status, operation } of cases) {
      const response = await handlePublishRequest(
        post('/api/publish/prepare', preparedEnvelope(requestId('1'), [{ id: EDIT_TASK_ID, fields: {
          [FIELD_NEXT_STEP]: {
            value: 'Safe error regression',
            baseValue: 'Existing value',
            baseSourceCommit: initialSha,
            baseContentRevision: 'r1',
          },
        } }])),
        DON_EMAIL,
        {},
        { githubFactory: () => ({ getRef: async () => { throw new GitHubApiError(status, operation); } }) },
      );
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.match(body.error, new RegExp(`GitHub ${operation} failed with HTTP ${status}\\.`));
      assert.doesNotMatch(body.error, /Contents write permission|api\.github\.com|ghs_|PRIVATE KEY|upstream/i);
    }
  });

  test('draft scope edit and empty prose publish without accepting or clearing queued state', async () => {
    const sourceFiles = currentSourceFiles();
    const id = requestId('1');
    const selected = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === DRAFT_TASK_ID);
    assert.ok(selected);
    const initialSource = sourceFiles.get(selected.path);
    assert.ok(initialSource);
    sourceFiles.set(selected.path, rewriteFrontmatter(patchItemSource(initialSource, {
      [FIELD_NEXT_STEP]: `Controlled prepublish step ${id}`,
    }), {
      set: {
        commitment: 'draft', status: 'queued', approval_state: 'proposed', approved_parts: 'task',
        accepted_from: '-', revision: 'r1', approved_by: '-', approved_at: '-', approval_ref: '-',
        approved_revision: '-', reviewed_detail: '-', approval_source: '-', approval_digest: '-',
      },
    }));
    const baseline = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === selected.data.id);
    assert.ok(baseline);
    const world = createWorld(sourceFiles);
    const task = fieldRequest(sourceFiles, world.main, DRAFT_TASK_ID, {
      [FIELD_OUTCOME]: `${readTaskField(baseline, FIELD_OUTCOME)}\n\nDraft regression ${id}`,
      [FIELD_NEXT_STEP]: '',
    });

    const { response: preparedResponse, body: prepared } = await prepare(world, id, [task]);
    assert.equal(preparedResponse.status, 200);
    assert.equal(parseTaskPublishPrepareResponse(prepared, id).reviews[0]?.requiresApproval, false);
    const { response, body } = await publish(world, id, [task]);
    assert.equal(response.status, 200, JSON.stringify(body));
    const receipt = parseTaskPublishReceipt(body, id);
    assert.equal(receipt.published, true);
    assert.deepEqual(receipt.fields.map(field => field.publishedValue), [
      task.fields[FIELD_OUTCOME].value,
      '',
    ]);
    const published = await loadCurrentTracker(world, receipt.commit);
    const item = published.records.items.find(candidate => candidate.data.id === task.id);
    assert.equal(item?.data.commitment, baseline.data.commitment);
    assert.equal(item?.data.status, baseline.data.status);
    assert.equal(item?.data.approval_state, baseline.data.approval_state);
    assert.equal(item?.data.approved_parts, baseline.data.approved_parts);
    assert.equal(readTaskField(item, FIELD_NEXT_STEP), '');
    assert.equal(published.records.updates.some(update => update.data.source === `authenticated-edit:${id}`), true);
    assert.equal(world.treeWrites.length, 1);
    assert.equal(world.treeWrites[0]?.baseTree, world.snapshot(initialSha)?.treeSha);
    assert.equal(world.treeWrites[0]?.entries.every(entry => !entry.path.includes('..')), true);
    assert.deepEqual(new Set(world.treeWrites[0].entries.map(entry => entry.path)), new Set([
      `tracker/items/fixture/${DRAFT_TASK_ID}.md`,
      `tracker/updates/${DRAFT_TASK_ID}/authenticated-edit-${id}.md`,
      `tracker/changelog/${manilaPublishDate()}.md`,
      `tracker/publish-receipts/${id}.json`,
    ]));
  });

  test('nested settings route every simulated publisher write under the captured data prefix', async () => {
    const sourceFiles = currentSourceFiles();
    const id = requestId('e');
    const baseline = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === DRAFT_TASK_ID);
    assert.ok(baseline);
    const world = createWorld(sourceFiles, { repositoryPrefix: NESTED_INSTANCE.data.folderPath });
    const task = fieldRequest(sourceFiles, world.main, DRAFT_TASK_ID, {
      [FIELD_OUTCOME]: `${readTaskField(baseline, FIELD_OUTCOME)}\n\nNested destination ${id}`,
    });

    const prepared = await prepare(world, id, [task], NESTED_INSTANCE);
    assert.equal(prepared.response.status, 200);
    const result = await publish(world, id, [task], [], NESTED_INSTANCE);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const receipt = parseTaskPublishReceipt(result.body, id);
    await loadCurrentTracker(world, receipt.commit, NESTED_INSTANCE);

    assert.equal(world.treeWrites.length, 1);
    assert.deepEqual(new Set(world.treeWrites[0].entries.map(entry => entry.path)), new Set([
      `${NESTED_INSTANCE.data.folderPath}/tracker/items/fixture/${DRAFT_TASK_ID}.md`,
      `${NESTED_INSTANCE.data.folderPath}/tracker/updates/${DRAFT_TASK_ID}/authenticated-edit-${id}.md`,
      `${NESTED_INSTANCE.data.folderPath}/tracker/changelog/${manilaPublishDate()}.md`,
      `${NESTED_INSTANCE.data.folderPath}/tracker/publish-receipts/${id}.json`,
    ]));
    assert.ok(world.treeWrites[0].entries.every(entry => entry.path.startsWith(`${NESTED_INSTANCE.data.folderPath}/`)));
  });

  test('planned scope review leaves a queued item planned and unaccepted', async () => {
    const sourceFiles = currentSourceFiles();
    const selected = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === PLANNED_TASK_ID);
    assert.ok(selected);
    const revision = selected.data.revision ?? 'r1';
    const planned = structuredClone(selected);
    Object.assign(planned.data, {
      commitment: 'planned',
      status: 'queued',
      revision,
      approval_state: 'approved',
      approved_parts: 'task',
      approved_by: 'owner',
      approved_at: PUBLISH_AT.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      approval_ref: 'publish-test:planned-fixture',
      approved_revision: revision,
      reviewed_detail: 'Controlled planned task fixture for publish regression coverage.',
      approval_source: 'authenticated-edit',
    });
    planned.data.approval_digest = taskApprovalDigest(planned);
    const initialSource = sourceFiles.get(selected.path);
    assert.ok(initialSource);
    sourceFiles.set(selected.path, rewriteFrontmatter(initialSource, {
      set: {
        commitment: 'planned', status: 'queued', revision,
        approval_state: 'approved', approved_parts: 'task',
        approved_by: planned.data.approved_by, approved_at: planned.data.approved_at,
        approval_ref: planned.data.approval_ref, approved_revision: revision,
        reviewed_detail: planned.data.reviewed_detail, approval_source: planned.data.approval_source,
        approval_digest: planned.data.approval_digest,
      },
    }));

    const baseline = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === selected.data.id);
    assert.ok(baseline);
    const world = createWorld(sourceFiles);
    const id = requestId('2');
    const task = fieldRequest(sourceFiles, world.main, selected.data.id, {
      [FIELD_OUTCOME]: `${readTaskField(baseline, FIELD_OUTCOME)}\n\nPlanned review ${id}`,
    });
    const { response: preparedResponse, body: prepared } = await prepare(world, id, [task]);
    assert.equal(preparedResponse.status, 200);
    const review = parseTaskPublishPrepareResponse(prepared, id).reviews[0];
    assert.equal(review?.requiresApproval, true);
    const result = await publish(world, id, [task], [{ taskId: task.id, reviewDigest: review.reviewDigest }]);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const published = await loadCurrentTracker(world, result.body.commit);
    const item = published.records.items.find(candidate => candidate.data.id === task.id);
    assert.equal(item?.data.commitment, 'planned');
    assert.equal(item?.data.status, 'queued');
    assert.equal(item?.data.approval_state, 'approved');
    assert.equal(item?.data.accepted_from, '-');
    assert.equal(item?.data.revision, incrementRevision(revision));
  });

  test('approved Business scope receives a fresh explicit revision and validates before Git writes', async () => {
    const sourceFiles = currentSourceFiles();
    const baseline = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === ACCEPTED_TASK_ID);
    assert.ok(baseline);
    const world = createWorld(sourceFiles);
    const id = requestId('3');
    const task = fieldRequest(sourceFiles, world.main, ACCEPTED_TASK_ID, {
      title: `${readTaskField(baseline, 'title')} (publish regression ${id})`,
    });
    const { response: preparedResponse, body: prepared } = await prepare(world, id, [task]);
    assert.equal(preparedResponse.status, 200);
    const review = parseTaskPublishPrepareResponse(prepared, id).reviews[0];
    assert.equal(review?.requiresApproval, true);
    assert.ok(review?.retained.some(entry => entry.label === 'Project' && entry.value === String(baseline.data.project)));
    assert.ok(review?.retained.some(entry => entry.label === 'Approved revision' && entry.value === String(baseline.data.approved_revision ?? baseline.data.revision)));

    const result = await publish(world, id, [task], [{ taskId: task.id, reviewDigest: review.reviewDigest }]);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const receipt = parseTaskPublishReceipt(result.body, id);
    const published = await loadCurrentTracker(world, receipt.commit);
    const item = published.records.items.find(candidate => candidate.data.id === ACCEPTED_TASK_ID);
    assert.equal(item?.data.commitment, 'accepted');
    assert.equal(item?.data.revision, incrementRevision(baseline.data.revision));
    assert.equal(item?.data.approved_revision, incrementRevision(baseline.data.revision));
    assert.equal(item?.data.approved_parts, baseline.data.approved_parts);
    assert.equal(item?.data.accepted_from, baseline.data.accepted_from);
    assert.equal(item?.data.approval_ref, `authenticated-edit:${id}`);
    assert.equal(world.treeWrites.length, 1);
  });

  test('archived runtime and AWS approvals preserve accepted provenance and retained schedule parts', async () => {
    const sourceFiles = currentSourceFiles();
    const baselineRecords = loadTrackerFromFiles(sourceFiles);
    const world = createWorld(sourceFiles);
    const id = requestId('4');
    const tasks = [ACCEPTED_RUNTIME_TASK_ID, ACCEPTED_CLOUD_TASK_ID].map(taskId => {
      const baseline = baselineRecords.items.find(candidate => candidate.data.id === taskId);
      assert.ok(baseline);
      return fieldRequest(sourceFiles, world.main, taskId, {
        [FIELD_OUTCOME]: `${readTaskField(baseline, FIELD_OUTCOME)}\n\nExplicit review ${id}`,
      });
    });
    const { response: preparedResponse, body: prepared } = await prepare(world, id, tasks);
    assert.equal(preparedResponse.status, 200);
    const reviews = parseTaskPublishPrepareResponse(prepared, id).reviews;
    assert.equal(reviews.length, 2);
    for (const review of reviews) {
      assert.equal(review.requiresApproval, true);
      assert.deepEqual(review.approvedParts, ['task', 'assignment', 'schedule']);
      assert.ok(review.retained.some(entry => entry.label === 'Planned start' && entry.value !== '-'));
      assert.ok(review.retained.some(entry => entry.label === 'Provisional schedule' && entry.value === 'true'));
    }
    const approvals = reviews.map(review => ({ taskId: review.taskId, reviewDigest: review.reviewDigest }));
    const result = await publish(world, id, tasks, approvals);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const published = await loadCurrentTracker(world, result.body.commit);
    for (const taskId of [ACCEPTED_RUNTIME_TASK_ID, ACCEPTED_CLOUD_TASK_ID]) {
      const baseline = baselineRecords.items.find(candidate => candidate.data.id === taskId);
      assert.ok(baseline);
      const item = published.records.items.find(candidate => candidate.data.id === taskId);
      assert.equal(item?.data.commitment, 'accepted');
      assert.equal(item?.data.approval_state, 'approved');
      assert.equal(item?.data.approved_parts, 'task,assignment,schedule');
      assert.equal(item?.data.accepted_from, baseline.data.accepted_from);
      assert.equal(item?.data.approval_source, 'authenticated-edit');
      assert.equal(item?.data.planned_start, baseline.data.planned_start);
      assert.equal(item?.data.planned_end, baseline.data.planned_end);
      assert.equal(item?.data.schedule_provisional, baseline.data.schedule_provisional);
    }
    assert.equal(published.records.legacyApprovals?.[ACCEPTED_RUNTIME_TASK_ID] !== undefined, true);
    assert.equal(published.records.legacyApprovals?.[ACCEPTED_CLOUD_TASK_ID] !== undefined, true);
  });

  test('scope review digest binds latest retained approval metadata and stale review conflicts', async () => {
    const sourceFiles = currentSourceFiles();
    const baseline = loadTrackerFromFiles(sourceFiles).items.find(candidate => candidate.data.id === ACCEPTED_TASK_ID);
    assert.ok(baseline);
    const world = createWorld(sourceFiles);
    const id = requestId('5');
    const task = fieldRequest(sourceFiles, world.main, ACCEPTED_TASK_ID, {
      title: `${readTaskField(baseline, 'title')} (stale review ${id})`,
    });
    const { body: prepared } = await prepare(world, id, [task]);
    const review = parseTaskPublishPrepareResponse(prepared, id).reviews[0];
    assert.ok(review);

    const current = world.snapshot();
    const itemPath = baseline.path;
    const approvedAt = new Date(Date.parse(baseline.data.approved_at) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const updatedSource = rewriteFrontmatter(current.files.get(itemPath), { set: { approved_at: approvedAt } });
    assert.notEqual(updatedSource, current.files.get(itemPath));
    world.externalChange({ path: itemPath, content: updatedSource });

    const result = await publish(world, id, [task], [{ taskId: task.id, reviewDigest: review.reviewDigest }]);
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    const conflict = parseTaskPublishConflictResponse(result.body, id);
    assert.equal(conflict.code, 'review-stale');
    assert.equal(conflict.currentSourceCommit, world.main);
    assert.equal(world.treeWrites.length, 0);
  });

  test('title-less source is rejected during prepare before any Git tree write', async () => {
    const sourceFiles = currentSourceFiles();
    const records = loadTrackerFromFiles(sourceFiles);
    const item = records.items.find(candidate => candidate.data.id === DRAFT_TASK_ID);
    assert.ok(item);
    const raw = sourceFiles.get(item.path);
    const titleLine = /^# .*?(?:\r?\n)/m.exec(raw ?? '');
    assert.ok(titleLine);
    sourceFiles.set(item.path, (raw ?? '').replace(titleLine[0], ''));
    const world = createWorld(sourceFiles);
    const task = fieldRequest(sourceFiles, world.main, item.data.id, {
      [FIELD_NEXT_STEP]: 'This source is missing its canonical title heading.',
    });
    const result = await prepare(world, requestId('a'), [task]);
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    const conflict = parseTaskPublishConflictResponse(result.body, requestId('a'));
    assert.equal(conflict.code, 'validation-failed');
    assert.equal(world.treeWrites.length, 0);
  });

  test('same payload retry returns original receipt before baseline checks; changed payload conflicts', async () => {
    const sourceFiles = currentSourceFiles();
    const world = createWorld(sourceFiles);
    const id = requestId('5');
    const task = fieldRequest(sourceFiles, world.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'Publish once, then verify the durable receipt handles the lost-response retry.',
    });
    const first = await publish(world, id, [task]);
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    const retried = await publish(world, id, [task]);
    assert.equal(retried.response.status, 200);
    assert.deepEqual(retried.body, first.body);
    assert.equal(world.treeWrites.length, 1);

    const altered = structuredClone(task);
    altered.fields[FIELD_NEXT_STEP].value += ' Changed.';
    const conflictResult = await publish(world, id, [altered]);
    assert.equal(conflictResult.response.status, 409);
    const conflict = parseTaskPublishConflictResponse(conflictResult.body, id);
    assert.equal(conflict.code, 'idempotency-conflict');
    assert.equal(world.treeWrites.length, 1);
  });

  test('unrelated main movement rebases by field value while same-field movement returns conflict', async () => {
    const sourceFiles = currentSourceFiles();
    const sourceItem = loadTrackerFromFiles(sourceFiles).items.find(item => item.data.id === EDIT_TASK_ID);
    assert.ok(sourceItem);
    const unrelatedWorld = createWorld(sourceFiles, {
      races: [{ path: 'tracker/changelog/2099-01-01.md', content: '# Concurrent unrelated note\n' }],
    });
    const id = requestId('6');
    const task = fieldRequest(sourceFiles, unrelatedWorld.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'Rebase this field over an unrelated main update.',
    });
    const result = await publish(unrelatedWorld, id, [task]);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(unrelatedWorld.treeWrites.length, 2);
    assert.notEqual(unrelatedWorld.treeWrites[1]?.baseTree, unrelatedWorld.treeWrites[0]?.baseTree);
    assert.equal(unrelatedWorld.snapshot(result.body.commit)?.parent, unrelatedWorld.commits.at(-1)?.parent);
    const published = await loadCurrentTracker(unrelatedWorld, result.body.commit);
    assert.equal(published.records.items.find(item => item.data.id === task.id)?.data.commitment, sourceItem.data.commitment);

    const conflictWorld = createWorld(sourceFiles);
    const conflictTask = fieldRequest(sourceFiles, conflictWorld.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'This value loses a same-field race.',
    });
    const baseline = sourceItem;
    conflictWorld.races.push({
      path: baseline.path,
      content: patchItemSource(conflictWorld.snapshot().files.get(baseline.path), {
        [FIELD_NEXT_STEP]: 'Concurrent approved-draft next step.',
      }),
    });
    const conflictResult = await publish(conflictWorld, requestId('7'), [conflictTask]);
    assert.equal(conflictResult.response.status, 409);
    const conflict = parseTaskPublishConflictResponse(conflictResult.body, requestId('7'));
    assert.equal(conflict.code, 'field-conflict');
    assert.equal(conflict.conflicts[0]?.field, FIELD_NEXT_STEP);
    assert.equal(conflictWorld.treeWrites.length, 1);
  });

  test('three repeated compare-and-swap races produce an honest branch conflict', async () => {
    const sourceFiles = currentSourceFiles();
    const racePath = 'tracker/changelog/2099-01-01.md';
    const world = createWorld(sourceFiles, {
      races: [1, 2, 3].map(index => ({ path: racePath, content: `# Concurrent update ${index}\n` })),
    });
    const id = requestId('8');
    const task = fieldRequest(sourceFiles, world.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'This publish will hit repeated main movement.',
    });
    const result = await publish(world, id, [task]);
    assert.equal(result.response.status, 409);
    const conflict = parseTaskPublishConflictResponse(result.body, id);
    assert.equal(conflict.code, 'branch-raced');
    assert.equal(world.treeWrites.length, 3);
  });

  test('status returns receipt and verified ancestry proof, while missing IDs stay not-found', async () => {
    const sourceFiles = currentSourceFiles();
    const world = createWorld(sourceFiles);
    const id = requestId('9');
    const task = fieldRequest(sourceFiles, world.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'Write a receipt for status lookup.',
    });
    const result = await publish(world, id, [task]);
    assert.equal(result.response.status, 200);
    const receiptPath = `tracker/publish-receipts/${id}.json`;
    const originalReceipt = JSON.parse(world.snapshot(result.body.commit)?.files.get(receiptPath));
    const changedReceipt = structuredClone(originalReceipt);
    changedReceipt.fields[0].publishedValue = 'tampered later on main';
    world.externalChange({ path: receiptPath, content: `${JSON.stringify(changedReceipt, null, 2)}\n` });
    world.externalChange({ path: 'tracker/changelog/2099-01-01.md', content: '# Descendant main\n' });

    const status = await handlePublishRequest(statusRequest(id, world.main), DON_EMAIL, {}, { githubFactory: () => world });
    assert.equal(status.status, 200);
    const statusReceipt = parseTaskPublishReceipt(await status.json(), id);
    assert.deepEqual(statusReceipt.source, { commit: world.main, includesPublishedCommit: true });
    assert.equal(statusReceipt.fields[0]?.publishedValue, originalReceipt.fields[0]?.publishedValue);
    const exactRetry = await publish(world, id, [task]);
    assert.equal(exactRetry.response.status, 200);
    assert.deepEqual(exactRetry.body, result.body);
    const changedRequest = structuredClone(task);
    changedRequest.fields[FIELD_NEXT_STEP].value += ' A different payload.';
    const changedRetry = await publish(world, id, [changedRequest]);
    assert.equal(changedRetry.response.status, 409);
    assert.equal(parseTaskPublishConflictResponse(changedRetry.body, id).code, 'idempotency-conflict');
    world.externalChange({ path: receiptPath, content: null });
    const afterDelete = await publish(world, id, [task]);
    assert.equal(afterDelete.response.status, 200);
    assert.deepEqual(afterDelete.body, result.body);
    const oldSourceStatus = await handlePublishRequest(statusRequest(id, initialSha), DON_EMAIL, {}, { githubFactory: () => world });
    assert.equal(oldSourceStatus.status, 200);
    assert.equal((await oldSourceStatus.json()).source.includesPublishedCommit, false);

    const missingId = requestId('a');
    const missing = await handlePublishRequest(statusRequest(missingId, world.main), DON_EMAIL, {}, { githubFactory: () => world });
    assert.equal(missing.status, 404);
    const notFound = await missing.json();
    assert.equal(notFound.requestId, missingId);
    assert.equal(notFound.published, false);
  });

  test('unrelated deployed source SHA does not override an unchanged field baseline', async () => {
    const sourceFiles = currentSourceFiles();
    const world = createWorld(sourceFiles);
    world.externalChange({ path: 'tracker/changelog/2099-01-01.md', content: '# Existing unrelated update\n' });
    const task = fieldRequest(sourceFiles, initialSha, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'The deployed snapshot SHA may be behind unrelated main commits.',
    });
    task.fields[FIELD_NEXT_STEP].baseSourceCommit = initialSha;
    task.fields[FIELD_NEXT_STEP].baseContentRevision = 'older-deployed-revision';
    const result = await prepare(world, requestId('b'), [task]);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(parseTaskPublishPrepareResponse(result.body, requestId('b')).currentSourceCommit, world.main);
  });

  test('expanded changelog content and projected tree entries are rejected before Git tree writes', async () => {
    const sourceFiles = currentSourceFiles();
    const sourceEntries = createEntries(sourceFiles);
    const changelogPath = `tracker/changelog/${manilaPublishDate()}.md`;
    const nearFullTree = createWorld(sourceFiles, { targetTreeLength: 19_997 });
    const id = requestId('c');
    const task = fieldRequest(sourceFiles, nearFullTree.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'This request should exceed the projected Git tree entry cap.',
    });
    nearFullTree.externalChange({
      path: changelogPath,
      content: `# Large but currently valid changelog\n${'x'.repeat(250 * 1024 - 37)}`,
    });
    const treeLimitResult = await publish(nearFullTree, id, [task]);
    assert.equal(treeLimitResult.response.status, 409);
    assert.equal(parseTaskPublishConflictResponse(treeLimitResult.body, id).code, 'validation-failed');
    assert.equal(nearFullTree.treeWrites.length, 0);

    const largeLogFiles = new Map(sourceFiles);
    largeLogFiles.set(changelogPath, `# Large but currently valid changelog\n${'x'.repeat(250 * 1024 - 37)}`);
    const largeLogWorld = createWorld(largeLogFiles);
    const largeLogTask = fieldRequest(largeLogFiles, largeLogWorld.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: '\\'.repeat(15_000),
    });
    const expandedResult = await publish(largeLogWorld, requestId('d'), [largeLogTask]);
    assert.equal(expandedResult.response.status, 409);
    assert.equal(parseTaskPublishConflictResponse(expandedResult.body, requestId('d')).code, 'validation-failed');
    assert.equal(largeLogWorld.treeWrites.length, 0);
    assert.ok(sourceEntries.length < 20_000);
  });

  test('prepare, receipt, and conflict envelopes pass the strict viewer decoders', async () => {
    const sourceFiles = currentSourceFiles();
    const world = createWorld(sourceFiles);
    const id = requestId('e');
    const task = fieldRequest(sourceFiles, world.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'Exercise exact API and viewer contracts.',
    });
    const prepared = await prepare(world, id, [task]);
    assert.equal(prepared.response.status, 200);
    assert.doesNotThrow(() => parseTaskPublishPrepareResponse(prepared.body, id));
    const published = await publish(world, id, [task]);
    assert.equal(published.response.status, 200);
    assert.doesNotThrow(() => parseTaskPublishReceipt(published.body, id));

    const staleWorld = createWorld(sourceFiles);
    const staleTask = fieldRequest(sourceFiles, staleWorld.main, EDIT_TASK_ID, {
      [FIELD_NEXT_STEP]: 'Stale baseline.',
    });
    const staleBaseline = loadTrackerFromFiles(sourceFiles).items.find(item => item.data.id === staleTask.id);
    assert.ok(staleBaseline);
    staleWorld.externalChange({
      path: staleBaseline.path,
      content: patchItemSource(
        staleWorld.snapshot().files.get(staleBaseline.path),
        { [FIELD_NEXT_STEP]: 'Concurrent value for stale baseline regression.' },
      ),
    });
    const conflict = await prepare(staleWorld, requestId('f'), [staleTask]);
    assert.equal(conflict.response.status, 409);
    assert.doesNotThrow(() => parseTaskPublishConflictResponse(conflict.body, requestId('f')));
  });
});
