/**
 * A repository-scoped GitHub API transport for acceptance tests.
 *
 * This transport intentionally has no in-memory Git model.  The caller owns
 * and initializes a disposable checkout; every object read or written here is
 * resolved through Git plumbing in that checkout.  Keeping the boundary at
 * fetch() means createGitHubClient exercises its real authentication and URL
 * handling, while the transport can still fail closed on the captured site
 * destination.
 */

import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const API_HOST = 'api.github.com';
const TOKEN_EXPIRY = '2099-01-01T00:00:00.000Z';
const SYNTHETIC_GIT_NAME = 'Synthetic GitHub';
const SYNTHETIC_GIT_EMAIL = 'synthetic-github@fixture.test';
const SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const SAFE_REPOSITORY_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\x00]+$/u;

function transportError(message) {
  const error = new Error(message);
  error.name = 'SyntheticGitHubTransportError';
  return error;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function decodePathPart(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw transportError(`Synthetic GitHub transport received an invalid ${label}.`);
  }
}

function validateRepositoryPath(path, label = 'repository path') {
  if (typeof path !== 'string' || !SAFE_REPOSITORY_PATH.test(path)
    || path.split('/').some(segment => segment.length === 0)) {
    throw transportError(`Synthetic GitHub transport received an invalid ${label}.`);
  }
  return path;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw transportError(`Synthetic GitHub transport received invalid ${label} JSON.`);
  }
}

function requestBodyBytes(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw transportError('Synthetic GitHub transport only accepts buffered request bodies.');
}

function baseGitEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  ]) delete environment[name];
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...overrides,
  });
  return environment;
}

function runGitAt(cwd, args, { input, env, allowFailure = false, operation = 'Git operation' } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: baseGitEnvironment(env),
    input,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    throw transportError(`Synthetic GitHub transport could not complete ${operation}.`);
  }
  return Buffer.from(result.stdout ?? '');
}

function outputText(value, label = 'Git output') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value).trim();
  } catch {
    throw transportError(`Synthetic GitHub transport received invalid ${label}.`);
  }
}

function validateSha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw transportError(`Synthetic GitHub transport received an invalid ${label}.`);
  }
  return value.toLowerCase();
}

function parseIdentity(value) {
  const match = /^(.*) <([^>]+)> (\d+) ([+-]\d{4})$/u.exec(value);
  if (!match) return null;
  return {
    name: match[1],
    email: match[2],
    timestamp: `${match[3]} ${match[4]}`,
  };
}

function createRepositoryInspection(dataRepo) {
  if (typeof dataRepo !== 'string' || dataRepo.length === 0) {
    throw new TypeError('dataRepo: expected the initialized disposable Git repository path');
  }
  const requestedRoot = resolve(dataRepo);
  let stat;
  try {
    stat = lstatSync(requestedRoot);
  } catch {
    throw new TypeError('dataRepo: expected an initialized disposable Git repository path');
  }
  if (!stat.isDirectory()) throw new TypeError('dataRepo: expected a directory');

  let topLevel;
  try {
    topLevel = outputText(runGitAt(requestedRoot, ['rev-parse', '--show-toplevel']), 'repository root');
  } catch {
    throw new TypeError('dataRepo: expected an initialized disposable Git repository');
  }
  if (topLevel !== requestedRoot) {
    throw new TypeError('dataRepo: Git top-level does not exactly match dataRepo');
  }
  const gitDirectoryValue = outputText(runGitAt(requestedRoot, ['rev-parse', '--git-dir']), 'Git directory');
  const gitDirectory = resolve(requestedRoot, gitDirectoryValue);
  try {
    if (!realpathSync(gitDirectory)) throw new Error('unreachable');
  } catch {
    throw new TypeError('dataRepo: Git metadata directory is unavailable');
  }
  return { requestedRoot, topLevel, gitDirectory };
}

