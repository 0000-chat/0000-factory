import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  InstanceConfigError,
  loadInstanceConfig,
  normalizeRepositoryPath,
  parseInstanceCatalog,
  parseInstanceConfig,
  parsePublicInstanceConfig,
  publicInstanceConfig,
} from '../tooling/instance/config.mjs';

function settings(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic',
    branding: {
      name: 'Synthetic Tracker',
      title: 'Synthetic delivery tracker',
      description: 'A fixture-only tracker.',
      markText: 'SYN',
      homeLabel: 'Synthetic tracker home',
      loadingLabel: 'Loading synthetic data…',
      faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'synthetic-org', repo: 'synthetic-data', branch: 'main' },
    data: { folderPath: '', layout: 'tracker-v1', evidence: { kind: 'none' } },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: 'synthetic',
      storeId: 'synthetic-tracker-viewer',
      themeKey: 'synthetic-tracker-theme',
      editLockPrefix: 'synthetic-tracker-task-edit',
      publishLockName: 'synthetic-tracker-task-publish',
      unscheduledCollapsedKey: 'synthetic.viewer.unscheduledCollapsed',
      activityPausedKey: 'synthetic.workActivity.animationsPaused',
    },
    access: { kind: 'unconfigured' },
    publish: { kind: 'disabled' },
    deployment: {
      accountBinding: 'synthetic-account',
      workerName: 'tracker-synthetic',
      customDomain: 'tracker.synthetic.test',
      compatibilityDate: '2026-09-30',
      compatibilityFlags: ['nodejs_compat'],
    },
    ...overrides,
  };
}

function readySettings(overrides = {}) {
  return settings({
    access: {
      kind: 'ready',
      teamDomain: 'https://team.synthetic.test',
      audience: 'synthetic-audience',
      readerEmails: ['reader@synthetic.test', 'publisher@synthetic.test'],
      service: { kind: 'disabled' },
    },
    publish: {
      kind: 'github-app',
      publisherEmail: 'publisher@synthetic.test',
      recordActorId: 'synthetic-publisher',
      operations: 'existing-task-edits-v1',
    },
    ...overrides,
  });
}

test('version 1 settings parse as nested, frozen site data', () => {
  const parsed = parseInstanceConfig(settings());
  assert.equal(parsed.data.folderPath, '');
  assert.equal(parsed.github.repo, 'synthetic-data');
  assert.equal(parsed.model.approvalProtocol, 'don-v1');
  assert.equal(parsed.deployment.workerName, 'tracker-synthetic');
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.browser), true);
  assert.throws(() => { parsed.browser.storeId = 'changed'; }, TypeError);
});

test('ready Access, service, and enabled publishing validate together', () => {
  const parsed = parseInstanceConfig(readySettings({
    access: {
      kind: 'ready',
      teamDomain: 'https://TEAM.synthetic.test/',
      audience: 'synthetic-audience',
      readerEmails: ['reader@synthetic.test', 'publisher@synthetic.test'],
      service: { kind: 'enabled', clientId: 'synthetic-service' },
    },
  }));
  assert.equal(parsed.access.teamDomain, 'https://team.synthetic.test');
  assert.deepEqual(parsed.access.service, { kind: 'enabled', clientId: 'synthetic-service' });
  assert.equal(parsed.publish.kind, 'github-app');
});

test('public projection round-trips without runtime policy', () => {
  const instance = parseInstanceConfig(readySettings());
  const projected = publicInstanceConfig(instance);
  assert.equal(projected.source.folderPath, '');
  assert.equal(projected.publishing.kind, 'enabled');
  assert.equal('access' in projected, false);
  assert.equal('deployment' in projected, false);
  assert.equal(JSON.stringify(projected).includes('reader@synthetic.test'), false);
  assert.equal(JSON.stringify(projected).includes('publisher@synthetic.test'), false);
  assert.deepEqual(parsePublicInstanceConfig(projected), projected);
  assert.throws(() => parsePublicInstanceConfig({ ...projected, access: { kind: 'ready' } }), /unknown field/);
});

