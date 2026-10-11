import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInstanceConfig, publicInstanceConfig } from '../../../tooling/instance/config.mjs';
import { renderInstanceArtifacts } from '../../../tooling/instance/render.mjs';
import { repositoryPath, selectedDataPaths } from '../../../tooling/instance/paths.mjs';
import { DataSourceError, SOURCE_READ_LIMITS, validateDataSource } from '../../../tooling/tracker/source-validation.mjs';
import { emptyPlanningArchive, loadPlanningArchive } from '../../../tooling/planning/archive.mjs';
import { readTeamProjection } from '../../../tooling/team-projection/reader.mjs';
import { readTeamCompanion } from '../../../tooling/team-projection/companion.mjs';
import { buildTeamProjectionSnapshot } from '../../../tooling/team-projection/snapshot.mjs';
import { buildTeamProjectionPlanningArchive } from '../../../tooling/team-projection/presentation.mjs';
import { buildTrackerData, parseOwnerNames } from './data.mjs';

const TOOLING_DIR = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = resolve(TOOLING_DIR, '..');
const RUNNING_ENGINE_ROOT = resolve(TOOLING_DIR, '../../..');
const RUNNING_ENGINE_REAL = realpathSync(RUNNING_ENGINE_ROOT);
const ENGINE_DIGEST_PATHS = Object.freeze([
  'package.json', 'bun.lock', 'patches', 'tsconfig.json',
  'tooling/instance', 'tooling/tracker', 'worker',
  'tooling/team-projection',
  'tracker/viewer/src', 'tracker/viewer/tooling', 'tracker/viewer/tsconfig.json',
  'tracker/viewer/tsr.config.json',
]);

export class TrackerValidationError extends DataSourceError {
  constructor(error) {
    const issues = error instanceof DataSourceError ? error.issues : [];
    super(error instanceof Error ? error.message : String(error), {
      code: error instanceof DataSourceError ? error.code : 'validation-failed',
      status: error instanceof DataSourceError ? error.status : 409,
      issues,
    });
    this.name = 'TrackerValidationError';
  }
}

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

function regularFile(path, label, { allowSymlink = false } = {}) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || (!allowSymlink && stat.isSymbolicLink())) {
    throw new Error(`${label}: must be a regular file`);
  }
  if ((stat.mode & 0o111) !== 0) throw new Error(`${label}: must not be executable`);
  return stat;
}

function directory(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new Error(`${label}: must be a directory`);
  return realPath(path);
}

function contained(parent, child) {
  const relativePath = relative(parent, child);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function outputPhysicalPath(path) {
  const absolute = resolve(path);
  const existing = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const next = dirname(cursor);
    if (next === cursor) break;
    existing.push(cursor.slice(next.length + 1));
    cursor = next;
  }
  const root = realPath(cursor);
  return existing.reverse().reduce((current, segment) => join(current, segment), root);
}

