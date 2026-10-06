import { useRouteContext } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { compactTeamSearch, sessionBrowseFilters } from './routing-state';
import { formatUrl, teamPath } from './navigation';
import { teamFilterOptions } from './route-data';
import { personSlug, segmentPersonMentions, type PersonRecord } from './person-identity';
import { PersonLink } from './person-link';
import type { TrackerRouterContext } from './router-context';
import type { TrackerSnapshot } from './snapshot';

export interface MarkdownPersonOptions {
  segmentMentions: (source: string) => readonly { text: string; person: PersonRecord | null }[];
  resolveMention: (text: string, person: PersonRecord | null) => { href: string } | null;
}

/** Build the safe source-to-route adapter used by the HTML Markdown renderer. */
export function markdownPersonOptions(data?: TrackerSnapshot): MarkdownPersonOptions {
  const team = data?.team ?? [];
  const filterOptions = data ? teamFilterOptions(data) : {};
  const rememberedTeam = data
    ? sessionBrowseFilters.restoreTeam(filterOptions)
    : { q: '', organization: 'all' as const };
  const hrefFor = (person: PersonRecord | null): string | null => {
    const slug = personSlug(person);
    if (!slug) return null;
    return formatUrl(teamPath(slug), compactTeamSearch(rememberedTeam, filterOptions));
  };

  return {
    segmentMentions: source => segmentPersonMentions(source, team),
    resolveMention: (_text, person) => {
      const href = hrefFor(person);
      return href ? { href } : null;
    },
  };
}

export interface PersonTextProps {
  value: string | null | undefined;
  data?: TrackerSnapshot;
  className?: string;
}

function PersonTextContent({ value, data }: Pick<PersonTextProps, 'value' | 'data'>): ReactNode {
  const source = String(value ?? '');
  const team = data?.team ?? [];
  const segments = segmentPersonMentions(source, team);
  return segments.map((segment, index) => {
    const slug = personSlug(segment.person);
    if (!slug) return <Fragment key={`${index}-${segment.text}`}>{segment.text}</Fragment>;
    return <PersonLink key={`${index}-${segment.text}`} value={slug} data={data}>{segment.text}</PersonLink>;
  });
}

function PersonTextResolved({ value, data, className }: PersonTextProps) {
  const content = <PersonTextContent value={value} data={data} />;
  return className ? <span className={className}>{content}</span> : content;
}

function PersonTextFromRoute({ value, className }: Omit<PersonTextProps, 'data'>) {
  const routeData = useRouteContext({
    strict: false,
    select: context => (context as Partial<TrackerRouterContext> | undefined)?.data,
  });
  return <PersonTextResolved value={value} data={routeData ?? undefined} className={className} />;
}

export function PersonText(props: PersonTextProps) {
  return props.data === undefined
    ? <PersonTextFromRoute value={props.value} className={props.className} />
    : <PersonTextResolved value={props.value} data={props.data} className={props.className} />;
}
