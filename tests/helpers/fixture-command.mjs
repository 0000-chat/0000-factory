#!/usr/bin/env node

/**
 * Run the documented engine commands against an authored synthetic checkout.
 *
 * The application checkout is always passed as --engine-root and the fixture
 * checkout, settings file, and output directory are all separate explicit
 * paths. This keeps package scripts useful on a fresh clone without teaching
 * the engine to discover site data from its own repository.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { fixtureInstance, writeFixtureData } from './fixture-data.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineRoot = projectRoot;

function usage() {
  return [
    'Usage: node tests/helpers/fixture-command.mjs COMMAND',
    '',
    'COMMAND is tracker-build, tracker-check, tracker-validate, tracker-archive, viewer-build, or viewer-dev.',
    'Each command creates and removes a synthetic, data-only checkout.',
  ].join('\n');
}

function fixtureRoot() {
  const configured = process.env.TRACKER_FIXTURE_TMP;
  const parent = resolve(configured || process.env.TMPDIR || tmpdir());
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'tracker-command-'));
}

function commandInput() {
  const root = fixtureRoot();
  const data = writeFixtureData({
    repositoryPath: join(root, 'data'),
    instance: fixtureInstance({ id: 'command-fixture', folderPath: 'tooling/project-tracker' }),
    mode: process.env.TRACKER_FIXTURE_MODE === 'populated' ? 'populated' : 'empty',
  });
  return { root, data, output: join(root, 'output') };
}

function explicitArgs(input) {
  return [
    '--engine-root', engineRoot,
    '--data-root', input.data.dataRepo,
    '--settings', input.data.instancePath,
    '--out', input.output,
  ];
}

function runOneShot(command, input) {
  const cli = command === 'tracker-build' || command === 'tracker-check' || command === 'tracker-validate' || command === 'tracker-archive'
    ? join(projectRoot, 'tooling/tracker/cli.mjs')
    : join(projectRoot, 'tracker/viewer/tooling/build.mjs');
  const args = command === 'tracker-build'
    ? ['build', ...explicitArgs(input)]
    : command === 'tracker-check'
      ? ['build', ...explicitArgs(input)]
      : command === 'tracker-validate'
        ? ['validate-only', ...explicitArgs(input).slice(0, -2)]
        : command === 'tracker-archive'
          ? ['archive', ...explicitArgs(input).slice(0, -2)]
          : explicitArgs(input);
  execFileSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: process.env.TMPDIR || resolve(process.env.TRACKER_FIXTURE_TMP || tmpdir()) },
  });
  if (command === 'tracker-check') {
    execFileSync(process.execPath, [cli, 'check', ...explicitArgs(input)], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, TMPDIR: process.env.TMPDIR || resolve(process.env.TRACKER_FIXTURE_TMP || tmpdir()) },
    });
  }
}

async function runDev(input) {
  const port = Number(process.env.TRACKER_DEV_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TRACKER_DEV_PORT must be an integer from 1 to 65535');
  const dev = join(projectRoot, 'tracker/viewer/tooling/dev.mjs');
  const child = spawn(process.execPath, [dev, '--engine-root', engineRoot, '--data-root', input.data.dataRepo, '--settings', input.data.instancePath, '--out', input.output, '--port', String(port)], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: process.env.TMPDIR || resolve(process.env.TRACKER_FIXTURE_TMP || tmpdir()) },
  });
  const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const exitCode = await new Promise(resolveExit => {
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    child.once('error', () => resolveExit(1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function main() {
  const command = process.argv[2];
  if (command === '--help' || command === '-h' || command === undefined) {
    console.log(usage());
    if (command === undefined) process.exitCode = 1;
    return;
  }
  if (!['tracker-build', 'tracker-check', 'tracker-validate', 'tracker-archive', 'viewer-build', 'viewer-dev'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  const input = commandInput();
  try {
    if (command === 'viewer-dev') await runDev(input);
    else runOneShot(command, input);
  } finally {
    input.data.cleanup();
    rmSync(input.root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
