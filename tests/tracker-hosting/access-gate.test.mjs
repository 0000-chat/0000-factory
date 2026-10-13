import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { afterAll, afterEach, describe, test } from 'bun:test';
import { parseInstanceConfig } from '../../tooling/instance/config.mjs';
import { createTrackerWorker } from '../../worker/access-gate.mjs';

const TEAM_DOMAIN = 'https://access.synthetic.test';
const ACCESS_AUD = 'tracker-viewer-aud';
const DON_EMAIL = 'publisher@example.test';
const OTHER_EMAIL = 'other@example.test';
const SERVICE_CLIENT_ID = 'test-service-client-id';
const KID = 'tracker-test-key';
const TRACKER_BODY = 'TRACKER DATA MUST NEVER LEAK';
const originalFetch = globalThis.fetch;

function siteSettings({ access = 'ready', service = 'disabled' } = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-access',
    branding: {
      name: 'Synthetic Access', title: 'Synthetic access tracker', description: 'Synthetic hosting test',
      markText: 'SYN', homeLabel: 'Home', loadingLabel: 'Loading', faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'synthetic-owner', repo: 'synthetic-repo', branch: 'main' },
    data: { folderPath: 'sites/synthetic-access', layout: 'tracker-v1', evidence: { kind: 'none' } },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: 'synthetic-access', storeId: 'synthetic-access-store', themeKey: 'synthetic-access-theme',
      editLockPrefix: 'synthetic-access-edit-lock', publishLockName: 'synthetic-access-publish-lock',
      unscheduledCollapsedKey: 'synthetic-access.unscheduled', activityPausedKey: 'synthetic-access.activity',
    },
    access: access === 'unconfigured'
      ? { kind: 'unconfigured' }
      : {
        kind: 'ready', teamDomain: TEAM_DOMAIN, audience: ACCESS_AUD, readerEmails: [DON_EMAIL, OTHER_EMAIL],
        service: service === 'enabled' ? { kind: 'enabled', clientId: SERVICE_CLIENT_ID } : { kind: 'disabled' },
      },
    publish: access === 'unconfigured'
      ? { kind: 'disabled' }
      : { kind: 'github-app', publisherEmail: DON_EMAIL, recordActorId: 'don', operations: 'existing-task-edits-v1' },
    deployment: {
      accountBinding: 'synthetic-access-account', workerName: 'synthetic-access-worker',
      customDomain: 'synthetic-access.example.test', compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
    },
  };
}

function workerFor(options = {}) {
  return createTrackerWorker(parseInstanceConfig(siteSettings(options)), {
    // Resolve the current test transport at request time while keeping the
    // site policy itself captured by createTrackerWorker.
    accessFetch: (...args) => globalThis.fetch(...args),
  });
}

const worker = workerFor();

const keyPair = await webcrypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  },
  true,
  ['sign', 'verify']
);
const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
publicJwk.kid = KID;

