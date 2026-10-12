import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { afterEach, test } from 'bun:test';
import { fixtureInstance, writeFixtureData } from '../../../tests/helpers/fixture-data.mjs';
import { createDevHandler } from '../tooling/dev.mjs';
import { buildSnapshot, validateOnly } from '../tooling/build.mjs';
import { SOURCE_READ_LIMITS } from '../../../tooling/tracker/source-validation.mjs';

const engineRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const testTempRoot = resolve(process.env.TMPDIR ?? tmpdir());
const roots = [];
const fixtures = [];

mkdirSync(testTempRoot, { recursive: true });

function temporaryRoot(prefix = 'tracker-instance-build-') {
  const root = mkdtempSync(join(testTempRoot, prefix));
  roots.push(root);
  return root;
}

function fixture({ id, folderPath = '', mode = 'empty', weeklyPlanning = true } = {}) {
  const root = temporaryRoot();
  const data = writeFixtureData({
    repositoryPath: join(root, 'data'),
    instance: fixtureInstance({ id, folderPath, weeklyPlanning }),
    mode,
  });
  fixtures.push(data);
  return { root, data, output: join(root, 'output') };
}

function build(input, options = {}) {
  return buildSnapshot({
    engineRoot,
    dataRepo: input.data.dataRepo,
    instancePath: input.data.instancePath,
    output: input.output,
    builtAt: '2026-10-06T01:02:03.000Z',
    ...options,
  });
}

function manifest(input) {
  return JSON.parse(readFileSync(join(input.output, 'build-manifest.json'), 'utf8'));
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixtureGitEnv() {
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
      .concat([
        ['GIT_CONFIG_NOSYSTEM', '1'],
        ['GIT_CONFIG_SYSTEM', devNull],
        ['GIT_CONFIG_GLOBAL', devNull],
      ]),
  );
}

function fixtureGit(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { env: fixtureGitEnv(), ...options });
}

