import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'bun:test';

import { fixtureInstance, writeFixtureData } from './helpers/fixture-data.mjs';
import { createSyntheticGitHub } from './helpers/synthetic-github.mjs';
import { repositoryPath } from '../tooling/instance/paths.mjs';
import { buildSnapshot } from '../tracker/viewer/tooling/build.mjs';
import { createDevHandler } from '../tracker/viewer/tooling/dev.mjs';

const ENGINE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEST_ROOT = resolve(process.env.TMPDIR ?? tmpdir());
const FIXED_BUILT_AT = '2026-10-06T00:00:00.000Z';
const INSTALLATION_ID = '108108';
const INSTALLATION_TOKEN = 'synthetic-installation-token-108';
const APP_ID = '108108';
const originalFetch = globalThis.fetch;

const { privateKey: accessPrivateKey, publicKey: accessPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCESS_PUBLIC_JWK = {
  ...accessPublicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'synthetic-access-key',
  use: 'sig',
};
const { privateKey: githubPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const GITHUB_PRIVATE_KEY = githubPrivateKey.export({ type: 'pkcs8', format: 'pem' });

const roots = new Set();
const fixtures = [];

function isolatedGitEnv(overrides = {}) {
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Synthetic Fixture Initializer',
    GIT_AUTHOR_EMAIL: 'initializer@fixture.test',
    GIT_COMMITTER_NAME: 'Synthetic Fixture Initializer',
    GIT_COMMITTER_EMAIL: 'initializer@fixture.test',
    ...overrides,
  };
}

function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    env: isolatedGitEnv(),
    input,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitText(cwd, args) {
  return git(cwd, args).toString('utf8').trim();
}

function gitCommit(cwd) {
  return gitText(cwd, ['rev-parse', `refs/heads/${gitText(cwd, ['symbolic-ref', '--short', 'HEAD'])}`]);
}

function temporaryRoot(prefix) {
  mkdirSync(TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEST_ROOT, prefix));
  roots.add(root);
  return root;
}

function initializeDataRepository({ id, folderPath = '', mode = 'empty', accessKind = 'unconfigured', publishKind = 'disabled' }) {
  const root = temporaryRoot(`contract-${id}-`);
  const instance = fixtureInstance({ id, folderPath, accessKind, publishKind });
  const data = writeFixtureData({ repositoryPath: join(root, 'data'), instance, mode });
  fixtures.push(data);
  mkdirSync(join(data.dataRepo, 'unrelated'), { recursive: true });
  writeFileSync(join(data.dataRepo, 'unrelated', 'sentinel.txt'), 'Synthetic unrelated sentinel remains unchanged.\n', 'utf8');
  git(data.dataRepo, ['init', '--quiet', '--initial-branch', instance.github.branch]);
  git(data.dataRepo, ['add', '--all']);
  git(data.dataRepo, ['commit', '--quiet', '-m', 'Synthetic fixture baseline']);
  return {
    root,
    data,
    instance,
    output: join(root, 'output'),
    baseline: gitCommit(data.dataRepo),
  };
}

function build(input, output = input.output) {
  return buildSnapshot({
    engineRoot: ENGINE_ROOT,
    instancePath: input.data.instancePath,
    dataRepo: input.data.dataRepo,
    output,
    builtAt: FIXED_BUILT_AT,
  });
}

