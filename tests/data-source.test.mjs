import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { parseInstanceConfig } from '../tooling/instance/config.mjs';
import { readDataFiles, repositoryPath } from '../tooling/instance/paths.mjs';
import {
  DataSourceError,
  MAX_FILE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
  MAX_TRACKER_FILES,
  isSourceFilePath,
  validateDataSource,
} from '../tooling/tracker/source-validation.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'tooling/tracker/cli.mjs');
const fixtures = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function instance(folderPath = '', id = folderPath ? 'synthetic-nested' : 'synthetic-root', evidence = 'none') {
  return parseInstanceConfig({
    schemaVersion: 1,
    id,
    branding: {
      name: 'Synthetic Tracker',
      title: 'Synthetic tracker',
      description: 'Synthetic data-only fixture.',
      markText: 'SYN',
      homeLabel: 'Home',
      loadingLabel: 'Loading',
      faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'synthetic-org', repo: 'synthetic-data', branch: 'main' },
    data: { folderPath, layout: 'tracker-v1', evidence: { kind: evidence } },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: id,
      storeId: `${id}-store`,
      themeKey: `${id}-theme`,
      editLockPrefix: `${id}-edit`,
      publishLockName: `${id}-publish`,
      unscheduledCollapsedKey: `${id}.unscheduled`,
      activityPausedKey: `${id}.activity`,
    },
    access: { kind: 'unconfigured' },
    publish: { kind: 'disabled' },
    deployment: {
      accountBinding: 'synthetic-account',
      workerName: `tracker-${id}`,
      customDomain: `${id}.synthetic.test`,
      compatibilityDate: '2026-09-30',
      compatibilityFlags: ['nodejs_compat'],
    },
  });
}

function emptyFiles(extra = []) {
  return new Map([
    ['team.md', '# Synthetic team\n'],
    ['tracker/people.json', '{"schemaVersion":1,"organizations":[],"people":[]}\n'],
    ...extra,
  ]);
}

function makeFixture() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tracker-source-'));
  fixtures.push(root);
  return root;
}

