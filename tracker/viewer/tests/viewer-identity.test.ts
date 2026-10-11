import { describe, expect, test } from 'bun:test';
import { parseViewerIdentity, resolveViewerPerson, resolveViewerPersonById } from '../src/viewer-identity';

const person = {
  id: 'fixture-owner',
  name: 'Fixture Owner',
  status: 'active',
  email: 'owner@example.test',
  emailAliases: ['owner.alias@example.test'],
};

describe('viewer identity', () => {
  test('parses human and service actor contracts', () => {
    expect(parseViewerIdentity({ schemaVersion: 1, actor: { kind: 'human', email: ' OWNER@example.test ' } })).toEqual({ kind: 'human', email: 'owner@example.test' });
    expect(parseViewerIdentity({ schemaVersion: 1, actor: { kind: 'human', personId: ' fixture-owner ' } })).toEqual({ kind: 'human', personId: 'fixture-owner' });
    expect(parseViewerIdentity({ schemaVersion: 1, actor: { kind: 'service' } })).toEqual({ kind: 'service' });
  });

  test('rejects malformed identity payloads', () => {
    expect(() => parseViewerIdentity({ schemaVersion: 1, actor: { kind: 'human', email: 'don' } })).toThrow();
    expect(() => parseViewerIdentity({ schemaVersion: 1, actor: { kind: 'human', personId: 'not safe/id' } })).toThrow();
    expect(() => parseViewerIdentity({ schemaVersion: 1, actor: { kind: 'unknown' } })).toThrow();
  });

  test('matches one active person by exact primary or alias email', () => {
    expect(resolveViewerPerson([person], 'OWNER.ALIAS@EXAMPLE.TEST')).toBe(person);
    expect(resolveViewerPerson([person], 'owner-at-example.test')).toBeNull();
    expect(resolveViewerPerson([{ ...person, status: 'inactive' }], 'owner@example.test')).toBeNull();
  });

  test('does not mark duplicate email matches as a person', () => {
    const duplicate = { ...person, id: 'duplicate' };
    expect(resolveViewerPerson([person, duplicate], 'owner@example.test')).toBeNull();
  });

  test('matches an explicit safe directory ID without requiring team email', () => {
    const projected = { id: 'fixture-owner', name: 'Fixture Owner', status: 'projected' };
    expect(resolveViewerPersonById([projected], ' FIXTURE-OWNER ')).toBe(projected);
    expect(resolveViewerPersonById([{ ...projected, id: 'other-owner' }], 'fixture-owner')).toBeNull();
  });
});
