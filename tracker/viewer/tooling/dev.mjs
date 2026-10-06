import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstanceConfig } from '../../../tooling/instance/config.mjs';
import { repositoryPath, selectedDataPaths } from '../../../tooling/instance/paths.mjs';
import { SOURCE_READ_LIMITS } from '../../../tooling/tracker/source-validation.mjs';
import { buildSnapshot, formatValidationError } from './build.mjs';
import { shouldFallbackNavigation } from './navigation-fallback.mjs';

const TOOLING_DIR = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(TOOLING_DIR, '../../..');
const DEFAULT_PORT = 4173;
const DEFAULT_INTERVAL = 700;

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label}: must be a non-empty path`);
  return value;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contained(parent, child) {
  const value = relative(parent, child);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function regularFile(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}: must be a regular file`);
  if ((stat.mode & 0o111) !== 0) throw new Error(`${label}: must not be executable`);
}

function digest(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new Error(`watch input is not a regular file: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function selectedInputDigests(root, instance) {
  const selections = selectedDataPaths({ dataRepo: root, instance });
  if (selections.length === 0 || selections.length > SOURCE_READ_LIMITS.maxFiles) {
    throw new Error('watch input exceeds the source file-count limit');
  }
  let totalBytes = 0;
  return selections.map(selection => {
    const path = join(root, selection.repositoryPath);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) {
      throw new Error('watch input is not a regular file');
    }
    if (stat.size > SOURCE_READ_LIMITS.maxFileBytes || totalBytes + stat.size > SOURCE_READ_LIMITS.maxTotalBytes) {
      throw new Error('watch input exceeds the source read limit');
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength > SOURCE_READ_LIMITS.maxFileBytes || totalBytes + bytes.byteLength > SOURCE_READ_LIMITS.maxTotalBytes) {
      throw new Error('watch input changed beyond the source read limit');
    }
    totalBytes += bytes.byteLength;
    return [
      `${selection.role}:${selection.canonicalPath}`,
      selection.repositoryPath,
      createHash('sha256').update(bytes).digest('hex'),
    ];
  });
}

/**
 * Return a content signature for the selected settings, branding asset, and
 * canonical data files. Engine source, generated output, local checkouts, and
 * unrelated data-repository documents are deliberately absent from it.
 */
export function snapshotSignature({ engineRoot, dataRepo, instancePath } = {}) {
  requireText(engineRoot, 'engineRoot');
  const selectedEngine = realPath(engineRoot);
  if (selectedEngine !== realPath(ENGINE_ROOT)) throw new Error(`engineRoot must identify the running tracker engine (${ENGINE_ROOT})`);
  const dataRoot = resolve(requireText(dataRepo, 'dataRepo'));
  const dataStat = lstatSync(dataRoot, { throwIfNoEntry: false });
  if (!dataStat || !dataStat.isDirectory() || dataStat.isSymbolicLink()) throw new Error('dataRepo: must be a real directory');
  const root = realPath(dataRoot);
  const settingsPath = resolve(requireText(instancePath, 'instancePath'));
  regularFile(settingsPath, 'settings');
  if (!contained(root, realPath(settingsPath))) throw new Error('settings must be physically contained in dataRepo');
  const { instance, manifestDir, configDigest } = loadInstanceConfig({ path: settingsPath });
  const selectedFolder = realPath(join(root, repositoryPath(instance, '')));
  const manifestReal = realPath(manifestDir);
  if (manifestReal !== selectedFolder || !contained(root, manifestReal) || !contained(selectedFolder, realPath(settingsPath))) {
    throw new Error('settings must be inside the selected data folder');
  }
  const assetPath = resolve(manifestDir, ...instance.branding.faviconPath.split('/'));
  regularFile(assetPath, 'branding asset');
  if (!contained(manifestReal, realPath(assetPath))) throw new Error('branding asset escapes the settings folder');
  const entries = [
    ['settings.json', settingsPath, configDigest],
    [`asset:${instance.branding.faviconPath}`, assetPath, digest(assetPath)],
  ];
  // Apply source limits before reading selected data and keep signatures tied
  // to the exact bytes the engine consumes.
  entries.push(...selectedInputDigests(root, instance));
  return createHash('sha256').update(JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)))).digest('hex');
}

export function createBuildWatcher({ readSignature, build, send = () => {}, onSuccess = () => {}, onError = () => {} }) {
  let lastSignature = null;
  let rebuilding = false;

  async function rebuild() {
    if (rebuilding) return false;
    const inputSignature = readSignature();
    rebuilding = true;
    try {
      const result = await build();
      onSuccess(result);
      send('reload');
      lastSignature = inputSignature;
      return true;
    } catch (error) {
      onError(error);
      send('build-error');
      return false;
    } finally {
      rebuilding = false;
    }
  }

  async function poll() {
    const signature = readSignature();
    if (signature === null || signature === lastSignature || rebuilding) return false;
    return rebuild();
  }

  return {
    getLastSignature: () => lastSignature,
    setLastSignature: signature => { lastSignature = signature; },
    rebuild,
    poll,
  };
}

function contentType(path) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
  }[extname(path)] ?? 'application/octet-stream';
}

function safeStaticPath(assetsRoot, pathname) {
  if (typeof pathname !== 'string' || pathname.includes('\\')) return null;
  let segments;
  try {
    segments = pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments.some(segment => segment.includes('/') || segment.includes('\\') || /[\u0000-\u001f\u007f]/u.test(segment) || segment === '.' || segment === '..')) return null;
  const relativePath = segments.length === 0 ? 'index.html' : segments.join('/');
  const root = resolve(assetsRoot);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const candidate = resolve(root, relativePath);
  const rootPrefix = `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) return null;
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) return null;
    if (index < segments.length - 1 && !stat.isDirectory()) return null;
  }
  const candidateStat = lstatSync(candidate, { throwIfNoEntry: false });
  if (candidateStat?.isSymbolicLink()) return null;
  if (candidateStat?.isFile() && !contained(realPath(root), realPath(candidate))) return null;
  return candidate;
}

