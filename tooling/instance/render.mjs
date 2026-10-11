/**
 * Render the small, site-specific boundary around the shared tracker engine.
 *
 * The output root has two distinct surfaces.  `assets/` is served to a
 * browser and therefore contains only the public projection and static
 * assets.  The files beside it are deployment inputs and may contain the
 * validated runtime policy needed by the Worker.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInstanceConfig, publicInstanceConfig } from './config.mjs';

const FORMAT_VERSION = 1;
const TEMPLATE_PATH = fileURLToPath(new URL('./viewer-shell.html', import.meta.url));
const AVATAR_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/iu;

/**
 * Escape JSON for an inline script.  JSON.stringify is not sufficient for an
 * HTML script element because a user-controlled value could contain
 * `</script>`.
 *
 * @param {unknown} value
 */
export function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** @param {string} value */
function htmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** @param {string} value */
function digestFile(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} path @param {string} label */
function requireDirectory(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new TypeError(`${label}: must be a directory`);
  return resolve(path);
}

/** @param {string} root @param {string} candidate @param {string} label */
function safeAssetPath(root, candidate, label) {
  const assetsRoot = resolve(root, 'assets');
  const absolute = resolve(root, candidate);
  const contained = absolute === assetsRoot || relative(assetsRoot, absolute).split(/[\\/]/u)[0] !== '..';
  if (!contained || absolute === assetsRoot) throw new Error(`${label}: asset must remain inside the assets directory`);
  const assetsStat = lstatSync(assetsRoot);
  if (assetsStat.isSymbolicLink() || !assetsStat.isDirectory()) {
    throw new Error(`${label}: assets directory must be a real directory`);
  }
  const settingsRootReal = realpathSync(root);
  const assetsRootReal = realpathSync(assetsRoot);
  const assetsContained = assetsRootReal === settingsRootReal
    || relative(settingsRootReal, assetsRootReal).split(/[\\/]/u)[0] !== '..';
  if (!assetsContained) throw new Error(`${label}: assets directory escapes the settings directory`);
  const sourceReal = realpathSync(absolute);
  if (sourceReal !== assetsRootReal && !sourceReal.startsWith(`${assetsRootReal}/`)) {
    throw new Error(`${label}: asset escapes the assets directory`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || (stat.mode & 0o111) !== 0) throw new Error(`${label}: asset must be a non-executable regular file`);
  return absolute;
}

function avatarAssets(root, allowlist = null) {
  if (!(allowlist instanceof Set) || allowlist.size === 0) return [];
  const directory = join(root, 'assets', 'avatars');
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) throw new Error('assets/avatars is required by the safe team companion');
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('assets/avatars must be a real directory');
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const name of allowlist) if (!entries.some(entry => entry.name === name)) throw new Error(`safe team companion avatar is missing: ${name}`);
  return entries.sort((left, right) => left.name.localeCompare(right.name)).filter(entry => allowlist.has(entry.name)).map(entry => {
    if (!entry.isFile() || entry.isSymbolicLink() || !AVATAR_ASSET.test(entry.name)) throw new Error(`avatar asset is not an approved local image: ${entry.name}`);
    const source = safeAssetPath(root, `assets/avatars/${entry.name}`, `assets/avatars/${entry.name}`);
    return { name: entry.name, source };
  });
}

/** @param {Record<string, unknown>} provenance */
function manifestProvenance(provenance) {
  const source = provenance && typeof provenance === 'object' ? provenance : {};
  const engineCommit = typeof source.engineCommit === 'string' && source.engineCommit ? source.engineCommit : 'unknown';
  const dataCommit = typeof source.dataCommit === 'string' && source.dataCommit
    ? source.dataCommit
    : typeof source.sourceCommit === 'string' && source.sourceCommit ? source.sourceCommit : 'unknown';
  const settingsDigest = typeof source.settingsDigest === 'string' && source.settingsDigest
    ? source.settingsDigest
    : typeof source.configDigest === 'string' && source.configDigest ? source.configDigest : null;
  const inputFingerprint = typeof source.inputFingerprint === 'string' && source.inputFingerprint ? source.inputFingerprint : null;
  const engineSourceDigest = typeof source.engineSourceDigest === 'string' && source.engineSourceDigest ? source.engineSourceDigest : null;
  return {
    formatVersion: FORMAT_VERSION,
    engine: {
      commit: engineCommit,
      dirty: source.engineDirty === true,
      sourceDigest: engineSourceDigest,
    },
    data: {
      commit: dataCommit,
      dirty: source.dataDirty === true,
    },
    source: { commit: dataCommit },
    settings: { digest: settingsDigest },
    inputFingerprint,
  };
}

/** @param {string} template @param {Readonly<Record<string, string>>} replacements */
function applyTemplate(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) output = output.replaceAll(`__${key}__`, value);
  if (/__(?:TRACKER_DESCRIPTION|TRACKER_TITLE|TRACKER_PUBLIC_INSTANCE_JSON)__/u.test(output)) {
    throw new Error('viewer shell contains an unresolved placeholder');
  }
  return output;
}

/** @param {string} path @param {string} value */
function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

/** @param {string} directory @param {string[]} files */
function artifactHashes(directory, files) {
  return Object.fromEntries(files.map(file => [file, digestFile(readFileSync(join(directory, file)))]));
}

/**
 * Render instance-specific deployment and browser artifacts atomically.
 *
 * @param {{
 *   instance: Readonly<object>,
 *   manifestDir: string,
 *   engineRoot: string,
 *   output: string,
 *   provenance?: Record<string, unknown>,
 * }} options
 */
