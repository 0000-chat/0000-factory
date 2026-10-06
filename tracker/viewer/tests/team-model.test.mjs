import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { buildTeamProfiles, parseTeamGuide, validatePeopleRegistry } from '../tooling/team.mjs';
import { buildTeamDirectory, compactEvidenceSummary, compactText, filterTeamMembers } from '../src/team-model.mjs';
import { classifySupportedPath } from '../src/navigation.ts';
import { rewriteTeamTrackerLinks } from '../src/team-links.mjs';

const guide = `# Synthetic fixture-org-alpha guide

## FixtureAlpha Person · [@fixture-alpha](https://example.test/people/fixture-alpha)
- **Person ID:** fixture-alpha
- **Strong at:** Synthetic review and fixture validation
- **Observed work (2026-10-01):** Checked synthetic source [evidence](https://example.test/evidence/alpha).

## FixtureBeta Person · [@fixture-beta](https://example.test/people/fixture-beta)
- **Person ID:** fixture-beta
- **Observed work (2026-10-01):** Reviewed synthetic [evidence](https://example.test/evidence/beta).

## FixtureGamma Person · [@fixture-gamma](https://example.test/people/fixture-gamma)
- **Person ID:** fixture-gamma
- **Observed work (2026-10-01):** Maintains synthetic validation data.
`;
const fixtureRegistry = {
  schemaVersion: 1,
  organizations: [{ id: 'fixture-org-alpha', name: 'Fixture Org Beta' }],
  people: [
    { id: 'fixture-alpha', name: 'FixtureAlpha Person', fullName: 'FixtureAlpha Person', aliases: [], organizationIds: ['fixture-org-alpha'], githubHandle: 'fixture-alpha', slackId: 'SLACK-FIXTURE-ALPHA', status: 'active', avatar: 'fixture-alpha.png', slackTitle: 'Fixture Auditor | Synthetic hours' },
    { id: 'fixture-beta', name: 'FixtureBeta Person', fullName: 'FixtureBeta Person', aliases: [], organizationIds: ['fixture-org-alpha'], githubHandle: 'fixture-beta', slackId: 'SLACK-FIXTURE-BETA', status: 'active', avatar: 'fixture-beta.png' },
    { id: 'fixture-gamma', name: 'FixtureGamma Person', fullName: 'FixtureGamma Person', aliases: [], organizationIds: ['fixture-org-alpha'], githubHandle: 'fixture-gamma', slackId: 'SLACK-FIXTURE-GAMMA', status: 'active', avatar: 'fixture-gamma.png' },
  ],
};
const fixtureGuideProfiles = parseTeamGuide(guide);

function item(id, owner, extra = {}) {
  return {
    id,
    title: id,
    owner,
    ownerName: owner,
    commitment: 'accepted',
    status: 'active',
    completed: false,
    health: { state: 'unknown', reason: 'Synthetic health review pending.' },
    sections: { blocker: null },
    linked: { updates: [] },
    ...extra,
  };
}

function makeFixtureRegistry() {
  return {
    schemaVersion: 1,
    organizations: [
      { id: 'fixture-org-gamma', name: 'fixture-org-gamma' },
      { id: 'fixture-org-delta', name: 'Fixture Org Delta' },
    ],
    people: [
      { id: 'fxa', name: 'FixtureEpsilon', fullName: 'FixtureZeta Person Extended', aliases: ['FixtureEta', 'FixtureTheta Person'], organizationIds: ['fixture-org-gamma'], githubHandle: 'fixture-delta', slackId: 'SLACK-FIXTURE-DELTA', status: 'active', avatar: 'fixture-delta.png' },
      { id: 'fxb', name: 'FixtureIota', fullName: 'FixtureKappa Person Extended', aliases: ['FixtureKappa Person Extended'], organizationIds: ['fixture-org-gamma'], slackId: 'SLACK-FIXTURE-EPSILON', status: 'active', slackTitle: 'Fixture Auditor | Synthetic hours', avatar: 'fixture-epsilon.png' },
      { id: 'fxc', name: 'FixtureLambda Person', aliases: [], organizationIds: ['fixture-org-delta'], status: 'inactive' },
      { id: 'fixture-epsilon', name: 'FixtureMu Person', aliases: [], organizationIds: [], status: 'active' },
    ],
  };
}

