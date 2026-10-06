import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseInstanceConfig, publicInstanceConfig } from '../tooling/instance/config.mjs';
import { renderInstanceArtifacts, safeJsonForHtml } from '../tooling/instance/render.mjs';

function settings(overrides = {}) {
  return parseInstanceConfig({
    schemaVersion: 1,
    id: 'render-test',
    branding: {
      name: 'Render Test',
      title: 'Render </title><script>globalThis.bad=1</script>',
      description: 'Description </script><script>globalThis.bad=2</script>&',
      markText: 'R', homeLabel: 'Render home', loadingLabel: 'Loading render fixture',
      faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'synthetic-org', repo: 'synthetic-data', branch: 'main' },
    data: { folderPath: 'site-data', layout: 'tracker-v1', evidence: { kind: 'none' } },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: 'render-test', storeId: 'render-test-store', themeKey: 'render-test-theme',
      editLockPrefix: 'render-test-edit', publishLockName: 'render-test-publish',
      unscheduledCollapsedKey: 'render-test.unscheduled', activityPausedKey: 'render-test.activity',
    },
    access: {
      kind: 'ready', teamDomain: 'https://team.synthetic.test', audience: 'audience',
      readerEmails: ['reader@synthetic.test', 'publisher@synthetic.test'], service: { kind: 'disabled' },
    },
    publish: { kind: 'github-app', publisherEmail: 'publisher@synthetic.test', recordActorId: 'publisher', operations: 'existing-task-edits-v1' },
    deployment: {
      accountBinding: 'synthetic-account', workerName: 'tracker-render-test', customDomain: 'render.synthetic.test',
      compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
    },
    ...overrides,
  });
}

