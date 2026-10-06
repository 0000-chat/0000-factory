import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseInstanceConfig } from '../tooling/instance/config.mjs';
import {
  canonicalPath,
  readDataFiles,
  repositoryPath,
  selectedDataPaths,
  selectDataPath,
  sourceUrl,
} from '../tooling/instance/paths.mjs';

function instance(folderPath = '', evidence = 'grok-bot-v1') {
  return parseInstanceConfig({
    schemaVersion: 1,
    id: folderPath ? 'nested' : 'root',
    branding: {
      name: 'Synthetic', title: 'Synthetic', description: 'Synthetic', markText: 'SYN',
      homeLabel: 'Home', loadingLabel: 'Loading', faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'synthetic-org', repo: 'synthetic-data', branch: 'main' },
    data: { folderPath, layout: 'tracker-v1', evidence: { kind: evidence } },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: folderPath ? 'nested' : 'root',
      storeId: `${folderPath ? 'nested' : 'root'}-store`,
      themeKey: `${folderPath ? 'nested' : 'root'}-theme`,
      editLockPrefix: `${folderPath ? 'nested' : 'root'}-edit`,
      publishLockName: `${folderPath ? 'nested' : 'root'}-publish`,
      unscheduledCollapsedKey: `${folderPath ? 'nested' : 'root'}.unscheduled`,
      activityPausedKey: `${folderPath ? 'nested' : 'root'}.activity`,
    },
    access: { kind: 'unconfigured' },
    publish: { kind: 'disabled' },
    deployment: {
      accountBinding: 'synthetic', workerName: folderPath ? 'tracker-nested' : 'tracker-root',
      customDomain: folderPath ? 'nested.synthetic.test' : 'root.synthetic.test',
      compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
    },
  });
}

const canonicalFiles = [
  'team.md', 'tracker/people.json', 'tracker/items/product/task.md', 'tracker/history/h.md',
  'tracker/decisions/d.md', 'tracker/updates/u.md', 'tracker/releases/r.md', 'tracker/plans/p.md',
  'tracker/milestones/m.md', 'tracker/capacities/c.md', 'tracker/capacity/legacy.md',
  'tracker/delivery/d.md', 'tracker/active/a.md', 'tracker/intake/i.md', 'tracker/archive/ar.md',
  'tracker/proposals/pr.md', 'tracker/migrations/unified-work.json', 'tracker/changelog/2026-01-01.md',
  'tracker/publish-receipts/request.json', 'grok-bot/inbox/synthetic/request.md',
  'grok-bot/receipts/synthetic/request.md',
];

function writeFixture(root, site) {
  for (const canonical of canonicalFiles) {
    const path = join(root, repositoryPath(site, canonical));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `synthetic:${canonical}\n`);
  }
  mkdirSync(join(root, repositoryPath(site, 'ignored')), { recursive: true });
  writeFileSync(join(root, repositoryPath(site, 'ignored/app.mjs')), 'throw new Error("must not execute");\n');
}

test('root and nested path translations cover every selected tracker role', () => {
  for (const site of [instance(''), instance('site-data')]) {
    const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-paths-'));
    writeFixture(root, site);
    const paths = selectedDataPaths({ dataRepo: root, instance: site });
    const byCanonical = new Map(paths.map(entry => [entry.canonicalPath, entry]));
    for (const canonical of canonicalFiles) {
      const selected = byCanonical.get(canonical);
      assert.ok(selected, `missing ${canonical}`);
      assert.equal(selected.repositoryPath, repositoryPath(site, canonical));
      assert.equal(canonicalPath(site, selected.repositoryPath), canonical);
      assert.equal(selected.sourceUrl, sourceUrl(site, canonical));
    }
    assert.equal(byCanonical.has('ignored/app.mjs'), false);
    assert.deepEqual([...new Set(paths.map(entry => entry.role))].sort(), ['changelog', 'evidence', 'migrations', 'receipts', 'records', 'registry', 'team']);
    const files = readDataFiles({ dataRepo: root, instance: site });
    assert.equal(files.get('tracker/people.json'), 'synthetic:tracker/people.json\n');
  }
});

test('path boundary rejects sibling prefixes, traversal, and encoded separators', () => {
  const site = instance('tooling/project-tracker');
  assert.equal(repositoryPath(site, 'tracker/items/task.md'), 'tooling/project-tracker/tracker/items/task.md');
  assert.equal(canonicalPath(site, 'tooling/project-tracker/tracker/items/task.md'), 'tracker/items/task.md');
  assert.equal(canonicalPath(site, 'tooling/project-trackers/tracker/items/task.md'), null);
  assert.equal(canonicalPath(site, 'tooling/project-trackerish/tracker/items/task.md'), null);
  assert.equal(canonicalPath(site, 'tooling/project-tracker/tracker/%69tems/task.md'), null);
  assert.equal(selectDataPath(site, 'tracker/items/../secret.md'), null);
  assert.equal(selectDataPath(site, 'tracker/items/%2e%2e/secret.md'), null);
  assert.throws(() => repositoryPath(site, 'tracker/items/../secret.md'), /canonicalPath/);
});

test('selected files fail closed on symlink escapes and executable inputs', () => {
  const site = instance('', 'none');
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-paths-security-'));
  mkdirSync(join(root, 'tracker/items'), { recursive: true });
  const outside = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-paths-outside-'));
  writeFileSync(join(outside, 'escape.md'), 'escape');
  symlinkSync(outside, join(root, 'tracker/items/escape-dir'));
  assert.throws(() => selectedDataPaths({ dataRepo: root, instance: site }), /symlink/);

  const executableRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'instance-paths-executable-'));
  mkdirSync(join(executableRoot, 'tracker/items'), { recursive: true });
  const executable = join(executableRoot, 'tracker/items/task.md');
  writeFileSync(executable, 'synthetic');
  chmodSync(executable, 0o755);
  assert.throws(() => selectedDataPaths({ dataRepo: executableRoot, instance: site }), /non-executable/);
});