test('parses experience guide fields and merges them into the explicit registry roster', () => {
  const fixtureGuideProfile = fixtureGuideProfiles.find(profile => profile.handle === 'fixture-alpha');
  assert.equal(fixtureGuideProfile.strongAt.includes('Synthetic review'), true);
  assert.equal(fixtureGuideProfile.observedWorkAt, '2026-10-01');
  assert.equal(fixtureGuideProfile.observedWorkLinks.length, 1);
  assert.ok(fixtureGuideProfile.observedWorkLinks.some(link => link.href === 'https://example.test/evidence/alpha'));
  assert.equal(fixtureGuideProfiles.find(profile => profile.name === 'FixtureGamma Person').strongAt, null);

  const fixtureProfiles = buildTeamProfiles(makeFixtureRegistry(), '');
  const profiles = buildTeamProfiles(fixtureRegistry, guide);
  const fixtureAlphaProfile = profiles.find(profile => profile.id === 'fixture-alpha');
  assert.equal(fixtureAlphaProfile.name, 'FixtureAlpha Person');
  assert.equal(fixtureAlphaProfile.slug, 'fixture-alpha');
  assert.equal(fixtureAlphaProfile.strongAt, fixtureGuideProfiles.find(profile => profile.handle === 'fixture-alpha').strongAt);
  assert.deepEqual(fixtureAlphaProfile.organizations, ['Fixture Org Beta']);
  assert.equal(fixtureAlphaProfile.avatarUrl, '/avatars/fixture-alpha.png');
  assert.equal(fixtureAlphaProfile.slackUrl, 'https://app.slack.com/team/SLACK-FIXTURE-ALPHA');

  const fixtureBetaProfile = fixtureProfiles.find(profile => profile.id === 'fxb');
  assert.equal(fixtureBetaProfile.fullName, 'FixtureKappa Person Extended');
  assert.deepEqual(fixtureBetaProfile.organizations, ['fixture-org-gamma']);
  assert.equal(fixtureBetaProfile.avatarUrl, '/avatars/fixture-epsilon.png');

  const directory = buildTeamDirectory(fixtureProfiles, []);
  assert.equal(directory.find(profile => profile.id === 'fxb').directoryRole, 'Fixture Auditor');
  assert.deepEqual(directory.find(profile => profile.id === 'fxc').organizations, ['Fixture Org Delta']);
  assert.deepEqual(directory.find(profile => profile.id === 'fixture-epsilon').organizations, []);
});

test('keeps every observation tied on the latest date and discards older dated notes', () => {
  const datedGuide = `## FixtureDelta Person\n\n- **Person ID:** fixture-delta\n- **Observed work (2026-09-29):** Synthetic baseline note [baseline evidence](https://example.test/evidence/baseline).\n- **Observed work (2026-10-01):** Synthetic latest note alpha [evidence alpha](https://example.test/evidence/alpha).\n- **Observed work (2026-10-01):** Synthetic latest note beta [evidence beta](https://example.test/evidence/beta).\n`;
  const [profile] = parseTeamGuide(datedGuide);
  assert.equal(profile.observedWorkAt, '2026-10-01');
  assert.equal(profile.observedWorkStart, '2026-10-01');
  assert.match(profile.observedWork, /Synthetic latest note alpha/);
  assert.match(profile.observedWork, /Synthetic latest note beta/);
  assert.doesNotMatch(profile.observedWork, /Synthetic baseline note/);
  assert.deepEqual(profile.observedWorkLinks.map(link => link.href), ['https://example.test/evidence/alpha', 'https://example.test/evidence/beta']);
});

test('builds the configured roster from people.json with explicit organizations and guide evidence', () => {
  const issues = validatePeopleRegistry(fixtureRegistry);
  assert.deepEqual(issues, []);
  const profiles = buildTeamProfiles(fixtureRegistry, guide);
  assert.equal(profiles.length, fixtureRegistry.people.length);
  assert.ok(profiles.every(profile => profile.organizationIds.length === 1 && profile.organizations[0] === 'Fixture Org Beta'));
  assert.ok(profiles.every(profile => profile.slackUrl?.startsWith('https://app.slack.com/team/')));
  assert.ok(profiles.every(profile => profile.avatarUrl?.startsWith('/avatars/')));

  const expandedIds = ['fixture-alpha', 'fixture-beta'];
  for (const id of expandedIds) assert.ok(profiles.find(profile => profile.id === id)?.observedWorkAt, `${id} should retain its dated guide evidence`);
  const directory = buildTeamDirectory(profiles, []);
  assert.equal(directory.find(profile => profile.id === 'fixture-alpha').directoryRole, 'Fixture Auditor');
  assert.equal(directory.find(profile => profile.id === 'fixture-beta').directoryRole, null);
  assert.equal(directory.find(profile => profile.id === 'fixture-gamma').directoryRole, null);
});

