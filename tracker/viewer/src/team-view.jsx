import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Users } from 'lucide-react';
import { Link, useNavigate, useRouteContext } from '@tanstack/react-router';
import { Badge } from './components/ui/badge.tsx';
import { Button } from './components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.tsx';
import { AssigneeAvatars } from './assignee-avatars.jsx';
import { renderMarkdown, renderMarkdownInline } from './markdown.js';
import { teamPath } from './navigation.ts';
import { personSlug, segmentPersonMentions } from './person-identity.ts';
import { SearchField } from './search-field.tsx';
import { TrackerEmpty } from './tracker-empty.tsx';
import { buildTeamDirectory, compactEvidenceSummary, compactText, filterTeamMembers } from './team-model.mjs';
import { rewriteTeamTrackerLinks, sourceRepositoryUrl } from './team-links.mjs';

function BadgeChip({ children, tone = 'slate' }) {
  return <Badge className={`tracker-badge tracker-badge-${tone}`} variant="outline">{children}</Badge>;
}

function humanize(value) {
  return String(value ?? '').replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toLocaleUpperCase());
}

function formatDate(value) {
  if (!value) return 'Date not recorded';
  const raw = String(value);
  const date = new Date(raw.includes('T') ? raw : `${raw}T00:00:00+08:00`);
  if (Number.isNaN(date.valueOf())) return raw;
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' }).format(date);
}

