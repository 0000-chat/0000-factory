import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'bun:test';
import { parseInstanceConfig } from '../../tooling/instance/config.mjs';
import { createTrackerWorker } from '../../worker/access-gate.mjs';
import { createGitHubClient } from '../../worker/github-client.mjs';

const TEAM_DOMAIN = 'https://synthetic.cloudflareaccess.test';
const AUDIENCE = 'synthetic-tracker-audience';
const PUBLISHER = 'publisher@example.test';
const READER = 'reader@example.test';
const KID = 'synthetic-key';
const FIXED_NOW = Date.parse('2026-10-06T00:00:00.000Z');

const keyPair = await webcrypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
publicJwk.kid = KID;

function settings({ access = 'ready', service = 'disabled', publish = 'github-app', folderPath = 'sites/synthetic' } = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic',
    branding: {
      name: 'Synthetic',
      title: 'Synthetic tracker',
      description: 'Synthetic tracker for Worker tests',
      markText: 'SYN',
      homeLabel: 'Synthetic home',
      loadingLabel: 'Loading synthetic tracker',
      faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'settings-owner', repo: 'settings-repo', branch: 'refs/stable' },
    data: { folderPath, layout: 'tracker-v1', evidence: { kind: 'none' } },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: 'synthetic',
      storeId: 'synthetic-store',
      themeKey: 'synthetic-theme',
      editLockPrefix: 'synthetic-edit-lock',
      publishLockName: 'synthetic-publish-lock',
      unscheduledCollapsedKey: 'synthetic.unscheduled',
      activityPausedKey: 'synthetic.activity',
    },
    access: access === 'unconfigured'
      ? { kind: 'unconfigured' }
      : {
        kind: 'ready',
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        readerEmails: [PUBLISHER, READER],
        service: service === 'enabled' ? { kind: 'enabled', clientId: 'synthetic-service' } : { kind: 'disabled' },
      },
    publish: publish === 'disabled'
      ? { kind: 'disabled' }
      : { kind: 'github-app', publisherEmail: PUBLISHER, recordActorId: 'synthetic-publisher', operations: 'existing-task-edits-v1' },
    deployment: {
      accountBinding: 'synthetic-account',
      workerName: 'synthetic-tracker',
      customDomain: 'tracker.synthetic.test',
      compatibilityDate: '2026-09-30',
      compatibilityFlags: ['nodejs_compat'],
    },
  };
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function tokenFor(claims = {}, signingKey = keyPair.privateKey) {
  const header = encoded({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = encoded({
    iss: TEAM_DOMAIN,
    aud: [AUDIENCE],
    email: PUBLISHER,
    iat: Math.floor(FIXED_NOW / 1000) - 10,
    exp: Math.floor(FIXED_NOW / 1000) + 300,
    ...claims,
  });
  const input = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

async function serviceTokenFor(claims = {}) {
  return tokenFor({ type: 'app', sub: '', common_name: 'synthetic-service', email: undefined, ...claims });
}

function accessFetch(calls) {
  return async url => {
    calls.push(String(url));
    assert.equal(String(url), `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  };
}

function request(token, path = '/', { method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('Cf-Access-Jwt-Assertion', token);
  return new Request(`https://tracker.synthetic.test${path}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body }),
  });
}

function assets(calls) {
  return {
    fetch: async assetRequest => {
      calls.push(new URL(assetRequest.url).pathname);
      return new Response('synthetic tracker', { headers: { 'Content-Type': 'text/plain' } });
    },
  };
}

test('invalid and unconfigured settings fail before assets, Access keys, or GitHub', async () => {
  const assetCalls = [];
  const keyCalls = [];
  const invalid = createTrackerWorker({ schemaVersion: 1 }, {
    accessFetch: accessFetch(keyCalls),
  });
  const invalidResponse = await invalid.fetch(request(null), { ASSETS: assets(assetCalls), GITHUB_APP_ID: 'ambient' });
  assert.equal(invalidResponse.status, 503);
  assert.deepEqual(assetCalls, []);
  assert.deepEqual(keyCalls, []);

  const unconfigured = createTrackerWorker(settings({ access: 'unconfigured' }), {
    accessFetch: accessFetch(keyCalls),
  });
  const unconfiguredResponse = await unconfigured.fetch(request(null), { ASSETS: assets(assetCalls) });
  assert.equal(unconfiguredResponse.status, 503);
  assert.deepEqual(assetCalls, []);
  assert.deepEqual(keyCalls, []);
});

test('the captured instance ignores contradictory Access and destination bindings', async () => {
  const keyCalls = [];
  const assetCalls = [];
  const instance = parseInstanceConfig(settings());
  const worker = createTrackerWorker(instance, {
    accessFetch: accessFetch(keyCalls),
    now: () => FIXED_NOW,
  });
  const token = await tokenFor();
  const response = await worker.fetch(request(token), {
    ACCESS_TEAM_DOMAIN: 'https://wrong.example.test',
    ACCESS_AUD: 'wrong-audience',
    ACCESS_EMAIL: 'wrong@example.test',
    GITHUB_REPOSITORY_OWNER: 'ambient-owner',
    GITHUB_REPOSITORY_NAME: 'ambient-repo',
    GITHUB_BRANCH: 'ambient-branch',
    TRACKER_REPOSITORY_PREFIX: 'ambient-prefix',
    ASSETS: assets(assetCalls),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(assetCalls, ['/']);
  assert.equal(keyCalls.length, 1);
});

test('Access rejects issuer, audience, signature, expiry, future, and reader mismatches', async () => {
  const cases = [
    ['issuer', { iss: 'https://wrong.cloudflareaccess.test' }],
    ['audience', { aud: ['wrong-audience'] }],
    ['expired', { exp: Math.floor(FIXED_NOW / 1000) - 1 }],
    ['future', { nbf: Math.floor(FIXED_NOW / 1000) + 60 }],
    ['reader', { email: 'outsider@example.test' }],
  ];
  for (const [, claims] of cases) {
    const keyCalls = [];
    const assetCalls = [];
    const worker = createTrackerWorker(settings(), {
      accessFetch: accessFetch(keyCalls),
      now: () => FIXED_NOW,
    });
    const token = await tokenFor(claims);
    const response = await worker.fetch(request(token), { ASSETS: assets(assetCalls) });
    assert.equal(response.status, 403);
    assert.deepEqual(assetCalls, []);
    assert.equal(keyCalls.length, claims.email ? 1 : 0);
  }

  const keyCalls = [];
  const assetCalls = [];
  const worker = createTrackerWorker(settings(), {
    accessFetch: accessFetch(keyCalls),
    now: () => FIXED_NOW,
  });
  const invalidSignature = await tokenFor({}, (await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )).privateKey);
  const response = await worker.fetch(request(invalidSignature), { ASSETS: assets(assetCalls) });
  assert.equal(response.status, 403);
  assert.deepEqual(assetCalls, []);
  assert.equal(keyCalls.length, 1);
});

test('service identities can read assets but cannot publish', async () => {
  const keyCalls = [];
  const assetCalls = [];
  const githubCalls = [];
  const worker = createTrackerWorker(settings({ service: 'enabled' }), {
    accessFetch: accessFetch(keyCalls),
    githubFactory: () => {
      githubCalls.push('created');
      throw new Error('service identity must never create GitHub client');
    },
    now: () => FIXED_NOW,
  });
  const token = await serviceTokenFor();
  const assetResponse = await worker.fetch(request(token), { ASSETS: assets(assetCalls) });
  assert.equal(assetResponse.status, 200);
  const publishResponse = await worker.fetch(request(token, '/api/publish/prepare', {
    method: 'POST',
    body: '{',
    headers: { Origin: 'https://tracker.synthetic.test', 'Content-Type': 'application/json' },
  }), { ASSETS: assets(assetCalls) });
  assert.equal(publishResponse.status, 403);
  assert.deepEqual(await publishResponse.json(), { error: 'Service Access identities are read-only.' });
  assert.deepEqual(githubCalls, []);
});

test('disabled publishing is a controlled 403 with no GitHub credential lookup', async () => {
  const keyCalls = [];
  const githubCalls = [];
  const worker = createTrackerWorker(settings({ publish: 'disabled' }), {
    accessFetch: accessFetch(keyCalls),
    githubFactory: () => {
      githubCalls.push('created');
      throw new Error('disabled publishing must not construct a client');
    },
    now: () => FIXED_NOW,
  });
  const token = await tokenFor();
  const response = await worker.fetch(request(token, '/api/publish', {
    method: 'POST',
    body: '{}',
    headers: { Origin: 'https://tracker.synthetic.test', 'Content-Type': 'application/json' },
  }), {
    GITHUB_APP_ID: 'ambient-app',
    GITHUB_INSTALLATION_ID: 'ambient-installation',
    GITHUB_PRIVATE_KEY: 'ambient-private-key',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Publishing is disabled for this instance.', code: 'publishing-disabled' });
  assert.deepEqual(githubCalls, []);
  assert.equal(keyCalls.length, 1);
});

test('a reader without publisher authority is rejected before publisher transport', async () => {
  const keyCalls = [];
  const githubCalls = [];
  const worker = createTrackerWorker(settings(), {
    accessFetch: accessFetch(keyCalls),
    githubFactory: () => {
      githubCalls.push('created');
      throw new Error('reader must not create GitHub client');
    },
    now: () => FIXED_NOW,
  });
  const token = await tokenFor({ email: READER });
  const response = await worker.fetch(request(token, '/api/publish/prepare', {
    method: 'POST',
    body: '{',
    headers: { Origin: 'https://tracker.synthetic.test', 'Content-Type': 'application/json' },
  }), {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Only the verified Don Access identity can review or publish tracker edits.' });
  assert.deepEqual(githubCalls, []);
});

test('GitHub client maps the captured nested destination and ignores ambient destination values', () => {
  const instance = parseInstanceConfig(settings());
  const client = createGitHubClient({
    env: {
      GITHUB_REPOSITORY_OWNER: 'ambient-owner',
      GITHUB_REPOSITORY_NAME: 'ambient-repo',
      GITHUB_BRANCH: 'ambient-branch',
      TRACKER_REPOSITORY_PREFIX: 'ambient-prefix',
    },
    instance,
    testTransport: { fetchImpl: async () => { throw new Error('transport should not run'); } },
  });
  assert.equal(client.repositoryPrefix, 'sites/synthetic');
  assert.equal(client.repositoryPath('tracker/items/example.md'), 'sites/synthetic/tracker/items/example.md');
  assert.equal(client.repositoryPath('tracker/publish-receipts/request.json'), 'sites/synthetic/tracker/publish-receipts/request.json');
});