function writeFiles(root, site, files) {
  for (const [canonicalPath, content] of files) {
    const path = join(root, repositoryPath(site, canonicalPath));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function draftItem({ ownerProposed = null } = {}) {
  const fields = [
    'id: source-task',
    'type: task',
    'status: queued',
    'phase: discovery',
    'owner: unassigned',
    'parent: -',
    'depends_on: -',
    'updated_at: 2026-10-01',
    'commitment: draft',
    'health_state: on-track',
  ];
  if (ownerProposed !== null) fields.push(`owner_proposed: ${ownerProposed}`);
  return `---\n${fields.join('\n')}\n---\n# Source task\n\n## Outcome\n\nA synthetic outcome.\n\n## Completion condition\n\nThe fixture is valid.\n\n## Next step\n\nInspect the fixture.\n\n## Evidence\n\nSynthetic evidence.\n`;
}

test('root and nested repositories produce identical canonical domain records', () => {
  const canonical = emptyFiles();
  const root = makeFixture();
  const nested = makeFixture();
  const rootSite = instance();
  const nestedSite = instance('site-data');
  writeFiles(root, rootSite, canonical);
  writeFiles(nested, nestedSite, canonical);
  writeFileSync(join(root, 'ignored-model.mjs'), 'throw new Error("must not execute");\n');
  writeFileSync(join(nested, repositoryPath(nestedSite, 'ignored-model.mjs')), 'throw new Error("must not execute");\n');

  const rootFiles = readDataFiles({ dataRepo: root, instance: rootSite });
  const nestedFiles = readDataFiles({ dataRepo: nested, instance: nestedSite });
  assert.deepEqual(validateDataSource({ files: rootFiles, instance: rootSite }), validateDataSource({ files: nestedFiles, instance: nestedSite }));
  assert.equal(rootFiles.has('ignored-model.mjs'), false);
  assert.equal(nestedFiles.has('ignored-model.mjs'), false);
});

test('missing optional evidence is valid for an evidence-enabled instance', () => {
  const site = instance('', 'synthetic-evidence', 'grok-bot-v1');
  const result = validateDataSource({ files: emptyFiles(), instance: site });
  assert.equal(result.records.items.length, 0);
  assert.deepEqual(result.registry.people, []);
  assert.equal(result.guide, '# Synthetic team\n');
});

test('source selection follows the shared canonical role boundaries', () => {
  const site = instance();
  assert.equal(isSourceFilePath('team.md', site), true);
  assert.equal(isSourceFilePath('tracker/items/product/task.md', site), true);
  assert.equal(isSourceFilePath('tracker/changelog/2026-01-01.md', site), true);
  assert.equal(isSourceFilePath('tracker/changelog/2026/archive.md', site), false);
  assert.equal(isSourceFilePath('tracker/publish-receipts/request.json', site), false);
  assert.equal(isSourceFilePath('grok-bot/inbox/synthetic/request.md', site), false);
  assert.throws(() => validateDataSource({ files: emptyFiles() }), /explicit validated instance/);
});

test('registry and team failures are surfaced as data-source validation errors', () => {
  const site = instance();
  assert.throws(() => validateDataSource({ files: new Map([['team.md', 'guide']]), instance: site }), error => {
    assert.ok(error instanceof DataSourceError);
    assert.match(error.message, /people registry is missing/);
    return true;
  });
  assert.throws(() => validateDataSource({ files: new Map([['team.md', 'guide'], ['tracker/people.json', '{']]), instance: site }), error => {
    assert.ok(error instanceof DataSourceError);
    assert.match(error.message, /people registry is invalid JSON/);
    return true;
  });
  assert.throws(() => validateDataSource({ files: new Map([['team.md', 'guide'], ['tracker/people.json', '{"schemaVersion":1,"organizations":[],"people":"bad"}']]), instance: site }), error => {
    assert.ok(error instanceof DataSourceError);
    assert.match(error.message, /did not pass validation/);
    assert.match(error.issues.join('\n'), /people must be an array/);
    return true;
  });
  assert.throws(() => validateDataSource({ files: new Map([['tracker/people.json', '{"schemaVersion":1,"organizations":[],"people":[]}']]), instance: site }), error => {
    assert.ok(error instanceof DataSourceError);
    assert.match(error.message, /team guide is missing/);
    return true;
  });
});

test('current items require one migration and owners resolve through the registry', () => {
  const site = instance();
  const withoutMigration = emptyFiles([['tracker/items/product/source-task.md', draftItem()]]);
  assert.throws(() => validateDataSource({ files: withoutMigration, instance: site }), error => {
    assert.ok(error instanceof DataSourceError);
    assert.match(error.issues.join('\n'), /exactly one unified-work migration manifest/);
    return true;
  });

  const unresolvedOwner = emptyFiles([['tracker/items/product/source-task.md', draftItem({ ownerProposed: 'unknown-person' })]]);
  assert.throws(() => validateDataSource({ files: unresolvedOwner, instance: site }), error => {
    assert.ok(error instanceof DataSourceError);
    assert.match(error.issues.join('\n'), /owner_proposed must resolve to exactly one person/);
    return true;
  });
});

test('source-read file and byte bounds remain enforced before domain parsing', () => {
  const site = instance();
  const tooMany = emptyFiles();
  for (let index = 0; index <= MAX_TRACKER_FILES - 2; index += 1) tooMany.set(`tracker/changelog/${String(index).padStart(4, '0')}.md`, 'x');
  assert.throws(() => validateDataSource({ files: tooMany, instance: site }), /file-count limit/);

  const tooLarge = emptyFiles([['tracker/changelog/large.md', 'x'.repeat(MAX_FILE_BYTES + 1)]]);
  assert.throws(() => validateDataSource({ files: tooLarge, instance: site }), /file limit/);

  const tooMuch = emptyFiles();
  for (let index = 0; index < 97; index += 1) tooMuch.set(`tracker/changelog/${String(index).padStart(4, '0')}.md`, 'x'.repeat(MAX_FILE_BYTES));
  assert.ok(MAX_TOTAL_SOURCE_BYTES < 97 * MAX_FILE_BYTES);
  assert.throws(() => validateDataSource({ files: tooMuch, instance: site }), /24 MiB aggregate/);
});

test('explicit CLI roots/settings/output control generated views and reject a wrong engine', () => {
  const site = instance();
  const dataRoot = makeFixture();
  const output = makeFixture();
  const settingsPath = join(makeFixture(), 'settings.json');
  writeFiles(dataRoot, site, emptyFiles());
  writeFileSync(settingsPath, `${JSON.stringify(site, null, 2)}\n`);
  const args = ['build', '--engine-root', projectRoot, '--data-root', dataRoot, '--settings', settingsPath, '--out', output];
  const build = spawnSync(process.execPath, [cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.equal(existsSync(join(output, 'tracker/views/now.md')), true);

  const check = spawnSync(process.execPath, [cliPath, 'check', '--engine-root', projectRoot, '--data-root', dataRoot, '--settings', settingsPath, '--out', output], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  const validateOnly = spawnSync(process.execPath, [cliPath, 'validate-only', '--engine-root', projectRoot, '--data-root', dataRoot, '--settings', settingsPath], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(validateOnly.status, 0, `${validateOnly.stdout}\n${validateOnly.stderr}`);

  const wrongEngine = spawnSync(process.execPath, [cliPath, ...args.map(value => value === projectRoot ? dataRoot : value)], { cwd: projectRoot, encoding: 'utf8' });
  assert.notEqual(wrongEngine.status, 0);
  assert.match(`${wrongEngine.stdout}\n${wrongEngine.stderr}`, /running tracker engine/);
});
