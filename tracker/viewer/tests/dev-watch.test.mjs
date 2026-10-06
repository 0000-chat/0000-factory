import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'bun:test';
import { fixtureInstance, writeFixtureData } from '../../../tests/helpers/fixture-data.mjs';
import { SOURCE_READ_LIMITS } from '../../../tooling/tracker/source-validation.mjs';
import { createBuildWatcher, snapshotSignature } from '../tooling/dev.mjs';

const engineRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const testTempRoot = resolve(process.env.TMPDIR ?? tmpdir());
const roots = [];
const fixtures = [];

mkdirSync(testTempRoot, { recursive: true });

function temporaryRoots() {
  const root = mkdtempSync(join(testTempRoot, 'tracker-dev-watch-'));
  roots.push(root);
  const fixture = writeFixtureData({
    repositoryPath: join(root, 'data'),
    instance: fixtureInstance({ id: 'watch-fixture' }),
    mode: 'empty',
  });
  fixtures.push(fixture);
  return {
    root: fixture.dataRepo,
    dataRepo: fixture.dataRepo,
    instancePath: fixture.instancePath,
    output: join(root, 'output'),
  };
}

function signature(inputs) {
  return snapshotSignature({ engineRoot, dataRepo: inputs.dataRepo, instancePath: inputs.instancePath });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('input signature tracks selected settings, branding, registry, and team changes', () => {
  const inputs = temporaryRoots();
  const cases = [
    [join(inputs.dataRepo, 'team.md'), '# Team\nA recorded guide update.\n'],
    [join(inputs.dataRepo, 'tracker', 'people.json'), '{"schemaVersion":1,"organizations":[],"people":[]}\n'],
    [inputs.instancePath, readFileSync(inputs.instancePath, 'utf8').replace('Synthetic watch-fixture', 'Edited watch-fixture')],
    [join(inputs.dataRepo, 'assets', 'favicon.svg'), '<svg>changed branding</svg>\n'],
  ];

  for (const [path, changedContents] of cases) {
    const before = signature(inputs);
    writeFileSync(path, changedContents);
    assert.notEqual(signature(inputs), before, path);
  }
});

test('unrelated data documents and generated output do not trigger rebuilds', () => {
  const inputs = temporaryRoots();
  const before = signature(inputs);
  mkdirSync(join(inputs.dataRepo, 'docs'), { recursive: true });
  writeFileSync(join(inputs.dataRepo, 'docs', 'notes.md'), 'unrelated documentation\n');
  mkdirSync(inputs.output, { recursive: true });
  writeFileSync(join(inputs.output, 'build-manifest.json'), 'generated output\n');
  assert.equal(signature(inputs), before);
});

test('the signature captured before a build leaves changes made during it for the next poll', async () => {
  let signatureValue = 'before build';
  let buildCount = 0;
  let releaseFirstBuild;
  let signalFirstBuild;
  const firstBuildStarted = new Promise(resolve => { signalFirstBuild = resolve; });
  const firstBuild = new Promise(resolve => { releaseFirstBuild = resolve; });
  const events = [];
  const watcher = createBuildWatcher({
    readSignature: () => signatureValue,
    build: () => {
      buildCount += 1;
      if (buildCount === 1) {
        signalFirstBuild();
        return firstBuild;
      }
      return Promise.resolve({ built: true });
    },
    send: event => events.push(event),
  });
  watcher.setLastSignature('previous signature');

  const building = watcher.rebuild();
  await firstBuildStarted;
  signatureValue = 'edited during build';
  releaseFirstBuild({ built: true });
  assert.equal(await building, true);
  assert.equal(watcher.getLastSignature(), 'before build');
  assert.equal(await watcher.poll(), true);
  assert.equal(buildCount, 2);
  assert.equal(watcher.getLastSignature(), 'edited during build');
  assert.deepEqual(events, ['reload', 'reload']);
});

test('failed rebuild preserves the last successful signature and announces an error', async () => {
  const events = [];
  const errors = [];
  const watcher = createBuildWatcher({
    readSignature: () => 'new input',
    build: async () => { throw new Error('validation failed'); },
    send: event => events.push(event),
    onError: error => errors.push(error.message),
  });
  watcher.setLastSignature('last successful input');

  assert.equal(await watcher.poll(), false);
  assert.equal(watcher.getLastSignature(), 'last successful input');
  assert.deepEqual(errors, ['validation failed']);
  assert.deepEqual(events, ['build-error']);
});

test('oversized selected input is rejected before reading and recovers on valid source', async () => {
  const inputs = temporaryRoots();
  const teamPath = join(inputs.dataRepo, 'team.md');
  const originalTeam = readFileSync(teamPath, 'utf8');
  const validSignature = signature(inputs);
  writeFileSync(teamPath, 'x'.repeat(SOURCE_READ_LIMITS.maxFileBytes + 1));

  assert.throws(() => signature(inputs), /source read limit/u);

  const events = [];
  let builds = 0;
  const watcher = createBuildWatcher({
    readSignature: () => {
      try {
        return signature(inputs);
      } catch {
        return null;
      }
    },
    build: () => {
      builds += 1;
      return Promise.resolve({ built: true });
    },
    send: event => events.push(event),
  });
  watcher.setLastSignature(validSignature);
  assert.equal(await watcher.poll(), false);
  assert.equal(builds, 0);
  assert.equal(watcher.getLastSignature(), validSignature);

  writeFileSync(teamPath, `${originalTeam}\nRecovered authored source.\n`);
  assert.equal(await watcher.poll(), true);
  assert.equal(builds, 1);
  assert.deepEqual(events, ['reload']);
});
