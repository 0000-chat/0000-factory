import { repositoryPath as instanceRepositoryPath } from '../tooling/instance/paths.mjs';

const API_ROOT = 'https://api.github.com';
const GRAPHQL_ROOT = 'https://api.github.com/graphql';
const API_VERSION = '2026-03-10';
const USER_AGENT = '0000-Tracker-Publisher';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_RESPONSE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export class GitHubConfigurationError extends Error {
  constructor() {
    super('GitHub App publishing credentials are not configured.');
    this.name = 'GitHubConfigurationError';
  }
}

export class GitHubApiError extends Error {
  constructor(status, operation) {
    super(`GitHub ${operation} failed with HTTP ${status}.`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.operation = operation;
  }
}

function getRepositoryConfiguration(instance) {
  if (
    !instance || typeof instance !== 'object'
    || !instance.github || typeof instance.github.owner !== 'string'
    || typeof instance.github.repo !== 'string' || typeof instance.github.branch !== 'string'
    || !instance.data || typeof instance.data.folderPath !== 'string'
  ) throw new GitHubConfigurationError();
  return {
    owner: instance.github.owner,
    repository: instance.github.repo,
    branch: instance.github.branch,
    repositoryPrefix: instance.data.folderPath,
  };
}

function isSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag, content) {
  const length = derLength(content.byteLength);
  const result = new Uint8Array(1 + length.byteLength + content.byteLength);
  result[0] = tag;
  result.set(length, 1);
  result.set(content, 1 + length.byteLength);
  return result;
}

function pkcs1ToPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  );
  const privateKey = der(0x04, pkcs1);
  const content = new Uint8Array(version.byteLength + algorithm.byteLength + privateKey.byteLength);
  content.set(version);
  content.set(algorithm, version.byteLength);
  content.set(privateKey, version.byteLength + algorithm.byteLength);
  return der(0x30, content);
}

function decodePem(value) {
  const pem = String(value ?? '').trim().replaceAll('\r', '');
  const match = /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)\s+-----END \1-----$/.exec(pem);
  if (!match) throw new GitHubConfigurationError();
  const encoded = match[2].replace(/\s/g, '');
  const binary = atob(encoded);
  const keyBytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return match[1] === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(keyBytes) : keyBytes;
}

function tokenConfiguration(env) {
  const appId = String(env.GITHUB_APP_ID ?? '').trim();
  const installationId = String(env.GITHUB_INSTALLATION_ID ?? '').trim();
  const privateKey = String(env.GITHUB_PRIVATE_KEY ?? '').trim();
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId) || !privateKey) {
    throw new GitHubConfigurationError();
  }
  return { appId, installationId, privateKey };
}

