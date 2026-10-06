import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'bun:test';

import { readDataFiles, selectedDataPaths } from '../tooling/instance/paths.mjs';
import { loadTrackerFromFiles, validateTracker } from '../tooling/tracker/model-core.mjs';
import {
  fixtureInstance,
  SYNTHETIC_FIXTURE_IDENTITIES,
  writeFixtureData,
} from './helpers/fixture-data.mjs';

const temporaryRoot = resolve(process.env.TMPDIR ?? tmpdir());
mkdirSync(temporaryRoot, { recursive: true });

function temporaryDirectory(prefix) {
  return mkdtempSync(join(temporaryRoot, prefix));
}

function walkFiles(root, current = '') {
  const directory = join(root, current);
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = current ? join(current, entry.name) : entry.name;
    if (entry.isDirectory()) return walkFiles(root, child);
    assert.equal(entry.isFile(), true, `fixture contains a non-file entry: ${child}`);
    return [relative(root, join(root, child)).split('\\').join('/')];
  }).sort();
}

function tracker(fixture) {
  const files = readDataFiles({ dataRepo: fixture.dataRepo, instance: fixture.instance });
  const records = loadTrackerFromFiles(files);
  assert.deepEqual(validateTracker(records), []);
  return { files, records };
}

test('defaults write an empty root fixture and clean up their owned directory', () => {
  const instance = fixtureInstance();
  assert.equal(instance.data.folderPath, '');
  assert.equal(instance.data.evidence.kind, 'none');
  assert.equal(instance.access.kind, 'unconfigured');
  assert.equal(instance.publish.kind, 'disabled');

  const fixture = writeFixtureData({ instance });
  try {
    const { files, records } = tracker(fixture);
    assert.deepEqual([...files.keys()], ['tracker/people.json', 'team.md']);
    assert.equal(records.items.length, 0);
    assert.equal(records.people.length, 2);
    assert.deepEqual(walkFiles(fixture.dataRepo), [
      'assets/favicon.svg',
      'settings.json',
      'team.md',
      'tracker/people.json',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(fixture.settingsPath, 'utf8')), instance);
    assert.equal(fixture.dataRepo, fixture.dataPath);
    assert.equal(fixture.instancePath, fixture.settingsPath);
  } finally {
    fixture.cleanup();
    fixture.cleanup();
  }
  assert.equal(existsSync(fixture.dataRepo), false);
});

test('settings, assets, and records share the selected data folder', () => {
  for (const [folderPath, id] of [['', 'literal-root'], ['tooling/project-tracker', 'literal-nested']]) {
    const fixture = writeFixtureData({ instance: fixtureInstance({ id, folderPath }) });
    try {
      const settingsRelative = folderPath ? 'tooling/project-tracker/settings.json' : 'settings.json';
      const assetRelative = folderPath ? 'tooling/project-tracker/assets/favicon.svg' : 'assets/favicon.svg';
      const registryRelative = folderPath ? 'tooling/project-tracker/tracker/people.json' : 'tracker/people.json';
      assert.equal(fixture.instancePath, join(fixture.dataRepo, ...settingsRelative.split('/')));
      assert.equal(fixture.settingsPath, join(fixture.dataRepo, ...settingsRelative.split('/')));
      assert.equal(fixture.assetPath, join(fixture.dataRepo, ...assetRelative.split('/')));
      assert.equal(existsSync(join(fixture.dataRepo, ...settingsRelative.split('/'))), true);
      assert.equal(existsSync(join(fixture.dataRepo, ...assetRelative.split('/'))), true);
      assert.equal(existsSync(join(fixture.dataRepo, ...registryRelative.split('/'))), true);
      assert.equal(existsSync(join(fixture.dataRepo, 'settings.json')), folderPath === '');
      assert.equal(existsSync(join(fixture.dataRepo, 'assets/favicon.svg')), folderPath === '');
      assert.equal(existsSync(join(fixture.dataRepo, 'tracker/people.json')), folderPath === '');
    } finally {
      fixture.cleanup();
    }
  }
});