function parseRepositoryPath(url, observation) {
  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/u.exec(url.pathname);
  if (!match) throw transportError('Synthetic GitHub transport rejected an unrecognized repository endpoint.');
  const owner = decodePathPart(match[1], 'repository owner');
  const repo = decodePathPart(match[2], 'repository name');
  observation.owner = owner;
  observation.repo = repo;
  observation.repository = `${owner}/${repo}`;
  return { owner, repo, suffix: match[3] ?? '' };
}

function parseBranchSuffix(suffix, plural, observation) {
  const prefix = `/git/${plural}/heads/`;
  if (!suffix.startsWith(prefix)) return null;
  const encoded = suffix.slice(prefix.length);
  if (!encoded) throw transportError('Synthetic GitHub transport rejected an empty branch reference.');
  const branch = decodePathPart(encoded, 'branch reference');
  observation.ref = branch;
  observation.fullRef = `refs/heads/${branch}`;
  return branch;
}

function normalizeRequestInput(input, init = {}) {
  const source = input instanceof Request ? input : null;
  const url = new URL(source ? source.url : input);
  const method = String(init.method ?? source?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers ?? source?.headers);
  let body = init.body;
  if (body === undefined && source && method !== 'GET' && method !== 'HEAD') {
    // The GitHub client sends a string body.  Request.clone() keeps this
    // helper fetch-compatible for direct transport tests without consuming a
    // caller-owned Request.
    body = source.clone().text();
  }
  return { url, method, headers, body };
}

/**
 * Create a strict, repository-backed fake GitHub transport.
 *
 * The returned object deliberately does not expose a `getRef` method: that
 * method is the test-transport shortcut recognized by createGitHubClient.
 * Tests therefore exercise the client's real fetch path and all endpoint
 * assertions below.
 *
 * @param {{dataRepo:string,instance:object,installationId:string,token:string}} options
 */