test('validates stable ids, unique Slack identities, and explicit organization references', () => {
  const invalid = makeFixtureRegistry();
  invalid.people.push({ id: 'fxa', name: 'FixtureNu', aliases: [], status: 'active', githubHandle: 'fixture-delta', slackId: 'SLACK-FIXTURE-DELTA', organizationIds: ['fixture-org-epsilon'] });
  invalid.people[1].aliases = 'malformed';
  invalid.people.push({ id: 'fixture-zeta', name: 'FixtureXi Person', aliases: [], organizationIds: [] });
  const issues = validatePeopleRegistry(invalid);
  assert.ok(issues.includes('duplicate person id: fxa'));
  assert.ok(issues.includes('duplicate Slack id: SLACK-FIXTURE-DELTA'));
  assert.ok(issues.includes('duplicate GitHub handle: fixture-delta'));
  assert.ok(issues.includes('person fxb aliases must be an array'));
  assert.ok(issues.includes('person fixture-zeta needs status active or inactive'));
  assert.ok(issues.includes('person fxa references unknown organization: fixture-org-epsilon'));
  assert.throws(() => buildTeamProfiles(invalid, guide), /invalid people registry/);
});

test('joins active accepted work, explicit blockers, latest owned-work evidence, and guide fallback', () => {
  const fixtureAlphaWork = item('fixture-alpha-verification', 'fixture-alpha', {
    title: 'Synthetic verification work',
    health: { state: 'at-risk', reason: 'Synthetic prerequisite evidence is pending review.' },
    linked: { updates: [{ id: 'fixture-alpha-update', title: 'Synthetic activity', observedAt: '2026-10-02T03:00:00Z', sections: { observation: 'Synthetic configuration work continues.' } }] },
  });
  const fixtureAlphaCompletedWork = item('fixture-alpha-complete', 'fixture-alpha', {
    commitment: 'accepted',
    status: 'done',
    completed: true,
    linked: { updates: [{ id: 'fixture-alpha-completion', title: 'Synthetic activity', observedAt: '2026-10-03T03:00:00Z', sections: { observation: 'Synthetic completion evidence was recorded.' } }] },
  });
  const fixtureBetaPlannedWork = item('fixture-beta-proposal', 'fixture-beta', { commitment: 'planned', status: 'queued' });
  const fixtureGammaWork = item('fixture-gamma-task', 'fixture-gamma', { ownerName: 'FixtureGamma Person' });
  const directory = buildTeamDirectory(buildTeamProfiles(fixtureRegistry, guide), [fixtureAlphaWork, fixtureAlphaCompletedWork, fixtureBetaPlannedWork, fixtureGammaWork]);

  const fixtureAlphaDirectoryEntry = directory.find(profile => profile.handle === 'fixture-alpha');
  assert.deepEqual(fixtureAlphaDirectoryEntry.acceptedWork.map(work => work.id), ['fixture-alpha-verification']);
  assert.equal(fixtureAlphaDirectoryEntry.blockers[0].reason, 'Synthetic prerequisite evidence is pending review.');
  assert.equal(fixtureAlphaDirectoryEntry.latestActivity.id, 'fixture-alpha-completion');
  assert.equal(fixtureAlphaDirectoryEntry.latestActivity.itemTitle, 'fixture-alpha-complete');

  const fixtureBetaDirectoryEntry = directory.find(profile => profile.handle === 'fixture-beta');
  assert.deepEqual(fixtureBetaDirectoryEntry.acceptedWork, []);
  assert.deepEqual(fixtureBetaDirectoryEntry.proposedWork.map(work => work.id), ['fixture-beta-proposal']);
  assert.equal(fixtureBetaDirectoryEntry.latestActivity.activityKind, 'guide-observation');
  assert.equal(fixtureBetaDirectoryEntry.latestActivity.observedAt, '2026-10-01');

  assert.deepEqual(directory.find(profile => profile.id === 'fixture-gamma').acceptedWork.map(work => work.id), ['fixture-gamma-task']);
  assert.equal(directory.find(profile => profile.id === 'fixture-gamma').latestActivity.activityKind, 'guide-observation');
});