function profileMentionHref(slug, routeSearch) {
  const path = teamPath(slug);
  const params = new URLSearchParams();
  if (routeSearch?.q) params.set('q', String(routeSearch.q));
  if (routeSearch?.organization && routeSearch.organization !== 'all') params.set('organization', String(routeSearch.organization));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function profileMentionOptions(profiles, routeSearch) {
  return {
    segmentMentions: source => segmentPersonMentions(source, profiles),
    resolveMention: (_text, person) => {
      const slug = personSlug(person);
      return slug ? { href: profileMentionHref(slug, routeSearch) } : null;
    },
  };
}

function MentionInline({ value, profiles, routeSearch, as: Tag = 'span', className = '', ...props }) {
  const html = renderMarkdownInline(value, profileMentionOptions(profiles, routeSearch));
  const classes = ['markdown', 'team-inline-markdown', className].filter(Boolean).join(' ');
  return <Tag className={classes} {...props} dangerouslySetInnerHTML={{ __html: html }} />;
}

function RichText({ value, className = '', items = [], profiles = [], routeSearch }) {
  const context = useRouteContext({ from: '__root__' });
  const sourceCommit = context.data?.source?.commit ?? 'unknown';
  const isTeamProjection = context.data?.source?.layout === 'team-projection-v1';
  const html = renderMarkdown(rewriteTeamTrackerLinks(value, items, sourceCommit, { allowRepositoryLinks: !isTeamProjection }), profileMentionOptions(profiles, routeSearch));
  return html ? <div className={`markdown team-markdown team-rich-text ${className}`} dangerouslySetInnerHTML={{ __html: html }} /> : <p className="team-empty-copy">Not recorded.</p>;
}

function sourceHref(activity, sourceCommit = 'unknown') {
  const source = String(activity?.source ?? '');
  const googleDoc = /^google-doc:(.+)$/i.exec(source);
  if (googleDoc) return `https://docs.google.com/document/d/${encodeURIComponent(googleDoc[1])}/edit`;
  const slack = /^slack:([^:]+):(?:p)?([0-9.]+)$/i.exec(source);
  if (slack) return `https://app.slack.com/archives/${encodeURIComponent(slack[1])}/p${slack[2].replaceAll('.', '')}`;
  if (/^https?:\/\//i.test(source)) return source;
  if (activity?.sourcePath) return sourceRepositoryUrl(activity.sourcePath, sourceCommit);
  return null;
}

function MemberLink({ memberSlug, search, children, className = '' }) {
  if (!memberSlug) return <Link className={className} to="/team" search={search}>{children}</Link>;
  return <Link className={className} to="/team/$memberSlug" params={{ memberSlug }} search={search}>{children}</Link>;
}

function WorkLink({ item, onSelect }) {
  return <button className="team-work-link" type="button" onClick={() => onSelect(item.id)}>
    <span>{item.title}</span><BadgeChip tone={item.status === 'active' ? 'blue' : item.status === 'blocked' ? 'red' : 'slate'}>{humanize(item.status)}</BadgeChip>
  </button>;
}

function AcceptedWork({ member, onSelect, compact = false }) {
  if (!member.acceptedWork.length) return <p className="team-empty-copy">No current accepted work is recorded.</p>;
  const visible = compact ? member.acceptedWork.slice(0, 2) : member.acceptedWork;
  return <div className="team-work-list">{visible.map(item => <WorkLink key={item.id} item={item} onSelect={onSelect} />)}{compact && member.acceptedWork.length > visible.length ? <small className="team-overflow-note">+{member.acceptedWork.length - visible.length} more</small> : null}</div>;
}

function guideContextLabel(member) {
  if (member.guideAssignmentStage === 'proposed') return 'Proposed in guide';
  if (member.guideAssignmentStage === 'mixed') return 'Includes proposed scope';
  return 'Guide note';
}

function guideContextTone(member) {
  return member.guideAssignmentStage ? 'amber' : 'slate';
}

function GuideContext({ member, items, profiles, routeSearch }) {
  if (member.current) return <section className="team-guide-context"><div className="team-section-heading"><h3>Team guide context</h3><BadgeChip tone={guideContextTone(member)}>{guideContextLabel(member)}</BadgeChip></div><RichText value={member.current} items={items} profiles={profiles} routeSearch={routeSearch} /></section>;
  if (member.strongAt) return <section className="team-guide-context"><div className="team-section-heading"><h3>Guide focus</h3><BadgeChip>Team guide</BadgeChip></div><RichText value={member.strongAt} items={items} profiles={profiles} routeSearch={routeSearch} /></section>;
  return <section className="team-guide-context"><div className="team-section-heading"><h3>Guide focus</h3><BadgeChip>Team guide</BadgeChip></div><p className="team-empty-copy">No focus or current assignment is recorded in the team guide.</p></section>;
}

function LatestActivity({ activity, compact = false, items = [], profiles = [], routeSearch, teamProjection = false }) {
  const context = useRouteContext({ from: '__root__' });
  const sourceCommit = context.data?.source?.commit ?? 'unknown';
  if (teamProjection && activity?.activityKind === 'guide-observation') return <p className="team-empty-copy">No dated update is recorded.</p>;
  if (!activity) return <p className="team-empty-copy">No dated update is recorded.</p>;
  if (compact) {
    const summary = compactEvidenceSummary(activity);
    const sourceText = activity.sections?.observation ?? activity.sections?.evidence;
    return <div className="team-activity team-activity-compact" title={sourceText ? String(sourceText) : undefined}>
      <strong className="team-activity-date">{formatDate(activity.observedAt)}</strong>
      {summary ? <MentionInline as="p" className="team-activity-summary" value={summary} profiles={profiles} routeSearch={routeSearch} /> : <p className="team-empty-copy">No summary recorded.</p>}
    </div>;
  }
  const summary = activity.sections?.observation ?? activity.sections?.evidence ?? 'The dated evidence record is linked to this work. Open its source for details.';
  const href = sourceHref(activity, sourceCommit);
  return <div className="team-activity">
    <div className="team-activity-heading"><strong>{formatDate(activity.observedAt)}</strong><BadgeChip>{activity.activityKind === 'tracker-update' ? 'Tracker evidence' : 'Team guide'}</BadgeChip></div>
    {activity.itemTitle ? <p className="team-activity-context">Update linked to <span>{activity.itemTitle}</span>.</p> : null}
    <RichText value={summary} items={items} profiles={profiles} routeSearch={routeSearch} />
    {href ? <a className="team-source-link" href={href} target="_blank" rel="noreferrer">Open evidence source<ArrowUpRight size={12} aria-hidden="true" /></a> : null}
  </div>;
}

function BlockerSummary({ blockers, compact = false, onSelect, profiles = [], routeSearch }) {
  if (!blockers.length) return <p className="team-empty-copy">No current blocker recorded.</p>;
  const visible = compact ? blockers.slice(0, 1) : blockers;
  return <ul className="team-blocker-list">{visible.map((blocker, index) => <li key={`${blocker.itemId}-${index}`}>
    {onSelect ? <button className="team-blocker-item" type="button" onClick={() => onSelect(blocker.itemId)}>{blocker.itemTitle}</button> : <strong>{blocker.itemTitle}</strong>}
    <MentionInline value={blocker.reason} profiles={profiles} routeSearch={routeSearch} />
  </li>)}</ul>;
}

function TeamFocus({ member, profiles = [], routeSearch, teamProjection = false }) {
  const focusItems = member.focusWork;
  const focusItem = focusItems[0];
  const hiddenItems = focusItems.slice(1);
  const focus = focusItem?.title || (teamProjection ? '' : compactText(member.current || member.strongAt));
  const proposedCount = hiddenItems.filter(item => item.isProposed).length;
  const blockedCount = hiddenItems.filter(item => item.isBlocked).length;
  const hiddenSummary = [
    `+${hiddenItems.length} more`,
    ...(proposedCount ? [`${proposedCount} proposed`] : []),
    ...(blockedCount ? [`${blockedCount} blocked`] : []),
  ].join(' · ');
  return <div className="team-focus">
    <div className="team-focus-item">
      {focus ? <MentionInline as="strong" title={focus} value={focus} profiles={profiles} routeSearch={routeSearch} /> : <strong>No current focus recorded.</strong>}
      {focusItem?.isProposed ? <BadgeChip tone="amber">Proposed</BadgeChip> : null}
      {focusItem?.isBlocked ? <BadgeChip tone="red">Blocked</BadgeChip> : null}
    </div>
    {hiddenItems.length ? <span className="team-overflow-note">{hiddenSummary}</span> : null}
  </div>;
}

function rowEventIsNavigationSafe(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (typeof event.button === 'number' && event.button !== 0) return false;
  if (event.target?.closest?.('a,button,input,select,textarea')) return false;
  return !(typeof window !== 'undefined' && window.getSelection?.()?.toString());
}

function TeamDirectory({ members, search, onSearchChange, organizationFilter, onOrganizationChange, onResetFilters, routeSearch, teamProjection = false }) {
  const navigate = useNavigate();
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const organizations = [...new Set(members.flatMap(member => member.organizations ?? []))].sort((left, right) => left.localeCompare(right));
  const matching = filterTeamMembers(members, { query: search, organization: organizationFilter, needsAttentionOnly, teamProjection });
  const navigateToMember = member => void navigate({ to: '/team/$memberSlug', params: { memberSlug: member.slug }, search: routeSearch });
  const emptyMessage = teamProjection && !needsAttentionOnly && !search.trim() && organizationFilter === 'all'
    ? 'No team members are shared yet.'
    : needsAttentionOnly
    ? 'No blocked or proposed work matches these filters.'
    : search.trim()
      ? `No team members match “${search.trim()}”.`
      : 'No teammates are recorded for this filter.';
  const hasFilters = Boolean(search.trim()) || organizationFilter !== 'all' || needsAttentionOnly;
  const resetFilters = () => {
    onResetFilters();
    setNeedsAttentionOnly(false);
  };
  return <Card className="surface-card team-directory-card">
    <CardHeader className="surface-card-header team-page-header">
      <div><div className="team-page-title-row"><CardTitle>Team</CardTitle><span className="team-member-count">{members.length} members</span></div><CardDescription>People and what they’re working on.</CardDescription></div>
    </CardHeader>
    <CardContent className="team-directory-content">
      <div className="team-directory-filters">
        <div style={{ width: 'min(100%, 380px)' }}><SearchField label="Search team" value={search} onChange={onSearchChange} placeholder="Search people or work" /></div>
        <label className="team-org-filter"><span>Organization</span><select aria-label="Filter by organization" value={organizationFilter} onChange={event => onOrganizationChange(event.target.value)}><option value="all">All organizations</option>{organizations.map(organization => <option key={organization} value={organization}>{organization}</option>)}<option value="__unrecorded__">Not recorded</option></select></label>
        <label className="team-attention-filter"><input type="checkbox" checked={needsAttentionOnly} onChange={event => setNeedsAttentionOnly(event.target.checked)} /><span>Needs attention</span></label>
      </div>
      {matching.length ? <div className="team-table-wrap"><table className="team-directory-table">
        <thead><tr><th scope="col">Person</th><th scope="col">Current focus</th><th scope="col">Latest update</th></tr></thead>
        <tbody>{matching.map(member => <tr key={member.slug} className="team-directory-row" data-testid={`team-row-${member.slug}`} tabIndex={0} aria-label={`Open ${member.name} profile`} onClick={event => { if (rowEventIsNavigationSafe(event)) navigateToMember(member); }} onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && rowEventIsNavigationSafe(event)) { event.preventDefault(); navigateToMember(member); } }}>
          <td data-label="Person"><MemberLink memberSlug={member.slug} search={routeSearch} className="team-member-link"><AssigneeAvatars owner={member.handle ?? member.name} ownerName={member.name} imageUrl={member.avatarUrl} size="md" /><span className="team-member-copy"><strong>{member.name}</strong><span className="team-member-org">{member.organizations?.join(', ') || 'Organization not recorded'}</span></span></MemberLink></td>
          <td data-label="Current focus"><TeamFocus member={member} profiles={members} routeSearch={routeSearch} teamProjection={teamProjection} /></td>
          <td data-label="Latest update"><LatestActivity activity={member.latestActivity} compact profiles={members} routeSearch={routeSearch} teamProjection={teamProjection} /></td>
        </tr>)}</tbody>
      </table></div> : <TrackerEmpty className="empty-panel team-no-results" icon={<Users size={22} aria-hidden="true" />} title={<p>{emptyMessage}</p>} action={hasFilters ? <Button size="sm" variant="ghost" onClick={resetFilters}>Reset filters</Button> : null} />}
      <p className="team-directory-note">Showing {matching.length} of {members.length} people</p>
    </CardContent>
  </Card>;
}