test('private and public parsers apply Git branch validation', () => {
  const invalidBranches = ['-bad', '.hidden', 'release/.hidden', 'release/item.lock'];
  for (const branch of invalidBranches) {
    assert.throws(
      () => parseInstanceConfig(settings({ github: { ...settings().github, branch } })),
      /settings\.github\.branch/,
    );

    const projected = publicInstanceConfig(parseInstanceConfig(settings()));
    assert.throws(
      () => parsePublicInstanceConfig({ ...projected, source: { ...projected.source, branch } }),
      /publicInstance\.source\.branch/,
    );
  }

  for (const branch of ['main', 'release/one']) {
    const instance = parseInstanceConfig(settings({ github: { ...settings().github, branch } }));
    assert.equal(instance.github.branch, branch);
    const projected = publicInstanceConfig(instance);
    assert.equal(parsePublicInstanceConfig(projected).source.branch, branch);
  }
});

test('loadInstanceConfig uses explicit path and hashes exact settings bytes', () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-config-'));
  const path = join(directory, 'settings.json');
  const raw = `${JSON.stringify(settings(), null, 2)}\n`;
  writeFileSync(path, raw);
  const loaded = loadInstanceConfig({ path });
  assert.equal(loaded.manifestDir, directory);
  assert.equal(loaded.configDigest, createHash('sha256').update(raw).digest('hex'));
  assert.equal(loaded.instance.id, 'synthetic');
});

test('unknown fields, unions, paths, refs, namespace, and publisher membership fail with field paths', () => {
  const unknown = settings({ extra: true });
  assert.throws(() => parseInstanceConfig(unknown), error => error instanceof InstanceConfigError && /settings\.extra/.test(error.message));
  assert.throws(() => parseInstanceConfig(settings({ data: { folderPath: '../escape', layout: 'tracker-v1', evidence: { kind: 'none' } } })), /settings\.data\.folderPath/);
  assert.throws(() => parseInstanceConfig(settings({ data: { folderPath: 'nested%2Fescape', layout: 'tracker-v1', evidence: { kind: 'none' } } })), /settings\.data\.folderPath/);
  assert.throws(() => parseInstanceConfig(settings({ browser: { ...settings().browser, namespace: 'other' } })), /settings\.browser\.namespace/);
  assert.throws(() => parseInstanceConfig(settings({ github: { ...settings().github, branch: 'main..bad' } })), /settings\.github\.branch/);
  assert.throws(() => parseInstanceConfig(settings({ access: { kind: 'ready', teamDomain: 'http://team.synthetic.test', audience: 'a', readerEmails: ['reader@synthetic.test'], service: { kind: 'disabled' } } })), /settings\.access\.teamDomain/);
  assert.throws(() => parseInstanceConfig(readySettings({ publish: { kind: 'github-app', publisherEmail: 'other@synthetic.test', recordActorId: 'actor', operations: 'existing-task-edits-v1' } })), /settings\.publish\.publisherEmail/);
  assert.throws(() => parseInstanceConfig(settings({ publish: { kind: 'github-app' } })), /settings\.publish/);
  assert.throws(() => parseInstanceConfig(settings({ deployment: { ...settings().deployment, compatibilityFlags: ['workers_beta'] } })), /settings\.deployment\.compatibilityFlags/);
  for (const path of ['/absolute', '../parent', 'a/../b', 'a%2Fb', 'a\\b', 'a//b']) {
    assert.throws(() => normalizeRepositoryPath(path), /repository-relative|unencoded|segment/);
  }
});

test('catalog rejects duplicate site and browser identities', () => {
  const first = settings();
  assert.throws(() => parseInstanceCatalog([first, structuredClone(first)]), /catalog\[1\]\.id/);
  const second = settings({ id: 'other', browser: { ...first.browser, namespace: 'other' } });
  assert.throws(() => parseInstanceCatalog([first, second]), /storeId/);
});
