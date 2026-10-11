import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  parseInstanceConfig,
  parsePublicInstanceConfig as parseNodePublicInstanceConfig,
  publicInstanceConfig,
} from '../../../tooling/instance/config.mjs';
import { fixtureInstance } from '../../../tests/helpers/fixture-data.mjs';
import {
  parsePublicInstanceConfig,
  trackerInstanceConfig,
} from '../src/instance-config';
import type { PublicInstanceConfig } from '../src/instance-config';

const synthetic0000Settings = (() => {
  const fixture = fixtureInstance({ id: 'synthetic-0000', folderPath: '' });
  return {
    ...fixture,
    id: '0000',
    github: {
      owner: 'fixture-owner',
      repo: 'fixture-tracker',
      branch: 'synthetic-main',
    },
    browser: {
      namespace: '0000',
      storeId: '0000-tracker-viewer',
      themeKey: '0000-tracker-theme',
      editLockPrefix: '0000-tracker-task-edit',
      publishLockName: '0000-tracker-task-publish-transaction',
      unscheduledCollapsedKey: '0000.viewer.unscheduledCollapsed',
      activityPausedKey: '0000.workActivity.animationsPaused',
    },
    deployment: {
      ...fixture.deployment,
      customDomain: 'tracker-0000.fixture.test',
    },
  };
})();
const synthetic0000Projection = publicInstanceConfig(parseInstanceConfig(synthetic0000Settings));

interface MutableProjection {
  [key: string]: unknown;
  schemaVersion: number;
  id: string;
  branding: Record<string, unknown>;
  source: Record<string, unknown>;
  browser: Record<string, unknown>;
  publishing: Record<string, unknown>;
}

function mutableProjection(value: PublicInstanceConfig): MutableProjection {
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    branding: { ...value.branding },
    source: { ...value.source },
    browser: { ...value.browser },
    publishing: { ...value.publishing },
  };
}