export function renderInstanceArtifacts({ instance, manifestDir, engineRoot, output, provenance = {} }) {
  const parsed = parseInstanceConfig(instance);
  if (typeof manifestDir !== 'string' || manifestDir.length === 0) throw new TypeError('manifestDir: must be a directory path');
  if (typeof engineRoot !== 'string' || engineRoot.length === 0) throw new TypeError('engineRoot: must be a directory path');
  if (typeof output !== 'string' || output.length === 0) throw new TypeError('output: must be a directory path');
  const settingsRoot = requireDirectory(manifestDir, 'manifestDir');
  const engine = requireDirectory(engineRoot, 'engineRoot');
  const outputPath = resolve(output);
  if (isAbsolute(output) === false && outputPath === '') throw new TypeError('output: invalid path');

  const sourceFavicon = safeAssetPath(settingsRoot, parsed.branding.faviconPath, 'settings.branding.faviconPath');
  const provenanceRecord = provenance && typeof provenance === 'object' ? provenance : {};
  const avatarNames = Array.isArray(provenanceRecord.avatarNames) ? new Set(provenanceRecord.avatarNames) : null;
  const avatars = avatarAssets(settingsRoot, avatarNames);
  const publicConfig = publicInstanceConfig(parsed);
  const publicJson = safeJsonForHtml(publicConfig);
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const shell = applyTemplate(template, {
    TRACKER_DESCRIPTION: htmlText(parsed.branding.description),
    TRACKER_TITLE: htmlText(parsed.branding.title),
    TRACKER_PUBLIC_INSTANCE_JSON: publicJson,
  });

  const runtimeInstance = safeJsonForHtml(parsed);
  const runtimeConfig = [
    '// Generated from the explicit site settings file. This file is not served as an asset.',
    `export const instance = Object.freeze(${runtimeInstance});`,
    'export default Object.freeze({ instance });',
    '',
  ].join('\n');
  const engineWorkerPath = join(engine, 'worker', 'access-gate.mjs');
  const relativeEngineWorker = relative(outputPath, engineWorkerPath).split('\\').join('/');
  if (isAbsolute(relativeEngineWorker)) throw new Error('engine worker must be reachable from the output root');
  const engineWorker = relativeEngineWorker.startsWith('.') ? relativeEngineWorker : `./${relativeEngineWorker}`;
  const workerEntry = [
    '// Generated Worker entry. The engine is deliberately resolved from the selected engine root.',
    `import { createTrackerWorker } from ${JSON.stringify(engineWorker)};`,
    "import { instance } from './runtime-config.mjs';",
    '',
    'export default createTrackerWorker(instance);',
    '',
  ].join('\n');

  const wrangler = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: parsed.deployment.workerName,
    main: './worker-entry.mjs',
    compatibility_date: parsed.deployment.compatibilityDate,
    compatibility_flags: [...parsed.deployment.compatibilityFlags],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: parsed.deployment.customDomain, custom_domain: true }],
    assets: {
      directory: './assets',
      binding: 'ASSETS',
      run_worker_first: true,
    },
  };
  if (parsed.deployment.accountBinding !== 'unconfigured') wrangler.account_id = parsed.deployment.accountBinding;

  const manifestBase = manifestProvenance(provenance);
  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${outputPath.split('/').at(-1)}.next-${process.pid}-${Date.now()}`);
  let backup = null;
  try {
    mkdirSync(join(stage, 'assets'), { recursive: true });
    writeText(join(stage, 'assets/index.html'), shell);
    copyFileSync(sourceFavicon, join(stage, 'assets/favicon.svg'));
    if (avatars.length) mkdirSync(join(stage, 'assets', 'avatars'), { recursive: true });
    for (const avatar of avatars) copyFileSync(avatar.source, join(stage, 'assets', 'avatars', avatar.name));
    writeText(join(stage, 'runtime-config.mjs'), runtimeConfig);
    writeText(join(stage, 'worker-entry.mjs'), workerEntry);
    writeText(join(stage, 'wrangler.json'), `${JSON.stringify(wrangler, null, 2)}\n`);

    // A snapshot builder may provide the data payload through provenance. The
    // renderer accepts it for the standalone renderer contract while leaving
    // bundling/data-model concerns to the build entrypoint.
    if (Object.hasOwn(provenanceRecord, 'data')) {
      writeText(join(stage, 'assets/data.json'), `${JSON.stringify(provenanceRecord.data, null, 2)}\n`);
    }
    if (parsed.features.weeklyPlanning && Object.hasOwn(provenanceRecord, 'planningArchive')) {
      writeText(join(stage, 'assets/planning/archive.json'), `${JSON.stringify(provenanceRecord.planningArchive, null, 2)}\n`);
    }

    const generatedFiles = [
      'assets/index.html', 'assets/favicon.svg', 'runtime-config.mjs',
      'worker-entry.mjs', 'wrangler.json',
    ];
    for (const avatar of avatars) generatedFiles.push(`assets/avatars/${avatar.name}`);
    if (existsSync(join(stage, 'assets/data.json'))) generatedFiles.push('assets/data.json');
    if (existsSync(join(stage, 'assets/planning/archive.json'))) generatedFiles.push('assets/planning/archive.json');
    const manifest = {
      ...manifestBase,
      artifactHashes: artifactHashes(stage, generatedFiles),
    };
    writeText(join(stage, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    if (existsSync(outputPath)) {
      backup = `${outputPath}.previous-${process.pid}-${Date.now()}`;
      renameSync(outputPath, backup);
    }
    renameSync(stage, outputPath);
    if (backup) rmSync(backup, { recursive: true, force: true });
    return {
      output: outputPath,
      publicInstance: publicConfig,
      manifest,
      files: generatedFiles.map(file => join(outputPath, file)),
    };
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (backup && !existsSync(outputPath) && existsSync(backup)) renameSync(backup, outputPath);
    throw error;
  }
}
