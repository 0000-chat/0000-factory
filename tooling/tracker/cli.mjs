#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstanceConfig } from '../instance/config.mjs';
import { readDataFiles, repositoryPath } from '../instance/paths.mjs';
import { archiveCandidates } from './model.mjs';
import { acceptedTaskDigest, isAccepted, milestonePlanApprovalDigest, taskApprovalDigest } from './planning.mjs';
import { DataSourceError, validateDataSource } from './source-validation.mjs';
import { renderViews } from './views.mjs';

const RUNNING_ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function usage() {
  return [
    'Usage: node tooling/tracker/cli.mjs COMMAND --engine-root ENGINE --data-root DATA_REPOSITORY --settings SETTINGS_JSON [--out OUTPUT]',
    '',
    'COMMAND is build, check, validate-only, archive, or digest.',
    'The output directory is required for build and optional for check/validate-only.',
    'archive accepts --apply; digest accepts a plan or item ID.',
  ].join('\n');
}

function requiredOption(options, name) {
  if (typeof options[name] !== 'string' || options[name].length === 0) throw new Error(`${name} is required`);
  return options[name];
}

/** Parse the explicit engine/data/settings boundary used by every command. */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    command: null,
    engineRoot: null,
    dataRoot: null,
    settings: null,
    out: null,
    apply: false,
    id: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--engine-root' || arg === '--data-root' || arg === '--settings' || arg === '--out') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replaceAll('-', '');
      options[key === 'engineroot' ? 'engineRoot' : key === 'dataroot' ? 'dataRoot' : key] = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    if (options.command === null) options.command = arg;
    else if (options.command === 'digest' && options.id === null) options.id = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (options.help) return options;
  options.command ??= 'check';
  if (!['build', 'check', 'validate-only', 'archive', 'digest'].includes(options.command)) {
    throw new Error(`unknown command: ${options.command}`);
  }
  requiredOption(options, 'engineRoot');
  requiredOption(options, 'dataRoot');
  requiredOption(options, 'settings');
  if (options.command === 'build' && options.out === null) throw new Error('out is required for build');
  if (options.apply && options.command !== 'archive') throw new Error('--apply is only valid for archive');
  if (options.command === 'digest' && options.id === null) throw new Error('digest requires a plan or item ID');
  return options;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function assertRunningEngine(engineRoot) {
  const selected = realPath(resolve(engineRoot));
  const running = realPath(RUNNING_ENGINE_ROOT);
  if (selected !== running) {
    throw new Error(`--engine-root must identify the running tracker engine (${running})`);
  }
  return selected;
}

function loadSource(options) {
  const engineRoot = assertRunningEngine(requiredOption(options, 'engineRoot'));
  const dataRepo = resolve(requiredOption(options, 'dataRoot'));
  const settingsPath = resolve(requiredOption(options, 'settings'));
  const { instance } = loadInstanceConfig({ path: settingsPath });
  const files = readDataFiles({ dataRepo, instance });
  const source = validateDataSource({ files, instance });
  return { engineRoot, dataRepo, settingsPath, instance, files, ...source };
}

function outputPath(output, instance, canonicalPath) {
  return join(output, repositoryPath(instance, canonicalPath));
}

function writeViews(output, instance, views) {
  for (const [canonicalPath, content] of Object.entries(views)) {
    const path = outputPath(output, instance, canonicalPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function staleViews(output, instance, views) {
  return Object.entries(views).filter(([canonicalPath, content]) => {
    const path = outputPath(output, instance, canonicalPath);
    return !existsSync(path) || readFileSync(path, 'utf8') !== content;
  });
}

function archive(dataRepo, instance, records, apply) {
  const candidates = archiveCandidates(records);
  if (!apply) {
    console.log(candidates.length ? candidates.map(item => repositoryPath(instance, item.path)).join('\n') : 'no accepted tasks ready to archive');
    return;
  }
  const moves = candidates.map(item => {
    const year = item.data.completed_at.slice(0, 4);
    const source = repositoryPath(instance, item.path);
    const target = repositoryPath(instance, `tracker/items/archive/${year}/${item.data.id}.md`);
    return { item, source, target };
  });
  for (const { target } of moves) if (existsSync(join(dataRepo, target))) throw new Error(`archive target exists: ${target}`);
  for (const { source, target } of moves) {
    const targetPath = join(dataRepo, target);
    mkdirSync(dirname(targetPath), { recursive: true });
    renameSync(join(dataRepo, source), targetPath);
  }
  console.log(`archived ${moves.length} tasks; run build to refresh views`);
}

function printDigest(id, records) {
  const plan = records.plans.find(record => record.data.id === id);
  if (plan) {
    const milestones = records.milestones.filter(record => record.data.plan_id === id);
    console.log(`plan ${id} approval_digest ${milestonePlanApprovalDigest(plan, milestones)}`);
    return;
  }
  const item = records.items.find(record => record.data.id === id);
  if (!item) throw new Error(`unknown plan or item: ${id}`);
  if (isAccepted(item)) console.log(`item ${id} accepted_task_digest ${acceptedTaskDigest(item)}`);
  else console.log(`item ${id} task_approval_digest ${taskApprovalDigest(item)}`);
}

/** Run one explicit-boundary tracker command. */
export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const source = loadSource(options);
  if (options.command === 'validate-only') {
    console.log('tracker source valid');
    return;
  }
  if (options.command === 'build') {
    writeViews(resolve(options.out), source.instance, renderViews(source.records));
    console.log('tracker views updated');
    return;
  }
  if (options.command === 'check') {
    if (options.out !== null) {
      const stale = staleViews(resolve(options.out), source.instance, renderViews(source.records));
      if (stale.length) {
        for (const [path] of stale) console.error(`${outputPath(resolve(options.out), source.instance, path)}: stale or missing; run tracker build`);
        process.exitCode = 1;
        return;
      }
    }
    console.log('tracker records and source valid');
    return;
  }
  if (options.command === 'archive') {
    archive(source.dataRepo, source.instance, source.records, options.apply);
    return;
  }
  printDigest(options.id, source.records);
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  try {
    run();
  } catch (error) {
    if (error instanceof DataSourceError && error.issues.length) {
      for (const issue of error.issues) console.error(issue);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
