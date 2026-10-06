import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'bun:test';

import { createGitHubClient } from '../worker/github-client.mjs';
import { fixtureInstance, writeFixtureData } from './helpers/fixture-data.mjs';
import { createSyntheticGitHub } from './helpers/synthetic-github.mjs';

const TEST_ROOT = resolve(process.env.TMPDIR ?? tmpdir());
const INSTALLATION_ID = '108108';
const INSTALLATION_TOKEN = 'synthetic-installation-token-108';
const APP_ID = '108108';
const FIXED_NOW = Date.parse('2026-10-03T00:00:00.000Z');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

function git(repository, args, input) {
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  return execFileSync('git', args, {
    cwd: repository,
    input,
    encoding: 'buffer',
    env: {
      ...environment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: devNull,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture Initializer',
      GIT_AUTHOR_EMAIL: 'initializer@fixture.test',
      GIT_COMMITTER_NAME: 'Fixture Initializer',
      GIT_COMMITTER_EMAIL: 'initializer@fixture.test',
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function text(output) {
  return Buffer.from(output).toString('utf8').trim();
}

function initializeFixture(folderPath) {
  mkdirSync(TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEST_ROOT, 'synthetic-github-'));
  try {
    const instance = fixtureInstance({
      id: folderPath ? 'transport-nested' : 'transport-root',
      folderPath,
      accessKind: 'ready',
      publishKind: 'github-app',
    });
    const fixture = writeFixtureData({ repositoryPath: root, instance, mode: 'populated' });
    mkdirSync(join(root, 'unrelated'), { recursive: true });
    writeFileSync(join(root, 'unrelated', 'sentinel.txt'), 'Sentinel data stays in the published tree.\n', 'utf8');
    git(root, ['init', '--initial-branch', instance.github.branch]);
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'Synthetic fixture baseline']);
    const baseline = text(git(root, ['rev-parse', `refs/heads/${instance.github.branch}`]));
    return { root, instance, fixture, baseline };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function createTransport(fixture) {
  const transport = createSyntheticGitHub({
    dataRepo: fixture.root,
    instance: fixture.instance,
    installationId: INSTALLATION_ID,
    token: INSTALLATION_TOKEN,
  });
  const client = createGitHubClient({
    env: {
      GITHUB_APP_ID: APP_ID,
      GITHUB_INSTALLATION_ID: INSTALLATION_ID,
      GITHUB_PRIVATE_KEY: PRIVATE_KEY,
    },
    instance: fixture.instance,
    testTransport: transport,
    now: () => FIXED_NOW,
  });
  return { transport, client };
}

function physical(instance, canonical) {
  return instance.data.folderPath ? `${instance.data.folderPath}/${canonical}` : canonical;
}

function commitMessage(requestId, sourceCommit) {
  return [
    'Synthetic authenticated tracker publish',
    '',
    `Publish-Request-ID: ${requestId}`,
    `Publish-Payload-SHA256: ${'a'.repeat(64)}`,
    `Publish-Original-SHA: ${sourceCommit}`,
  ].join('\n');
}

async function exerciseTransport(folderPath) {
  const fixture = initializeFixture(folderPath);
  try {
    const { transport, client } = createTransport(fixture);
    const prefix = fixture.instance.data.folderPath;
    const teamPath = physical(fixture.instance, 'team.md');
    const receiptId = '12345678-1234-4234-8234-123456789abc';
    const receiptPath = physical(fixture.instance, `tracker/publish-receipts/${receiptId}.json`);
    const baselineCommit = await client.getCommit(await client.getRef());
    assert.equal(baselineCommit.sha, fixture.baseline);
    const baselineTree = await client.getTree(baselineCommit.tree.sha);
    assert.ok(baselineTree.some(entry => entry.path === teamPath && entry.type === 'blob'));
    assert.ok(baselineTree.some(entry => entry.path === 'unrelated/sentinel.txt' && entry.type === 'blob'));

    const source = readFileSync(join(fixture.root, teamPath), 'utf8');
    const blobs = await client.readBlobs(baselineCommit.sha, [teamPath]);
    assert.equal(blobs.get(teamPath), source);

    const updatedTeam = `${source}Synthetic transport changed this source.\n`;
    const receipt = '{"schemaVersion":2,"status":"committed"}\n';
    const nextTree = await client.createTree(baselineCommit.tree.sha, [
      { path: teamPath, mode: '100644', type: 'blob', content: updatedTeam },
      { path: receiptPath, mode: '100644', type: 'blob', content: receipt },
    ]);
    const nextCommit = await client.createCommit(
      commitMessage(receiptId, baselineCommit.sha),
      nextTree,
      baselineCommit.sha,
    );
    assert.match(nextTree, /^[a-f0-9]{40}$/);
    assert.match(nextCommit, /^[a-f0-9]{40}$/);
    assert.equal(text(git(fixture.root, ['rev-parse', `${nextCommit}^{commit}`])), nextCommit);
    assert.equal(text(git(fixture.root, ['rev-parse', `${nextCommit}^{tree}`])), nextTree);
    assert.equal(text(git(fixture.root, ['show', `${nextCommit}:${teamPath}`])), updatedTeam.trim());
    assert.equal(text(git(fixture.root, ['show', `${nextCommit}:unrelated/sentinel.txt`])), 'Sentinel data stays in the published tree.');
    assert.ok(git(fixture.root, ['archive', '--format=tar', nextCommit, teamPath]).byteLength > 0);

    assert.equal(await client.advanceMain(nextCommit), nextCommit);
    assert.equal(await client.getRef(), nextCommit);
    const ancestry = await client.compareCommits(baselineCommit.sha, nextCommit);
    assert.deepEqual(ancestry, { aheadBy: 1, status: 'ahead' });
    assert.deepEqual(await client.compareCommits(nextCommit, nextCommit), { aheadBy: 0, status: 'identical' });

    const receiptCommit = await client.receiptCommit(receiptId, nextCommit);
    assert.deepEqual(receiptCommit, {
      commit: nextCommit,
      message: commitMessage(receiptId, baselineCommit.sha),
      parent: baselineCommit.sha,
    });
    const receiptBlob = await client.readBlobs(nextCommit, [receiptPath]);
    assert.equal(receiptBlob.get(receiptPath), receipt);

    const staleTree = await client.createTree(baselineCommit.tree.sha, [
      { path: teamPath, mode: '100644', type: 'blob', content: `${source}Stale branch.\n` },
    ]);
    const staleCommit = await client.createCommit('Synthetic stale branch', staleTree, baselineCommit.sha);
    assert.equal(await client.advanceMain(staleCommit), null);
    assert.equal(await client.getRef(), nextCommit);
    assert.equal(transport.state.head, nextCommit);

    const treeWrite = transport.writes.find(write => write.operation === 'create-tree');
    assert.deepEqual(treeWrite.paths, [teamPath, receiptPath]);
    assert.equal(treeWrite.owner, fixture.instance.github.owner);
    assert.equal(treeWrite.repo, fixture.instance.github.repo);
    assert.equal(treeWrite.ref, `refs/heads/${fixture.instance.github.branch}`);
    assert.ok(transport.writes.some(write => write.operation === 'create-commit' && write.parent === baselineCommit.sha));
    assert.ok(transport.writes.some(write => write.operation === 'update-ref' && write.commit === nextCommit));
    assert.ok(transport.requests.some(request => request.repository === `${fixture.instance.github.owner}/${fixture.instance.github.repo}`));
    assert.ok(transport.requests.some(request => request.ref === fixture.instance.github.branch));
    if (prefix) assert.ok(treeWrite.paths.every(path => path.startsWith(`${prefix}/`)));

    await assert.rejects(
      transport.fetch(`https://api.github.com/repos/foreign-owner/${fixture.instance.github.repo}/git/ref/heads/${fixture.instance.github.branch}`, {
        headers: { Authorization: `Bearer ${INSTALLATION_TOKEN}` },
      }),
      /foreign repository destination/i,
    );
    await assert.rejects(
      transport.fetch(`https://api.github.com/repos/${fixture.instance.github.owner}/${fixture.instance.github.repo}/git/ref/heads/foreign-branch`, {
        headers: { Authorization: `Bearer ${INSTALLATION_TOKEN}` },
      }),
      /foreign branch reference/i,
    );
    await assert.rejects(
      transport.fetch('https://example.test/repos/foreign/repo/git/ref/heads/main'),
      /foreign network destination/i,
    );
    await assert.rejects(
      transport.fetch(`http://api.github.com/repos/${fixture.instance.github.owner}/${fixture.instance.github.repo}/git/ref/heads/${fixture.instance.github.branch}`),
      /foreign network destination/i,
    );
    await assert.rejects(
      transport.fetch(`https://synthetic-user:synthetic-password@api.github.com/repos/${fixture.instance.github.owner}/${fixture.instance.github.repo}/git/ref/heads/${fixture.instance.github.branch}`),
      /foreign network destination/i,
    );
    const capturedQuery = `query TrackerSource { repository(owner: ${JSON.stringify(fixture.instance.github.owner)}, name: ${JSON.stringify(fixture.instance.github.repo)}) { b0: object(expression: ${JSON.stringify(`${baselineCommit.sha}:${teamPath}`)}) { ... on Blob { text byteSize isTruncated } } } }`;
    await assert.rejects(
      transport.fetch('https://api.github.com/graphql', {
        method: 'GET',
        headers: { Authorization: `Bearer ${INSTALLATION_TOKEN}` },
        body: JSON.stringify({ query: capturedQuery }),
      }),
      /unrecognized GraphQL endpoint/i,
    );
    await assert.rejects(
      transport.fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${INSTALLATION_TOKEN}` },
        body: JSON.stringify({ query: 'query Unrecognized { viewer { login } }' }),
      }),
      /unrecognized GraphQL query/i,
    );

    return { fixture, transport };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('uses real GitHub client requests against a checkoutable root-layout Git repository', async () => {
  await exerciseTransport('');
});

test('uses literal tooling/project-tracker paths for nested repository layouts', async () => {
  await exerciseTransport('tooling/project-tracker');
});

test('rejects a data path whose Git top-level is not exactly the supplied repository', () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const fixture = initializeFixture('');
  const child = join(fixture.root, 'nested-path');
  mkdirSync(child);
  try {
    assert.throws(() => createSyntheticGitHub({
      dataRepo: child,
      instance: fixture.instance,
      installationId: INSTALLATION_ID,
      token: INSTALLATION_TOKEN,
    }), /initialized disposable Git repository|top-level/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
