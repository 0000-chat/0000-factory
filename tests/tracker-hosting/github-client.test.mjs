import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import {
  createGitHubClient,
  GITHUB_API_VERSION,
  GitHubApiError,
  GitHubConfigurationError,
} from '../../worker/github-client.mjs';
import { parseInstanceConfig } from '../../tooling/instance/config.mjs';

const FIXED_NOW = Date.parse('2026-10-03T00:00:00.000Z');
const INSTALLATION_TOKEN = 'ghs_test-installation-token-not-for-errors';
const USER_AGENT = '0000-Tracker-Publisher';
const APP_ID = '123456';
const INSTALLATION_ID = '987654';
const GITHUB_OWNER = 'synthetic-owner';
const GITHUB_NAME = 'synthetic-repo';
const GITHUB_REPOSITORY = `${GITHUB_OWNER}/${GITHUB_NAME}`;
const TEST_INSTANCE = parseInstanceConfig({
  schemaVersion: 1,
  id: 'synthetic-github',
  branding: {
    name: 'Synthetic GitHub', title: 'Synthetic GitHub tracker', description: 'Synthetic transport test',
    markText: 'SYN', homeLabel: 'Home', loadingLabel: 'Loading', faviconPath: 'assets/favicon.svg',
  },
  github: { owner: GITHUB_OWNER, repo: GITHUB_NAME, branch: 'main' },
  data: { folderPath: 'sites/synthetic-github', layout: 'tracker-v1', evidence: { kind: 'none' } },
  model: { approvalProtocol: 'don-v1' },
  browser: {
    namespace: 'synthetic-github', storeId: 'synthetic-github-store', themeKey: 'synthetic-github-theme',
    editLockPrefix: 'synthetic-github-edit-lock', publishLockName: 'synthetic-github-publish-lock',
    unscheduledCollapsedKey: 'synthetic-github.unscheduled', activityPausedKey: 'synthetic-github.activity',
  },
  access: {
    kind: 'ready', teamDomain: 'https://access.synthetic.test', audience: 'synthetic-audience',
    readerEmails: ['publisher@example.test'], service: { kind: 'disabled' },
  },
  publish: {
    kind: 'github-app', publisherEmail: 'publisher@example.test', recordActorId: 'publisher', operations: 'existing-task-edits-v1',
  },
  deployment: {
    accountBinding: 'synthetic-account', workerName: 'synthetic-github-worker', customDomain: 'synthetic-github.example.test',
    compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
  },
});
const TREE_SHA = 'a'.repeat(40);
const COMMIT_SHA = 'b'.repeat(40);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

function testEnv(overrides = {}) {
  return {
    GITHUB_APP_ID: APP_ID,
    GITHUB_INSTALLATION_ID: INSTALLATION_ID,
    GITHUB_PRIVATE_KEY: privateKeyPem,
    ...overrides,
  };
}

function makeClient(env = testEnv(), testTransport = {}) {
  return createGitHubClient({ env, instance: TEST_INSTANCE, testTransport });
}

function validTokenPayload(overrides = {}) {
  return {
    token: INSTALLATION_TOKEN,
    expires_at: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
    permissions: { contents: 'write' },
    repositories: [{ full_name: GITHUB_REPOSITORY }],
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function mockGitHub({ token = validTokenPayload(), onApi }) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return jsonResponse(token, 201);
    }
    return onApi(url, init);
  };
  return { calls, fetchImpl };
}

function assertApiHeaders(init) {
  const headers = new Headers(init.headers);
  assert.equal(headers.get('Accept'), 'application/vnd.github+json');
  assert.equal(headers.get('Authorization'), `Bearer ${INSTALLATION_TOKEN}`);
  assert.equal(headers.get('User-Agent'), USER_AGENT);
  assert.equal(headers.get('X-GitHub-Api-Version'), GITHUB_API_VERSION);
}

