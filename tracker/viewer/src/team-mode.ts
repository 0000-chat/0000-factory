import type { TrackerSnapshot } from './snapshot';

/** The source layout emitted by the validated public team projection. */
export const TEAM_PROJECTION_LAYOUT = 'team-projection-v1' as const;

export type TeamProjectionSource = {
  readonly layout?: string;
  readonly projectionId?: string;
  readonly week?: string;
  readonly revision?: string;
  readonly policyRevision?: string;
};

/**
 * Keep the read-only boundary tied to the data that was actually fetched.
 * The private tracker layout remains the default when older snapshots omit
 * the layout marker.
 */
export function isTeamProjection(data: Pick<TrackerSnapshot, 'source'> | null | undefined): boolean {
  return data?.source?.layout === TEAM_PROJECTION_LAYOUT;
}

export function teamProjectionSource(data: Pick<TrackerSnapshot, 'source'> | null | undefined): TeamProjectionSource | null {
  return isTeamProjection(data) ? data?.source as TeamProjectionSource : null;
}

/**
 * Return the stable owner values present in the fetched projection. An owner
 * value is a source-backed ID; the display name is used only when the
 * projection supplied one distinct from that ID.
 */
export function projectedAssigneeChoices(data: Pick<TrackerSnapshot, 'items'> | null | undefined): Array<{ value: string; label: string; verifiedLabel: boolean }> {
  const choices = new Map<string, { value: string; label: string; verifiedLabel: boolean }>();
  for (const item of data?.items ?? []) {
    const value = typeof item.owner === 'string' ? item.owner.trim() : '';
    if (!value || value.toLowerCase() === 'unassigned') continue;
    const name = typeof item.ownerName === 'string' ? item.ownerName.trim() : '';
    const hasVerifiedLabel = Boolean(name) && name !== value;
    const current = choices.get(value);
    if (!current || (!current.verifiedLabel && hasVerifiedLabel)) {
      choices.set(value, {
        value,
        label: hasVerifiedLabel ? name : value,
        verifiedLabel: hasVerifiedLabel,
      });
    }
  }
  return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
}
