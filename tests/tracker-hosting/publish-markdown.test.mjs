import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeTaskContentValue,
  patchTaskBody,
  readTaskContentValues,
} from '../../tooling/tracker/publish-markdown.mjs';

test('task content normalization matches the shared title and narrative projection', () => {
  assert.equal(normalizeTaskContentValue('title', '  New title  '), 'New title');
  assert.equal(
    normalizeTaskContentValue('sections.outcome', '\r\n  First line  \r\n  second line  \r\n\r\n'),
    '  First line  \n  second line',
  );
});

test('task content projection reads canonical sections and ignores headings inside fences', () => {
  const body = [
    '#  0000 Legacy  ',
    '',
    '## Outcome',
    'The project outcome.',
    '',
    '## Completion condition',
    '```markdown',
    '# Example title',
    '## Outcome',
    '```',
    '',
    '## Next step',
    'Inspect the deploy.',
    '',
    '## Evidence',
    '- [Decision](https://example.test/decision)',
  ].join('\n');

  assert.deepEqual(readTaskContentValues(body), {
    title: '0000 Legacy',
    'sections.outcome': 'The project outcome.',
    'sections.completionCondition': '```markdown\n# Example title\n## Outcome\n```',
    'sections.nextStep': 'Inspect the deploy.',
    'sections.evidence': '- [Decision](https://example.test/decision)',
  });
});

test('patching fields preserves CRLF, indentation, fences, and unrelated bytes', () => {
  const body = [
    '# Legacy title',
    '',
    '<!-- Keep this byte-for-byte. -->',
    '',
    '## Outcome',
    'Old outcome.',
    '',
    '## Completion condition',
    '  - Keep this indentation.',
    '',
    '## Next step',
    '```md',
    '## This is code, not a section.',
    '```',
    '',
    '## Evidence',
    '- Existing evidence.',
    '',
    '## Changelog',
    '- Keep the changelog.',
    '',
  ].join('\r\n');
  const expected = body
    .replace('# Legacy title', '# Updated title')
    .replace('Old outcome.', '  New outcome.\r\n  Continued with a hard break.  \r\n  Final line.');

  const actual = patchTaskBody(body, {
    title: ' Updated title ',
    'sections.outcome': '\r\n  New outcome.\r\n  Continued with a hard break.  \r\n  Final line.\r\n',
  });

  assert.equal(actual, expected);
  assert.deepEqual(readTaskContentValues(actual), {
    title: 'Updated title',
    'sections.outcome': '  New outcome.\n  Continued with a hard break.  \n  Final line.',
    'sections.completionCondition': '  - Keep this indentation.',
    'sections.nextStep': '```md\n## This is code, not a section.\n```',
    'sections.evidence': '- Existing evidence.',
  });
});

test('a semantically unchanged field leaves its original bytes untouched', () => {
  const body = '# Title  \n\n## Outcome\n  Keep the meaningful indentation.  \n';

  assert.equal(patchTaskBody(body, { 'sections.outcome': '  Keep the meaningful indentation.  ' }), body);
});

test('a missing empty section is inserted in canonical order before Changelog', () => {
  const body = '# Title\n\n## Completion condition\nComplete the work.\n\n## Changelog\n- Original release note.\n';
  const expected = '# Title\n\n## Outcome\nDescribe the result.\n\n## Completion condition\nComplete the work.\n\n## Changelog\n- Original release note.\n';

  const actual = patchTaskBody(body, { 'sections.outcome': 'Describe the result.' });

  assert.equal(actual, expected);
  assert.equal(readTaskContentValues(actual)['sections.outcome'], 'Describe the result.');
});

test('multiple missing sections are inserted deterministically before Changelog', () => {
  const body = '# Title\n\n## Changelog\n- Original release note.\n';
  const actual = patchTaskBody(body, {
    'sections.evidence': 'Evidence.',
    'sections.outcome': 'Outcome.',
    'sections.nextStep': 'Next step.',
  });

  assert.equal(actual, [
    '# Title',
    '',
    '## Outcome',
    'Outcome.',
    '',
    '## Next step',
    'Next step.',
    '',
    '## Evidence',
    'Evidence.',
    '',
    '## Changelog',
    '- Original release note.',
    '',
  ].join('\n'));
});