const alternateKeyPair = await webcrypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  },
  true,
  ['sign', 'verify']
);

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function tokenFor(claims = {}, signingKey = keyPair.privateKey) {
  const header = encodeJson({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = encodeJson({
    iss: TEAM_DOMAIN,
    aud: [ACCESS_AUD],
    email: DON_EMAIL,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims
  });
  const signingInput = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    signingKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function serviceTokenFor(claims = {}, signingKey = keyPair.privateKey) {
  return tokenFor({
    type: 'app',
    sub: '',
    common_name: SERVICE_CLIENT_ID,
    email: undefined,
    ...claims
  }, signingKey);
}

function environment(overrides = {}) {
  const requests = [];
  const { assetFetch, ...bindings } = overrides;
  return {
    env: {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD,
      ACCESS_EMAIL: DON_EMAIL,
      ASSETS: {
        fetch: async request => {
          requests.push(request);
          return assetFetch
            ? assetFetch(request)
            : new Response(TRACKER_BODY, { headers: { 'Content-Type': 'text/plain' } });
        }
      },
      ...bindings
    },
    assetCalls: () => requests.length,
    assetRequests: () => requests
  };
}

function mockAccessKeys(keys = [publicJwk]) {
  globalThis.fetch = async request => {
    assert.equal(String(request), `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json({ keys });
  };
}

async function request(token, env, { path = '/', method = 'GET', headers: requestHeaders = {}, body } = {}, requestWorker = worker) {
  const headers = new Headers(requestHeaders);
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return requestWorker.fetch(new Request(`https://tracker.synthetic.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  }), env);
}

function publishPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: '00000000-0000-4000-8000-000000000001',
    tasks: [{
      id: 'fixture-task',
      fields: {
        title: {
          value: 'Synthetic task edited',
          baseValue: 'Synthetic task',
          baseSourceCommit: 'a'.repeat(40),
          baseContentRevision: 'source-revision-1',
        },
        'sections.outcome': {
          value: '',
          baseValue: 'Existing outcome',
          baseSourceCommit: 'a'.repeat(40),
          baseContentRevision: 'source-revision-1',
        },
      },
    }],
    ...overrides,
  };
}

function publishHeaders(origin = 'https://tracker.synthetic.test') {
  return { Origin: origin, 'Content-Type': 'application/json' };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('valid Access JWT for the confirmed Don email serves the snapshot', async () => {
  mockAccessKeys();
  const token = await tokenFor();
  const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
  const response = await request(token, result.env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), TRACKER_BODY);
  assert.equal(result.assetCalls(), 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('public provenance is the only unauthenticated asset route', async () => {
  const result = environment({
    assetFetch: async request => {
      assert.equal(new URL(request.url).pathname, '/factory-provenance.json');
      return Response.json({
        schemaVersion: 1,
        factory: {
          repository: 'https://github.com/0000-chat/0000-factory.git',
          branch: 'codex/weekly-planning-archive',
          commit: 'a'.repeat(40),
        },
        worker: 'synthetic-access-worker',
      });
    },
  });
  const response = await request(null, result.env, { path: '/factory-provenance.json?nonce=test' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    factory: {
      repository: 'https://github.com/0000-chat/0000-factory.git',
      branch: 'codex/weekly-planning-archive',
      commit: 'a'.repeat(40),
    },
    worker: 'synthetic-access-worker',
  });
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(result.assetCalls(), 1);

  const privateResponse = await request(null, result.env, { path: '/data.json' });
  assert.equal(privateResponse.status, 403);
  assert.equal(result.assetCalls(), 1);
});

test('human email identity remains authorized on an app-typed Access JWT', async () => {
  mockAccessKeys();
  const token = await tokenFor({ type: 'app' });
  const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
  const response = await request(token, result.env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), TRACKER_BODY);
  assert.equal(result.assetCalls(), 1);
});

test('valid configured Access service JWT serves the private snapshot', async () => {
  mockAccessKeys();
  const token = await serviceTokenFor();
  const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
  const response = await request(token, result.env, {}, workerFor({ service: 'enabled' }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), TRACKER_BODY);
  assert.equal(result.assetCalls(), 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

describe('authenticated identity endpoint', () => {
  test('returns the verified human identity without invoking assets', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const response = await request(token, result.env, { path: '/api/me' });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      actor: { kind: 'human', email: DON_EMAIL },
    });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(result.assetCalls(), 0);
  });

  test('returns a service identity without exposing its client ID', async () => {
    mockAccessKeys();
    const token = await serviceTokenFor();
    const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
    const response = await request(token, result.env, { path: '/api/me' }, workerFor({ service: 'enabled' }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      actor: { kind: 'service' },
    });
    assert.equal(result.assetCalls(), 0);
  });

  test('supports HEAD and rejects mutating methods without serving assets', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const headResponse = await request(token, result.env, { path: '/api/me', method: 'HEAD' });
    const postResponse = await request(token, result.env, { path: '/api/me', method: 'POST' });

    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.body, null);
    assert.equal(headResponse.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(postResponse.status, 405);
    assert.deepEqual(await postResponse.json(), { error: 'GET or HEAD is required.' });
    assert.equal(postResponse.headers.get('allow'), 'GET, HEAD');
    assert.equal(result.assetCalls(), 0);
  });
});

describe('service JWT identity must match the explicitly configured client ID', () => {
  const cases = [
    ['wrong client ID', { common_name: 'another-service-client-id' }],
    ['missing client ID', { common_name: undefined }],
    ['wrong service token type', { type: 'org' }],
    ['service token with a nonempty subject', { sub: 'publisher@example.test' }],
    ['service token with an email claim', { email: DON_EMAIL }]
  ];

  for (const [name, claims] of cases) {
    test(name, async () => {
      mockAccessKeys();
      const token = await serviceTokenFor(claims);
      const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
      const response = await request(token, result.env, {}, workerFor({ service: 'enabled' }));

      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /TRACKER DATA/);
      assert.equal(result.assetCalls(), 0);
    });
  }

  test('service JWT is denied when no client ID is configured', async () => {
    mockAccessKeys();
    const token = await serviceTokenFor();
    const result = environment();
    const response = await request(token, result.env, {}, workerFor());

    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /TRACKER DATA/);
    assert.equal(result.assetCalls(), 0);
  });
});

describe('service JWT still requires valid Access claims and a signature', () => {
  const cases = [
    ['wrong issuer', { iss: 'https://other-access.synthetic.test' }],
    ['wrong audience', { aud: ['another-audience'] }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['not-yet-valid token', { nbf: Math.floor(Date.now() / 1000) + 60 }]
  ];

  for (const [name, claims] of cases) {
    test(name, async () => {
      mockAccessKeys();
      const token = await serviceTokenFor(claims);
      const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
      const response = await request(token, result.env);

      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /TRACKER DATA/);
      assert.equal(result.assetCalls(), 0);
    });
  }

  test('a service JWT with an invalid signature is denied', async () => {
    mockAccessKeys();
    const token = await serviceTokenFor({}, alternateKeyPair.privateKey);
    const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
    const response = await request(token, result.env);

    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /TRACKER DATA/);
    assert.equal(result.assetCalls(), 0);
  });
});

test('authorized HTML navigation falls back to the private root document', async () => {
  mockAccessKeys();
  const token = await tokenFor();
  const result = environment({
    assetFetch: async request => new URL(request.url).pathname === '/'
      ? new Response('<main>tracker app</main>', { headers: { 'Content-Type': 'text/html' } })
      : new Response('Not found', { status: 404 })
  });
  const response = await request(token, result.env, { path: '/work/id', headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<main>tracker app</main>');
  assert.equal(result.assetCalls(), 2);
  assert.deepEqual(result.assetRequests().map(assetRequest => new URL(assetRequest.url).pathname), ['/work/id', '/']);
  assert.equal(result.assetRequests()[1].headers.get('accept'), 'text/html');
  assert.ok(result.assetRequests().every(assetRequest => assetRequest.headers.has('Cf-Access-Jwt-Assertion')));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('HEAD navigation falls back with the original method and returns no body', async () => {
  mockAccessKeys();
  const token = await tokenFor();
  const result = environment({
    assetFetch: async request => new URL(request.url).pathname === '/'
      ? new Response('head mock body', { headers: { 'Content-Type': 'text/html' } })
      : new Response(null, { status: 404 })
  });
  const response = await request(token, result.env, { path: '/work/id', method: 'HEAD', headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.deepEqual(result.assetRequests().map(assetRequest => assetRequest.method), ['HEAD', 'HEAD']);
  assert.deepEqual(result.assetRequests().map(assetRequest => new URL(assetRequest.url).pathname), ['/work/id', '/']);
});

test('existing root document is served without a second asset request', async () => {
  mockAccessKeys();
  const token = await tokenFor();
  const result = environment();
  const response = await request(token, result.env, { headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.equal(result.assetCalls(), 1);
});

describe('ineligible requests keep the asset 404', () => {
  const cases = [
    ['missing JavaScript', { path: '/missing.js', headers: { Accept: 'text/html' } }],
    ['missing CSS', { path: '/missing.css', headers: { Accept: 'text/html' } }],
    ['missing JSON', { path: '/missing.json', headers: { Accept: 'text/html' } }],
    ['missing image', { path: '/missing.png', headers: { Accept: 'text/html' } }],
    ['final dot in a file-like path', { path: '/missing.', headers: { Accept: 'text/html' } }],
    ['encoded extension dot', { path: '/missing%2ejs', headers: { Accept: 'text/html' } }],
    ['trailing slash after a file path', { path: '/missing.js/', headers: { Accept: 'text/html' } }],
    ['encoded path separator', { path: '/unsafe%2fpath', headers: { Accept: 'text/html' } }],
    ['malformed path escape', { path: '/unsafe%ZZpath', headers: { Accept: 'text/html' } }],
    ['JSON accept header', { path: '/work/id', headers: { Accept: 'application/json' } }],
    ['HTML explicitly refused', { path: '/work/id', headers: { Accept: 'text/html;q=0, */*;q=1' } }],
    ['POST navigation', { path: '/work/id', method: 'POST', headers: { Accept: 'text/html' } }]
  ];

  for (const [name, options] of cases) {
    test(name, async () => {
      mockAccessKeys();
      const token = await tokenFor();
      const result = environment({ assetFetch: async () => new Response('Not found', { status: 404 }) });
      const response = await request(token, result.env, options);

      assert.equal(response.status, 404);
      assert.equal(result.assetCalls(), 1);
    });
  }
});

test('missing token denies access without invoking the asset binding', async () => {
  const result = environment();
  const response = await request(null, result.env, { path: '/private/work', headers: { Accept: 'text/html' } });

  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /TRACKER DATA/);
  assert.equal(result.assetCalls(), 0);
});

test('unconfigured captured Access settings deny access without invoking the asset binding', async () => {
  const token = await tokenFor();
  const result = environment();
  const response = await request(token, {}, {}, workerFor({ access: 'unconfigured' }));

  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /TRACKER DATA/);
  assert.equal(result.assetCalls(), 0);
});

test('captured Access settings ignore contradictory ambient identity bindings', async () => {
  mockAccessKeys();
  const token = await tokenFor();
  const result = environment({ ACCESS_AUD: '__ACCESS_AUD__' });
  const response = await request(token, result.env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), TRACKER_BODY);
  assert.equal(result.assetCalls(), 1);
});

describe('invalid Access claims deny access without serving the snapshot', () => {
  const cases = [
    ['wrong email', { email: 'unauthorized@example.test' }],
    ['wrong audience', { aud: ['another-audience'] }],
    ['wrong issuer', { iss: 'https://other-access.synthetic.test' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }]
  ];

  for (const [name, claims] of cases) {
    test(name, async () => {
      mockAccessKeys();
      const token = await tokenFor(claims);
      const result = environment();
      const response = await request(token, result.env, { path: '/private/work', headers: { Accept: 'text/html' } });

      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /TRACKER DATA/);
      assert.equal(result.assetCalls(), 0);
    });
  }
});

test('a signature made by another key denies access without serving the snapshot', async () => {
  mockAccessKeys();
  const token = await tokenFor({}, alternateKeyPair.privateKey);
  const result = environment();
  const response = await request(token, result.env);

  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /TRACKER DATA/);
  assert.equal(result.assetCalls(), 0);
});

describe('authenticated task publish routes', () => {
  test('app-typed human Access identity retains Don publish authorization', async () => {
    mockAccessKeys();
    const token = await tokenFor({ type: 'app' });
    const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
    const response = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders(),
      body: JSON.stringify(publishPayload()),
    });

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY/);
    assert.equal(result.assetCalls(), 0);
  });

  test('service Access identities are read-only on publish routes', async () => {
    mockAccessKeys();
    const token = await serviceTokenFor();
    const result = environment({ ACCESS_SERVICE_TOKEN_CLIENT_ID: SERVICE_CLIENT_ID });
    const serviceWorker = workerFor({ service: 'enabled' });

    for (const method of ['GET', 'POST']) {
      const response = await request(token, result.env, {
        path: '/api/publish/prepare',
        method,
        headers: publishHeaders(),
        body: method === 'POST' ? '{' : undefined,
      }, serviceWorker);

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'Service Access identities are read-only.' });
    }

    assert.equal(result.assetCalls(), 0);
  });

  test('missing GitHub App credentials return an actionable 503 without claiming publication', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const response = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders(),
      body: JSON.stringify(publishPayload()),
    });

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(result.assetCalls(), 0);
  });

  test('rejects blank titles but permits clearing a narrative section', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const payload = publishPayload();
    payload.tasks[0].fields.title.value = ' \n ';
    const response = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders(),
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Title must contain non-whitespace text.' });
    assert.equal(result.assetCalls(), 0);
  });

  test('rejects unknown fields and cross-origin requests', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const payload = publishPayload();
    payload.tasks[0].fields.status = {
      value: 'done',
      baseValue: 'queued',
      baseSourceCommit: 'a'.repeat(40),
      baseContentRevision: 'source-revision-1',
    };
    const badField = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders(),
      body: JSON.stringify(payload),
    });
    assert.equal(badField.status, 400);
    assert.deepEqual(await badField.json(), { error: 'Editable fields are restricted to the task content whitelist.' });

    const crossOrigin = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders('https://attacker.example'),
      body: JSON.stringify(publishPayload()),
    });
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: 'Same-origin requests are required.' });

    const pathOrigin = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders('https://tracker.synthetic.test/extra'),
      body: JSON.stringify(publishPayload()),
    });
    assert.equal(pathOrigin.status, 403);
    assert.deepEqual(await pathOrigin.json(), { error: 'Same-origin requests are required.' });
    assert.equal(result.assetCalls(), 0);
  });

  test('authenticates before inspecting malformed JSON bodies', async () => {
    const result = environment();
    const response = await request(null, result.env, {
      path: '/api/publish',
      method: 'POST',
      headers: publishHeaders(),
      body: '{',
    });

    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Access required.\n');
    assert.equal(result.assetCalls(), 0);
  });

  test('unsupported API methods and paths return JSON without SPA fallback', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment({ assetFetch: async () => new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }) });
    const getResponse = await request(token, result.env, { path: '/api/publish' });
    assert.equal(getResponse.status, 405);
    assert.deepEqual(await getResponse.json(), { error: 'POST is required.' });
    assert.equal(getResponse.headers.get('allow'), 'POST');

    const headResponse = await request(token, result.env, { path: '/api/publish', method: 'HEAD' });
    assert.equal(headResponse.status, 405);
    assert.equal(headResponse.body, null);

    const missingResponse = await request(token, result.env, { path: '/api/not-a-route' });
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), { error: 'Not found.' });

    const encodedMissingResponse = await request(token, result.env, { path: '/api%2Fnot-a-route' });
    assert.equal(encodedMissingResponse.status, 404);
    assert.deepEqual(await encodedMissingResponse.json(), { error: 'Not found.' });
    assert.equal(result.assetCalls(), 0);
  });

  test('rejects oversized UTF-8 field values', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const payload = publishPayload();
    payload.tasks[0].fields['sections.outcome'].value = 'ü'.repeat(8_193);
    const response = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders(),
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /byte limit/);
    assert.equal(result.assetCalls(), 0);
  });

  test('rejects requests above the aggregate body limit before parsing JSON', async () => {
    mockAccessKeys();
    const token = await tokenFor();
    const result = environment();
    const response = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: { ...publishHeaders(), 'Content-Length': String(1024 * 1024 + 1) },
      body: JSON.stringify(publishPayload()),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Publish request exceeds the 1 MiB limit.' });
    assert.equal(result.assetCalls(), 0);
  });

  test('a different valid Access identity cannot use Don review or publish authority', async () => {
    mockAccessKeys();
    const token = await tokenFor({ email: 'other@example.test' });
    const result = environment({ ACCESS_EMAIL: 'other@example.test' });
    const response = await request(token, result.env, {
      path: '/api/publish/prepare',
      method: 'POST',
      headers: publishHeaders(),
      body: '{',
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Only the verified Don Access identity can review or publish tracker edits.' });
    assert.equal(result.assetCalls(), 0);
  });
});