test('signs a short-lived App JWT and requests only the intended repository and Contents write', async () => {
  const { calls, fetchImpl } = mockGitHub({
    onApi: () => jsonResponse({ object: { sha: TREE_SHA } }),
  });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });

  assert.equal(await client.getRef(), TREE_SHA);
  assert.equal(calls.length, 2);

  const [tokenCall, apiCall] = calls;
  assert.equal(tokenCall.url.href, `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(tokenCall.init.signal instanceof AbortSignal, true);
  const tokenHeaders = new Headers(tokenCall.init.headers);
  assert.equal(tokenHeaders.get('Accept'), 'application/vnd.github+json');
  assert.equal(tokenHeaders.get('Content-Type'), 'application/json');
  assert.equal(tokenHeaders.get('User-Agent'), USER_AGENT);
  assert.equal(tokenHeaders.get('X-GitHub-Api-Version'), GITHUB_API_VERSION);

  const authorization = tokenHeaders.get('Authorization');
  assert.match(authorization ?? '', /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const jwt = authorization.slice('Bearer '.length);
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, APP_ID);
  assert.equal(payload.iat, Math.floor(FIXED_NOW / 1000) - 60);
  assert.equal(payload.exp, Math.floor(FIXED_NOW / 1000) + 540);
  assert.equal(verifySignature(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, 'base64url'),
  ), true);

  assert.deepEqual(JSON.parse(tokenCall.init.body), {
    repositories: [GITHUB_NAME],
    permissions: { contents: 'write' },
  });
  assert.equal(apiCall.url.href, `https://api.github.com/repos/${GITHUB_REPOSITORY}/git/ref/heads/main`);
  assertApiHeaders(apiCall.init);
});

test('sends the publisher User-Agent on token exchange and later REST and GraphQL requests', async () => {
  const { calls, fetchImpl } = mockGitHub({
    onApi: url => url.pathname === '/graphql'
      ? jsonResponse({ data: { repository: { b0: { text: 'source', byteSize: 6, isTruncated: false } } } })
      : jsonResponse({ object: { sha: TREE_SHA } }),
  });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });

  assert.equal(await client.getRef(), TREE_SHA);
  assert.equal((await client.readBlobs(COMMIT_SHA, ['tracker/items/task.md'])).get('tracker/items/task.md'), 'source');

  assert.deepEqual(calls.map(({ init }) => new Headers(init.headers).get('User-Agent')), [
    USER_AGENT,
    USER_AGENT,
    USER_AGENT,
  ]);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    `/app/installations/${INSTALLATION_ID}/access_tokens`,
    `/repos/${GITHUB_REPOSITORY}/git/ref/heads/main`,
    '/graphql',
  ]);
});

test('rejects installation tokens whose returned permissions or repository scope is broader or insufficient', async () => {
  const invalidPayloads = [
    {
      label: 'read-only contents',
      payload: validTokenPayload({ permissions: { contents: 'read' } }),
      message: /Contents write permission/i,
    },
    {
      label: 'different repository',
      payload: validTokenPayload({ repositories: [{ full_name: 'another-org/another-repo' }] }),
      message: /not limited to the expected repository/i,
    },
    {
      label: 'same repository name under a different owner',
      payload: validTokenPayload({ repositories: [{ full_name: `another-owner/${GITHUB_NAME}` }] }),
      message: /not limited to the expected repository/i,
    },
    {
      label: 'multiple repositories',
      payload: validTokenPayload({ repositories: [
        { full_name: GITHUB_REPOSITORY },
        { full_name: 'another-org/another-repo' },
      ] }),
      message: /not limited to the expected repository/i,
    },
    {
      label: 'malformed repository scope',
      payload: validTokenPayload({ repositories: 'all repositories' }),
      message: /repository/i,
    },
  ];

  for (const { label, payload, message } of invalidPayloads) {
    const { fetchImpl } = mockGitHub({ token: payload, onApi: () => jsonResponse({ object: { sha: TREE_SHA } }) });
    const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });
    await assert.rejects(client.getRef(), error => {
      assert.match(error.message, message, label);
      assert.equal(error.message.includes(INSTALLATION_TOKEN), false, label);
      return true;
    });
  }
});