function assertOutputBoundary(outputPath, inputs) {
  const existing = lstatSync(outputPath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error('output: symlink destinations are not allowed');
  if (existing && !existing.isDirectory()) throw new Error('output: must be a directory when it already exists');
  const physicalOutput = outputPhysicalPath(outputPath);
  for (const [label, input] of inputs) {
    const physicalInput = realPath(input);
    if (contained(physicalInput, physicalOutput) || contained(physicalOutput, physicalInput)) {
      throw new Error(`output overlaps ${label}`);
    }
  }
}

const GIT_DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_SAFETY_FILE_LIMIT = 1024 * 1024;

class GitSafetyError extends Error {
  constructor() {
    super('git metadata configuration is not inert');
    this.name = 'GitSafetyError';
  }
}

function gitEnvironment() {
  // Repository-provided and ambient GIT_* values can redirect the object,
  // index, config, transport, or helper process used by a provenance read.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: GIT_DEV_NULL,
    GIT_CONFIG_GLOBAL: GIT_DEV_NULL,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}

function gitCommand(root, args) {
  return execFileSync('git', [
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.fsmonitorHookVersion=',
    '-c', `core.hooksPath=${GIT_DEV_NULL}`,
    '-c', 'core.untrackedCache=false',
    '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'protocol.file.allow=never',
    '-C', root,
    ...args,
  ], {
    encoding: 'utf8',
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitDirectoryFromWorktree(root) {
  const dotGit = join(root, '.git');
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GIT_SAFETY_FILE_LIMIT) throw new GitSafetyError();
  const pointer = readFileSync(dotGit, 'utf8').match(/^\s*gitdir:\s*(.+?)\s*$/imu);
  if (!pointer) throw new GitSafetyError();
  return resolve(root, pointer[1]);
}

function gitDirectoriesForGitDirectory(gitDirectory) {
  const directories = [gitDirectory];
  const commonDirPath = join(gitDirectory, 'commondir');
  const commonStat = lstatSync(commonDirPath, { throwIfNoEntry: false });
  if (commonStat) {
    if (!commonStat.isFile() || commonStat.isSymbolicLink() || commonStat.size > GIT_SAFETY_FILE_LIMIT) throw new GitSafetyError();
    const commonDirectory = readFileSync(commonDirPath, 'utf8').trim();
    if (!commonDirectory) throw new GitSafetyError();
    directories.push(resolve(gitDirectory, commonDirectory));
  }
  return [...new Set(directories)];
}

function gitDirectories(root) {
  const gitDirectory = gitDirectoryFromWorktree(root);
  return gitDirectory ? gitDirectoriesForGitDirectory(gitDirectory) : [];
}

function gitConfigPaths(root) {
  let directories = gitDirectories(root);
  if (directories.length === 0) {
    try {
      const discovered = gitCommand(root, ['rev-parse', '--git-dir']).trim();
      if (discovered) directories = gitDirectoriesForGitDirectory(resolve(root, discovered));
    } catch (error) {
      if (error instanceof GitSafetyError) throw error;
      return [];
    }
  }
  return [...new Set(directories.flatMap(directory => [
    join(directory, 'config'),
    join(directory, 'config.worktree'),
  ]))];
}

function assertGitSafetyFile(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GIT_SAFETY_FILE_LIMIT) throw new GitSafetyError();
  return true;
}

function unsafeGitConfigKey(key) {
  const normalized = key.toLowerCase();
  return normalized.startsWith('filter.')
    || normalized.startsWith('include.')
    || normalized.startsWith('includeif.')
    || normalized.startsWith('submodule.')
    || normalized === 'core.fsmonitor'
    || normalized === 'core.fsmonitorhookversion'
    || normalized === 'core.attributesfile'
    || normalized === 'core.excludesfile'
    || normalized === 'extensions.partialclone'
    || (normalized.startsWith('remote.') && (normalized.endsWith('.promisor') || normalized.endsWith('.partialclonefilter')));
}

function assertGitReadSafety(root) {
  const configPaths = gitConfigPaths(root);
  for (const configPath of configPaths) {
    if (!assertGitSafetyFile(configPath)) continue;
    let keys;
    try {
      // Ask Git to parse the local file, but disable includes and request only
      // key names. Values and included files never enter this process.
      keys = gitCommand(root, [
        'config', '--no-includes', '--file', configPath, '--null', '--name-only', '--list',
      ]).split('\0').filter(Boolean);
    } catch {
      throw new GitSafetyError();
    }
    if (keys.some(unsafeGitConfigKey)) throw new GitSafetyError();
  }
}

function runGit(root, args) {
  try {
    assertGitReadSafety(root);
    return gitCommand(root, args).trim();
  } catch (error) {
    if (error instanceof GitSafetyError) throw error;
    return null;
  }
}

function engineGitMetadata(engineRoot) {
  const gitTop = runGit(engineRoot, ['rev-parse', '--show-toplevel']);
  if (!gitTop) return { commit: 'unknown', dirty: true, sourceDigest: null };
  const gitRoot = realPath(gitTop);
  const scope = relative(gitRoot, engineRoot).split(sep).join('/');
  if (scope === '..' || scope.startsWith('../') || isAbsolute(scope)) {
    return { commit: 'unknown', dirty: true, sourceDigest: null };
  }
  // Commands run with -C engineRoot, so paths are relative to the selected
  // engine subtree rather than the containing controller checkout.
  const tracked = runGit(engineRoot, ['ls-files', '--', '.']);
  const commit = tracked ? runGit(engineRoot, ['rev-parse', 'HEAD']) || 'unknown' : 'unknown';
  const status = runGit(engineRoot, ['status', '--porcelain', '--ignore-submodules=all', '--', '.']);
  const dirty = status === null || Boolean(status) || commit === 'unknown';
  const sourceDigest = digestEngineSource(engineRoot);
  return { commit, dirty, sourceDigest };
}

function dataGitMetadata(dataRepo) {
  const gitTop = runGit(dataRepo, ['rev-parse', '--show-toplevel']);
  if (!gitTop || realPath(gitTop) !== realPath(dataRepo)) {
    // A containing engine/controller checkout is not the data repository.
    // Never expose that checkout's SHA as data provenance.
    return { commit: 'unknown', dirty: true };
  }
  const commit = runGit(dataRepo, ['rev-parse', 'HEAD']) || 'unknown';
  const status = runGit(dataRepo, ['status', '--porcelain', '--ignore-submodules=all', '--', '.']);
  return {
    commit,
    dirty: commit === 'unknown' || status === null || Boolean(status),
  };
}

function walkFiles(root, current, output) {
  const absolute = join(root, current);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`engine source symlink is not allowed: ${current}`);
  if (stat.isFile()) {
    // Executable mode is metadata, not evidence that a source file is
    // unreferenced. A checked-in executable script can be imported by the
    // build, so include every regular source file in the digest.
    output.push(current.split(sep).join('/'));
    return;
  }
  if (!stat.isDirectory()) throw new Error(`engine source is not a regular file or directory: ${current}`);
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    walkFiles(root, join(current, entry.name), output);
  }
}