export function createSyntheticGitHub({ dataRepo, instance, installationId, token } = {}) {
  const repository = createRepositoryInspection(dataRepo);
  if (!instance || typeof instance !== 'object') throw new TypeError('instance: expected validated fixture settings');
  const owner = instance.github?.owner;
  const repo = instance.github?.repo;
  const branch = instance.github?.branch;
  const repositoryPrefix = instance.data?.folderPath;
  if ([owner, repo, branch, repositoryPrefix].some(value => typeof value !== 'string')) {
    throw new TypeError('instance: expected validated GitHub and data settings');
  }
  if (typeof installationId !== 'string' || installationId.length === 0) {
    throw new TypeError('installationId: expected a synthetic installation identifier');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token: expected a synthetic installation token');
  }

  const expectedRepository = `${owner}/${repo}`;
  const expectedRef = `refs/heads/${branch}`;
  const requests = [];
  const writes = [];
  const writePaths = [];
  const identity = Object.freeze({
    dataRepo: repository.requestedRoot,
    topLevel: repository.topLevel,
    owner,
    repo,
    repository: expectedRepository,
    branch,
    ref: expectedRef,
    name: SYNTHETIC_GIT_NAME,
    email: SYNTHETIC_GIT_EMAIL,
    installationId,
  });

  function readHeadSha() {
    const raw = runGitAt(repository.topLevel, ['rev-parse', '--verify', expectedRef], {
      allowFailure: true,
      operation: 'reference read',
    });
    if (raw === null) throw transportError('Synthetic GitHub fixture is missing the captured branch reference.');
    const head = outputText(raw, 'reference SHA');
    if (!SHA_PATTERN.test(head)) throw transportError('Synthetic GitHub fixture has an invalid branch reference.');
    return head.toLowerCase();
  }

  function resolveCommit(value) {
    const sha = validateSha(value, 'commit SHA');
    const raw = runGitAt(repository.topLevel, ['rev-parse', '--verify', `${sha}^{commit}`], { allowFailure: true });
    if (raw === null) return null;
    const resolved = outputText(raw, 'commit SHA');
    return resolved.toLowerCase() === sha ? sha : null;
  }

  function resolveTree(value) {
    const sha = validateSha(value, 'tree SHA');
    const type = runGitAt(repository.topLevel, ['cat-file', '-t', sha], { allowFailure: true });
    if (type === null || outputText(type, 'tree type') !== 'tree') return null;
    const resolved = runGitAt(repository.topLevel, ['rev-parse', '--verify', `${sha}^{tree}`], { allowFailure: true });
    if (resolved === null || outputText(resolved, 'tree SHA').toLowerCase() !== sha) return null;
    return sha;
  }

  function resolveBlob(value) {
    const sha = validateSha(value, 'blob SHA');
    const type = runGitAt(repository.topLevel, ['cat-file', '-t', sha], { allowFailure: true });
    if (type === null || outputText(type, 'blob type') !== 'blob') return null;
    return sha;
  }

  function readCommit(value) {
    const sha = resolveCommit(value);
    if (sha === null) return null;
    const raw = runGitAt(repository.topLevel, ['cat-file', '-p', sha], { operation: 'commit read' });
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw transportError('Synthetic GitHub fixture contains an invalid commit object.');
    }
    const separator = text.indexOf('\n\n');
    if (separator < 0) throw transportError('Synthetic GitHub fixture contains a malformed commit object.');
    const headers = text.slice(0, separator).split('\n');
    const treeLine = headers.find(line => line.startsWith('tree '));
    const parentLines = headers.filter(line => line.startsWith('parent '));
    const authorLine = headers.find(line => line.startsWith('author '));
    const committerLine = headers.find(line => line.startsWith('committer '));
    const tree = treeLine?.slice('tree '.length);
    if (!tree || !SHA_PATTERN.test(tree) || resolveTree(tree) === null) {
      throw transportError('Synthetic GitHub fixture contains a commit with an invalid tree.');
    }
    const parents = parentLines.map(line => line.slice('parent '.length));
    if (parents.some(parent => resolveCommit(parent) === null)) {
      throw transportError('Synthetic GitHub fixture contains a commit with an invalid parent.');
    }
    return {
      sha,
      tree: { sha: tree.toLowerCase() },
      parents: parents.map(parent => ({ sha: parent.toLowerCase() })),
      message: text.slice(separator + 2),
      author: parseIdentity(authorLine?.slice('author '.length) ?? '') ?? undefined,
      committer: parseIdentity(committerLine?.slice('committer '.length) ?? '') ?? undefined,
    };
  }

  function readTree(value) {
    const sha = resolveTree(value);
    if (sha === null) return null;
    const raw = runGitAt(repository.topLevel, ['ls-tree', '-r', '-t', '-l', '-z', sha], { operation: 'tree read' });
    const entries = [];
    for (const record of raw.toString('utf8').split('\0')) {
      if (!record) continue;
      const separator = record.indexOf('\t');
      if (separator < 0) throw transportError('Synthetic GitHub fixture contains a malformed tree entry.');
      const fields = record.slice(0, separator).split(/\s+/u);
      if (fields.length < 4 || !SHA_PATTERN.test(fields[2])) {
        throw transportError('Synthetic GitHub fixture contains an invalid tree entry.');
      }
      const [mode, type, entrySha, size] = fields;
      const path = validateRepositoryPath(record.slice(separator + 1), 'tree path');
      const entry = { path, mode, type, sha: entrySha.toLowerCase() };
      if (type === 'blob') {
        const byteSize = Number(size);
        if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
          throw transportError('Synthetic GitHub fixture contains an invalid blob size.');
        }
        entry.size = byteSize;
      }
      entries.push(entry);
    }
    return entries;
  }

  function readBlobFromCommit(commitValue, pathValue) {
    const commit = resolveCommit(commitValue);
    if (commit === null) return null;
    const path = validateRepositoryPath(pathValue);
    const object = `${commit}:${path}`;
    const type = runGitAt(repository.topLevel, ['cat-file', '-t', object], { allowFailure: true });
    if (type === null || outputText(type, 'blob type') !== 'blob') return null;
    return runGitAt(repository.topLevel, ['cat-file', 'blob', object], { operation: 'blob read' });
  }

  function readBlob(value) {
    const sha = resolveBlob(value);
    if (sha === null) return null;
    return runGitAt(repository.topLevel, ['cat-file', 'blob', sha], { operation: 'blob read' });
  }

  function assertSitePath(path, label = 'repository path') {
    const normalized = validateRepositoryPath(path, label);
    if (repositoryPrefix && normalized !== repositoryPrefix && !normalized.startsWith(`${repositoryPrefix}/`)) {
      throw transportError(`Synthetic GitHub transport rejected a ${label} outside the captured data folder.`);
    }
    return normalized;
  }

  function createTree(baseTreeValue, entries) {
    const baseTree = resolveTree(baseTreeValue);
    if (baseTree === null) return null;
    const scratch = mkdtempSync(join(repository.gitDirectory, 'synthetic-github-index-'));
    const indexPath = join(scratch, 'index');
    const indexEnv = { GIT_INDEX_FILE: indexPath };
    try {
      runGitAt(repository.topLevel, ['read-tree', baseTree], { env: indexEnv, operation: 'tree base read' });
      const paths = new Set();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object'
          || Object.keys(entry).some(key => !['path', 'mode', 'type', 'content'].includes(key))
          || entry.mode !== '100644' || entry.type !== 'blob' || typeof entry.content !== 'string') {
          throw transportError('Synthetic GitHub transport only supports UTF-8 content tree entries.');
        }
        const path = assertSitePath(entry.path, 'tree write path');
        if (paths.has(path)) throw transportError('Synthetic GitHub transport rejected duplicate tree write paths.');
        paths.add(path);
        const blob = outputText(runGitAt(repository.topLevel, ['hash-object', '-w', '--stdin'], {
          input: Buffer.from(entry.content, 'utf8'),
          operation: 'blob creation',
        }), 'blob SHA');
        if (!SHA_PATTERN.test(blob)) throw transportError('Synthetic GitHub transport created an invalid blob.');
        runGitAt(repository.topLevel, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], {
          env: indexEnv,
          operation: 'tree entry update',
        });
      }
      const tree = outputText(runGitAt(repository.topLevel, ['write-tree'], {
        env: indexEnv,
        operation: 'tree creation',
      }), 'tree SHA');
      if (!SHA_PATTERN.test(tree)) throw transportError('Synthetic GitHub transport created an invalid tree.');
      writes.push({
        operation: 'create-tree',
        owner,
        repo,
        ref: expectedRef,
        baseTree,
        tree: tree.toLowerCase(),
        paths: [...paths],
      });
      writePaths.push(...paths);
      return tree.toLowerCase();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  function createCommit(treeValue, message, parentValue) {
    const tree = resolveTree(treeValue);
    const parent = resolveCommit(parentValue);
    if (tree === null || parent === null) return null;
    if (typeof message !== 'string') throw transportError('Synthetic GitHub transport received an invalid commit message.');
    const timestamp = new Date().toISOString();
    const commit = outputText(runGitAt(repository.topLevel, ['commit-tree', tree, '-p', parent], {
      input: Buffer.from(message, 'utf8'),
      env: {
        GIT_AUTHOR_NAME: SYNTHETIC_GIT_NAME,
        GIT_AUTHOR_EMAIL: SYNTHETIC_GIT_EMAIL,
        GIT_COMMITTER_NAME: SYNTHETIC_GIT_NAME,
        GIT_COMMITTER_EMAIL: SYNTHETIC_GIT_EMAIL,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      },
      operation: 'commit creation',
    }));
    if (!SHA_PATTERN.test(commit) || readCommit(commit) === null) {
      throw transportError('Synthetic GitHub transport created an invalid commit.');
    }
    writes.push({
      operation: 'create-commit',
      owner,
      repo,
      ref: expectedRef,
      tree,
      commit: commit.toLowerCase(),
      parent,
    });
    return commit.toLowerCase();
  }

  function isAncestor(base, head) {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', base, head], {
      cwd: repository.topLevel,
      env: baseGitEnvironment(),
      encoding: null,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw transportError('Synthetic GitHub transport could not compare commit ancestry.');
    }
    return result.status === 0;
  }

  function commitCount(range) {
    return Number(outputText(runGitAt(repository.topLevel, ['rev-list', '--count', range]), 'commit count'));
  }

  function compareCommits(baseValue, headValue) {
    const base = resolveCommit(baseValue);
    const head = resolveCommit(headValue);
    if (base === null || head === null) return null;
    if (base === head) return { status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0 };
    const baseAhead = isAncestor(base, head);
    const headAhead = isAncestor(head, base);
    const aheadBy = commitCount(`${base}..${head}`);
    const behindBy = commitCount(`${head}..${base}`);
    return {
      status: baseAhead ? 'ahead' : headAhead ? 'behind' : 'diverged',
      ahead_by: aheadBy,
      behind_by: behindBy,
      total_commits: aheadBy,
    };
  }

  function updateRef(commitValue) {
    const commit = resolveCommit(commitValue);
    if (commit === null) return null;
    const previous = readHeadSha();
    if (!isAncestor(previous, commit)) return null;
    const result = spawnSync('git', ['update-ref', expectedRef, commit, previous], {
      cwd: repository.topLevel,
      env: baseGitEnvironment(),
      encoding: null,
    });
    if (result.error || result.status !== 0) return null;
    writes.push({
      operation: 'update-ref',
      owner,
      repo,
      ref: expectedRef,
      previous,
      commit,
      force: false,
    });
    return commit;
  }

  function commitHistory(pathValue, headValue) {
    const path = assertSitePath(pathValue);
    const head = resolveCommit(headValue);
    if (head === null) return null;
    const output = runGitAt(repository.topLevel, ['log', '--format=%H', head, '--', path], { operation: 'commit history read' });
    const shas = outputText(output, 'commit history').split(/\r?\n/u).filter(Boolean).slice(0, 100);
    return shas.map(sha => {
      const commit = readCommit(sha);
      if (commit === null) throw transportError('Synthetic GitHub fixture returned an invalid history commit.');
      return {
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: commit.author,
          committer: commit.committer,
        },
        parents: commit.parents,
      };
    });
  }

  function authorizeApi(headers) {
    if (headers.get('Authorization') !== `Bearer ${token}`) return false;
    return true;
  }

  function requireCapturedRepository(parsed, observation) {
    if (parsed.owner !== owner || parsed.repo !== repo) {
      throw transportError('Synthetic GitHub transport rejected a foreign repository destination.');
    }
    observation.owner = owner;
    observation.repo = repo;
    observation.repository = expectedRepository;
  }

  async function routeGraphql(url, method, headers, body, observation) {
    if (url.pathname !== '/graphql' || url.search || method !== 'POST') {
      throw transportError('Synthetic GitHub transport rejected an unrecognized GraphQL endpoint.');
    }
    if (!authorizeApi(headers)) return jsonResponse({ message: 'Bad credentials' }, 401);
    const payload = parseJson(body, 'GraphQL request');
    if (!payload || typeof payload.query !== 'string' || Object.keys(payload).some(key => key !== 'query')) {
      return jsonResponse({ message: 'Validation Failed' }, 422);
    }
    const query = payload.query;
    const repositoryMatch = /^query\s+TrackerSource\s*\{\s*repository\(owner:\s*("(?:\\.|[^"\\])*")\s*,\s*name:\s*("(?:\\.|[^"\\])*")\)\s*\{([\s\S]*)\}\s*\}\s*$/u.exec(query);
    if (!repositoryMatch) throw transportError('Synthetic GitHub transport rejected an unrecognized GraphQL query.');
    const queryOwner = JSON.parse(repositoryMatch[1]);
    const queryRepo = JSON.parse(repositoryMatch[2]);
    if (queryOwner !== owner || queryRepo !== repo) {
      throw transportError('Synthetic GitHub transport rejected a foreign repository destination.');
    }
    const selection = repositoryMatch[3];
    const aliases = [];
    const expressionPattern = /(b\d+):\s*object\(expression:\s*("(?:\\.|[^"\\])*")\)\s*\{\s*\.\.\.\s*on\s+Blob\s*\{\s*text\s+byteSize\s+isTruncated\s*\}\s*\}/gu;
    let match;
    let cursor = 0;
    while ((match = expressionPattern.exec(selection)) !== null) {
      if (selection.slice(cursor, match.index).trim() !== '') {
        throw transportError('Synthetic GitHub transport rejected an unrecognized GraphQL query.');
      }
      aliases.push({ alias: match[1], expression: JSON.parse(match[2]) });
      cursor = expressionPattern.lastIndex;
    }
    if (selection.slice(cursor).trim() !== '' || aliases.length === 0
      || aliases.some((entry, index) => entry.alias !== `b${index}`)) {
      throw transportError('Synthetic GitHub transport rejected an unrecognized GraphQL query.');
    }
    const output = {};
    for (const { alias, expression } of aliases) {
      const separator = expression.indexOf(':');
      if (separator <= 0) throw transportError('Synthetic GitHub transport received an invalid blob expression.');
      const commit = expression.slice(0, separator);
      const path = assertSitePath(expression.slice(separator + 1), 'blob path');
      const bytes = readBlobFromCommit(commit, path);
      if (bytes === null) {
        output[alias] = null;
        continue;
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        output[alias] = null;
        continue;
      }
      output[alias] = { text, byteSize: bytes.byteLength, isTruncated: false };
      observation.path = path;
      observation.commit = validateSha(commit, 'commit SHA');
    }
    return jsonResponse({ data: { repository: output } });
  }

  async function routeRepository(url, method, headers, body, observation) {
    const parsed = parseRepositoryPath(url, observation);
    requireCapturedRepository(parsed, observation);
    if (!authorizeApi(headers)) return jsonResponse({ message: 'Bad credentials' }, 401);
    const { suffix } = parsed;

    const getRefBranch = parseBranchSuffix(suffix, 'ref', observation);
    if (getRefBranch !== null) {
      if (getRefBranch !== branch) throw transportError('Synthetic GitHub transport rejected a foreign branch reference.');
      if (method !== 'GET') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      return jsonResponse({ ref: expectedRef, node_id: 'synthetic-ref', object: { sha: readHeadSha(), type: 'commit' } });
    }
    const updateRefBranch = parseBranchSuffix(suffix, 'refs', observation);
    if (updateRefBranch !== null) {
      if (updateRefBranch !== branch) throw transportError('Synthetic GitHub transport rejected a foreign branch reference.');
      if (method !== 'PATCH') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      const value = parseJson(body, 'ref update');
      if (!value || Object.keys(value).some(key => !['sha', 'force'].includes(key))
        || value.force !== false || typeof value.sha !== 'string' || !SHA_PATTERN.test(value.sha)) {
        return jsonResponse({ message: 'Validation Failed' }, 422);
      }
      const updated = updateRef(value.sha);
      if (updated === null) return jsonResponse({ message: 'Reference update failed' }, 409);
      return jsonResponse({ ref: expectedRef, node_id: 'synthetic-ref', object: { sha: updated, type: 'commit' } });
    }

    let match = /^\/git\/commits\/([^/]+)$/u.exec(suffix);
    if (match) {
      const sha = decodePathPart(match[1], 'commit SHA');
      if (method !== 'GET') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      const commit = readCommit(sha);
      if (commit === null) return jsonResponse({ message: 'Not Found' }, 404);
      observation.commit = commit.sha;
      return jsonResponse(commit);
    }

    match = /^\/git\/trees\/([^/]+)$/u.exec(suffix);
    if (match) {
      const sha = decodePathPart(match[1], 'tree SHA');
      if (method === 'GET') {
        if (url.searchParams.get('recursive') !== '1' || [...url.searchParams.keys()].some(key => key !== 'recursive')) {
          throw transportError('Synthetic GitHub transport rejected an unrecognized tree query.');
        }
        const tree = readTree(sha);
        if (tree === null) return jsonResponse({ message: 'Not Found' }, 404);
        observation.tree = validateSha(sha, 'tree SHA');
        return jsonResponse({ sha: observation.tree, tree, truncated: false });
      }
      return jsonResponse({ message: 'Method Not Allowed' }, 405);
    }

    match = /^\/git\/blobs\/([^/]+)$/u.exec(suffix);
    if (match) {
      if (method !== 'GET') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      const sha = decodePathPart(match[1], 'blob SHA');
      const bytes = readBlob(sha);
      if (bytes === null) return jsonResponse({ message: 'Not Found' }, 404);
      observation.blob = validateSha(sha, 'blob SHA');
      return jsonResponse({ sha: observation.blob, size: bytes.byteLength, encoding: 'base64', content: bytes.toString('base64') });
    }

    match = /^\/compare\/([^/.]+)\.\.\.([^/.]+)$/u.exec(suffix);
    if (match) {
      if (method !== 'GET' || url.search) throw transportError('Synthetic GitHub transport rejected an unrecognized compare query.');
      const base = decodePathPart(match[1], 'base commit SHA');
      const head = decodePathPart(match[2], 'head commit SHA');
      const comparison = compareCommits(base, head);
      if (comparison === null) return jsonResponse({ message: 'Not Found' }, 404);
      observation.base = validateSha(base, 'base commit SHA');
      observation.head = validateSha(head, 'head commit SHA');
      return jsonResponse({ ...comparison, base_commit: { sha: observation.base }, merge_base_commit: { sha: observation.base } });
    }

    if (suffix === '/git/trees') {
      if (method !== 'POST') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      const value = parseJson(body, 'tree creation');
      if (!value || Object.keys(value).some(key => !['base_tree', 'tree'].includes(key))
        || typeof value.base_tree !== 'string' || !Array.isArray(value.tree)) {
        return jsonResponse({ message: 'Validation Failed' }, 422);
      }
      const tree = createTree(value.base_tree, value.tree);
      if (tree === null) return jsonResponse({ message: 'Not Found' }, 404);
      observation.tree = tree;
      observation.paths = value.tree.map(entry => entry?.path).filter(path => typeof path === 'string');
      return jsonResponse({ sha: tree });
    }

    if (suffix === '/git/commits') {
      if (method !== 'POST') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      const value = parseJson(body, 'commit creation');
      if (!value || Object.keys(value).some(key => !['message', 'tree', 'parents'].includes(key))
        || typeof value.message !== 'string' || typeof value.tree !== 'string'
        || !Array.isArray(value.parents) || value.parents.length !== 1 || typeof value.parents[0] !== 'string') {
        return jsonResponse({ message: 'Validation Failed' }, 422);
      }
      const commit = createCommit(value.tree, value.message, value.parents[0]);
      if (commit === null) return jsonResponse({ message: 'Not Found' }, 404);
      observation.commit = commit;
      observation.parent = validateSha(value.parents[0], 'parent SHA');
      return jsonResponse({ sha: commit });
    }

    if (suffix === '/commits') {
      if (method !== 'GET') return jsonResponse({ message: 'Method Not Allowed' }, 405);
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !['path', 'sha', 'per_page'].includes(key))
        || url.searchParams.get('path') === null || url.searchParams.get('sha') === null) {
        throw transportError('Synthetic GitHub transport rejected an unrecognized commit history query.');
      }
      const path = url.searchParams.get('path');
      const sha = url.searchParams.get('sha');
      const history = commitHistory(path, sha);
      if (history === null) return jsonResponse({ message: 'Not Found' }, 404);
      observation.path = path;
      observation.commit = validateSha(sha, 'commit SHA');
      return jsonResponse(history);
    }

    throw transportError('Synthetic GitHub transport rejected an unrecognized repository endpoint.');
  }

  async function fetch(input, init = {}) {
    const normalized = normalizeRequestInput(input, init);
    const { url, method, headers } = normalized;
    const observation = {
      method,
      url: `${url.origin}${url.pathname}${url.search}`,
      host: url.host,
      pathname: url.pathname,
      search: url.search,
    };
    requests.push(observation);
    try {
      if (url.origin !== `https://${API_HOST}` || url.username || url.password) {
        throw transportError('Synthetic GitHub transport rejected a foreign network destination.');
      }
      const bodyValue = normalized.body instanceof Promise
        ? await normalized.body
        : normalized.body;
      const body = requestBodyBytes(bodyValue).toString('utf8');
      let response;
      const tokenPath = /^\/app\/installations\/([^/]+)\/access_tokens$/u.exec(url.pathname);
      if (tokenPath) {
        if (method !== 'POST' || url.search) throw transportError('Synthetic GitHub transport rejected an unrecognized token endpoint.');
        const requestedInstallation = decodePathPart(tokenPath[1], 'installation identifier');
        if (requestedInstallation !== installationId) throw transportError('Synthetic GitHub transport rejected a foreign installation destination.');
        const value = parseJson(body, 'installation token request');
        if (!value || Object.keys(value).some(key => !['repositories', 'permissions'].includes(key))
          || !Array.isArray(value.repositories) || value.repositories.length !== 1 || value.repositories[0] !== repo
          || value.permissions?.contents !== 'write') {
          response = jsonResponse({ message: 'Validation Failed' }, 422);
        } else {
          response = jsonResponse({
            token,
            expires_at: TOKEN_EXPIRY,
            permissions: { contents: 'write' },
            repositories: [{ full_name: expectedRepository }],
          }, 201);
        }
      } else if (url.pathname === '/graphql') {
        response = await routeGraphql(url, method, headers, body, observation);
      } else if (url.pathname.startsWith('/repos/')) {
        response = await routeRepository(url, method, headers, body, observation);
      } else {
        throw transportError('Synthetic GitHub transport rejected an unrecognized endpoint.');
      }
      observation.status = response.status;
      return response;
    } catch (error) {
      observation.rejected = true;
      throw error;
    }
  }

  // Verify the expected branch once at construction.  This both catches a
  // caller that forgot to initialize its fixture and records no mutable Git
  // state outside dataRepo.
  readHeadSha();

  const state = {};
  Object.defineProperties(state, {
    dataRepo: { enumerable: true, get: () => repository.requestedRoot },
    topLevel: { enumerable: true, get: () => repository.topLevel },
    gitDirectory: { enumerable: true, get: () => repository.gitDirectory },
    owner: { enumerable: true, get: () => owner },
    repo: { enumerable: true, get: () => repo },
    branch: { enumerable: true, get: () => branch },
    ref: { enumerable: true, get: () => expectedRef },
    head: { enumerable: true, get: () => readHeadSha() },
    headSha: { enumerable: true, get: () => readHeadSha() },
  });
  const observations = { requests, writes };
  return {
    fetch,
    fetchImpl: fetch,
    requests,
    writes,
    writePaths,
    requestObservations: requests,
    writeObservations: writes,
    requestLog: requests,
    writeLog: writes,
    observations,
    identity,
    state,
  };
}
