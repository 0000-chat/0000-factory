import { decisionPath, workItemPath } from './navigation.ts';
import { trackerInstanceConfig } from './instance-config.ts';

function sourceReference(sourceCommit) {
  const candidate = String(sourceCommit ?? '').trim();
  return candidate && candidate !== 'unknown' ? candidate : trackerInstanceConfig.source.branch;
}

function sourceRepositoryBase(sourceCommit) {
  const { owner, repo, folderPath } = trackerInstanceConfig.source;
  const prefix = folderPath ? `/${folderPath.split('/').map(encodeURIComponent).join('/')}` : '';
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(sourceReference(sourceCommit))}${prefix}`;
}

export function sourceRepositoryUrl(path, sourceCommit = 'unknown') {
  const segments = String(path ?? '').split('/').filter(Boolean).map(encodeURIComponent);
  return `${sourceRepositoryBase(sourceCommit)}/${segments.join('/')}`;
}

/** Rewrite tracker Markdown references to the matching history API path. */
export function rewriteTeamTrackerLinks(value, items, sourceCommit = 'unknown', { allowRepositoryLinks = true } = {}) {
  const markdown = String(value ?? '');
  return markdown.replace(/\]\((\.?\/)?(tracker\/(?:items|decisions)\/[^)]+\.md)\)/g, (match, _prefix, path) => {
    const item = items.find(candidate => candidate.sourcePath === path);
    if (item) return `](${workItemPath(item.id)})`;
    const decisionId = /^tracker\/decisions\/([^/]+)\.md$/u.exec(path)?.[1];
    if (decisionId) return `](${decisionPath(decisionId)})`;
    return match;
  }).replace(/\]\((\.?\/)?(tracker\/(?:history|updates)\/[^)]+\.md)\)/g, (match, _prefix, path) => allowRepositoryLinks ? `](${sourceRepositoryUrl(path, sourceCommit)})` : match);
}