function digestEngineSource(engineRoot) {
  const files = [];
  for (const candidate of ENGINE_DIGEST_PATHS) walkFiles(engineRoot, candidate, files);
  const hash = createHash('sha256');
  for (const path of [...new Set(files)].sort()) {
    const bytes = readFileSync(join(engineRoot, path));
    hash.update(path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

function assertRunningEngine(engineRoot) {
  const selected = realPath(requireText(engineRoot, 'engineRoot'));
  if (selected !== RUNNING_ENGINE_REAL) {
    throw new Error(`engineRoot must identify the running tracker engine (${RUNNING_ENGINE_REAL})`);
  }
  directory(selected, 'engineRoot');
  return selected;
}

function assertSettingsBoundary(settingsPath, dataRepo, instance, manifestDir) {
  regularFile(settingsPath, 'settings');
  const dataRoot = realPath(dataRepo);
  const manifestReal = realPath(manifestDir);
  const selectedFolder = realPath(join(dataRoot, repositoryPath(instance, '')));
  if (!contained(dataRoot, manifestReal) || manifestReal !== selectedFolder) {
    throw new Error('settings must be inside the selected data folder');
  }
  const settingsReal = realPath(settingsPath);
  if (!contained(selectedFolder, settingsReal)) throw new Error('settings escapes the selected data folder');
}

function brandingAssetPath({ manifestDir, instance }) {
  const asset = resolve(manifestDir, ...instance.branding.faviconPath.split('/'));
  const root = realPath(manifestDir);
  const physical = realPath(asset);
  if (!contained(root, physical)) throw new Error('branding asset escapes the settings folder');
  regularFile(asset, 'branding asset');
  return asset;
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Acquire all selected data roles once. The returned map is the sole source
 * used for validation, model projection, and the build fingerprint. A later
 * boundary check detects edits made while the bundle is being produced.
 */
function captureDataFiles(dataRepo, instance) {
  const selections = selectedDataPaths({ dataRepo, instance });
  if (selections.length === 0 || selections.length > SOURCE_READ_LIMITS.maxFiles) {
    throw new DataSourceError('The candidate tracker source is outside the supported file-count limit.', {
      code: 'validation-failed',
      status: 409,
    });
  }
  const files = new Map();
  const snapshots = [];
  let totalBytes = 0;
  for (const selection of selections) {
    const path = join(dataRepo, selection.repositoryPath);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) {
      throw new DataSourceError(`Candidate tracker source is not a regular file: ${selection.canonicalPath}.`, {
        code: 'validation-failed',
        status: 409,
      });
    }
    if (stat.size > SOURCE_READ_LIMITS.maxFileBytes || totalBytes + stat.size > SOURCE_READ_LIMITS.maxTotalBytes) {
      throw new DataSourceError('Candidate tracker source exceeds the configured read limit.', {
        code: 'validation-failed',
        status: 409,
      });
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength > SOURCE_READ_LIMITS.maxFileBytes || totalBytes + bytes.byteLength > SOURCE_READ_LIMITS.maxTotalBytes) {
      throw new DataSourceError('Candidate tracker source changed beyond the configured read limit.', {
        code: 'validation-failed',
        status: 409,
      });
    }
    totalBytes += bytes.byteLength;
    files.set(selection.canonicalPath, bytes.toString('utf8'));
    snapshots.push({
      role: selection.role,
      canonicalPath: selection.canonicalPath,
      repositoryPath: selection.repositoryPath,
      digest: digestBytes(bytes),
    });
  }
  return { files, snapshots };
}

function loadTeamProjectionInputs({ engine, data, settingsPath, outputPath, loaded, assetPath, assetDigest }) {
  const instance = loaded.instance;
  const selectedRootPath = join(data, repositoryPath(instance, ''));
  const selectedRootStat = lstatSync(selectedRootPath, { throwIfNoEntry: false });
  if (!selectedRootStat || !selectedRootStat.isDirectory() || selectedRootStat.isSymbolicLink()) {
    throw new Error('team projection data folder must be a real directory');
  }
  const selectedRoot = realPath(selectedRootPath);
  if (!contained(realPath(data), selectedRoot)) throw new Error('team projection data folder escapes dataRepo');
  const selectedProjection = readTeamProjection({
    dataRoot: selectedRoot,
    projectionPath: instance.data.projectionPath,
    linkPolicy: instance.data.projectionLinkPolicy,
  });
  const companion = readTeamCompanion({
    dataRoot: selectedRoot,
    companionPath: instance.data.companionPath,
    projection: selectedProjection.rawProjection,
  });
  const dataMeta = dataGitMetadata(data);
  const engineMeta = engineGitMetadata(engine);
  return {
    engineRoot: engine,
    dataRepo: data,
    instancePath: settingsPath,
    manifestDir: loaded.manifestDir,
    configDigest: loaded.configDigest,
    assetPath,
    instance,
    files: new Map([
      [instance.data.projectionPath, ''],
      ...(instance.data.companionPath ? [[instance.data.companionPath, '']] : []),
    ]),
    records: null,
    validated: { records: null, registry: null, guide: '', teamProfiles: [] },
    projection: selectedProjection.projection,
    projectionDigest: selectedProjection.digest,
    projectionBytes: selectedProjection.bytes,
    companion,
    planningArchive: instance.features.weeklyPlanning
      ? buildTeamProjectionPlanningArchive(selectedProjection.projection)
      : emptyPlanningArchive(),
    planningSnapshots: [],
    planningPresent: false,
    dataSnapshots: [{
      role: 'team-projection',
      canonicalPath: instance.data.projectionPath,
      repositoryPath: repositoryPath(instance, instance.data.projectionPath),
      digest: selectedProjection.digest,
    }, ...(companion ? [{
      role: 'team-companion',
      canonicalPath: instance.data.companionPath,
      repositoryPath: repositoryPath(instance, instance.data.companionPath),
      digest: companion.fileDigest,
    }] : [])],
    settingsDigest: loaded.configDigest,
    assetDigest,
    dataMeta,
    engineMeta,
    outputPath,
  };
}

function loadBuildInputs({ engineRoot, instancePath, dataRepo, output } = {}, { requireOutput = true } = {}) {
  const engine = assertRunningEngine(engineRoot);
  const data = directory(requireText(dataRepo, 'dataRepo'), 'dataRepo');
  if (engine === data || contained(engine, data) || contained(data, engine)) {
    throw new Error('engineRoot and dataRepo must be separate repositories');
  }
  const settingsPath = resolve(requireText(instancePath, 'instancePath'));
  // Reject an external or aliased settings file before parsing any settings
  // content. The selected folder check below remains authoritative after the
  // instance's folderPath has been read.
  regularFile(settingsPath, 'settings');
  if (!contained(data, realPath(settingsPath))) throw new Error('settings must be physically contained in dataRepo');
  const loaded = loadInstanceConfig({ path: settingsPath });
  const settingsBytes = readFileSync(settingsPath);
  if (digestBytes(settingsBytes) !== loaded.configDigest) throw new Error('settings changed while being read');
  assertSettingsBoundary(settingsPath, data, loaded.instance, loaded.manifestDir);
  const assetPath = brandingAssetPath(loaded);
  const assetBytes = readFileSync(assetPath);
  const assetDigest = digestBytes(assetBytes);
  const outputPath = requireOutput ? resolve(requireText(output, 'output')) : null;
  if (outputPath) assertOutputBoundary(outputPath, [
    ['engineRoot', engine],
    ['dataRepo', data],
    ['settings', settingsPath],
    ['branding asset', assetPath],
  ]);

  if (loaded.instance.data.layout === 'team-projection-v1') {
    return loadTeamProjectionInputs({ engine, data, settingsPath, outputPath, loaded, assetPath, assetDigest });
  }

  let captured;
  try {
    captured = captureDataFiles(data, loaded.instance);
  } catch (error) {
    if (error instanceof DataSourceError) throw new TrackerValidationError(error);
    throw error;
  }
  const files = captured.files;
  let validated;
  try {
    validated = validateDataSource({ files, instance: loaded.instance });
  } catch (error) {
    if (error instanceof DataSourceError) throw new TrackerValidationError(error);
    throw error;
  }
  const dataMeta = dataGitMetadata(data);
  const engineMeta = engineGitMetadata(engine);
  const planning = loaded.instance.features.weeklyPlanning
    ? loadPlanningArchive({ dataRoot: data, instance: loaded.instance })
    : { archive: emptyPlanningArchive(), snapshots: [], present: false };
  if (loaded.instance.data.folderPath && !contained(data, realPath(loaded.manifestDir))) {
    throw new Error('selected settings folder escapes dataRepo');
  }
  return {
    engineRoot: engine,
    dataRepo: data,
    instancePath: settingsPath,
    manifestDir: loaded.manifestDir,
    configDigest: loaded.configDigest,
    assetPath,
    instance: loaded.instance,
    files,
    records: validated.records,
    validated,
    planningArchive: planning.archive,
    planningSnapshots: planning.snapshots,
    planningPresent: planning.present,
    dataSnapshots: captured.snapshots,
    settingsDigest: loaded.configDigest,
    assetDigest,
    dataMeta,
    engineMeta,
  };
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inputFingerprint(inputs) {
  const selected = inputs.dataSnapshots.map(selection => ({
    role: selection.role,
    path: selection.canonicalPath,
    digest: selection.digest,
  }));
  const fingerprintInput = {
    engine: {
      commit: inputs.engineMeta.commit,
      sourceDigest: inputs.engineMeta.sourceDigest,
    },
    settings: inputs.configDigest,
    branding: {
      path: inputs.instance.branding.faviconPath,
      digest: inputs.assetDigest,
    },
    data: selected,
    planning: inputs.planningSnapshots.map(selection => ({
      path: selection.path,
      digest: selection.digest,
    })),
  };
  return digestText(JSON.stringify(fingerprintInput));
}

function assertBuildInputsUnchanged(inputs) {
  if (inputs.instance.data.layout === 'team-projection-v1') {
    const selectedRoot = realPath(join(inputs.dataRepo, repositoryPath(inputs.instance, '')));
    const currentProjection = readTeamProjection({
      dataRoot: selectedRoot,
      projectionPath: inputs.instance.data.projectionPath,
      linkPolicy: inputs.instance.data.projectionLinkPolicy,
    });
    if (currentProjection.digest !== inputs.projectionDigest) throw new Error('team projection input changed during build');
    if (inputs.instance.data.companionPath) {
      const currentCompanion = readTeamCompanion({
        dataRoot: selectedRoot,
        companionPath: inputs.instance.data.companionPath,
        projection: currentProjection.rawProjection,
      });
      if (!currentCompanion || currentCompanion.fileDigest !== inputs.companion?.fileDigest) {
        throw new Error('team companion input changed during build');
      }
    }
    if (digestBytes(readFileSync(inputs.instancePath)) !== inputs.settingsDigest) {
      throw new Error('settings changed during build');
    }
    if (digestBytes(readFileSync(inputs.assetPath)) !== inputs.assetDigest) {
      throw new Error('branding asset changed during build');
    }
    if (digestEngineSource(inputs.engineRoot) !== inputs.engineMeta.sourceDigest) {
      throw new Error('engine source changed during build');
    }
    return;
  }
  const currentSelections = selectedDataPaths({ dataRepo: inputs.dataRepo, instance: inputs.instance });
  if (currentSelections.length !== inputs.dataSnapshots.length) {
    throw new Error('data inputs changed during build');
  }
  let totalBytes = 0;
  for (const [index, current] of currentSelections.entries()) {
    const captured = inputs.dataSnapshots[index];
    const path = join(inputs.dataRepo, current.repositoryPath);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (
      !stat
      || !stat.isFile()
      || stat.isSymbolicLink()
      || (stat.mode & 0o111) !== 0
      || stat.size > SOURCE_READ_LIMITS.maxFileBytes
      || totalBytes + stat.size > SOURCE_READ_LIMITS.maxTotalBytes
    ) throw new Error('data inputs changed beyond the configured read limit');
    const bytes = readFileSync(path);
    if (bytes.byteLength > SOURCE_READ_LIMITS.maxFileBytes || totalBytes + bytes.byteLength > SOURCE_READ_LIMITS.maxTotalBytes) {
      throw new Error('data inputs changed beyond the configured read limit');
    }
    totalBytes += bytes.byteLength;
    if (
      current.role !== captured.role
      || current.canonicalPath !== captured.canonicalPath
      || current.repositoryPath !== captured.repositoryPath
      || digestBytes(bytes) !== captured.digest
    ) throw new Error('data inputs changed during build');
  }
  if (digestBytes(readFileSync(inputs.instancePath)) !== inputs.settingsDigest) {
    throw new Error('settings changed during build');
  }
  if (digestBytes(readFileSync(inputs.assetPath)) !== inputs.assetDigest) {
    throw new Error('branding asset changed during build');
  }
  if (digestEngineSource(inputs.engineRoot) !== inputs.engineMeta.sourceDigest) {
    throw new Error('engine source changed during build');
  }
  if (inputs.instance.features.weeklyPlanning) {
    const currentPlanning = loadPlanningArchive({ dataRoot: inputs.dataRepo, instance: inputs.instance });
    const capturedPlanning = inputs.planningSnapshots.map(({ path, digest }) => ({ path, digest }));
    const currentPlanningSnapshots = currentPlanning.snapshots.map(({ path, digest }) => ({ path, digest }));
    if (JSON.stringify(currentPlanningSnapshots) !== JSON.stringify(capturedPlanning)) {
      throw new Error('planning archive inputs changed during build');
    }
  }
}

function addContentRevision(data) {
  const canonicalContent = structuredClone(data);
  delete canonicalContent.source;
  const contentRevision = digestText(JSON.stringify(canonicalContent));
  return { ...data, source: { ...data.source, contentRevision } };
}

function runFrontendBuild(assetsPath, instance) {
  const bunBin = process.env.BUN_BIN || 'bun';
  const esbuildBin = fileURLToPath(import.meta.resolve('esbuild/bin/esbuild'));
  const entry = join(VIEWER_DIR, 'src', 'main.tsx');
  const workerEntry = join(VIEWER_DIR, 'src', 'livestore.worker.ts');
  const sharedWorkerEntry = fileURLToPath(import.meta.resolve('@livestore/adapter-web/shared-worker'));
  mkdirSync(assetsPath, { recursive: true });
  const publicConfig = JSON.stringify(publicInstanceConfig(instance));
  // Use the installed deterministic bundler for the production graph. Its
  // automatic JSX runtime is production mode unless --jsx-dev is requested.
  execFileSync(esbuildBin, [
    entry,
    workerEntry,
    sharedWorkerEntry,
    '--bundle',
    '--platform=browser',
    '--format=esm',
    `--outdir=${assetsPath}`,
    '--entry-names=[name]',
    '--jsx=automatic',
    '--define:process.env.NODE_ENV="production"',
    `--define:__TRACKER_PUBLIC_INSTANCE__=${publicConfig}`,
  ], {
    cwd: RUNNING_ENGINE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  const emittedApp = join(assetsPath, 'main.js');
  if (!existsSync(emittedApp)) throw new Error(`frontend bundle was not emitted: ${emittedApp}`);
  const emittedWorker = join(assetsPath, 'livestore.worker.js');
  if (!existsSync(emittedWorker)) throw new Error(`LiveStore worker bundle was not emitted: ${emittedWorker}`);
  const emittedSharedWorker = join(assetsPath, 'make-shared-worker.js');
  if (!existsSync(emittedSharedWorker)) throw new Error(`LiveStore shared worker bundle was not emitted: ${emittedSharedWorker}`);
  renameSync(emittedSharedWorker, join(assetsPath, 'livestore.shared-worker.js'));
  renameSync(emittedApp, join(assetsPath, 'app.js'));

  const sqliteWasm = fileURLToPath(import.meta.resolve('@livestore/wa-sqlite/dist/wa-sqlite.wasm'));
  regularFile(sqliteWasm, 'LiveStore SQLite WASM');
  copyFileSync(sqliteWasm, join(assetsPath, 'wa-sqlite.wasm'));

  const sourceStyles = join(VIEWER_DIR, 'src', 'styles.css');
  const styleOutput = join(assetsPath, 'styles.css');
  execFileSync(bunBin, ['x', 'tailwindcss', '-i', sourceStyles, '-o', styleOutput, '--minify'], {
    cwd: RUNNING_ENGINE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const bundledStyles = existsSync(join(assetsPath, 'main.css')) ? readFileSync(join(assetsPath, 'main.css'), 'utf8') : '';
  if (existsSync(join(assetsPath, 'main.css'))) rmSync(join(assetsPath, 'main.css'));
  const teamStyles = readFileSync(join(VIEWER_DIR, 'src', 'team.css'), 'utf8');
  writeFileSync(styleOutput, `${readFileSync(styleOutput, 'utf8')}\n${bundledStyles}\n${teamStyles}\n`);
}

function ensureGeneratedRoutes() {
  const routeTree = join(VIEWER_DIR, 'src', 'routeTree.gen.ts');
  if (existsSync(routeTree)) return;
  execFileSync('bun', ['x', 'tsr', 'generate'], {
    cwd: VIEWER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function walkArtifactFiles(root, current = '', files = []) {
  const directory = join(root, current);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = current ? `${current}/${entry.name}` : entry.name;
    const absolute = join(root, path);
    if (entry.isSymbolicLink()) throw new Error(`generated artifact symlink is not allowed: ${path}`);
    if (entry.isDirectory()) walkArtifactFiles(root, path, files);
    else if (entry.isFile() && path !== 'build-manifest.json') files.push(path);
    else if (!entry.isFile()) throw new Error(`generated artifact is not a regular file: ${path}`);
  }
  return files;
}

function artifactHashes(root) {
  return Object.fromEntries(walkArtifactFiles(root).sort().map(path => [
    path,
    createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
  ]));
}

function updateManifest(outputPath) {
  const manifestPath = join(outputPath, 'build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.artifactHashes = artifactHashes(outputPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function renderStagedOutput(inputs, outputPath, data, provenance) {
  renderInstanceArtifacts({
    instance: inputs.instance,
    manifestDir: inputs.manifestDir,
    engineRoot: inputs.engineRoot,
    output: outputPath,
    provenance: {
      ...provenance,
      data,
      avatarNames: inputs.companion?.directory?.map(entry => entry.avatar).filter(Boolean) ?? [],
      ...(inputs.instance.features.weeklyPlanning ? { planningArchive: inputs.planningArchive } : {}),
    },
  });
  runFrontendBuild(join(outputPath, 'assets'), inputs.instance);
  return updateManifest(outputPath);
}

function swapOutput(stage, outputPath) {
  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true });
  let backup = null;
  try {
    if (existsSync(outputPath)) {
      backup = `${outputPath}.previous-${process.pid}-${randomUUID()}`;
      renameSync(outputPath, backup);
    }
    renameSync(stage, outputPath);
    if (backup) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (backup && !existsSync(outputPath) && existsSync(backup)) renameSync(backup, outputPath);
    throw error;
  }
}

function stageAndSwap(inputs, outputPath, data, provenance) {
  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${outputPath.split('/').at(-1)}.next-${process.pid}-${randomUUID()}`);
  try {
    const manifest = renderStagedOutput(inputs, stage, data, provenance);
    // The snapshot map and its fingerprint were captured before rendering.
    // Check the same boundaries once more before the outer atomic swap so a
    // concurrent edit cannot be represented by bytes from a different input.
    assertBuildInputsUnchanged(inputs);
    swapOutput(stage, outputPath);
    return manifest;
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function validateEngineCommit(expected, actual) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || expected.length === 0) throw new TypeError('engineCommit: must be a non-empty commit SHA');
  if (actual === 'unknown' || expected !== actual) {
    throw new Error(`engineCommit does not match the actual engine provenance (${actual})`);
  }
}

export function buildSnapshot({ engineRoot, instancePath, dataRepo, output, builtAt = new Date().toISOString(), engineCommit } = {}) {
  assertRunningEngine(engineRoot);
  ensureGeneratedRoutes();
  const inputs = loadBuildInputs({ engineRoot, instancePath, dataRepo, output });
  validateEngineCommit(engineCommit, inputs.engineMeta.commit);
  const sourceMeta = {
    ...inputs.dataMeta,
    builtAt,
    projectionDigest: inputs.projectionDigest ?? null,
    approverIds: inputs.instance.model.approverIds,
    ownerNames: parseOwnerNames(inputs.validated.guide),
  };
  let data = inputs.instance.data.layout === 'team-projection-v1'
    ? buildTeamProjectionSnapshot(inputs.projection, sourceMeta, inputs.companion)
    : buildTrackerData(inputs.records, sourceMeta);
  if (inputs.instance.data.layout !== 'team-projection-v1') data.team = inputs.validated.teamProfiles;
  data = addContentRevision(data);
  const fingerprint = inputFingerprint(inputs);
  const provenance = {
    engineCommit: inputs.engineMeta.commit,
    engineDirty: inputs.engineMeta.dirty,
    engineSourceDigest: inputs.engineMeta.sourceDigest,
    dataCommit: inputs.dataMeta.commit,
    dataDirty: inputs.dataMeta.dirty,
    settingsDigest: inputs.configDigest,
    inputFingerprint: fingerprint,
  };
  const outputPath = resolve(output);
  const manifest = stageAndSwap(inputs, outputPath, data, provenance);
  return {
    data,
    output: outputPath,
    instance: inputs.instance,
    manifest,
    engineRoot: inputs.engineRoot,
    dataRepo: inputs.dataRepo,
    planningArchive: inputs.planningArchive,
    settings: inputs.instancePath,
  };
}

export function validateOnly({ engineRoot, instancePath, dataRepo, engineCommit } = {}) {
  const inputs = loadBuildInputs({ engineRoot, instancePath, dataRepo }, { requireOutput: false });
  validateEngineCommit(engineCommit, inputs.engineMeta.commit);
  return {
    instance: inputs.instance,
    records: inputs.records,
    projection: inputs.projection ?? null,
    registry: inputs.validated.registry,
    guide: inputs.validated.guide,
    teamProfiles: inputs.validated.teamProfiles,
    files: inputs.files,
    planningArchive: inputs.planningArchive,
    engineRoot: inputs.engineRoot,
    dataRepo: inputs.dataRepo,
    instancePath: inputs.instancePath,
    configDigest: inputs.configDigest,
    engine: inputs.engineMeta,
    data: inputs.dataMeta,
  };
}

export function formatValidationError(error) {
  if (error instanceof DataSourceError && error.issues.length) {
    return [error.message, ...error.issues.map(issue => `- ${issue}`)].join('\n');
  }
  return error?.stack ?? String(error);
}

function parseArgs(argv) {
  const options = { engineRoot: null, dataRepo: null, instancePath: null, output: null, engineCommit: undefined, builtAt: undefined, validateOnly: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--validate-only') options.validateOnly = true;
    else if (['--engine-root', '--data-root', '--settings', '--out', '--engine-commit', '--built-at'].includes(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--engine-root') options.engineRoot = value;
      else if (arg === '--data-root') options.dataRepo = value;
      else if (arg === '--settings') options.instancePath = value;
      else if (arg === '--out') options.output = value;
      else if (arg === '--engine-commit') options.engineCommit = value;
      else options.builtAt = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  requireText(options.engineRoot, 'engine-root');
  requireText(options.dataRepo, 'data-root');
  requireText(options.instancePath, 'settings');
  if (!options.validateOnly) requireText(options.output, 'out');
  return options;
}

function usage() {
  return [
    'Usage: bun tracker/viewer/tooling/build.mjs --engine-root ENGINE --data-root DATA_REPOSITORY --settings SETTINGS_JSON --out OUTPUT [--engine-commit SHA]',
    '       bun tracker/viewer/tooling/build.mjs --validate-only --engine-root ENGINE --data-root DATA_REPOSITORY --settings SETTINGS_JSON',
    '',
    'All repository roots and the output destination are explicit. The output is',
    'replaced atomically only after data validation, bundling, and artifact hashing succeed.',
  ].join('\n');
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else if (options.validateOnly) {
      validateOnly(options);
      console.log('tracker source valid');
    } else {
      const result = buildSnapshot(options);
      console.log(`tracker viewer built at ${result.output}`);
      console.log(`source commit ${result.data.source.shortCommit} · ${result.data.source.builtAt}`);
    }
  } catch (error) {
    console.error(formatValidationError(error));
    process.exitCode = 1;
  }
}