function readManifest(output) {
  return JSON.parse(readFileSync(join(output, 'build-manifest.json'), 'utf8'));
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function physicalPath(instance, canonicalPath) {
  const path = repositoryPath(instance, canonicalPath);
  return path ? path.split('/').join('/') : path;
}

function assertManifestIdentity(input, result) {
  const manifest = readManifest(input.output);
  const engineCommit = gitText(ENGINE_ROOT, ['rev-parse', 'HEAD']);
  const dataCommit = gitCommit(input.data.dataRepo);
  const settingsDigest = createHash('sha256').update(readFileSync(input.data.instancePath)).digest('hex');
  const engineDirty = gitText(ENGINE_ROOT, ['status', '--porcelain']).length > 0;
  const dataDirty = gitText(input.data.dataRepo, ['status', '--porcelain']).length > 0;

  assert.equal(manifest.engine.commit, engineCommit);
  assert.equal(manifest.engine.dirty, engineDirty);
  assert.equal(manifest.data.commit, dataCommit);
  assert.equal(manifest.data.dirty, dataDirty);
  assert.equal(manifest.source.commit, dataCommit);
  assert.equal(manifest.settings.digest, settingsDigest);
  assert.match(manifest.inputFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(result.data.source.commit, dataCommit);
  assert.equal(result.data.source.dirty, dataDirty);
  assert.equal(result.manifest.inputFingerprint, manifest.inputFingerprint);
  assert.equal(typeof manifest.engine.sourceDigest, 'string');
  assert.ok(manifest.artifactHashes && Object.keys(manifest.artifactHashes).length > 0);
  for (const [path, digest] of Object.entries(manifest.artifactHashes)) {
    assert.equal(digestFile(join(input.output, path)), digest, path);
  }
}

function publicAssetText(output) {
  return [
    readFileSync(join(output, 'assets/index.html'), 'utf8'),
    readFileSync(join(output, 'assets/data.json'), 'utf8'),
  ].join('\n');
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function accessToken(instance, email, claims = {}) {
  const header = base64UrlJson({ alg: 'RS256', kid: ACCESS_PUBLIC_JWK.kid, typ: 'JWT' });
  const payload = base64UrlJson({
    iss: instance.access.teamDomain,
    aud: [instance.access.audience],
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(accessPrivateKey).toString('base64url')}`;
}

function installNetwork({ instance, transport = null }) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ origin: url.origin, pathname: url.pathname });
    if (url.origin === instance.access?.teamDomain && url.pathname === '/cdn-cgi/access/certs') {
      return Response.json({ keys: [ACCESS_PUBLIC_JWK] });
    }
    if (url.origin === 'https://api.github.com' && transport) return transport.fetch(input, init);
    throw new Error(`unexpected synthetic network destination: ${url.origin}${url.pathname}`);
  };
  return {
    calls,
    accessCalls: () => calls.filter(call => call.pathname === '/cdn-cgi/access/certs').length,
    githubCalls: () => calls.filter(call => call.origin === 'https://api.github.com').length,
  };
}

async function importGeneratedWorker(output, suffix) {
  const module = await import(`${pathToFileURL(join(output, 'worker-entry.mjs')).href}?contract-${suffix}`);
  assert.ok(module.default && typeof module.default.fetch === 'function');
  return module.default;
}

function requestFor(instance, path, {
  token,
  method = 'GET',
  body,
  origin = `https://${instance.deployment.customDomain}`,
} = {}) {
  const headers = new Headers();
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  if (body !== undefined) {
    headers.set('Origin', origin);
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function workerEnvironment(output, { assetCalls, credentials = true } = {}) {
  const handler = createDevHandler({ output });
  return {
    ASSETS: {
      fetch: request => {
        if (assetCalls) assetCalls.count += 1;
        return handler(request);
      },
    },
    ...(credentials ? {
      GITHUB_APP_ID: APP_ID,
      GITHUB_INSTALLATION_ID: INSTALLATION_ID,
      GITHUB_PRIVATE_KEY,
      // These ambient values are deliberately foreign. The generated Worker
      // must use its captured settings and never infer a destination from them.
      GITHUB_OWNER: 'foreign-owner',
      GITHUB_REPOSITORY: 'foreign-repository',
      GITHUB_BRANCH: 'foreign-branch',
    } : {}),
  };
}

function publishTask(result, sourceCommit) {
  const item = result.data.items.find(candidate => candidate.id === 'fixture-foundation-task');
  assert.ok(item, 'the built snapshot contains the approved synthetic task');
  assert.equal(item.acceptance.approved, true);
  assert.ok(item.proposal.approvedParts.includes('task'));
  const field = 'sections.outcome';
  const proposedValue = `${item.sections.outcome}\n\nPublished through the external engine contract.`;
  return {
    id: item.id,
    fields: {
      [field]: {
        value: proposedValue,
        baseValue: item.sections.outcome,
        baseSourceCommit: sourceCommit,
        baseContentRevision: item.proposal.revision,
      },
    },
    proposedValue,
  };
}

function requestIdFor(folderPath) {
  return folderPath
    ? '20000000-0000-4000-8000-000000000002'
    : '10000000-0000-4000-8000-000000000001';
}

function assertPublicBoundary(input) {
  const publicText = publicAssetText(input.output);
  for (const privateField of [
    'teamDomain', 'audience', 'readerEmails', 'publisherEmail', 'recordActorId',
    'accountBinding', 'GITHUB_PRIVATE_KEY', 'ACCESS_SERVICE_TOKEN',
  ]) assert.equal(publicText.includes(privateField), false, privateField);
  assert.match(publicText, new RegExp(`Synthetic ${input.instance.id}`));
  assert.match(publicText, new RegExp(`"folderPath":"${input.instance.data.folderPath}"`));
  assert.match(publicText, new RegExp(`"owner":"${input.instance.github.owner}"`));
  assert.equal(existsSync(join(input.output, 'runtime-config.mjs')), true);
  assert.equal(existsSync(join(input.output, 'worker-entry.mjs')), true);
  assert.equal(existsSync(join(input.output, 'wrangler.json')), true);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test('builds four fresh data-only repositories through the external engine contract', () => {
  for (const [folderPath, mode, accessKind, publishKind] of [
    ['', 'empty', 'unconfigured', 'disabled'],
    ['', 'populated', 'unconfigured', 'disabled'],
    ['tooling/project-tracker', 'empty', 'unconfigured', 'disabled'],
    ['tooling/project-tracker', 'populated', 'unconfigured', 'disabled'],
  ]) {
    const input = initializeDataRepository({
      id: `contract-${folderPath ? 'nested' : 'root'}-${mode}`,
      folderPath,
      mode,
      accessKind,
      publishKind,
    });
    const result = build(input);
    const builtData = JSON.parse(readFileSync(join(input.output, 'assets/data.json'), 'utf8'));
    assert.equal(builtData.items.length, mode === 'populated' ? 94 : 0);
    assert.equal(result.instance.data.folderPath, folderPath);
    assert.equal(input.data.instancePath, join(input.data.dataRepo, ...(folderPath ? [folderPath, 'settings.json'] : ['settings.json'])));
    assert.equal(input.output.startsWith(`${ENGINE_ROOT}/`), false);
    assert.equal(input.output.startsWith(`${input.data.dataRepo}/`), false);
    assertManifestIdentity(input, result);
    assertPublicBoundary(input);
    assert.match(readFileSync(join(input.output, 'assets/index.html'), 'utf8'), /__TRACKER_PUBLIC_INSTANCE__/u);
    const wrangler = JSON.parse(readFileSync(join(input.output, 'wrangler.json'), 'utf8'));
    assert.equal(wrangler.workers_dev, false);
    assert.equal(wrangler.preview_urls, false);
    assert.equal(wrangler.assets.run_worker_first, true);
    assert.equal(wrangler.assets.directory, './assets');
  }
});

test('does not execute data-repository package or tooling code and serves only public assets', async () => {
  const input = initializeDataRepository({ id: 'contract-hostile-data' });
  const marker = join(input.root, 'data-code-executed');
  writeFileSync(join(input.data.dataRepo, 'evil-model.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`, 'utf8');
  writeFileSync(join(input.data.dataRepo, 'package.json'), JSON.stringify({ scripts: { prepare: `node ${marker}` } }), 'utf8');
  build(input);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(input.output, 'worker-entry.mjs'), 'utf8').includes(input.data.dataRepo), false);
  const handler = createDevHandler({ output: input.output });
  for (const privatePath of ['/runtime-config.mjs', '/worker-entry.mjs', '/wrangler.json', '/build-manifest.json']) {
    assert.equal((await handler(new Request(`https://contract-hostile-data.fixture.test${privatePath}`))).status, 404, privatePath);
  }
  const network = installNetwork({ instance: input.instance });
  const worker = await importGeneratedWorker(input.output, 'hostile');
  let assetCalls = 0;
  const response = await worker.fetch(
    requestFor(input.instance, '/'),
    { ASSETS: { fetch: () => { assetCalls += 1; return new Response('should not be served'); } } },
  );
  assert.equal(response.status, 503);
  assert.equal(assetCalls, 0);
  assert.equal(network.calls.length, 0);
});

test('generated Worker fails closed before assets or GitHub and disabled publishing is a controlled 403', async () => {
  const unconfigured = initializeDataRepository({ id: 'contract-unconfigured' });
  build(unconfigured);
  const unconfiguredNetwork = installNetwork({ instance: unconfigured.instance });
  const unconfiguredWorker = await importGeneratedWorker(unconfigured.output, 'unconfigured');
  let unconfiguredAssets = 0;
  const unconfiguredResponse = await unconfiguredWorker.fetch(
    requestFor(unconfigured.instance, '/'),
    { ASSETS: { fetch: () => { unconfiguredAssets += 1; return new Response('private asset'); } } },
  );
  assert.equal(unconfiguredResponse.status, 503);
  assert.equal(unconfiguredAssets, 0);
  assert.equal(unconfiguredNetwork.calls.length, 0);

  const disabled = initializeDataRepository({
    id: 'contract-disabled-publish',
    accessKind: 'ready',
    publishKind: 'disabled',
  });
  build(disabled);
  const disabledNetwork = installNetwork({ instance: disabled.instance });
  const disabledWorker = await importGeneratedWorker(disabled.output, 'disabled-publish');
  const token = accessToken(disabled.instance, disabled.instance.access.readerEmails[0]);
  const disabledResponse = await disabledWorker.fetch(
    requestFor(disabled.instance, '/api/publish', { method: 'POST', token, body: {} }),
    workerEnvironment(disabled.output, { credentials: false }),
  );
  const disabledBody = await disabledResponse.json();
  assert.equal(disabledResponse.status, 403);
  assert.equal(disabledBody.code, 'publishing-disabled');
  assert.equal(disabledNetwork.githubCalls(), 0);
});

test('published root and nested data converge through generated HTTP, real Git objects, and a fresh clone', { timeout: 60_000 }, async () => {
  for (const folderPath of ['', 'tooling/project-tracker']) {
    const input = initializeDataRepository({
      id: `contract-publisher-${folderPath ? 'nested' : 'root'}`,
      folderPath,
      mode: 'populated',
      accessKind: 'ready',
      publishKind: 'github-app',
    });
    const baseline = build(input);
    assert.equal(baseline.data.source.commit, input.baseline);
    const task = publishTask(baseline, input.baseline);
    const requestId = requestIdFor(folderPath);
    const transport = createSyntheticGitHub({
      dataRepo: input.data.dataRepo,
      instance: input.instance,
      installationId: INSTALLATION_ID,
      token: INSTALLATION_TOKEN,
    });
    const network = installNetwork({ instance: input.instance, transport });
    const worker = await importGeneratedWorker(input.output, folderPath ? 'publisher-nested' : 'publisher-root');
    const assetCalls = { count: 0 };
    const env = workerEnvironment(input.output, { assetCalls });
    const publisherToken = accessToken(input.instance, input.instance.publish.publisherEmail);
    const invalidToken = accessToken(input.instance, input.instance.publish.publisherEmail, { aud: ['wrong-audience'] });
    const invalidResponse = await worker.fetch(requestFor(input.instance, '/', { token: invalidToken }), env);
    // Prove invalid claims do not reach the assets.
    assert.equal(invalidResponse.status, 403);
    assert.equal(assetCalls.count, 0);

    const homeResponse = await worker.fetch(requestFor(input.instance, '/', { token: publisherToken }), env);
    assert.equal(homeResponse.status, 200);
    assert.match(await homeResponse.text(), new RegExp(`Synthetic ${input.instance.id}`));
    assert.equal(assetCalls.count, 1);

    const prepareResponse = await worker.fetch(
      requestFor(input.instance, '/api/publish/prepare', {
        method: 'POST',
        token: publisherToken,
        body: { schemaVersion: 1, requestId, tasks: [{ id: task.id, fields: task.fields }] },
      }),
      env,
    );
    const prepared = await prepareResponse.json();
    assert.equal(prepareResponse.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.status, 'ready-for-review');
    assert.equal(prepared.currentSourceCommit, input.baseline);
    assert.equal(prepared.reviews.length, 1);
    assert.equal(prepared.reviews[0].taskId, task.id);
    assert.equal(prepared.reviews[0].requiresApproval, true);
    assert.match(prepared.reviews[0].reviewDigest, /^[a-f0-9]{64}$/u);

    const finalPayload = {
      schemaVersion: 2,
      requestId,
      tasks: [{ id: task.id, fields: task.fields }],
      approvals: [{ taskId: task.id, reviewDigest: prepared.reviews[0].reviewDigest }],
    };
    const finalResponse = await worker.fetch(
      requestFor(input.instance, '/api/publish', { method: 'POST', token: publisherToken, body: finalPayload }),
      env,
    );
    const receipt = await finalResponse.json();
    assert.equal(finalResponse.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.published, true);
    assert.equal(receipt.requestId, requestId);
    assert.equal(receipt.originalSourceCommit, input.baseline);
    assert.match(receipt.commit, /^[a-f0-9]{40}$/u);

    const treeWrites = transport.writes.filter(write => write.operation === 'create-tree');
    const commitWrites = transport.writes.filter(write => write.operation === 'create-commit');
    const refWrites = transport.writes.filter(write => write.operation === 'update-ref');
    assert.equal(treeWrites.length, 1);
    assert.equal(commitWrites.length, 1);
    assert.equal(refWrites.length, 1);
    assert.equal(commitWrites[0].parent, input.baseline);
    assert.equal(refWrites[0].previous, input.baseline);
    assert.equal(refWrites[0].commit, receipt.commit);
    assert.equal(refWrites[0].force, false);
    assert.equal(treeWrites[0].owner, input.instance.github.owner);
    assert.equal(treeWrites[0].repo, input.instance.github.repo);
    assert.equal(treeWrites[0].ref, `refs/heads/${input.instance.github.branch}`);
    assert.ok(treeWrites[0].paths.includes(physicalPath(input.instance, task.id ? `tracker/items/fixture/${task.id}.md` : '')));
    assert.ok(treeWrites[0].paths.includes(physicalPath(input.instance, `tracker/publish-receipts/${requestId}.json`)));
    assert.ok(treeWrites[0].paths.some(path => path.includes('/tracker/updates/') || path.startsWith('tracker/updates/')));
    assert.ok(treeWrites[0].paths.some(path => path.includes('/tracker/changelog/') || path.startsWith('tracker/changelog/')));
    assert.ok(transport.writePaths.every(path => input.instance.data.folderPath === '' || path.startsWith(`${input.instance.data.folderPath}/`)));
    for (const observation of transport.requests.filter(request => request.pathname.startsWith('/repos/'))) {
      assert.equal(observation.repository, `${input.instance.github.owner}/${input.instance.github.repo}`);
    }
    assert.equal(transport.requests.some(request => request.pathname === '/graphql'), true);
    assert.equal(gitText(input.data.dataRepo, ['rev-list', '--count', `${input.baseline}..${receipt.commit}`]), '1');
    assert.equal(gitText(input.data.dataRepo, ['show', `${receipt.commit}:unrelated/sentinel.txt`]), 'Synthetic unrelated sentinel remains unchanged.');

    const retryResponse = await worker.fetch(
      requestFor(input.instance, '/api/publish', { method: 'POST', token: publisherToken, body: finalPayload }),
      env,
    );
    const retryReceipt = await retryResponse.json();
    assert.equal(retryResponse.status, 200, JSON.stringify(retryReceipt));
    assert.equal(retryReceipt.commit, receipt.commit);
    assert.equal(transport.writes.filter(write => write.operation === 'create-commit').length, 1);

    const changedPayload = structuredClone(finalPayload);
    changedPayload.tasks[0].fields['sections.outcome'].value = `${task.proposedValue}\nA changed retry payload.`;
    const changedResponse = await worker.fetch(
      requestFor(input.instance, '/api/publish', { method: 'POST', token: publisherToken, body: changedPayload }),
      env,
    );
    const changedBody = await changedResponse.json();
    assert.equal(changedResponse.status, 409, JSON.stringify(changedBody));
    assert.equal(changedBody.code, 'idempotency-conflict');
    assert.equal(transport.writes.filter(write => write.operation === 'create-commit').length, 1);

    const statusResponse = await worker.fetch(
      requestFor(input.instance, `/api/publish/${requestId}?sourceCommit=${receipt.commit}`, { token: publisherToken }),
      env,
    );
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200, JSON.stringify(status));
    assert.equal(status.commit, receipt.commit);
    assert.equal(status.source.commit, receipt.commit);
    assert.equal(status.source.includesPublishedCommit, true);

    const clone = join(input.root, 'published-clone');
    git(input.root, ['clone', '--quiet', '--no-hardlinks', input.data.dataRepo, clone]);
    git(clone, ['checkout', '--quiet', '--detach', receipt.commit]);
    assert.equal(gitText(clone, ['status', '--porcelain']), '');
    const cloneData = {
      dataRepo: clone,
      instancePath: join(clone, ...(input.instance.data.folderPath ? [input.instance.data.folderPath, 'settings.json'] : ['settings.json'])),
    };
    const rebuilt = build({ data: cloneData }, join(input.root, 'published-output'));
    const rebuiltManifest = readManifest(join(input.root, 'published-output'));
    const rebuiltItem = rebuilt.data.items.find(candidate => candidate.id === task.id);
    assert.ok(rebuiltItem);
    assert.equal(rebuiltItem.sections.outcome, task.proposedValue);
    assert.equal(rebuiltItem.commitment, 'accepted');
    assert.equal(rebuiltItem.proposal.approvedParts.includes('task'), true);
    assert.equal(rebuilt.data.source.commit, receipt.commit);
    assert.equal(rebuiltManifest.data.commit, receipt.commit);
    assert.equal(rebuiltManifest.source.commit, receipt.commit);
    assert.equal(rebuiltManifest.data.dirty, false);
    assert.notEqual(rebuiltManifest.inputFingerprint, readManifest(input.output).inputFingerprint);
    for (const [path, digest] of Object.entries(rebuiltManifest.artifactHashes)) {
      assert.equal(digestFile(join(input.root, 'published-output', path)), digest, path);
    }
    assert.equal(gitText(clone, ['show', `${receipt.commit}:unrelated/sentinel.txt`]), 'Synthetic unrelated sentinel remains unchanged.');
    assert.equal(network.githubCalls() > 0, true);
  }
});