function ProfileSection({ title, children, className = '' }) {
  return <Card className={`surface-card team-profile-section ${className}`}><CardHeader className="team-section-card-header"><CardTitle>{title}</CardTitle></CardHeader><CardContent>{children}</CardContent></Card>;
}

function TeamProfile({ member, onSelectItem, items, routeSearch, profiles, teamProjection = false }) {
  const organizationText = member.organizations?.join(', ') || 'Organization not recorded';
  return <div className="team-profile-page">
    <MemberLink search={routeSearch} className="team-back-link"><ArrowLeft size={15} aria-hidden="true" />All team members</MemberLink>
    <Card className="surface-card team-profile-hero">
      <CardContent>
        <div className="team-profile-identity"><AssigneeAvatars owner={member.handle ?? member.name} ownerName={member.name} imageUrl={member.avatarUrl} size="lg" /><div><p className="eyebrow">Team profile</p><h1>{member.name}</h1>{member.fullName && member.fullName !== member.name ? <p className="team-handle">{member.fullName}</p> : null}<p className="team-handle">{member.handle ? `@${member.handle}` : 'No GitHub handle recorded'}</p><div className="team-profile-meta"><BadgeChip>{organizationText}</BadgeChip>{member.slackTitle ? <span>{member.slackTitle}</span> : null}</div></div><div className="team-profile-links">{member.githubUrl ? <a className="team-github-link" href={member.githubUrl} target="_blank" rel="noreferrer">GitHub<ArrowUpRight size={14} aria-hidden="true" /></a> : null}{member.slackUrl ? <a className="team-github-link" href={member.slackUrl} target="_blank" rel="noreferrer">Slack<ArrowUpRight size={14} aria-hidden="true" /></a> : null}</div></div>
        <div className="team-profile-stats"><div><strong>{member.acceptedWork.length}</strong><span>Open accepted work</span></div><div><strong>{member.blockers.length}</strong><span>Recorded blockers</span></div><div><strong>{member.latestActivity ? formatDate(member.latestActivity.observedAt) : 'None'}</strong><span>Latest dated evidence</span></div></div>
      </CardContent>
    </Card>

    <div className={`team-profile-grid${teamProjection ? ' team-profile-grid-shared' : ''}`}>
      <div className="team-profile-column">
        <ProfileSection title="Current accepted work">
          <AcceptedWork member={member} onSelect={onSelectItem} />
          {member.proposedWork.length ? <div className="team-proposed-work"><div className="team-section-heading"><h3>Proposed tracker work</h3><BadgeChip tone="amber">Not accepted</BadgeChip></div><div className="team-work-list">{member.proposedWork.map(item => <div className="team-proposed-item" key={item.id}><strong>{item.title}</strong><small>{humanize(item.commitment)} · {humanize(item.status)}</small></div>)}</div></div> : null}
        </ProfileSection>
        <ProfileSection title="Latest evidenced update">
          <LatestActivity activity={member.latestActivity} items={items} profiles={profiles} routeSearch={routeSearch} teamProjection={teamProjection} />
          {member.latestActivity?.itemId ? <button className="text-link team-activity-item-link" type="button" onClick={() => onSelectItem(member.latestActivity.itemId)}>Open {member.latestActivity.itemTitle}<ArrowUpRight size={14} aria-hidden="true" /></button> : null}
        </ProfileSection>
        <ProfileSection title="Blockers">
          <BlockerSummary blockers={member.blockers} onSelect={onSelectItem} profiles={profiles} routeSearch={routeSearch} />
        </ProfileSection>
      </div>
      {teamProjection ? null : <div className="team-profile-column">
        <ProfileSection title="Capability and fit">
          <div className="team-profile-copy"><div><h3>Strong at</h3><RichText value={member.strongAt} items={items} profiles={profiles} routeSearch={routeSearch} /></div><div><h3>Experience points</h3><RichText value={member.experience} items={items} profiles={profiles} routeSearch={routeSearch} /></div><div><h3>Best assignments</h3><RichText value={member.bestAssignments} items={items} profiles={profiles} routeSearch={routeSearch} /></div></div>
        </ProfileSection>
        <ProfileSection title="Guide context">
          <GuideContext member={member} items={items} profiles={profiles} routeSearch={routeSearch} />
          <div className="team-preference"><h3>Stated preference</h3><RichText value={member.preference} items={items} profiles={profiles} routeSearch={routeSearch} /></div>
        </ProfileSection>
      </div>}
    </div>
  </div>;
}