test('keeps a visible accepted focus free of a hidden proposal badge', () => {
  const accepted = item('accepted-focus', 'fxa', { title: 'Synthetic accepted focus' });
  const proposal = item('hidden-proposal', 'fxa', { title: 'Synthetic hidden proposal', commitment: 'planned', status: 'queued' });
  const member = buildTeamDirectory(buildTeamProfiles(makeFixtureRegistry(), ''), [accepted, proposal]).find(profile => profile.id === 'fxa');

  assert.equal(member.focusWork[0].id, 'accepted-focus');
  assert.equal(member.focusWork[0].isProposed, false);
  assert.equal(member.focusWork[1].id, 'hidden-proposal');
  assert.equal(member.focusWork[1].isProposed, true);
});

test('marks a proposed-only focus as proposed', () => {
  const proposal = item('proposed-focus', 'fxa', { commitment: 'draft', status: 'queued' });
  const member = buildTeamDirectory(buildTeamProfiles(makeFixtureRegistry(), ''), [proposal]).find(profile => profile.id === 'fxa');

  assert.equal(member.focusWork[0].id, 'proposed-focus');
  assert.equal(member.focusWork[0].isProposed, true);
});

test('keeps blocked state on its own hidden work item', () => {
  const acceptedFocus = item('accepted-focus', 'fxa', { title: 'A synthetic accepted focus' });
  const atRiskWork = item('at-risk-work', 'fxa', {
    title: 'B synthetic accepted at-risk work',
    health: { state: 'at-risk', reason: 'Synthetic review is pending.' },
  });
  const blockedWork = item('blocked-work', 'fxa', {
    title: 'Z synthetic accepted blocked work',
    health: { state: 'blocked', reason: 'Synthetic verification is pending.' },
  });
  const member = buildTeamDirectory(buildTeamProfiles(makeFixtureRegistry(), ''), [acceptedFocus, atRiskWork, blockedWork]).find(profile => profile.id === 'fxa');

  assert.equal(member.focusWork[0].id, 'accepted-focus');
  assert.equal(member.focusWork[0].isBlocked, false);
  assert.equal(member.focusWork.find(work => work.id === 'at-risk-work').isBlocked, false);
  assert.equal(member.focusWork.find(work => work.id === 'blocked-work').isBlocked, true);
});

test('at-risk-only work does not match the needs attention filter', () => {
  const atRiskWork = item('at-risk-work', 'fxa', {
    health: { state: 'at-risk', reason: 'Synthetic review is pending.' },
  });
  const [member] = buildTeamDirectory(buildTeamProfiles(makeFixtureRegistry(), ''), [atRiskWork]);

  assert.equal(member.focusWork[0].isBlocked, false);
  assert.equal(member.attention.blocked, false);
  assert.deepEqual(filterTeamMembers([member], { needsAttentionOnly: true }), []);
});

test('guide proposal context without current work does not create an item badge or attention match', () => {
  const profile = buildTeamProfiles(makeFixtureRegistry(), '').find(profile => profile.id === 'fxa');
  const [member] = buildTeamDirectory([{ ...profile, current: 'Synthetic proposal remains under review.' }], []);

  assert.equal(member.attention.proposed, false);
  assert.deepEqual(member.focusWork, []);
});

test('keeps compact directory text source-backed and filters explicit attention only', () => {
  const blocked = item('blocked-work', 'fxa', {
    status: 'blocked',
    health: { state: 'blocked', reason: 'Synthetic verification evidence is pending.' },
  });
  const proposed = item('proposed-work', 'fxb', { commitment: 'planned', status: 'queued' });
  const normal = item('normal-work', 'fxc');
  const directory = buildTeamDirectory(buildTeamProfiles(makeFixtureRegistry(), ''), [blocked, proposed, normal]);

  const source = 'Dr. Fixture Auditor reviewed e.g. synthetic inputs. A second sentence has a [source](https://example.test/evidence/compact).';
  assert.equal(compactText(source), 'Dr. Fixture Auditor reviewed e.g. synthetic inputs. A second sentence has a source.');
  assert.equal(compactEvidenceSummary({ sections: { observation: source } }), 'Dr. Fixture Auditor reviewed e.g. synthetic inputs. A second sentence has a source.');
  assert.deepEqual(filterTeamMembers(directory, { needsAttentionOnly: true }).map(member => member.id), ['fxa', 'fxb']);
  assert.deepEqual(filterTeamMembers(directory, { organization: 'Fixture Org Delta' }).map(member => member.id), ['fxc']);
  assert.deepEqual(filterTeamMembers(directory, { query: 'verification evidence' }).map(member => member.id), ['fxa']);
});