async function appJwt(configuration, now = Date.now) {
  const issuedAt = Math.floor(now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(encoder.encode(JSON.stringify({
    iat: issuedAt - 60,
    exp: issuedAt + 540,
    iss: configuration.appId,
  })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    decodePem(configuration.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    encoder.encode(signingInput)
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function responseText(response, maximumBytes) {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new Error('GitHub response exceeded its size limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function queryString(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

function normalizeClientArguments(input, options = {}) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'instance')) {
    throw new TypeError('createGitHubClient requires explicit { env, instance, testTransport } settings');
  }
  return {
    env: input.env ?? {},
    instance: input.instance,
    testTransport: input.testTransport ?? options.testTransport,
    fetchImpl: input.fetchImpl ?? options.fetchImpl,
    now: input.now ?? options.now,
  };
}

function transportFetch(testTransport) {
  if (typeof testTransport === 'function') return testTransport;
  if (!testTransport || typeof testTransport !== 'object') return null;
  if (typeof testTransport.fetchImpl === 'function') return testTransport.fetchImpl;
  if (typeof testTransport.fetch === 'function') return testTransport.fetch.bind(testTransport);
  return null;
}

/**
 * Construct a repository-scoped publisher client.
 *
 * The object form is the captured-settings contract:
 * `createGitHubClient({ env, instance, testTransport })`.
 */
export function createGitHubClient(input, options = {}) {
  const normalized = normalizeClientArguments(input, options);
  const env = normalized.env;
  const instance = normalized.instance;
  const suppliedTransport = transportFetch(normalized.testTransport);
  const fetchImpl = normalized.fetchImpl ?? suppliedTransport ?? globalThis.fetch;
  const now = normalized.now
    ?? (normalized.testTransport && typeof normalized.testTransport === 'object' && typeof normalized.testTransport.now === 'function'
      ? normalized.testTransport.now
      : Date.now);
  const repositoryConfig = getRepositoryConfiguration(instance);
  const OWNER = repositoryConfig.owner;
  const REPOSITORY = repositoryConfig.repository;
  const TRACKER_BRANCH = repositoryConfig.branch;
  const repositoryPrefix = repositoryConfig.repositoryPrefix;
  if (normalized.testTransport && typeof normalized.testTransport === 'object'
    && typeof normalized.testTransport.getRef === 'function') {
    const transportClient = Object.create(normalized.testTransport);
    Object.assign(transportClient, {
      instance,
      repositoryPrefix,
      repositoryPath: path => instanceRepositoryPath(instance, path),
    });
    return transportClient;
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  let cachedToken = null;

  function timedFetch(url, init) {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  async function installationToken() {
    const configuration = tokenConfiguration(env);
    if (cachedToken && cachedToken.expiresAt > now() + 60_000) return cachedToken.value;

    const jwt = await appJwt(configuration, now);
    const response = await timedFetch(`${API_ROOT}/app/installations/${configuration.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
      body: JSON.stringify({
        repositories: [REPOSITORY],
        permissions: { contents: 'write' },
      }),
    });
    if (!response.ok) throw new GitHubApiError(response.status, 'installation-token request');
    const payload = JSON.parse(await responseText(response, 64 * 1024));
    if (typeof payload.token !== 'string' || typeof payload.expires_at !== 'string') {
      throw new Error('GitHub did not return a valid installation token.');
    }
    if (payload.permissions?.contents !== 'write') {
      throw new Error('GitHub installation token does not have repository Contents write permission.');
    }
    if (Object.hasOwn(payload, 'repositories')
      && (!Array.isArray(payload.repositories)
        || payload.repositories.length !== 1
        || payload.repositories[0]?.full_name !== `${OWNER}/${REPOSITORY}`)) {
      throw new Error('GitHub installation token is not limited to the expected repository.');
    }
    const expiresAt = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('GitHub returned an expired installation token.');
    cachedToken = { value: payload.token, expiresAt };
    return payload.token;
  }

  async function callJson(url, { method = 'GET', body, operation, maximumBytes = MAX_RESPONSE_BYTES } = {}) {
    const token = await installationToken();
    const response = await timedFetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new GitHubApiError(response.status, operation);
    }
    const text = await responseText(response, maximumBytes);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub ${operation} returned invalid JSON.`);
    }
  }

  async function getRef() {
    const ref = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/git/ref/heads/${encodeURIComponent(TRACKER_BRANCH)}`, {
      operation: `${TRACKER_BRANCH} reference read`,
    });
    if (!isSha(ref?.object?.sha)) throw new Error('GitHub returned an invalid main reference.');
    return ref.object.sha.toLowerCase();
  }

  async function getCommit(commitSha) {
    if (!isSha(commitSha)) throw new Error('Invalid Git commit SHA.');
    const commit = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/git/commits/${commitSha}`, {
      operation: 'commit read',
    });
    if (!isSha(commit?.sha) || commit.sha.toLowerCase() !== commitSha.toLowerCase()) {
      throw new Error('GitHub commit response did not match the pinned SHA.');
    }
    if (!isSha(commit?.tree?.sha)) throw new Error('GitHub returned an invalid commit tree.');
    return commit;
  }

  async function getTree(treeSha) {
    if (!isSha(treeSha)) throw new Error('Invalid Git tree SHA.');
    const tree = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/git/trees/${treeSha}?recursive=1`, {
      operation: 'recursive tracker tree read',
      maximumBytes: MAX_TREE_RESPONSE_BYTES,
    });
    if (!isSha(tree?.sha) || tree.sha.toLowerCase() !== treeSha.toLowerCase()) {
      throw new Error('GitHub tree response did not match the pinned SHA.');
    }
    if (!Array.isArray(tree?.tree) || tree.truncated !== false) {
      throw new Error('GitHub tracker tree was missing or truncated.');
    }
    return tree.tree;
  }

  async function readBlobs(commitSha, paths) {
    if (!isSha(commitSha) || !Array.isArray(paths) || paths.length === 0 || paths.length > 50) {
      throw new Error('GitHub blob batch is outside its supported bounds.');
    }
    const aliases = paths.map((path, index) => `b${index}: object(expression: ${JSON.stringify(`${commitSha}:${path}`)}) { ... on Blob { text byteSize isTruncated } }`);
    const query = `query TrackerSource { repository(owner: ${JSON.stringify(OWNER)}, name: ${JSON.stringify(REPOSITORY)}) { ${aliases.join(' ')} } }`;
    const result = await callJson(GRAPHQL_ROOT, {
      method: 'POST',
      body: { query },
      operation: 'pinned Markdown batch read',
    });
    if (Array.isArray(result?.errors) && result.errors.length > 0) throw new Error('GitHub rejected a pinned source-file batch.');
    if (!result?.data?.repository || typeof result.data.repository !== 'object') {
      throw new Error('GitHub returned an incomplete source-file batch.');
    }
    const output = new Map();
    paths.forEach((path, index) => {
      const blob = result.data.repository[`b${index}`];
      if (
        !blob || typeof blob.text !== 'string' || blob.isTruncated !== false
        || !Number.isSafeInteger(blob.byteSize) || blob.byteSize < 0
        || encoder.encode(blob.text).byteLength !== blob.byteSize
      ) {
        throw new Error(`GitHub returned missing, truncated, or invalid source text for ${path}.`);
      }
      output.set(path, blob.text);
    });
    if (output.size !== paths.length) throw new Error('GitHub returned an unexpected source-file count.');
    return output;
  }

  async function createTree(baseTree, entries) {
    const result = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/git/trees`, {
      method: 'POST',
      body: { base_tree: baseTree, tree: entries },
      operation: 'Git tree creation',
    });
    if (!isSha(result?.sha)) throw new Error('GitHub returned an invalid tree SHA.');
    return result.sha;
  }

  async function createCommit(message, tree, parent) {
    const result = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/git/commits`, {
      method: 'POST',
      body: { message, tree, parents: [parent] },
      operation: 'Git commit creation',
    });
    if (!isSha(result?.sha)) throw new Error('GitHub returned an invalid commit SHA.');
    return result.sha.toLowerCase();
  }

  async function advanceMain(commitSha) {
    try {
      const result = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/git/refs/heads/${encodeURIComponent(TRACKER_BRANCH)}`, {
        method: 'PATCH',
        body: { sha: commitSha, force: false },
        operation: `fast-forward ${TRACKER_BRANCH} update`,
      });
      if (!isSha(result?.object?.sha)) throw new Error('GitHub returned an invalid updated main reference.');
      return result.object.sha.toLowerCase() === commitSha.toLowerCase() ? result.object.sha.toLowerCase() : null;
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 409 || error.status === 422)) return null;
      throw error;
    }
  }

  async function compareCommits(base, head) {
    if (!isSha(base) || !isSha(head)) throw new Error('Invalid Git commit comparison.');
    try {
      const result = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/compare/${base}...${head}`, {
        operation: 'commit ancestry check',
      });
      return {
        aheadBy: Number.isInteger(result?.ahead_by) ? result.ahead_by : null,
        status: typeof result?.status === 'string' ? result.status : 'unknown',
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return { aheadBy: null, status: 'unknown' };
      throw error;
    }
  }

  async function receiptCommit(requestId, mainSha) {
    if (!isSha(mainSha)) throw new Error('Invalid main SHA for receipt lookup.');
    const path = instanceRepositoryPath(instance, `tracker/publish-receipts/${requestId}.json`);
    const query = queryString({ path, sha: mainSha, per_page: 100 });
    const commits = await callJson(`${API_ROOT}/repos/${OWNER}/${REPOSITORY}/commits?${query}`, {
      operation: 'publish receipt commit lookup',
    });
    if (!Array.isArray(commits)) throw new Error('GitHub returned an invalid publish receipt history.');
    if (commits.length === 0) return null;
    const expectedMarker = `Publish-Request-ID: ${requestId}`;
    const matching = commits.find(candidate =>
      typeof candidate?.commit?.message === 'string'
      && candidate.commit.message.split(/\r?\n/).includes(expectedMarker));
    if (!matching) {
      throw new Error('GitHub receipt-path history exists but its request marker was not found in the bounded history window.');
    }
    const commitSha = matching.sha;
    const message = matching.commit.message;
    if (!isSha(commitSha) || typeof message !== 'string'
      || !Array.isArray(matching.parents) || matching.parents.length !== 1
      || !isSha(matching.parents[0]?.sha)) {
      throw new Error('GitHub returned an invalid publish receipt commit.');
    }
    return {
      commit: commitSha.toLowerCase(),
      message,
      parent: matching.parents[0].sha.toLowerCase(),
    };
  }

  return {
    instance,
    repositoryPrefix,
    repositoryPath: path => instanceRepositoryPath(instance, path),
    getRef,
    getCommit,
    getTree,
    readBlobs,
    createTree,
    createCommit,
    advanceMain,
    compareCommits,
    receiptCommit,
  };
}

export const GITHUB_API_VERSION = API_VERSION;