function thrownMessage(parse: (value: unknown) => unknown, value: unknown): string | null {
  try {
    parse(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('public projection fails clearly when missing or malformed', () => {
  assert.throws(() => parsePublicInstanceConfig(undefined), /publicInstance: must be an object/);
  assert.throws(() => parsePublicInstanceConfig({}), /publicInstance\.schemaVersion: must be 1/);
  assert.throws(() => parsePublicInstanceConfig({
    ...trackerInstanceConfig,
    unexpected: true,
  }), /publicInstance\.unexpected: unknown field/);
  assert.throws(() => parsePublicInstanceConfig({
    ...trackerInstanceConfig,
    browser: { ...trackerInstanceConfig.browser, storeId: 'other-store' },
  }), /publicInstance\.browser\.storeId: must use the synthetic namespace/);
  assert.throws(() => parsePublicInstanceConfig({
    ...trackerInstanceConfig,
    branding: { ...trackerInstanceConfig.branding, faviconPath: 'assets/\n.svg' },
  }), /publicInstance\.branding\.faviconPath: contains a control character/);
});

test('the synthetic 0000 projection preserves browser keys byte-for-byte', () => {
  const parsed = parsePublicInstanceConfig(synthetic0000Projection);
  assert.equal(parsed.id, '0000');
  assert.deepEqual(parsed.browser, {
    namespace: '0000',
    storeId: '0000-tracker-viewer',
    themeKey: '0000-tracker-theme',
    editLockPrefix: '0000-tracker-task-edit',
    publishLockName: '0000-tracker-task-publish-transaction',
    unscheduledCollapsedKey: '0000.viewer.unscheduledCollapsed',
    activityPausedKey: '0000.workActivity.animationsPaused',
  });
  assert.equal(parsed.publishing.kind, 'disabled');
  assert.deepEqual(parsed.features, { weeklyPlanning: true });
});

test('browser public config accepts a disabled weekly planning feature and rejects malformed values', () => {
  const disabled = parsePublicInstanceConfig({
    ...synthetic0000Projection,
    features: { weeklyPlanning: false },
  });
  assert.deepEqual(disabled.features, { weeklyPlanning: false });
  for (const features of [null, [], true, {}, { weeklyPlanning: 'false' }, { weeklyPlanning: false, future: true }]) {
    assert.throws(
      () => parsePublicInstanceConfig({ ...synthetic0000Projection, features }),
      /publicInstance\.features(?:\.weeklyPlanning|\.future)?/u,
    );
  }
});

test('independent projections isolate every browser state surface', () => {
  const first = parsePublicInstanceConfig({
    ...trackerInstanceConfig,
    id: 'alpha',
    browser: {
      namespace: 'alpha',
      storeId: 'alpha-store',
      themeKey: 'alpha-theme',
      editLockPrefix: 'alpha-edit',
      publishLockName: 'alpha-publish',
      unscheduledCollapsedKey: 'alpha.unscheduled',
      activityPausedKey: 'alpha.activity',
    },
  });
  const second = parsePublicInstanceConfig({
    ...trackerInstanceConfig,
    id: 'beta',
    browser: {
      namespace: 'beta',
      storeId: 'beta-store',
      themeKey: 'beta-theme',
      editLockPrefix: 'beta-edit',
      publishLockName: 'beta-publish',
      unscheduledCollapsedKey: 'beta.unscheduled',
      activityPausedKey: 'beta.activity',
    },
  });
  for (const key of Object.keys(first.browser) as Array<keyof typeof first.browser>) {
    assert.notEqual(first.browser[key], second.browser[key], key);
  }
});

test('browser parser stays behaviorally aligned with the Node public parser', () => {
  const accepted = [synthetic0000Projection, trackerInstanceConfig];
  for (const candidate of accepted) {
    const nodeParsed = parseNodePublicInstanceConfig(candidate);
    const browserParsed = parsePublicInstanceConfig(candidate);
    assert.deepEqual(browserParsed, nodeParsed);
    assert.equal(Object.isFrozen(browserParsed), true);
    assert.equal(Object.isFrozen(browserParsed.branding), true);
    assert.equal(Object.isFrozen(browserParsed.source), true);
    assert.equal(Object.isFrozen(browserParsed.browser), true);
    assert.equal(Object.isFrozen(browserParsed.publishing), true);
    assert.throws(() => { browserParsed.browser.storeId = 'changed'; }, TypeError);
    assert.throws(() => { nodeParsed.browser.storeId = 'changed'; }, TypeError);
  }
});

test('browser and Node parsers reject the same malformed projection corpus', () => {
  const base = mutableProjection(synthetic0000Projection);
  const malformed: Array<[string, unknown]> = [
    ['unknown root field', { ...base, unexpected: true }],
    ['missing branding', (() => {
      const { branding: _branding, ...value } = base;
      return value;
    })()],
    ['missing browser storage key', (() => {
      const { storeId: _storeId, ...browser } = base.browser;
      return { ...base, browser };
    })()],
    ['namespace mismatch', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.browser.namespace = 'other';
      return value;
    })()],
    ['storage namespace mismatch', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.browser.storeId = 'other-store';
      return value;
    })()],
    ['unsafe source folder traversal', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.source.folderPath = 'data/../private';
      return value;
    })()],
    ['encoded source folder', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.source.folderPath = 'data%2Fprivate';
      return value;
    })()],
    ['unsafe favicon path', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.branding.faviconPath = 'assets/../favicon.svg';
      return value;
    })()],
    ['favicon outside assets', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.branding.faviconPath = 'favicon.svg';
      return value;
    })()],
    ...['-bad', '.hidden', 'item.lock'].map((branch): [string, unknown] => [
      `invalid source ref ${branch}`,
      (() => {
        const value = mutableProjection(synthetic0000Projection);
        value.source.branch = branch;
        return value;
      })(),
    ]),
    ['control character', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.branding.name = '0000\ntracker';
      return value;
    })()],
    ['invalid publishing kind', (() => {
      const value = mutableProjection(synthetic0000Projection);
      value.publishing.kind = 'maybe';
      return value;
    })()],
  ];

  for (const [label, candidate] of malformed) {
    const nodeMessage = thrownMessage(parseNodePublicInstanceConfig, candidate);
    const browserMessage = thrownMessage(parsePublicInstanceConfig, candidate);
    assert.notEqual(nodeMessage, null, `${label}: Node parser accepted malformed projection`);
    assert.notEqual(browserMessage, null, `${label}: browser parser accepted malformed projection`);
    assert.equal(browserMessage, nodeMessage, `${label}: parser error drift`);
  }
});