test('uses canonical owner IDs before display names and leaves ambiguous legacy names unassigned', () => {
  const profiles = [
    { id: 'fxd', slug: 'fxd', githubHandle: 'fixture-eta', handle: 'fixture-eta', name: 'FixtureOmicron', fullName: 'FixturePi Person', aliases: ['FixturePi Person'] },
    { id: 'fixture-theta', slug: 'fixture-theta', name: 'FixtureOmicron', fullName: 'FixtureRho Person', aliases: ['FixtureOmicron'] },
  ];
  const ownedByHandle = item('fxd-work', 'fixture-eta', { ownerName: 'FixtureOmicron' });
  const ambiguousLegacy = item('ambiguous-fxd-work', 'archived-fxd', { ownerName: 'FixtureOmicron' });
  const directory = buildTeamDirectory(profiles, [ownedByHandle, ambiguousLegacy]);
  assert.deepEqual(directory.find(profile => profile.id === 'fxd').acceptedWork.map(work => work.id), ['fxd-work']);
  assert.deepEqual(directory.find(profile => profile.id === 'fixture-theta').acceptedWork, []);
});

test('preserves stable punctuation and never falls back from an unknown owner value', () => {
  const profiles = [
    { id: 'fixture-iota', slug: 'fixture-iota', handle: 'fixture-iota', name: 'FixtureSigma Person', aliases: [] },
    { id: 'fixture-kappa', slug: 'fixture-kappa', handle: 'fixture-kappa', name: 'FixtureTau', aliases: [] },
    { id: 'fxd', slug: 'fxd', handle: 'fxd', name: 'FixtureOmicron', aliases: [] },
    { id: 'fixture-lambda', slug: 'fixture-lambda', handle: 'fixture-lambda', name: 'FixtureNu', aliases: [] },
    { id: 'fixture-mu', slug: 'fixture-mu', handle: 'fixture-mu', name: 'FixtureNu', aliases: [] },
  ];
  const directory = buildTeamDirectory(profiles, [
    item('punctuated-owner', 'fixture-iota', { ownerName: 'FixtureSigma Person' }),
    item('unpunctuated-owner', 'fixture-kappa', { ownerName: 'FixtureTau' }),
    item('fixture-org-epsilon-owner', null, { ownerName: 'FixtureOmicron' }),
    item('unknown-owner', 'archived-fxd', { ownerName: 'FixtureOmicron' }),
    item('duplicate-name', null, { ownerName: 'FixtureNu' }),
  ]);

  assert.deepEqual(directory.find(profile => profile.id === 'fixture-iota').acceptedWork.map(work => work.id), ['punctuated-owner']);
  assert.deepEqual(directory.find(profile => profile.id === 'fixture-kappa').acceptedWork.map(work => work.id), ['unpunctuated-owner']);
  assert.deepEqual(directory.find(profile => profile.id === 'fxd').acceptedWork.map(work => work.id), ['fixture-org-epsilon-owner']);
  assert.deepEqual(directory.find(profile => profile.id === 'fixture-lambda').acceptedWork, []);
  assert.deepEqual(directory.find(profile => profile.id === 'fixture-mu').acceptedWork, []);
});

test('builds stable Team paths and rewrites tracker Markdown links to router routes', () => {
  assert.deepEqual(classifySupportedPath('/team'), { kind: 'team' });
  assert.deepEqual(classifySupportedPath('/team/fixture-alpha'), { kind: 'team', memberSlug: 'fixture-alpha' });
  assert.deepEqual(classifySupportedPath('/team/a%2Fb'), { kind: 'invalid' });

  const markdown = rewriteTeamTrackerLinks('[work](tracker/items/work-item.md) [decision](tracker/decisions/launch.md) [history](tracker/history/old.md)', [
    { id: 'item/1', sourcePath: 'tracker/items/work-item.md' },
  ]);
  assert.match(markdown, /\]\(\/work\/item%2F1\)/);
  assert.match(markdown, /\]\(\/decisions\/launch\)/);
  assert.equal(
    markdown,
    '[work](/work/item%2F1) [decision](/decisions/launch) [history](https://github.com/synthetic-org/synthetic-tracker/blob/main/tracker-data/tracker/history/old.md)',
  );
  assert.doesNotMatch(markdown, /#\//);
});