test('allows GitHub to omit its optional repository list while still requesting the exact repository scope', async () => {
  let tokenRequestBody;
  const { fetchImpl } = mockGitHub({
    token: validTokenPayload({ repositories: undefined }),
    onApi: () => jsonResponse({ object: { sha: TREE_SHA } }),
  });
  const client = makeClient(testEnv(), {
    fetchImpl: async (input, init) => {
      if (new URL(input).pathname.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        tokenRequestBody = JSON.parse(init.body);
      }
      return fetchImpl(input, init);
    },
    now: () => FIXED_NOW,
  });

  assert.equal(await client.getRef(), TREE_SHA);
  assert.deepEqual(tokenRequestBody, {
    repositories: [GITHUB_NAME],
    permissions: { contents: 'write' },
  });
});

test('caches a validated installation token and passes a 15-second timeout signal to each request', async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutCalls = [];
  AbortSignal.timeout = milliseconds => {
    timeoutCalls.push(milliseconds);
    return new AbortController().signal;
  };
  try {
    const { calls, fetchImpl } = mockGitHub({
      onApi: () => jsonResponse({ object: { sha: TREE_SHA } }),
    });
    const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });

    await client.getRef();
    await client.getRef();

    assert.equal(calls.length, 3, 'one token request and two GitHub API requests');
    assert.deepEqual(timeoutCalls, [15_000, 15_000, 15_000]);
    assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal));
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('normalizes ref SHA and advances main only to the exact requested SHA without force', async () => {
  let advanceBody;
  let advanceHeaders;
  const { calls, fetchImpl } = mockGitHub({
    onApi: (url, init) => {
      if (url.pathname.endsWith('/git/refs/heads/main') && init.method === 'PATCH') {
        advanceBody = JSON.parse(init.body);
        advanceHeaders = init;
        return jsonResponse({ object: { sha: COMMIT_SHA.toUpperCase() } });
      }
      if (url.pathname.endsWith('/git/ref/heads/main')) return jsonResponse({ object: { sha: TREE_SHA.toUpperCase() } });
      return jsonResponse({}, 404);
    },
  });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });

  assert.equal(await client.getRef(), TREE_SHA);
  assert.equal(await client.advanceMain(COMMIT_SHA), COMMIT_SHA);
  assert.deepEqual(advanceBody, { sha: COMMIT_SHA, force: false });
  assertApiHeaders(advanceHeaders);
  assert.equal(calls.at(-1).init.method, 'PATCH');

  const mismatch = mockGitHub({
    onApi: (url, init) => init.method === 'PATCH'
      ? jsonResponse({ object: { sha: TREE_SHA } })
      : jsonResponse({ object: { sha: TREE_SHA } }),
  });
  const mismatchClient = makeClient(testEnv(), { fetchImpl: mismatch.fetchImpl, now: () => FIXED_NOW });
  assert.equal(await mismatchClient.advanceMain(COMMIT_SHA), null);
});

test('requires a commit response to match the requested pinned SHA', async () => {
  const { calls, fetchImpl } = mockGitHub({
    onApi: () => jsonResponse({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } }),
  });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });
  const commit = await client.getCommit(COMMIT_SHA);
  assert.equal(commit.sha, COMMIT_SHA);
  assert.equal(commit.tree.sha, TREE_SHA);
  assert.equal(calls.at(-1).url.pathname, `/repos/${GITHUB_REPOSITORY}/git/commits/${COMMIT_SHA}`);

  const mismatch = mockGitHub({
    onApi: () => jsonResponse({ sha: TREE_SHA, tree: { sha: TREE_SHA } }),
  });
  const mismatchClient = makeClient(testEnv(), { fetchImpl: mismatch.fetchImpl, now: () => FIXED_NOW });
  await assert.rejects(mismatchClient.getCommit(COMMIT_SHA), /commit.*SHA|pinned.*commit/i);
});

