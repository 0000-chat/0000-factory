import { isAccepted } from './view-model.mjs';
import { avatarAssetPath, resolvePerson } from './person-identity.ts';

function dateMillis(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

function plainText(value) {
  return String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)[#>*_`~]+/g, '$1')
    .replace(/[*_`~]+(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep the source wording for the compact directory row; CSS controls its visual length. */
export function compactText(value) {
  return plainText(value);
}

export function compactEvidenceSummary(activity) {
  if (!activity) return '';
  return compactText(activity.sections?.observation ?? activity.sections?.evidence);
}

function currentAccepted(item) {
  return isAccepted(item) && item?.completed !== true && !['done', 'completed', 'archived'].includes(String(item?.status ?? '').toLowerCase());
}

function blockersFor(item, { includeAtRisk = true } = {}) {
  const blockers = [
    item?.sections?.blocker,
    ...(Array.isArray(item?.blockers) ? item.blockers.map(blocker => blocker?.reason) : []),
    (item?.health?.state === 'blocked' || (includeAtRisk && item?.health?.state === 'at-risk')) ? item?.health?.reason : null,
  ].map(value => String(value ?? '').trim()).filter(Boolean);
  return [...new Set(blockers)];
}

function explicitlyBlocked(item) {
  const status = String(item?.status ?? '').trim().toLowerCase();
  const healthState = String(item?.health?.state ?? '').trim().toLowerCase();
  return status === 'blocked' || healthState === 'blocked' || blockersFor(item, { includeAtRisk: false }).length > 0;
}

function updateFor(item) {
  return (Array.isArray(item?.linked?.updates) ? item.linked.updates : [])
    .filter(update => dateMillis(update.observedAt) !== null)
    .map(update => ({ ...update, itemId: item.id, itemTitle: item.title, activityKind: 'tracker-update' }));
}

const SHARED_PROFILE_FIELDS = [
  'id',
  'slug',
  'name',
  'fullName',
  'aliases',
  'handle',
  'githubHandle',
  'githubUrl',
  'slackId',
  'slackUrl',
  'slackTitle',
  'avatar',
  'avatarUrl',
  'organization',
  'organizations',
  'organizationIds',
  'verifiedLabel',
  'status',
];

function pickSharedProfileFields(profile) {
  return Object.fromEntries(SHARED_PROFILE_FIELDS
    .filter(field => Object.hasOwn(profile, field))
    .map(field => [field, profile[field]]));
}

/** Remove manager-only profile and guide context from a shared team member. */
export function projectTeamProfile(profile, { teamProjection = false } = {}) {
  if (!teamProjection || profile === null || typeof profile !== 'object' || Array.isArray(profile)) return profile;
  return pickSharedProfileFields(profile);
}

function latestActivity(profile, ownedWork, { teamProjection = false } = {}) {
  const trackerUpdates = ownedWork.flatMap(updateFor);
  const guideUpdate = !teamProjection && profile.observedWork ? {
      id: `${profile.slug}-team-guide-observation`,
      title: 'Team guide observation',
      observedAt: profile.observedWorkAt,
      observedStart: profile.observedWorkStart,
      source: 'team.md',
      sections: { observation: profile.observedWork },
      links: profile.observedWorkLinks ?? [],
      activityKind: 'guide-observation',
    } : null;
  return [...trackerUpdates, ...(guideUpdate ? [guideUpdate] : [])]
    .filter(update => dateMillis(update.observedAt) !== null)
    .sort((left, right) => dateMillis(right.observedAt) - dateMillis(left.observedAt))[0] ?? null;
}

function guideAssignmentStage(profile, { teamProjection = false } = {}) {
  if (teamProjection) return null;
  const current = String(profile.current ?? '');
  if (!/\b(planned|draft|proposed|unaccepted|not accepted)\b/i.test(current)) return null;
  return /\b(active|accepted)\b[^.]{0,120}\bwork\b/i.test(current) ? 'mixed' : 'proposed';
}

function directoryRole(title) {
  const value = String(title ?? '').trim();
  if (!value) return null;
  const schedulePart = part => /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b|\b(?:PST|PHT|HST|GMT|UTC|NZST|NZDT|EST|EDT|CST|CDT|MST|MDT|IST|shift|time\s?zone|duty\s*:?)\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d+\s?(?:hours?|hrs?)\b/i.test(part);
  const role = value.split(/[|•]/).map(part => part.trim()).find(part => part && !schedulePart(part));
  return role ?? null;
}

function assignedProfile(item, profiles) {
  return resolvePerson(profiles, item?.owner ?? null, item?.ownerName ?? null);
}

/** Join the team guide roster to live accepted work and its linked evidence. */
export function buildTeamDirectory(profiles, items, { teamProjection = false } = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const profileList = (Array.isArray(profiles) ? profiles : [])
    .map(profile => projectTeamProfile(profile, { teamProjection }));
  const ownedByProfile = new Map(profileList.map(profile => [profile.id, []]));
  for (const item of allItems) {
    const profile = assignedProfile(item, profileList);
    if (profile) ownedByProfile.get(profile.id)?.push(item);
  }
  return profileList.map(profile => {
    const owned = ownedByProfile.get(profile.id) ?? [];
    const acceptedWork = owned.filter(currentAccepted).sort((left, right) => {
      const rank = status => ({ blocked: 0, active: 1, queued: 2 }[String(status ?? '').toLowerCase()] ?? 3);
      return rank(left.status) - rank(right.status) || String(left.title).localeCompare(String(right.title));
    });
    const proposedWork = owned.filter(item => !currentAccepted(item) && !item?.completed && ['draft', 'planned'].includes(String(item.commitment ?? '').toLowerCase()));
    const focusWork = [...acceptedWork, ...proposedWork].map(item => ({
      ...item,
      isProposed: ['draft', 'planned'].includes(String(item.commitment ?? '').toLowerCase()),
      isBlocked: explicitlyBlocked(item),
    }));
    const blockers = acceptedWork.flatMap(item => blockersFor(item).map(reason => ({ itemId: item.id, itemTitle: item.title, reason })));
    const attention = {
      blocked: focusWork.some(item => item.isBlocked),
      proposed: focusWork.some(item => item.isProposed),
    };
    const guideAssignmentStageValue = guideAssignmentStage(profile, { teamProjection });
    return {
      ...profile,
      acceptedWork,
      proposedWork,
      focusWork,
      blockers,
      latestActivity: latestActivity(profile, owned, { teamProjection }),
      guideAssignmentStage: guideAssignmentStageValue,
      directoryRole: directoryRole(profile.slackTitle),
      attention,
      needsAttention: attention.blocked || attention.proposed,
    };
  });
}

/**
 * Team projections intentionally omit the canonical roster. A validated safe
 * companion may supply display metadata; without it, expose only assignee IDs
 * that occur in the projection and use a task-supplied human name.
 */
export function projectedTeamProfiles(items, directory = []) {
  const profiles = new Map();
  for (const entry of Array.isArray(directory) ? directory : []) {
    const id = String(entry?.id ?? '').trim();
    const displayName = String(entry?.displayName ?? '').trim();
    if (!id || !displayName || profiles.has(id)) continue;
    profiles.set(id, {
      id,
      slug: id,
      handle: id,
      name: displayName,
      fullName: displayName,
      status: 'projected',
      githubHandle: null,
      avatar: typeof entry?.avatar === 'string' ? entry.avatar : null,
      avatarUrl: avatarAssetPath(entry?.avatar),
      aliases: [],
      organizations: [],
      organizationIds: [],
      current: null,
      strongAt: null,
      experience: null,
      bestAssignments: null,
      preference: null,
      slackTitle: null,
      githubUrl: null,
      slackUrl: null,
      verifiedLabel: true,
    });
  }
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.owner ?? '').trim();
    if (!id || id.toLowerCase() === 'unassigned') continue;
    const candidateName = String(item?.ownerName ?? '').trim();
    const hasVerifiedName = candidateName && candidateName !== id;
    const current = profiles.get(id);
    if (current) {
      if (!current.verifiedLabel && hasVerifiedName) {
        current.name = candidateName;
        current.fullName = candidateName;
        current.verifiedLabel = true;
      }
      continue;
    }
    profiles.set(id, {
      id,
      slug: id,
      handle: id,
      name: hasVerifiedName ? candidateName : id,
      fullName: hasVerifiedName ? candidateName : null,
      status: 'projected',
      githubHandle: null,
      avatar: null,
      aliases: [],
      organizations: [],
      organizationIds: [],
      current: null,
      strongAt: null,
      experience: null,
      bestAssignments: null,
      preference: null,
      slackTitle: null,
      avatarUrl: null,
      githubUrl: null,
      slackUrl: null,
      verifiedLabel: Boolean(hasVerifiedName),
    });
  }
  return [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}
function searchableText(member, { teamProjection = false } = {}) {
  const latestActivityText = teamProjection && member.latestActivity?.activityKind === 'guide-observation'
    ? []
    : [member.latestActivity?.sections?.observation, member.latestActivity?.sections?.evidence];
  return [
    member.name,
    member.fullName,
    member.handle,
    member.slackTitle,
    member.organization,
    ...(member.organizations ?? []),
    ...(teamProjection ? [] : [member.strongAt, member.current]),
    ...(member.acceptedWork ?? []).map(item => item.title),
    ...(member.proposedWork ?? []).map(item => item.title),
    ...(member.blockers ?? []).map(blocker => `${blocker.itemTitle ?? ''} ${blocker.reason ?? ''}`),
    ...latestActivityText,
  ].join(' ').toLocaleLowerCase();
}

export function filterTeamMembers(members, { query = '', organization = 'all', needsAttentionOnly = false, teamProjection = false } = {}) {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
  return (Array.isArray(members) ? members : []).filter(member => {
    const memberOrganizations = member.organizations ?? [];
    const organizationMatch = organization === 'all'
      || (organization === '__unrecorded__' ? memberOrganizations.length === 0 : memberOrganizations.includes(organization));
    const attentionMatch = !needsAttentionOnly || member.needsAttention === true;
    return organizationMatch && attentionMatch && searchableText(member, { teamProjection }).includes(normalizedQuery);
  });
}