test('missing sections inherit CRLF and retain the source final-newline state', () => {
  const crlfBody = '# Title\r\n\r\n## Changelog\r\n- Original.\r\n';
  assert.equal(
    patchTaskBody(crlfBody, { 'sections.outcome': 'Added.' }),
    '# Title\r\n\r\n## Outcome\r\nAdded.\r\n\r\n## Changelog\r\n- Original.\r\n',
  );

  assert.equal(
    patchTaskBody('# Title', { 'sections.evidence': 'Evidence.' }),
    '# Title\n\n## Evidence\nEvidence.',
  );
});

test('empty absent sections stay absent and H3 narrative structure remains editable', () => {
  const body = '# Title\n\n## Changelog\n- Original.\n';
  assert.equal(patchTaskBody(body, { 'sections.outcome': '  \n\t' }), body);

  const value = 'Overview\n### Details\nSupporting detail.';
  const patched = patchTaskBody(body, { 'sections.outcome': value });
  assert.equal(readTaskContentValues(patched)['sections.outcome'], value);
});

test('ambiguous changelog anchors and missing title targets are rejected', () => {
  assert.throws(
    () => patchTaskBody('# Title\n\n## Changelog\nOne.\n\n## changelog\nTwo.', { 'sections.outcome': 'Added.' }),
    /multiple Changelog headings/i,
  );
  assert.throws(
    () => patchTaskBody('## Outcome\nValue', { title: 'New title' }),
    /no H1 title/i,
  );
  assert.equal(patchTaskBody('#', { title: 'Project title' }), '# Project title');
});

test('fenced headings in edited narrative values remain code, not structure', () => {
  const body = '# Title\n\n## Outcome\nOld.\n\n## Changelog\n- Keep.\n';
  const value = 'Example:\n```md\n# Title in code\n## Outcome in code\n```';
  const actual = patchTaskBody(body, { 'sections.outcome': value });

  assert.equal(readTaskContentValues(actual)['sections.outcome'], value);
});

test('duplicate or ambiguous target headings and unclosed fences are rejected', () => {
  assert.throws(
    () => readTaskContentValues('# First\n\n# Second\n\n## Outcome\nValue'),
    /multiple H1|duplicate title/i,
  );
  assert.throws(
    () => readTaskContentValues('# Title\n\n## Outcome\nOne\n\n## outcome\nTwo'),
    /duplicate.*outcome/i,
  );
  assert.throws(
    () => patchTaskBody('# Title\n\n## Outcome\n```md\n## Hidden', {}),
    /unclosed fence/i,
  );
});

test('narrative values cannot inject top-level headings or leave fences open', () => {
  const body = '# Title\n\n## Outcome\nOld.\n\n## Changelog\n- Keep.\n';

  assert.throws(
    () => patchTaskBody(body, { 'sections.outcome': 'Text\n## New section' }),
    /top-level H1 or H2/i,
  );
  assert.throws(
    () => patchTaskBody(body, { 'sections.outcome': '# New title' }),
    /top-level H1 or H2/i,
  );
  assert.throws(
    () => patchTaskBody(body, { 'sections.outcome': '```md\nunfinished' }),
    /unclosed fence/i,
  );
  assert.throws(
    () => patchTaskBody(body, { title: 'First line\n## Injected section' }),
    /single line/i,
  );
});

test('the patcher rejects unknown fields and non-string replacements', () => {
  const body = '# Title\n\n## Outcome\nValue';

  assert.throws(() => patchTaskBody(body, { status: 'done' }), /unknown editable field/i);
  assert.throws(() => patchTaskBody(body, { 'sections.outcome': 42 }), /must be a string/i);
  assert.throws(() => normalizeTaskContentValue('status', 'done'), /unknown editable field/i);
});