test('requires a recursive tree response to match the requested pinned SHA', async () => {
  const expectedTree = [{ path: 'tracker/items/task.md', type: 'blob', mode: '100644', size: 12, sha: 'c'.repeat(40) }];
  const valid = mockGitHub({
    onApi: () => jsonResponse({ sha: TREE_SHA, tree: expectedTree, truncated: false }),
  });
  const validClient = makeClient(testEnv(), { fetchImpl: valid.fetchImpl, now: () => FIXED_NOW });
  assert.deepEqual(await validClient.getTree(TREE_SHA), expectedTree);
  assert.equal(valid.calls.at(-1).url.pathname, `/repos/${GITHUB_REPOSITORY}/git/trees/${TREE_SHA}`);
  assert.equal(valid.calls.at(-1).url.searchParams.get('recursive'), '1');

  const mismatch = mockGitHub({
    onApi: () => jsonResponse({ sha: COMMIT_SHA, tree: expectedTree, truncated: false }),
  });
  const mismatchClient = makeClient(testEnv(), { fetchImpl: mismatch.fetchImpl, now: () => FIXED_NOW });
  await assert.rejects(mismatchClient.getTree(TREE_SHA), /tree.*SHA|pinned.*tree/i);
});

test('rejects malformed and truncated recursive trees', async () => {
  for (const tree of [
    { sha: TREE_SHA, tree: [{ path: 'tracker/items/task.md' }], truncated: true },
    { sha: TREE_SHA, tree: 'not-an-array', truncated: false },
    { sha: TREE_SHA, tree: [{ path: 'tracker/items/task.md' }] },
  ]) {
    const { fetchImpl } = mockGitHub({
      onApi: (url) => url.pathname.includes('/git/commits/')
        ? jsonResponse({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } })
        : jsonResponse(tree),
    });
    const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });
    await assert.rejects(client.getTree(TREE_SHA), /missing or truncated/i);
  }
});

test('reads exact UTF-8 blob byte counts and uses commit-pinned GraphQL expressions', async () => {
  let graphqlCall;
  const { fetchImpl } = mockGitHub({
    onApi: (url, init) => {
      graphqlCall = { url, init };
      return jsonResponse({ data: { repository: { b0: { text: 'é', byteSize: 2, isTruncated: false } } } });
    },
  });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });

  const blobs = await client.readBlobs(COMMIT_SHA, ['tracker/items/task.md']);
  assert.equal(blobs.get('tracker/items/task.md'), 'é');
  assert.equal(graphqlCall.url.href, 'https://api.github.com/graphql');
  assertApiHeaders(graphqlCall.init);
  assert.equal(graphqlCall.init.method, 'POST');
  const query = JSON.parse(graphqlCall.init.body).query;
  assert.match(query, new RegExp(`${COMMIT_SHA}:tracker/items/task\\.md`));
  assert.match(query, /isTruncated/);
});

test('rejects missing, truncated, byte-count-mismatched, and GraphQL-error blobs', async () => {
  const malformedResponses = [
    { data: { repository: {} } },
    { data: { repository: { b0: { text: 'abc', byteSize: 3, isTruncated: true } } } },
    { data: { repository: { b0: { text: 'abc', byteSize: 4, isTruncated: false } } } },
    { data: { repository: { b0: { text: 'abc', byteSize: 3 } } } },
    { errors: [{ message: 'private upstream diagnostic' }], data: { repository: { b0: { text: 'abc', byteSize: 3, isTruncated: false } } } },
  ];

  for (const payload of malformedResponses) {
    const { fetchImpl } = mockGitHub({ onApi: () => jsonResponse(payload) });
    const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });
    await assert.rejects(client.readBlobs(COMMIT_SHA, ['tracker/items/task.md']), error => {
      assert.equal(error.message.includes('private upstream diagnostic'), false);
      return true;
    });
  }
});

