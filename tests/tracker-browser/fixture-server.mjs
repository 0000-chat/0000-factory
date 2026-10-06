import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { fixtureInstance, writeFixtureData } from '../helpers/fixture-data.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '../..');
const ENGINE_ROOT = PROJECT_ROOT;
const DEV_SCRIPT = join(PROJECT_ROOT, 'tracker/viewer/tooling/dev.mjs');
const DEFAULT_BASE_PORT = 4187;
const HEALTH_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  let basePort = Number(process.env.TRACKER_BROWSER_PORT ?? DEFAULT_BASE_PORT);
  let projectsFile = process.env.TRACKER_BROWSER_PROJECTS_FILE ?? null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-port') {
      const value = argv[++index];
      if (value === undefined) throw new Error('--base-port requires a value');
      basePort = Number(value);
    } else if (arg === '--projects-file') {
      const value = argv[++index];
      if (value === undefined) throw new Error('--projects-file requires a value');
      projectsFile = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65532) throw new Error('base port must leave room for three fixture servers');
  return { basePort, projectsFile: projectsFile ? resolve(projectsFile) : null };
}

function isolatedGitEnvironment() {
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function runGit(dataRepo, args) {
  execFileSync('git', ['-C', dataRepo, ...args], {
    env: isolatedGitEnvironment(),
    stdio: 'ignore',
  });
}

function createOwnedRunRoot() {
  const configured = process.env.TRACKER_BROWSER_FIXTURE_ROOT;
  const parent = resolve(configured ?? process.env.TMPDIR ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'tracker-browser-run-'));
}

function makeProject({ id, folderPath, mode, accessKind, publishKind, port, root }) {
  const projectRoot = join(root, id);
  const dataRepo = join(projectRoot, 'data');
  const output = join(projectRoot, 'output');
  mkdirSync(dataRepo, { recursive: true });
  const instance = fixtureInstance({ id, folderPath, accessKind, publishKind });
  const fixture = writeFixtureData({ repositoryPath: dataRepo, instance, mode });
  runGit(dataRepo, ['init', '--quiet', '--initial-branch=main']);
  runGit(dataRepo, ['config', 'user.name', 'Fixture Browser']);
  runGit(dataRepo, ['config', 'user.email', 'fixture-browser@fixture.test']);
  runGit(dataRepo, ['add', '.']);
  runGit(dataRepo, ['commit', '--quiet', '-m', 'fixture browser baseline']);
  return {
    id,
    port,
    dataRepo,
    output,
    settingsPath: fixture.instancePath,
    child: null,
  };
}

function startDevServer(project) {
  const bun = process.env.BUN_BIN || 'bun';
  const child = spawn(bun, [
    DEV_SCRIPT,
    '--engine-root', ENGINE_ROOT,
    '--data-root', project.dataRepo,
    '--settings', project.settingsPath,
    '--out', project.output,
    '--port', String(project.port),
  ], {
    cwd: PROJECT_ROOT,
    env: { ...isolatedGitEnvironment(), TMPDIR: process.env.TMPDIR || tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Keep the child pipes drained without copying build output into test logs.
  child.stdout?.resume();
  child.stderr?.resume();
  project.spawnError = null;
  child.once('error', () => { project.spawnError = true; });
  project.child = child;
  return child;
}

async function waitForHealth(project) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (project.spawnError) throw new Error(`fixture server failed to start: ${project.id}`);
    if (project.child?.exitCode != null || project.child?.signalCode != null) {
      throw new Error(`fixture server stopped before becoming healthy: ${project.id}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${project.port}/__health`);
      if (response.ok) return;
    } catch {
      // The initial build can take a little while. Retry without logging paths.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw new Error(`fixture server did not become healthy: ${project.id}`);
}

function createReadinessServer(port) {
  const server = createServer((request, response) => {
    if (request.url === '/__health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolvePromise => {
    let forceTimer;
    const finish = () => {
      clearTimeout(forceTimer);
      child.removeListener('exit', finish);
      child.removeListener('error', finish);
      resolvePromise();
    };
    child.once('exit', finish);
    child.once('error', finish);
    if (!child.kill('SIGTERM')) {
      finish();
      return;
    }
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_000);
  });
}

function closeReadinessServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  return new Promise(resolvePromise => server.close(() => resolvePromise()));
}

async function main() {
  const { basePort, projectsFile: configuredProjectsFile } = parseArgs(process.argv.slice(2));
  const root = createOwnedRunRoot();
  const projectsFile = configuredProjectsFile ?? join(root, 'projects.json');
  const projects = [];
  let readinessServer;
  let metadataOwned = false;
  let stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await closeReadinessServer(readinessServer);
      await Promise.all(projects.map(project => project.child ? waitForChildExit(project.child) : Promise.resolve()));
      if (metadataOwned) rmSync(projectsFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    })();
    return stopPromise;
  };
  const handleSignal = () => {
    void stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    // Register teardown before any fixture or caller metadata write can fail.
    projects.push(
      makeProject({ id: 'empty-0000', folderPath: 'tooling/project-tracker', mode: 'empty', accessKind: 'unconfigured', publishKind: 'disabled', port: basePort + 1, root }),
      makeProject({ id: 'populated-root', folderPath: '', mode: 'populated', accessKind: 'ready', publishKind: 'enabled', port: basePort + 2, root }),
      makeProject({ id: 'populated-nested', folderPath: 'tooling/project-tracker', mode: 'populated', accessKind: 'unconfigured', publishKind: 'disabled', port: basePort + 3, root }),
    );
    mkdirSync(dirname(projectsFile), { recursive: true });
    writeFileSync(projectsFile, `${JSON.stringify(projects.map(({ id, port, dataRepo, output, settingsPath }) => ({ id, port, dataRepo, output, settingsPath, runRoot: root })), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    metadataOwned = true;
    for (const project of projects) startDevServer(project);
    await Promise.all(projects.map(waitForHealth));
    readinessServer = await createReadinessServer(basePort);
    console.log('tracker browser fixtures ready');
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