/** @param {import('./features/contracts').TeamViewProps} props */
export function TeamView({ profiles, items, teamProjection = false, memberSlug = null, search, onSearchChange, organizationFilter, onOrganizationChange, onResetFilters, onSelectItem }) {
  const members = useMemo(() => buildTeamDirectory(profiles, items, { teamProjection }), [profiles, items, teamProjection]);
  const routeSearch = { q: search, organization: organizationFilter };
  if (memberSlug) {
    const member = members.find(profile => profile.slug === memberSlug);
    if (!member) return <Card className="surface-card team-not-found"><CardContent><TrackerEmpty title={<h1>Team member not found</h1>} description="The requested profile is not in the current team snapshot." descriptionClassName="team-empty-copy" action={<MemberLink search={routeSearch} className="team-back-link"><ArrowLeft size={15} aria-hidden="true" />All team members</MemberLink>} /></CardContent></Card>;
    return <TeamProfile member={member} onSelectItem={onSelectItem} items={Array.isArray(items) ? items : []} routeSearch={routeSearch} profiles={members} teamProjection={teamProjection} />;
  }
  return <TeamDirectory members={members} search={search} onSearchChange={onSearchChange} organizationFilter={organizationFilter} onOrganizationChange={onOrganizationChange} onResetFilters={onResetFilters} routeSearch={routeSearch} teamProjection={teamProjection} />;
}
