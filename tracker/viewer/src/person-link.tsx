import { Link, useRouteContext, useRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from './components/ui/avatar';
import { Pill, PillAvatar } from './components/kibo-ui/pill';
import { resolvePerson, personSlug, type PersonRecord } from './person-identity';
import { compactTeamSearch, sessionBrowseFilters } from './routing-state';
import { teamFilterOptions } from './route-data';
import type { TrackerRouterContext } from './router-context';
import type { TrackerSnapshot } from './snapshot';
import { cn } from './lib/utils';
import { formatUrl, teamPath } from './navigation';
import { useViewerIdentity } from './viewer-identity';

export interface PersonLinkProps {
  value: string | null | undefined;
  name?: string | null;
  avatar?: boolean;
  pill?: boolean;
  className?: string;
  children?: ReactNode;
  data?: TrackerSnapshot;
  assignment?: boolean;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return null;
}

function initialsFor(value: string): string {
  const initials = value
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(part => part.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  return (initials || '?').toLocaleUpperCase();
}

function displayLabel(person: PersonRecord | null, value: string | null | undefined, name: string | null | undefined): string {
  return firstText(person?.name, person?.fullName, name, value) ?? 'Unknown person';
}

function imageSource(person: PersonRecord): string | null {
  return firstText(person.imageUrl, person.avatarUrl);
}

function labelContent(
  label: string,
  children: ReactNode,
  person: PersonRecord | null,
  avatar: boolean,
  pill: boolean,
): ReactNode {
  const content = <span className="person-link-label">{children ?? label}</span>;
  if (!avatar || !person) return content;

  const source = imageSource(person);
  const fallback = initialsFor(label);
  if (pill) {
    return <>{<PillAvatar src={source ?? undefined} alt="" aria-hidden="true" fallback={fallback} />}{content}</>;
  }
  return (
    <>
      <Avatar className="person-link-avatar" aria-hidden="true">
        {source ? <AvatarImage src={source} alt="" /> : null}
        <AvatarFallback>{fallback}</AvatarFallback>
      </Avatar>
      {content}
    </>
  );
}

interface PersonLinkContentProps extends PersonLinkProps {
  routerAvailable: boolean;
}

function PersonLinkContent({ routerAvailable, ...props }: PersonLinkContentProps) {
  const { data, value, name, avatar = false, pill = false, className, children, assignment = false } = props;
  const viewerIdentity = useViewerIdentity();
  const team = data?.team ?? [];
  const person = resolvePerson(team, value, name);
  const label = displayLabel(person, value, name);
  const viewerPerson = viewerIdentity.kind === 'ready' && viewerIdentity.actor.kind === 'human'
    ? viewerIdentity.actor.person
    : null;
  const assignedToViewer = assignment && person !== null && viewerPerson !== null
    && textValue(person.id) !== '' && textValue(person.id) === textValue(viewerPerson.id);

  if (!person) {
    return <span className={cn('person-link person-link-plain', className)}><span className="person-link-label">{children ?? label}</span></span>;
  }

  const slug = personSlug(person);
  if (!slug) {
    return <span className={cn('person-link person-link-plain', className)}><span className="person-link-label">{children ?? label}</span></span>;
  }

  const search = data
    ? sessionBrowseFilters.restoreTeam(teamFilterOptions(data))
    : { q: '', organization: 'all' as const };
  const linkClassName = cn('person-link', pill ? undefined : className);
  const assignedLabel = assignedToViewer ? `${label}, Assigned to you` : children ? label : undefined;
  const linkContent = <>
    {labelContent(label, children, person, avatar, pill)}
    {assignedToViewer ? <span className="person-link-assigned" data-testid="assigned-to-you" title="Assigned to you" aria-label="Assigned to you">You</span> : null}
  </>;
  const stopBubble = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const stopKeyboardBubble = (event: { key?: string; stopPropagation: () => void }) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  };
  const link = routerAvailable ? (
    <Link
      className={linkClassName}
      to="/team/$memberSlug"
      params={{ memberSlug: slug }}
      search={search}
      aria-label={assignedLabel}
      onPointerDown={stopBubble}
      onClick={stopBubble}
      onKeyDown={stopKeyboardBubble}
    >
      {linkContent}
    </Link>
  ) : (
    <a
      className={linkClassName}
      href={formatUrl(teamPath(slug), compactTeamSearch(search, data ? teamFilterOptions(data) : {}))}
      aria-label={assignedLabel}
      onPointerDown={stopBubble}
      onClick={stopBubble}
      onKeyDown={stopKeyboardBubble}
    >
      {linkContent}
    </a>
  );

  return pill ? <Pill asChild className={cn('person-link-pill', className)}>{link}</Pill> : link;
}

function PersonLinkWithRouteContext(props: PersonLinkProps) {
  const routeData = useRouteContext({
    strict: false,
    select: context => (context as Partial<TrackerRouterContext> | undefined)?.data,
  });
  return <PersonLinkContent {...props} data={routeData ?? undefined} routerAvailable />;
}

function PersonLinkFromRouter(props: PersonLinkProps) {
  const router = useRouter({ warn: false });
  return router
    ? <PersonLinkWithRouteContext {...props} />
    : <PersonLinkContent {...props} routerAvailable={false} />;
}

function PersonLinkWithOptionalRouter(props: PersonLinkProps) {
  const router = useRouter({ warn: false });
  return <PersonLinkContent {...props} routerAvailable={Boolean(router)} />;
}

export function PersonLink(props: PersonLinkProps) {
  return props.data === undefined
    ? <PersonLinkFromRouter {...props} />
    : <PersonLinkWithOptionalRouter {...props} />;
}