test('populated root and nested layouts expose the same validated canonical data', () => {
  const canonical = [];
  for (const folderPath of ['', 'site-data']) {
    const instance = fixtureInstance({
      id: folderPath ? 'populated-nested' : 'populated-root',
      folderPath,
    });
    const fixture = writeFixtureData({ instance, mode: 'populated' });
    try {
      const { files, records } = tracker(fixture);
      canonical.push([...files.entries()]);
      assert.equal(records.items.length, 94);
      assert.equal(records.history.length, 4);
      assert.equal(records.plans.length, 1);
      assert.equal(records.milestones.length, 1);
      assert.equal(records.capacities.length, 1);
      assert.equal(records.updates.length, 1);
      assert.equal(records.delivery.length, 1);
      assert.equal(records.migrations.length, 1);
      assert.equal(records.migrations[0].data.mappings.length, 98);
      assert.equal(records.migrations[0].data.sourceCommit, SYNTHETIC_FIXTURE_IDENTITIES.migrationCommit);
      assert.equal(records.plans[0].data.id, 'fixture-plan');
      assert.equal(records.plans[0].data.status, 'approved');
      assert.equal(records.milestones[0].data.approval_state, 'approved');
      assert.equal(records.items.find(item => item.data.id === 'fixture-dependent-task').data.depends_on, 'fixture-foundation-task');
      assert.equal(records.items.find(item => item.data.id === 'fixture-foundation-task').data.approval_state, 'approved');
      assert.match(records.items.find(item => item.data.id === 'fixture-foundation-task').body, /Synthetic foundation task/u);
      assert.equal(new Set(selectedDataPaths({ dataRepo: fixture.dataRepo, instance }).map(path => path.role)).has('evidence'), false);
      assert.equal(walkFiles(fixture.dataRepo).some(path => /(?:node_modules|package\.json|\.m?js$|wrangler)/u.test(path)), false);
    } finally {
      fixture.cleanup();
    }
  }
  assert.deepEqual(canonical[0], canonical[1]);
});

test('ready Access, simulated publishing, and optional bot evidence stay synthetic', () => {
  const instance = fixtureInstance({
    id: 'ready-evidence',
    folderPath: 'site-data',
    evidenceKind: 'grok-bot-v1',
    accessKind: 'ready',
    publishKind: 'enabled',
  });
  assert.equal(instance.access.kind, 'ready');
  assert.match(instance.access.teamDomain, /\.fixture\.test$/u);
  assert.equal(instance.access.readerEmails.every(email => email.endsWith('@fixture.test')), true);
  assert.equal(instance.publish.kind, 'github-app');

  const fixture = writeFixtureData({ instance, mode: 'populated' });
  try {
    const { files, records } = tracker(fixture);
    assert.equal(records.botMessages.length, 1);
    assert.equal(records.botReceipts.length, 1);
    assert.equal(new Set(selectedDataPaths({ dataRepo: fixture.dataRepo, instance }).map(path => path.role)).has('evidence'), true);
    const text = `${JSON.stringify(fixture.instance)}\n${[...files.values()].join('\n')}`;
    for (const token of [['Next', 'Pay'].join(''), '0'.repeat(4)]) assert.equal(text.includes(token), false);
    assert.match(text, /fixture\.test/u);
  } finally {
    fixture.cleanup();
  }
});

test('cleanup preserves a caller-owned repository and rejects unsafe combinations', () => {
  const parent = temporaryDirectory('fixture-owner-');
  const repositoryPath = join(parent, 'repository');
  mkdirSync(repositoryPath, { recursive: true });
  const sentinel = join(repositoryPath, 'keep.txt');
  writeFileSync(sentinel, 'caller-owned\n');
  const fixture = writeFixtureData({
    repositoryPath,
    instance: fixtureInstance({ id: 'owned-root', folderPath: 'data' }),
  });
  fixture.cleanup();
  assert.equal(existsSync(sentinel), true);
  assert.deepEqual(walkFiles(repositoryPath), ['keep.txt']);
  rmSync(parent, { recursive: true, force: true });

  assert.throws(() => fixtureInstance({ publishKind: 'enabled' }), /requires accessKind: ready/u);
  assert.throws(() => fixtureInstance({ folderPath: '../outside' }), /folderPath/u);
  assert.throws(() => writeFixtureData({ instance: fixtureInstance(), mode: 'invalid' }), /mode/u);
});
