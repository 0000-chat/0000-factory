import { describe, expect, test } from 'bun:test';
import {
  normalizePersonIdentity,
  resolvePerson,
  segmentPersonMentions,
} from '../src/person-identity';

const fixturePerson1 = {
  id: 'fixture-alpha',
  slug: 'fixture-alpha',
  handle: 'fxa',
  githubHandle: 'fixture-alpha.person',
  name: 'FixtureAlpha',
  fullName: 'FixtureAlpha Person',
  aliases: ['FixtureAlpha Alias'],
};

describe('person identity resolution', () => {
  test('normalizes stable keys without erasing punctuation', () => {
    expect(normalizePersonIdentity('  @FIXTURE-ALPHA.PERSON  ')).toBe('fixture-alpha.person');
    expect(normalizePersonIdentity('fixtureunknown')).toBe('fixtureunknown');
    expect(resolvePerson([fixturePerson1], '  @FIXTURE-ALPHA.PERSON  ')).toBe(fixturePerson1);
    expect(resolvePerson([fixturePerson1], 'fixtureunknown')).toBeNull();
  });

  test('stable identity wins over a conflicting display name', () => {
    const fixturePerson2 = { id: 'fixture-beta', slug: 'fixture-beta', name: 'FixtureBeta' };
    expect(resolvePerson([fixturePerson1, fixturePerson2], 'FXA', 'FixtureBeta')).toBe(fixturePerson1);
  });

  test('duplicate stable identities remain ambiguous', () => {
    const fixturePerson7 = { id: 'fixture-gamma', slug: 'fixture-gamma', handle: 'fxb', name: 'FixtureGamma' };
    const fixturePerson8 = { id: 'fixture-delta', slug: 'fixture-delta', handle: 'fxb', name: 'FixtureDelta' };
    expect(resolvePerson([fixturePerson7, fixturePerson8], 'FXB', 'FixtureGamma')).toBeNull();
  });

  test('resolves one confirmed human name or explicit alias', () => {
    const fixturePerson5 = {
      id: 'fixture-beta',
      slug: 'fixture-beta',
      name: 'FixtureBeta',
      fullName: 'FixtureBeta Person',
      aliases: ['FixtureBeta Alias', 'FixtureBeta Person'],
    };
    expect(resolvePerson([fixturePerson5], 'FixtureBeta')).toBe(fixturePerson5);
    expect(resolvePerson([fixturePerson5], 'FixtureBeta Person')).toBe(fixturePerson5);
    expect(resolvePerson([fixturePerson5], null, 'FixtureBeta Alias')).toBe(fixturePerson5);
  });

  test('does not use an unknown explicit handle to fall back through ownerName', () => {
    const fixturePerson6 = { id: 'fixture-gamma', slug: 'fixture-gamma', handle: 'fxb', name: 'FixtureBeta', aliases: ['FixtureGamma Alias'] };
    expect(resolvePerson([fixturePerson6], 'archived-fixture', 'FixtureBeta')).toBeNull();
  });

  test('rejects ambiguous names, missing records, and special values', () => {
    const fixturePerson7 = { id: 'fixture-gamma', slug: 'fixture-gamma', name: 'FixtureGamma Person', aliases: ['FixtureGamma Alias'] };
    const fixturePerson8 = { id: 'fixture-delta', slug: 'fixture-delta', name: 'FixtureGamma Person', aliases: ['FixtureGamma Alias'] };
    expect(resolvePerson([fixturePerson7, fixturePerson8], 'FixtureGamma Person')).toBeNull();
    expect(resolvePerson([fixturePerson7], null, null)).toBeNull();
    for (const value of ['unassigned', '__unassigned__', 'unknown', '-', 'n/a']) {
      expect(resolvePerson([fixturePerson7], value, 'FixtureGamma Person')).toBeNull();
    }
  });

  test('segments stable mentions while protecting URLs and code', () => {
    const fixturePerson15 = { id: 'fixture-beta', slug: 'fixture-beta', githubHandle: 'fixture-reader', name: 'FixtureGamma' };
    const fixturePerson10 = { id: 'fixture-delta', slug: 'fixture-delta', handle: 'fixture-alpha', name: 'FixtureAlpha' };
    const fixturePerson11 = { id: 'fixture-epsilon', slug: 'fixture-epsilon', handle: 'fixture-alpha', name: 'FixtureBeta' };
    const segments = segmentPersonMentions(
      'Ping @fixture-reader, see https://example.test/@fixture-reader and `@fixture-reader`; @fixture-alpha stays text.',
      [fixturePerson15, fixturePerson10, fixturePerson11],
    );
    expect(segments.filter(segment => segment.person).map(segment => segment.text)).toEqual(['@fixture-reader']);
    expect(segments.map(segment => segment.text).join('')).toBe(
      'Ping @fixture-reader, see https://example.test/@fixture-reader and `@fixture-reader`; @fixture-alpha stays text.',
    );
  });

  test('matches distinctive plain names with longest confirmed aliases and keeps ordinary nouns plain', () => {
    const fixturePerson1 = { id: 'fixture-alpha', slug: 'fixture-alpha', handle: 'FXA', name: 'FixtureLead', fullName: 'FixtureAlpha Person' };
    const fixturePerson2 = { id: 'fixture-beta', slug: 'fixture-beta', name: 'FixtureAlpha' };
    const fixturePerson3 = { id: 'fixture-gamma', slug: 'fixture-gamma', githubHandle: 'fixture-gamma-handle', name: 'FixtureGamma', fullName: 'FixtureGamma Person Extended', aliases: ['FixtureGamma Alias'] };
    const segments = segmentPersonMentions(
      'fxa the task. FixtureAlpha reviewed it with FixtureAlpha Person and FIXTURE-GAMMA-HANDLE. fixturealpha stays plain, and FixtureGamma Alias was copied from https://example.test/FIXTURE-GAMMA-HANDLE, fixture-reader@example.test, and tracker/items/fixture-alpha.md.',
      [fixturePerson1, fixturePerson2, fixturePerson3],
    );
    expect(segments.filter(segment => segment.person).map(segment => segment.text)).toEqual([
      'FixtureAlpha',
      'FixtureAlpha Person',
      'FIXTURE-GAMMA-HANDLE',
      'FixtureGamma Alias',
    ]);
  });

  test('protects arbitrary backtick runs and generic URI schemes', () => {
    const fixturePerson15 = { id: 'fixture-zeta', slug: 'fixture-zeta', githubHandle: 'fixture-reader', name: 'FixtureGamma' };
    const source = '``FixtureGamma`` and ````FixtureGamma```` ftp://FixtureGamma tel://FixtureGamma custom+scheme://FixtureGamma';
    const segments = segmentPersonMentions(source, [fixturePerson15]);
    expect(segments.filter(segment => segment.person)).toEqual([]);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });
});