test('HTML projection is escaped and runtime policy stays outside assets', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-render-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets/favicon.svg'), '<svg>fixture</svg>\n');
  const engine = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-engine-'));
  mkdirSync(join(engine, 'worker'), { recursive: true });
  writeFileSync(join(engine, 'worker/access-gate.mjs'), 'export function createTrackerWorker() { return { fetch() { return new Response("ok"); } }; }\n');
  const output = join(root, 'output');
  const parsed = settings();
  const result = renderInstanceArtifacts({
    instance: parsed,
    manifestDir: root,
    engineRoot: engine,
    output,
    provenance: { engineCommit: 'engine-sha', dataCommit: 'data-sha', settingsDigest: 'settings-sha', inputFingerprint: 'fingerprint', data: { synthetic: true } },
  });
  const html = readFileSync(join(output, 'assets/index.html'), 'utf8');
  const publicJson = safeJsonForHtml(publicInstanceConfig(parsed));
  assert.match(html, /__TRACKER_PUBLIC_INSTANCE__/);
  assert.match(html, /\\u003c/);
  assert.match(html, new RegExp(publicJson.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.equal(html.includes('team.synthetic.test'), false);
  assert.equal(html.includes('reader@synthetic.test'), false);
  assert.equal(html.includes('publisher@synthetic.test'), false);
  assert.equal(html.includes('synthetic-account'), false);
  assert.equal(readFileSync(join(output, 'runtime-config.mjs'), 'utf8').includes('team.synthetic.test'), true);
  assert.equal(readFileSync(join(output, 'assets/data.json'), 'utf8'), '{\n  "synthetic": true\n}\n');
  assert.match(readFileSync(join(output, 'worker-entry.mjs'), 'utf8'), new RegExp(pathToFileURL(join(engine, 'worker/access-gate.mjs')).href.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  const wrangler = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
  assert.equal(wrangler.name, 'tracker-render-test');
  assert.equal(wrangler.workers_dev, false);
  assert.equal(wrangler.preview_urls, false);
  assert.equal(wrangler.assets.run_worker_first, true);
  assert.deepEqual(wrangler.compatibility_flags, ['nodejs_compat']);
  const manifest = JSON.parse(readFileSync(join(output, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.source.commit, 'data-sha');
  assert.equal(manifest.engine.commit, 'engine-sha');
  assert.equal(manifest.settings.digest, 'settings-sha');
  assert.ok(manifest.artifactHashes['assets/index.html']);
  assert.equal(result.output, output);
});

test('failed render preserves the last valid output', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-render-preserve-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets/favicon.svg'), '<svg/>');
  const engine = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-engine-preserve-'));
  mkdirSync(join(engine, 'worker'), { recursive: true });
  writeFileSync(join(engine, 'worker/access-gate.mjs'), 'export function createTrackerWorker() { return { fetch() {} }; }');
  const output = join(root, 'output');
  renderInstanceArtifacts({ instance: settings(), manifestDir: root, engineRoot: engine, output });
  const before = readFileSync(join(output, 'assets/index.html'), 'utf8');
  const invalid = structuredClone(settings());
  invalid.branding.faviconPath = 'assets/missing.svg';
  assert.throws(() => renderInstanceArtifacts({ instance: invalid, manifestDir: root, engineRoot: engine, output }), /asset/);
  assert.equal(readFileSync(join(output, 'assets/index.html'), 'utf8'), before);
});

test('assets directory symlink escapes are rejected without replacing valid output', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-render-assets-escape-'));
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'favicon.svg'), '<svg>valid-favicon</svg>\n');
  const outside = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-render-assets-outside-'));
  writeFileSync(join(outside, 'favicon.svg'), '<svg>external-sentinel</svg>\n');
  const engine = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-engine-assets-escape-'));
  mkdirSync(join(engine, 'worker'), { recursive: true });
  writeFileSync(join(engine, 'worker/access-gate.mjs'), 'export function createTrackerWorker() { return { fetch() {} }; }');
  const output = join(root, 'output');
  renderInstanceArtifacts({ instance: settings(), manifestDir: root, engineRoot: engine, output });
  const before = new Map([
    ['assets/index.html', readFileSync(join(output, 'assets/index.html'), 'utf8')],
    ['assets/favicon.svg', readFileSync(join(output, 'assets/favicon.svg'), 'utf8')],
    ['runtime-config.mjs', readFileSync(join(output, 'runtime-config.mjs'), 'utf8')],
    ['worker-entry.mjs', readFileSync(join(output, 'worker-entry.mjs'), 'utf8')],
    ['wrangler.json', readFileSync(join(output, 'wrangler.json'), 'utf8')],
    ['build-manifest.json', readFileSync(join(output, 'build-manifest.json'), 'utf8')],
  ]);
  rmSync(assets, { recursive: true, force: true });
  symlinkSync(outside, assets, 'dir');

  assert.throws(
    () => renderInstanceArtifacts({ instance: settings(), manifestDir: root, engineRoot: engine, output }),
    /assets directory (?:escapes the settings directory|must be a real directory)/,
  );
  for (const [file, content] of before) {
    assert.equal(readFileSync(join(output, file), 'utf8'), content);
    assert.equal(content.includes('external-sentinel'), false);
  }
});

test('assets directory aliases to the settings folder cannot expose policy files', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-render-assets-alias-'));
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'favicon.svg'), '<svg>valid-favicon</svg>\n');
  writeFileSync(join(root, 'settings.json'), 'settings-policy-external-sentinel\n');
  const engine = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-engine-assets-alias-'));
  mkdirSync(join(engine, 'worker'), { recursive: true });
  writeFileSync(join(engine, 'worker/access-gate.mjs'), 'export function createTrackerWorker() { return { fetch() {} }; }');
  const output = join(root, 'output');
  renderInstanceArtifacts({ instance: settings(), manifestDir: root, engineRoot: engine, output });
  const before = new Map([
    ['assets/index.html', readFileSync(join(output, 'assets/index.html'), 'utf8')],
    ['assets/favicon.svg', readFileSync(join(output, 'assets/favicon.svg'), 'utf8')],
    ['runtime-config.mjs', readFileSync(join(output, 'runtime-config.mjs'), 'utf8')],
    ['worker-entry.mjs', readFileSync(join(output, 'worker-entry.mjs'), 'utf8')],
    ['wrangler.json', readFileSync(join(output, 'wrangler.json'), 'utf8')],
    ['build-manifest.json', readFileSync(join(output, 'build-manifest.json'), 'utf8')],
  ]);
  rmSync(assets, { recursive: true, force: true });
  symlinkSync(root, assets, 'dir');
  const invalid = structuredClone(settings());
  invalid.branding.faviconPath = 'assets/settings.json';

  assert.throws(
    () => renderInstanceArtifacts({ instance: invalid, manifestDir: root, engineRoot: engine, output }),
    /assets directory must be a real directory/,
  );
  for (const [file, content] of before) {
    assert.equal(readFileSync(join(output, file), 'utf8'), content);
    assert.equal(content.includes('settings-policy-external-sentinel'), false);
  }
});

test('root and nested settings asset directories render valid favicons', () => {
  const workspace = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-render-layouts-'));
  const nested = join(workspace, 'tooling', 'project-tracker');
  const engine = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-engine-layouts-'));
  mkdirSync(join(engine, 'worker'), { recursive: true });
  writeFileSync(join(engine, 'worker/access-gate.mjs'), 'export function createTrackerWorker() { return { fetch() {} }; }');

  for (const [name, manifestDir] of [['root', workspace], ['nested', nested]]) {
    mkdirSync(join(manifestDir, 'assets'), { recursive: true });
    writeFileSync(join(manifestDir, 'assets/favicon.svg'), `<svg>${name}-favicon</svg>\n`);
    const output = join(workspace, `${name}-output`);
    renderInstanceArtifacts({ instance: settings(), manifestDir, engineRoot: engine, output });
    assert.equal(readFileSync(join(output, 'assets/favicon.svg'), 'utf8'), `<svg>${name}-favicon</svg>\n`);
  }
});
