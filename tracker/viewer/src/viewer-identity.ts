import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PersonRecord } from './person-identity';
import type { SnapshotRecord } from './snapshot';

export type ViewerActor =
  | { readonly kind: 'human'; readonly email?: string; readonly personId?: string }
  | { readonly kind: 'service' };

export type ViewerResolvedActor =
  | { readonly kind: 'human'; readonly email?: string; readonly personId?: string; readonly person: PersonRecord | null }
  | { readonly kind: 'service' };

export type ViewerIdentity =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly actor: ViewerResolvedActor }
  | { readonly kind: 'unavailable'; readonly message: string };

const unavailableWithoutProvider: ViewerIdentity = {
  kind: 'unavailable',
  message: 'Signed-in identity is unavailable.',
};

const ViewerIdentityContext = createContext<ViewerIdentity>(unavailableWithoutProvider);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizedPersonId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) ? id : null;
}

function actorFromPayload(payload: unknown): ViewerActor {
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.actor)) {
    throw new Error('Invalid viewer identity response.');
  }
  if (payload.actor.kind === 'service') return { kind: 'service' };
  if (payload.actor.kind !== 'human') throw new Error('Invalid viewer identity actor.');
  const email = normalizedEmail(payload.actor.email);
  const personId = normalizedPersonId(payload.actor.personId);
  if (email === null && personId === null) throw new Error('Invalid viewer identity contract.');
  return {
    kind: 'human',
    ...(email ? { email } : {}),
    ...(personId ? { personId } : {}),
  };
}

export function parseViewerIdentity(payload: unknown): ViewerActor {
  return actorFromPayload(payload);
}

function personIsActive(person: PersonRecord): boolean {
  return typeof person.status === 'string' && person.status.trim().toLowerCase() === 'active';
}

function personEmails(person: PersonRecord): string[] {
  const aliases = Array.isArray(person.emailAliases) ? person.emailAliases : [];
  return [person.email, ...aliases]
    .filter((value): value is string => typeof value === 'string')
    .map(value => normalizedEmail(value))
    .filter((value): value is string => value !== null);
}

export function resolveViewerPerson(team: readonly PersonRecord[] | null | undefined, email: string): PersonRecord | null {
  const normalized = normalizedEmail(email);
  if (normalized === null) return null;
  const matches = (Array.isArray(team) ? team : []).filter(person => (
    personIsActive(person) && personEmails(person).includes(normalized)
  ));
  return matches.length === 1 ? matches[0] : null;
}

/** Resolve the explicit safe directory identity without using a display name. */
export function resolveViewerPersonById(team: readonly PersonRecord[] | null | undefined, personId: string): PersonRecord | null {
  const normalized = normalizedPersonId(personId)?.toLocaleLowerCase() ?? null;
  if (normalized === null) return null;
  const matches = (Array.isArray(team) ? team : []).filter(person => (
    typeof person.id === 'string' && person.id.trim().toLocaleLowerCase() === normalized
  ));
  return matches.length === 1 ? matches[0] : null;
}

async function fetchViewerActor(): Promise<ViewerActor> {
  const response = await fetch('/api/me', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Viewer identity request failed (${response.status}).`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Viewer identity response was not valid JSON.');
  }
  return parseViewerIdentity(payload);
}

export function useViewerIdentity(): ViewerIdentity {
  return useContext(ViewerIdentityContext);
}

export function ViewerIdentityProvider({ team, children }: { readonly team: readonly SnapshotRecord[]; readonly children: ReactNode }) {
  type FetchState =
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly actor: ViewerActor }
    | { readonly kind: 'unavailable'; readonly message: string };
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'loading' });
  const requestSequence = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++requestSequence.current;
    setFetchState({ kind: 'loading' });
    void fetchViewerActor()
      .then(actor => {
        if (requestSequence.current !== sequence) return;
        setFetchState({ kind: 'ready', actor });
      })
      .catch(() => {
        if (requestSequence.current === sequence) setFetchState({ kind: 'unavailable', message: 'Could not verify signed-in identity.' });
      });
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      requestSequence.current += 1;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  let identity: ViewerIdentity;
  if (fetchState.kind === 'loading' || fetchState.kind === 'unavailable') {
    identity = fetchState;
  } else if (fetchState.actor.kind === 'service') {
    identity = { kind: 'ready', actor: fetchState.actor };
  } else {
    const person = fetchState.actor.personId
      ? resolveViewerPersonById(team, fetchState.actor.personId)
      : fetchState.actor.email
        ? resolveViewerPerson(team, fetchState.actor.email)
        : null;
    identity = { kind: 'ready', actor: { ...fetchState.actor, person } };
  }
  return createElement(ViewerIdentityContext.Provider, { value: identity }, children);
}
