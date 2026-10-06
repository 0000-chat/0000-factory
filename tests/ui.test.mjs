import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { fixtureInstance, writeFixtureData } from './helpers/fixture-data.mjs';
import { buildSnapshot } from '../tracker/viewer/tooling/build.mjs';

const source = process.env.TRACKER_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoots = [];
const fixtures = [];

function outputRoot() {
  const root = mkdtempSync(join(tmpdir(), '0000-tracker-ui-'));
  tempRoots.push(root);
  return join(root, 'tracker-viewer');
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function buildFixture(mode = 'empty') {
  const fixture = writeFixtureData({
    instance: fixtureInstance({ id: `ui-${mode}`, folderPath: '' }),
    mode,
  });
  fixtures.push(fixture);
  const output = outputRoot();
  buildSnapshot({
    engineRoot: source,
    dataRepo: fixture.dataRepo,
    instancePath: fixture.instancePath,
    output,
    builtAt: '2026-09-30T07:00:00.000Z',
  });
  return { fixture, output };
}

test('build emits the React shell, semantic tokens, and a safe extended snapshot contract', async () => {
  const { output } = buildFixture('populated');
  const assets = join(output, 'assets');
  const app = readFileSync(join(assets, 'app.js'), 'utf8');
  const css = readFileSync(join(assets, 'styles.css'), 'utf8');
  const html = readFileSync(join(assets, 'index.html'), 'utf8');
  const data = JSON.parse(readFileSync(join(assets, 'data.json'), 'utf8'));

  assert.match(html, /id="root"/);
  assert.ok(app.length > 1000);
  assert.match(app, /ui-populated/);
  assert.match(app, /Unscoped/);
  assert.match(app, /Work activity and approved schedule/);
  assert.match(css, /--primary:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(data.schemaVersion, 4);
  assert.ok(Array.isArray(data.items));
  assert.ok(Array.isArray(data.plans));
  assert.ok(Array.isArray(data.history));
  assert.ok(Array.isArray(data.migrations));
  assert.ok(Array.isArray(data.capacities));
  for (const item of data.items) {
    assert.equal(typeof item.progress.scoped, 'boolean');
    assert.ok(['draft', 'planned', 'accepted'].includes(item.commitment));
    assert.equal(Object.hasOwn(item, 'planned'), false);
    assert.ok(item.acceptance && typeof item.acceptance === 'object');
    assert.ok(item.approval && typeof item.approval === 'object');
    assert.ok(['on-track', 'at-risk', 'blocked', 'unknown'].includes(item.health.state));
    assert.ok(Object.hasOwn(item.health, 'missingInformation'));
    assert.ok(Object.hasOwn(item.health, 'suggestedAction'));
    assert.ok(Object.hasOwn(item.health, 'actor'));
    assert.ok(Object.hasOwn(item.schedule, 'forecastEndMin'));
  }
  for (const plan of data.plans) {
    assert.ok(Array.isArray(plan.taskIds));
    assert.equal(Object.hasOwn(plan, 'tasks'), false);
    for (const taskId of plan.taskIds) assert.ok(data.items.some(item => item.id === taskId));
  }
});

test('build keeps route assets root-relative and routing state out of localStorage', async () => {
  const { output } = buildFixture();
  const assets = join(output, 'assets');
  const html = readFileSync(join(assets, 'index.html'), 'utf8');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.ok(readFileSync(join(assets, 'app.js'), 'utf8').length > 0);

  const viewerSource = join(source, 'tracker', 'viewer', 'src');
  const routeSources = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:[cm]?[jt]sx?)$/i.test(entry.name) && /(?:^|[\\/])(?:routes?|router|routing-state|routeTree)(?:[\\/.-]|$)/i.test(file)) routeSources.push(file);
    }
  };
  visit(viewerSource);
  assert.ok(routeSources.length > 0, 'the route modules must remain discoverable after extraction');
  for (const file of routeSources) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /localStorage/);
  }
});