test('does not expose GitHub response bodies, installation tokens, or private keys in errors', async () => {
  const upstreamSecret = 'upstream-response-secret-do-not-return';
  const { fetchImpl } = mockGitHub({
    onApi: () => new Response(upstreamSecret, { status: 500 }),
  });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });
  await assert.rejects(client.getRef(), error => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 500);
    assert.equal(error.message.includes(upstreamSecret), false);
    assert.equal(error.message.includes(INSTALLATION_TOKEN), false);
    return true;
  });

  for (const { status, operation, failure } of [
    { status: 401, operation: 'installation-token request', failure: 'token' },
    { status: 403, operation: 'main reference read', failure: 'rest' },
  ]) {
    const requestCredentials = [];
    const privateSecret = 'PRIVATE-KEY-CANARY-DO-NOT-LOG';
    const privateKeyEnvironment = testEnv();
    const unsafeBody = `${upstreamSecret} ${INSTALLATION_TOKEN} ${privateSecret} https://api.github.com/private`;
    const authFailureClient = makeClient(privateKeyEnvironment, {
      fetchImpl: async (input, init = {}) => {
        const url = new URL(input);
        requestCredentials.push(new Headers(init.headers).get('Authorization'));
        if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
          return failure === 'token'
            ? new Response(unsafeBody, { status })
            : jsonResponse(validTokenPayload(), 201);
        }
        return new Response(unsafeBody, { status });
      },
      now: () => FIXED_NOW,
    });

    await assert.rejects(authFailureClient.getRef(), error => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, status);
      assert.equal(error.operation, operation);
      assert.match(error.message, new RegExp(`GitHub ${operation} failed with HTTP ${status}\\.`));
      for (const secret of [upstreamSecret, INSTALLATION_TOKEN, privateSecret, privateKeyPem, 'api.github.com']) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    });
    assert.equal(requestCredentials.length, failure === 'token' ? 1 : 2);
    assert.ok(requestCredentials.every(credential => credential && !credential.includes(privateSecret)));
  }

  const privateSecret = 'PRIVATE-KEY-CANARY-DO-NOT-LOG';
  const badClient = makeClient(testEnv({ GITHUB_PRIVATE_KEY: privateSecret }));
  await assert.rejects(badClient.getRef(), error => {
    assert.ok(error instanceof GitHubConfigurationError);
    assert.equal(error.message.includes(privateSecret), false);
    return true;
  });
});

test('rejects invalid ref and commit SHA values before making API requests', async () => {
  const { calls, fetchImpl } = mockGitHub({ onApi: () => jsonResponse({}) });
  const client = makeClient(testEnv(), { fetchImpl, now: () => FIXED_NOW });

  await assert.rejects(client.getCommit('not-a-sha'), /Invalid Git commit SHA/i);
  await assert.rejects(client.getTree('not-a-sha'), /Invalid Git tree SHA/i);
  await assert.rejects(client.readBlobs('not-a-sha', ['tracker/items/task.md']), /outside its supported bounds/i);
  assert.equal(calls.length, 0);
});

test('distinguishes an empty receipt history from an unavailable history lookup', async () => {
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const emptyHistory = mockGitHub({ onApi: () => jsonResponse([]) });
  const emptyClient = makeClient(testEnv(), { fetchImpl: emptyHistory.fetchImpl, now: () => FIXED_NOW });

  assert.equal(await emptyClient.receiptCommit(requestId, COMMIT_SHA), null);
  const historyCall = emptyHistory.calls.at(-1);
  assert.equal(historyCall.url.pathname, `/repos/${GITHUB_REPOSITORY}/commits`);
  assert.equal(historyCall.url.searchParams.get('path'), `${TEST_INSTANCE.data.folderPath}/tracker/publish-receipts/${requestId}.json`);
  assert.equal(historyCall.url.searchParams.get('sha'), COMMIT_SHA);

  const unavailableHistory = mockGitHub({
    onApi: () => new Response('temporary history lookup failure', { status: 404 }),
  });
  const unavailableClient = makeClient(testEnv(), {
    fetchImpl: unavailableHistory.fetchImpl,
    now: () => FIXED_NOW,
  });
  await assert.rejects(unavailableClient.receiptCommit(requestId, COMMIT_SHA), error => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 404);
    assert.equal(error.operation, 'publish receipt commit lookup');
    return true;
  });
});