function privateHeaders(headers = {}) {
  const result = new Headers(headers);
  result.set('Cache-Control', 'no-cache');
  result.set('X-Content-Type-Options', 'nosniff');
  return result;
}

function staticResponse(path, method) {
  return new Response(method === 'HEAD' ? null : readFileSync(path), {
    headers: privateHeaders({ 'content-type': contentType(path) }),
  });
}

export function createDevHandler({ output, subscribers = new Set() }) {
  const outputPath = resolve(requireText(output, 'output'));
  const assetsPath = join(outputPath, 'assets');
  return request => {
    const url = new URL(request.url);
    if (url.pathname === '/__tracker_reload') {
      const headers = privateHeaders({ 'content-type': 'text/event-stream', connection: 'keep-alive' });
      if (request.method === 'HEAD') return new Response(null, { headers });
      let subscriber;
      const stream = new ReadableStream({
        start(controller) {
          subscriber = controller;
          controller.enqueue('retry: 1000\n\n');
          subscribers.add(controller);
        },
        cancel() {
          if (subscriber) subscribers.delete(subscriber);
        },
      });
      return new Response(stream, { headers });
    }
    if (url.pathname === '/__health') {
      const health = Response.json({ ok: true });
      return request.method === 'HEAD'
        ? new Response(null, { status: health.status, headers: privateHeaders(health.headers) })
        : new Response(health.body, { status: health.status, headers: privateHeaders(health.headers) });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers: privateHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
    }

    const path = safeStaticPath(assetsPath, url.pathname);
    const response = path && existsSync(path) && lstatSync(path).isFile()
      ? staticResponse(path, request.method)
      : new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers: privateHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
    if (!shouldFallbackNavigation(request, response)) return response;

    const rootPath = safeStaticPath(assetsPath, '/');
    if (!rootPath || !existsSync(rootPath) || !lstatSync(rootPath).isFile()) return response;
    return staticResponse(rootPath, request.method);
  };
}

function parseArgs(argv) {
  const options = { engineRoot: null, dataRepo: null, instancePath: null, output: null, port: DEFAULT_PORT, interval: DEFAULT_INTERVAL, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--engine-root', '--data-root', '--settings', '--out', '--port', '--interval'].includes(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--engine-root') options.engineRoot = value;
      else if (arg === '--data-root') options.dataRepo = value;
      else if (arg === '--settings') options.instancePath = value;
      else if (arg === '--out') options.output = value;
      else if (arg === '--port') options.port = Number(value);
      else options.interval = Math.max(Number(value), 250);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  requireText(options.engineRoot, 'engine-root');
  requireText(options.dataRepo, 'data-root');
  requireText(options.instancePath, 'settings');
  requireText(options.output, 'out');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('port must be 1–65535');
  if (!Number.isFinite(options.interval) || options.interval < 250) throw new Error('interval must be at least 250ms');
  return options;
}

function usage() {
  return [
    'Usage: bun tracker/viewer/tooling/dev.mjs --engine-root ENGINE --data-root DATA_REPOSITORY --settings SETTINGS_JSON --out OUTPUT [--port 4173] [--interval 700]',
    '',
    'The server binds to 127.0.0.1, serves only generated assets, and rebuilds',
    'when selected settings, data, or branding inputs change. Invalid input keeps',
    'the last valid output and emits a build-error event.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  let sourceReadWarning = false;
  const subscribers = new Set();
  const send = event => {
    for (const controller of subscribers) {
      try {
        controller.enqueue(`data: ${event}\n\n`);
      } catch {
        subscribers.delete(controller);
      }
    }
  };
  const readSignature = () => {
    try {
      const signature = snapshotSignature({ engineRoot: options.engineRoot, dataRepo: options.dataRepo, instancePath: options.instancePath });
      sourceReadWarning = false;
      return signature;
    } catch (error) {
      if (!sourceReadWarning) console.warn(`tracker source changed while scanning; retrying: ${error.message}`);
      sourceReadWarning = true;
      return null;
    }
  };
  const watcher = createBuildWatcher({
    readSignature,
    build: () => buildSnapshot({ engineRoot: options.engineRoot, dataRepo: options.dataRepo, instancePath: options.instancePath, output: options.output }),
    send,
    onSuccess: result => console.log(`rebuilt ${result.data.source.shortCommit} at ${result.data.source.builtAt}`),
    onError: error => console.error(formatValidationError(error)),
  });

  await watcher.rebuild();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    fetch: createDevHandler({ output: options.output, subscribers }),
  });
  console.log(`tracker viewer listening at http://${server.hostname}:${server.port}`);

  const timer = setInterval(() => { void watcher.poll(); }, options.interval);
  const stop = () => {
    clearInterval(timer);
    for (const controller of subscribers) controller.close();
    server.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(formatValidationError(error));
    process.exitCode = 1;
  });
}
