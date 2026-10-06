import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../src/markdown.js';

const people = [
  { slug: 'fixture-alpha', names: ['FixtureAlpha'] },
  { slug: 'fixture-beta', names: ['FixtureBeta Person', 'FixtureBeta'] },
  { slug: 'fixture-gamma', names: ['FixtureGamma Alias', 'FixtureGammaAlias'] },
  { slug: 'fixture-delta', names: ['FixtureDelta'] },
  { slug: 'fixture-epsilon', names: ['FixtureDelta'] },
  { slug: 'fixture-zeta', names: ['FixtureZeta'] },
];

const mentionCandidates = [...new Set(people.flatMap(person => [
  ...person.names,
  ...person.names.map(name => `@${name}`),
]))];

function resolveMention(value: string) {
  const withAt = value.startsWith('@');
  const key = withAt ? value.slice(1) : value;
  const matches = people.filter(person => person.names.some(name => name.toLocaleLowerCase() === key.toLocaleLowerCase()));
  if (matches.length !== 1) return null;
  // A bare single-word human name keeps its roster capitalization. @mentions
  // and distinctive handles are intentionally case-insensitive.
  if (!withAt && key.toLocaleLowerCase() === 'fixturealpha' && value !== 'FixtureAlpha') return null;
  return { href: `/team/${matches[0].slug}` };
}

function markdown(value: string) {
  return renderMarkdown(value, { mentionCandidates, resolveMention });
}

describe('Markdown teammate mentions', () => {
  test('links known unique names case-insensitively and keeps unknown and ambiguous names plain', () => {
    const output = markdown('fIxTuReBeTa pErSoN, FIXTUREGAMMAALIAS, FixtureDelta, unknown, FixtureAlpha, @fixturealpha, FIXTUREALPHA.');
    expect(output).toContain('<a href="/team/fixture-beta">fIxTuReBeTa pErSoN</a>');
    expect(output).toContain('<a href="/team/fixture-gamma">FIXTUREGAMMAALIAS</a>');
    expect(output).toContain('unknown');
    expect(output).toContain('FixtureDelta');
    expect(output).not.toContain('<a href="/team/fixture-delta">FixtureDelta</a>');
    expect(output).toContain('<a href="/team/fixture-alpha">FixtureAlpha</a>');
    expect(output).toContain('<a href="/team/fixture-alpha">@fixturealpha</a>');
    expect(output).not.toContain('<a href="/team/fixture-alpha">FIXTUREALPHA</a>');
  });

  test('uses the longest matching canonical name and preserves punctuation', () => {
    const source = 'FixtureBeta Person, FixtureBeta.';
    const output = markdown(source);
    expect(output).toBe('<p><a href="/team/fixture-beta">FixtureBeta Person</a>, <a href="/team/fixture-beta">FixtureBeta</a>.</p>');
  });

  test('links aliases inside bold and emphasis source marks', () => {
    const output = markdown('**FixtureGamma Alias** and _fixturegammaalias_.');
    expect(output).toContain('<strong><a href="/team/fixture-gamma">FixtureGamma Alias</a></strong>');
    expect(output).toContain('<em><a href="/team/fixture-gamma">fixturegammaalias</a></em>');
  });

  test('does not nest links or match inline/fenced code, URLs, email, and paths', () => {
    const output = markdown('`FixtureAlpha` [FixtureAlpha](/team/fixture-alpha) https://example.test/FixtureAlpha fixture-alpha@example.test /team/FixtureAlpha\n\n```\nFixtureBeta Person\n```\n\nFixtureAlpha');
    expect(output).toContain('<code>FixtureAlpha</code>');
    expect(output).toContain('<a href="/team/fixture-alpha">FixtureAlpha</a>');
    expect(output).toContain('https://example.test/FixtureAlpha');
    expect(output).toContain('fixture-alpha@example.test');
    expect(output).toContain('/team/FixtureAlpha');
    expect(output).toContain('<pre><code>FixtureBeta Person</code></pre>');
    expect(output).not.toContain('<pre><code><a href="/team/fixture-beta">');
    expect(output.match(/<a href="\/team\/fixture-alpha">/g)?.length).toBe(2);
  });

  test('keeps known mentions plain in fenced code with standard info strings', () => {
    const source = '```text\nFixtureBeta Person\n```\n\n~~~md\nFixtureBeta Person\n~~~\n\nFixtureBeta Person';
    const output = markdown(source);
    expect(output.match(/<pre><code>FixtureBeta Person<\/code><\/pre>/g)?.length).toBe(2);
    expect(output.match(/<a href="\/team\/fixture-beta">/g)?.length).toBe(1);
  });

  test('keeps mentions plain in arbitrary-length inline code spans', () => {
    const output = markdown('``FixtureBeta Person`` and ````FixtureBeta Person```` and FixtureBeta Person');
    expect(output).toContain('<code>FixtureBeta Person</code> and <code>FixtureBeta Person</code> and ');
    expect(output.match(/<a href="\/team\/fixture-beta">/g)?.length).toBe(1);
  });

  test('escapes source and rejects unsafe mention hrefs', () => {
    const source = '<img src=x onerror=alert(1)> FixtureAlpha';
    const output = renderMarkdown(source, {
      mentionCandidates: ['FixtureAlpha'],
      resolveMention: () => ({ href: 'javascript:alert(1)' }),
    });
    expect(output).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('javascript:');
    expect(source).toBe('<img src=x onerror=alert(1)> FixtureAlpha');
  });

  test('renders foundation segments through the resolver without inventing unknown links', () => {
    const output = renderMarkdown('FixtureAlpha unknown', {
      segmentMentions: () => [
        { text: 'FixtureAlpha', person: { slug: 'fixture-alpha' } },
        { text: ' unknown', person: null },
      ],
      resolveMention: (_text: string, person: { slug: string }) => ({ href: `/team/${person.slug}` }),
    });
    expect(output).toBe('<p><a href="/team/fixture-alpha">FixtureAlpha</a> unknown</p>');
  });
});