function gitCommit(root) {
  fixtureGit(root, ['init', '--quiet']);
  fixtureGit(root, ['config', 'user.name', 'Fixture Builder']);
  fixtureGit(root, ['config', 'user.email', 'fixture.builder@fixture.test']);
  fixtureGit(root, ['add', '.']);
  fixtureGit(root, ['commit', '--quiet', '-m', 'authored synthetic fixture']);
  return fixtureGit(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function setFixtureGitConfig(root, key, value) {
  fixtureGit(root, ['config', key, value]);
}

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function buildInFreshProcess(input, output) {
  const builder = fileURLToPath(new URL('../tooling/build.mjs', import.meta.url));
  execFileSync(process.execPath, [
    builder,
    '--engine-root', engineRoot,
    '--data-root', input.data.dataRepo,
    '--settings', input.data.instancePath,
    '--out', output,
    '--built-at', '2026-10-06T01:02:03.000Z',
  ], {
    cwd: engineRoot,
    env: { ...fixtureGitEnv(), TMPDIR: testTempRoot },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function outputFiles(root, current = '', files = []) {
  for (const entry of readdirSync(join(root, current), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) outputFiles(root, relativePath, files);
    else files.push(relativePath);
  }
  return files;
}

function outputBytes(root) {
  return Object.fromEntries(outputFiles(root).map(path => [path, readFileSync(join(root, path))]));
}

afterEach(() => {
  for (const fixtureData of fixtures.splice(0)) fixtureData.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('builds real root and nested empty/populated data-only repositories', () => {
  for (const [folderPath, mode, expectedItems] of [
    ['', 'empty', 0],
    ['', 'populated', 94],
    ['tooling/project-tracker', 'empty', 0],
    ['tooling/project-tracker', 'populated', 94],
  ]) {
    const input = fixture({ id: `build-${folderPath ? 'nested' : 'root'}-${mode}`, folderPath, mode });
    const result = build(input);
    const data = JSON.parse(readFileSync(join(input.output, 'assets/data.json'), 'utf8'));
    assert.equal(data.items.length, expectedItems);
    assert.equal(result.instance.data.folderPath, folderPath);
    for (const path of [
      'assets/index.html', 'assets/favicon.svg', 'assets/data.json', 'assets/app.js',
      'assets/styles.css', 'assets/livestore.worker.js', 'assets/livestore.shared-worker.js',
      'assets/wa-sqlite.wasm', 'runtime-config.mjs', 'worker-entry.mjs', 'wrangler.json',
      'build-manifest.json',
    ]) assert.equal(existsSync(join(input.output, path)), true, path);
    assert.equal(existsSync(join(input.output, 'assets/planning/archive.json')), true);

    const wrangler = JSON.parse(readFileSync(join(input.output, 'wrangler.json'), 'utf8'));
    assert.equal(wrangler.workers_dev, false);
    assert.equal(wrangler.preview_urls, false);
    assert.equal(wrangler.assets.run_worker_first, true);
    assert.equal(wrangler.assets.directory, './assets');
    assert.match(readFileSync(join(input.output, 'assets/index.html'), 'utf8'), /globalThis\.__TRACKER_PUBLIC_INSTANCE__/u);
  }
});

test('tracker-v1 roster avatars are copied into the static output and missing declarations fail the build', () => {
  const input = fixture({ id: 'tracker-v1-roster-avatar' });
  const registryPath = join(input.data.dataRepo, 'tracker', 'people.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.people[0].avatar = 'fixture-don.png';
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  mkdirSync(join(input.data.dataRepo, 'assets', 'avatars'), { recursive: true });
  writeFileSync(
    join(input.data.dataRepo, 'assets', 'avatars', 'fixture-don.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );

  const result = build(input);
  assert.equal(result.data.team[0].avatarUrl, '/avatars/fixture-don.png');
  assert.ok(existsSync(join(input.output, 'assets', 'avatars', 'fixture-don.png')));
  assert.ok(manifest(input).artifactHashes['assets/avatars/fixture-don.png']);

  rmSync(join(input.data.dataRepo, 'assets', 'avatars', 'fixture-don.png'));
  assert.throws(() => build(input), /declared avatar is missing/u);
});

test('disabled weekly planning skips archive inputs and generated planning assets', () => {
  const input = fixture({ id: 'planning-disabled', weeklyPlanning: false });
  mkdirSync(join(input.data.dataRepo, 'planning'), { recursive: true });
  writeFileSync(join(input.data.dataRepo, 'planning/index.json'), '{ malformed planning input');

  const result = build(input);
  assert.equal(result.instance.features.weeklyPlanning, false);
  assert.equal(existsSync(join(input.output, 'assets/planning/archive.json')), false);
  assert.equal(manifest(input).artifactHashes['assets/planning/archive.json'], undefined);
  assert.match(readFileSync(join(input.output, 'assets/index.html'), 'utf8'), /"features":\{"weeklyPlanning":false\}/u);
});

test('turning weekly planning off replaces an existing archive output', () => {
  const input = fixture({ id: 'planning-toggle-output' });
  build(input);
  assert.equal(existsSync(join(input.output, 'assets/planning/archive.json')), true);

  const disabledSettings = { ...input.data.instance, features: { weeklyPlanning: false } };
  writeFileSync(input.data.instancePath, `${JSON.stringify(disabledSettings, null, 2)}\n`);
  build(input);

  assert.equal(existsSync(join(input.output, 'assets/planning/archive.json')), false);
  assert.equal(existsSync(join(input.output, 'assets/planning')), false);
});

test('data checkout code is inert and generated private Worker inputs stay outside assets', async () => {
  const input = fixture({ id: 'hostile-data', mode: 'empty' });
  const marker = join(input.root, 'data-code-executed');
  writeFileSync(join(input.data.dataRepo, 'evil-model.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  writeFileSync(join(input.data.dataRepo, 'package.json'), JSON.stringify({ scripts: { prepare: `node ${marker}` } }));
  build(input);

  assert.equal(existsSync(marker), false);
  const workerEntry = readFileSync(join(input.output, 'worker-entry.mjs'), 'utf8');
  assert.equal(workerEntry.includes(input.data.dataRepo), false);
  assert.match(workerEntry, /createTrackerWorker/u);

  const privatePaths = ['/runtime-config.mjs', '/worker-entry.mjs', '/wrangler.json', '/build-manifest.json'];
  const handler = createDevHandler({ output: input.output });
  for (const path of privatePaths) assert.equal((await handler(new Request(`http://127.0.0.1${path}`))).status, 404, path);

  const generatedWorker = await import(`${pathToFileURL(join(input.output, 'worker-entry.mjs')).href}?hostile-test`);
  let assetCalled = false;
  const response = await generatedWorker.default.fetch(new Request('https://hostile-data.fixture.test/'), {
    ASSETS: { fetch: () => { assetCalled = true; return new Response('asset'); } },
  });
  assert.equal(response.status, 503);
  assert.equal(assetCalled, false);
});

test('requires the running engine, rejects overlap/symlink inputs, and validates settings before parsing', () => {
  const input = fixture({ id: 'boundary-check', mode: 'empty' });
  assert.throws(
    () => validateOnly({ engineRoot: input.data.dataRepo, dataRepo: input.data.dataRepo, instancePath: input.data.instancePath }),
    /engineRoot must identify the running tracker engine/u,
  );
  assert.throws(
    () => validateOnly({ engineRoot, dataRepo: engineRoot, instancePath: input.data.instancePath }),
    /engineRoot and dataRepo must be separate repositories/u,
  );
  assert.throws(
    () => build({ ...input, output: join(input.data.dataRepo, 'generated') }),
    /output overlaps dataRepo/u,
  );

  const realOutput = join(input.root, 'real-output');
  mkdirSync(realOutput);
  const outputLink = join(input.root, 'output-link');
  symlinkSync(realOutput, outputLink, 'dir');
  assert.throws(() => build({ ...input, output: outputLink }), /output: symlink destinations are not allowed/u);

  const outsideSettings = join(input.root, 'settings-outside.json');
  writeFileSync(outsideSettings, readFileSync(input.data.instancePath));
  assert.throws(
    () => validateOnly({ engineRoot, dataRepo: input.data.dataRepo, instancePath: outsideSettings }),
    /settings must be physically contained in dataRepo/u,
  );

  const outsideTeam = join(input.root, 'team-outside.md');
  writeFileSync(outsideTeam, readFileSync(join(input.data.dataRepo, 'team.md')));
  rmSync(join(input.data.dataRepo, 'team.md'));
  symlinkSync(outsideTeam, join(input.data.dataRepo, 'team.md'));
  assert.throws(
    () => build(input),
    /data path (?:escapes repository through symlink|escapes repository)/u,
  );
});

test('applies source read limits before loading selected records and receipts', () => {
  const input = fixture({ id: 'read-limit-check', mode: 'empty' });
  writeFileSync(join(input.data.dataRepo, 'team.md'), 'x'.repeat(SOURCE_READ_LIMITS.maxFileBytes + 1));
  assert.throws(() => build(input), /configured read limit/u);
  assert.equal(existsSync(input.output), false);
});

test('fingerprint follows selected inputs and engine patches, while unrelated files do not matter', () => {
  const input = fixture({ id: 'fingerprint-check', mode: 'empty' });
  build(input);
  const initial = manifest(input).inputFingerprint;

  writeFileSync(join(input.data.dataRepo, 'team.md'), `${readFileSync(join(input.data.dataRepo, 'team.md'), 'utf8')}\nAn authored team note.\n`);
  build(input);
  const teamChanged = manifest(input).inputFingerprint;
  assert.notEqual(teamChanged, initial);

  writeFileSync(join(input.data.dataRepo, 'docs.md'), 'unrelated data documentation\n');
  build(input);
  assert.equal(manifest(input).inputFingerprint, teamChanged);

  const settings = JSON.parse(readFileSync(input.data.instancePath, 'utf8'));
  settings.branding.description = 'A changed authored fixture description.';
  writeFileSync(input.data.instancePath, `${JSON.stringify(settings, null, 2)}\n`);
  build(input);
  const settingsChanged = manifest(input).inputFingerprint;
  assert.notEqual(settingsChanged, teamChanged);

  const patchPath = join(engineRoot, 'patches', `.instance-build-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(patchPath, 'temporary source patch for fingerprint coverage\n', { mode: 0o755 });
    chmodSync(patchPath, 0o755);
    build(input);
    assert.notEqual(manifest(input).inputFingerprint, settingsChanged);
  } finally {
    rmSync(patchPath, { force: true });
  }
  build(input);
  assert.equal(manifest(input).inputFingerprint, settingsChanged);
});

test('fixed-time builds are repeatable and manifest hashes cover every generated artifact', () => {
  const input = fixture({ id: 'repeatability-check', mode: 'populated' });
  const secondOutput = join(input.root, 'output-second');
  build(input);
  build({ ...input, output: secondOutput });
  assert.deepEqual(manifest(input), JSON.parse(readFileSync(join(secondOutput, 'build-manifest.json'), 'utf8')));
  assert.deepEqual(outputBytes(input.output), outputBytes(secondOutput));

  const builtManifest = manifest(input);
  for (const [path, expected] of Object.entries(builtManifest.artifactHashes)) {
    assert.equal(digest(join(input.output, path)), expected, path);
  }
  for (const path of ['assets/app.js', 'assets/livestore.worker.js', 'assets/livestore.shared-worker.js', 'assets/wa-sqlite.wasm', 'assets/styles.css']) {
    assert.equal(typeof builtManifest.artifactHashes[path], 'string', path);
  }
  assert.equal(Object.hasOwn(builtManifest.artifactHashes, 'build-manifest.json'), false);
});

test('fresh builder processes produce identical production artifacts', () => {
  const input = fixture({ id: 'fresh-process-repeatability', mode: 'populated' });
  gitCommit(input.data.dataRepo);
  const firstOutput = join(input.root, 'fresh-output-first');
  const secondOutput = join(input.root, 'fresh-output-second');
  buildInFreshProcess(input, firstOutput);
  buildInFreshProcess(input, secondOutput);

  const firstManifest = manifest({ ...input, output: firstOutput });
  const secondManifest = manifest({ ...input, output: secondOutput });
  assert.deepEqual(secondManifest, firstManifest);
  assert.deepEqual(outputBytes(firstOutput), outputBytes(secondOutput));
  for (const [path, expected] of Object.entries(firstManifest.artifactHashes)) {
    assert.equal(digest(join(secondOutput, path)), expected, path);
  }
});

test('production bundle hydrates in Chromium without JSX runtime errors', async () => {
  const input = fixture({ id: 'empty-0000', mode: 'empty' });
  build(input);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const handler = createDevHandler({ output: input.output });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler,
  });
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/work`, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.ok(), true);
    await page.getByRole('complementary', { name: 'Tracker navigation' }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.getByRole('heading', { name: 'Work', exact: true, level: 1 }).isVisible(), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await page.close();
    await browser.close();
    server.stop(true);
  }
});

test('records the actual data Git identity and preserves the last valid output on failure', () => {
  const input = fixture({ id: 'provenance-check', mode: 'populated' });
  const commit = gitCommit(input.data.dataRepo);
  const result = build(input);
  const builtManifest = manifest(input);
  const engineCommit = fixtureGit(engineRoot, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(result.data.source.commit, commit);
  assert.equal(builtManifest.data.commit, commit);
  assert.equal(builtManifest.source.commit, commit);
  assert.equal(builtManifest.engine.commit, engineCommit);

  const before = readFileSync(join(input.output, 'assets/data.json'), 'utf8');
  const itemPath = join(input.data.dataRepo, 'tracker/items/fixture/fixture-project.md');
  writeFileSync(itemPath, readFileSync(itemPath, 'utf8').replace('## Evidence', '## Outcome'));
  assert.throws(() => build(input), /tracker source did not pass full domain validation/u);
  assert.equal(readFileSync(join(input.output, 'assets/data.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(dirnameOf(input.output)).filter(name => name.startsWith('.output.next-')), []);
});

test('rejects executable Git metadata before running it and preserves valid output', () => {
  const input = fixture({ id: 'git-safety-check', mode: 'empty' });
  gitCommit(input.data.dataRepo);
  build(input);
  const beforeManifest = readFileSync(join(input.output, 'build-manifest.json'));
  const beforeData = readFileSync(join(input.output, 'assets/data.json'));

  const fsMonitorMarker = join(input.root, 'fsmonitor-marker');
  const fsMonitorScript = join(input.root, 'fsmonitor.sh');
  writeFileSync(fsMonitorScript, `#!/bin/sh\nprintf marker > ${JSON.stringify(fsMonitorMarker)}\nprintf 'version 2\\n'\n`);
  chmodSync(fsMonitorScript, 0o755);
  setFixtureGitConfig(input.data.dataRepo, 'core.fsmonitor', fsMonitorScript);
  assert.throws(() => build(input), /git metadata configuration is not inert/u);
  assert.equal(existsSync(fsMonitorMarker), false);
  assert.deepEqual(readFileSync(join(input.output, 'build-manifest.json')), beforeManifest);
  assert.deepEqual(readFileSync(join(input.output, 'assets/data.json')), beforeData);

  fixtureGit(input.data.dataRepo, ['config', '--unset', 'core.fsmonitor']);
  const filterMarker = join(input.root, 'filter-marker');
  const filterScript = join(input.root, 'filter.sh');
  writeFileSync(filterScript, `#!/bin/sh\nprintf marker > ${JSON.stringify(filterMarker)}\ncat\n`);
  chmodSync(filterScript, 0o755);
  writeFileSync(join(input.data.dataRepo, '.gitattributes'), '* filter=fixture-filter\n');
  setFixtureGitConfig(input.data.dataRepo, 'filter.fixture-filter.clean', filterScript);
  setFixtureGitConfig(input.data.dataRepo, 'filter.fixture-filter.process', filterScript);
  assert.throws(() => build(input), /git metadata configuration is not inert/u);
  assert.equal(existsSync(filterMarker), false);
  assert.deepEqual(readFileSync(join(input.output, 'build-manifest.json')), beforeManifest);
  assert.deepEqual(readFileSync(join(input.output, 'assets/data.json')), beforeData);
});

test('ignores ambient Git repository and configuration redirection', () => {
  const input = fixture({ id: 'ambient-git-check', mode: 'empty' });
  const actualCommit = gitCommit(input.data.dataRepo);
  const foreign = fixture({ id: 'foreign-git-check', mode: 'empty' });
  const foreignCommit = gitCommit(foreign.data.dataRepo);
  assert.notEqual(actualCommit, foreignCommit);

  const ambientMarker = join(input.root, 'ambient-marker');
  const ambientScript = join(input.root, 'ambient-fsmonitor.sh');
  const ambientConfig = join(input.root, 'ambient.gitconfig');
  writeFileSync(ambientScript, `#!/bin/sh\nprintf marker > ${JSON.stringify(ambientMarker)}\nprintf 'version 2\\n'\n`);
  chmodSync(ambientScript, 0o755);
  writeFileSync(ambientConfig, `[core]\n\tfsmonitor = ${ambientScript}\n`);

  const result = withEnvironment({
    GIT_DIR: join(foreign.data.dataRepo, '.git'),
    GIT_WORK_TREE: foreign.data.dataRepo,
    GIT_INDEX_FILE: join(foreign.root, 'foreign.index'),
    GIT_OBJECT_DIRECTORY: join(foreign.data.dataRepo, '.git', 'objects'),
    GIT_CONFIG_GLOBAL: ambientConfig,
    GIT_CONFIG_SYSTEM: ambientConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: ambientScript,
  }, () => build(input));

  assert.equal(result.data.source.commit, actualCommit);
  assert.equal(manifest(input).data.commit, actualCommit);
  assert.equal(existsSync(ambientMarker), false);
});

function dirnameOf(path) {
  return resolve(path, '..');
}
