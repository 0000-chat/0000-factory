import {
  extractMarkdownSections,
  extractMarkdownTitle,
  normalizeNarrativeValue,
  normalizeTaskTitle,
  scanMarkdownHeadings,
} from './markdown.mjs';

const sectionFields = [
  { field: 'sections.outcome', heading: 'Outcome', key: 'outcome' },
  { field: 'sections.completionCondition', heading: 'Completion condition', key: 'completion condition' },
  { field: 'sections.nextStep', heading: 'Next step', key: 'next step' },
  { field: 'sections.evidence', heading: 'Evidence', key: 'evidence' },
];
const sectionFieldByName = new Map(sectionFields.map(section => [section.field, section]));
const editableFields = new Set(['title', ...sectionFields.map(section => section.field)]);
const sectionRank = new Map(sectionFields.map((section, index) => [section.key, index]));

function requireEditableField(field) {
  if (!editableFields.has(field)) throw new Error(`unknown editable field: ${field}`);
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} replacement must be a string`);
}

export function normalizeTaskContentValue(field, value) {
  requireEditableField(field);
  requireString(value, field);
  return field === 'title' ? normalizeTaskTitle(value) : normalizeNarrativeValue(value);
}

function validateSourceHeadings(body, scan) {
  if (scan.unclosedFence) throw new Error('task body contains an unclosed fenced code block');

  const titles = scan.headings.filter(heading => heading.level === 1);
  if (titles.length > 1) throw new Error('task body has multiple H1 title headings');

  const counts = new Map();
  for (const heading of scan.headings) {
    if (heading.level !== 2) continue;
    const key = heading.text.toLowerCase();
    if (!sectionRank.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) throw new Error(`task body has duplicate target heading: ${key}`);
  }

  return { titles };
}

export function readTaskContentValues(body) {
  requireString(body, 'task body');
  const scan = scanMarkdownHeadings(body);
  const { titles } = validateSourceHeadings(body, scan);
  const title = titles.length === 0 ? '' : extractMarkdownTitle(body) ?? '';
  const sections = extractMarkdownSections(body);

  return {
    title: normalizeTaskTitle(title),
    'sections.outcome': normalizeNarrativeValue(sections.outcome ?? ''),
    'sections.completionCondition': normalizeNarrativeValue(sections['completion condition'] ?? ''),
    'sections.nextStep': normalizeNarrativeValue(sections['next step'] ?? ''),
    'sections.evidence': normalizeNarrativeValue(sections.evidence ?? ''),
  };
}

function sourceLineRanges(body, lineCount) {
  const ranges = [];
  let start = 0;
  for (let index = 0; index < lineCount; index += 1) {
    const newline = body.indexOf('\n', start);
    if (newline < 0) {
      ranges.push({ start, contentEnd: body.length, end: body.length, eol: '' });
      start = body.length;
      continue;
    }
    const contentEnd = newline > start && body[newline - 1] === '\r' ? newline - 1 : newline;
    ranges.push({ start, contentEnd, end: newline + 1, eol: body.slice(contentEnd, newline + 1) });
    start = newline + 1;
  }
  return ranges;
}

function preferredLineEnding(body) {
  const firstNewline = /\r\n|\n/.exec(body)?.[0];
  return firstNewline ?? '\n';
}

function replaceLineEndings(value, eol) {
  return value.replaceAll('\n', eol);
}

function splitRawLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) {
      const raw = text.slice(start);
      lines.push({ raw, content: raw, eol: '' });
      break;
    }
    const contentEnd = newline > start && text[newline - 1] === '\r' ? newline - 1 : newline;
    const raw = text.slice(start, newline + 1);
    lines.push({ raw, content: text.slice(start, contentEnd), eol: text.slice(contentEnd, newline + 1) });
    start = newline + 1;
  }
  return lines;
}

function replaceSectionRegion(region, value, eol, hasFollowingHeading, headerHasTerminator) {
  const content = replaceLineEndings(value, eol);
  const lines = splitRawLines(region);
  const firstContent = lines.findIndex(line => line.content.trim() !== '');

  if (firstContent < 0) {
    if (content === '') return region;
    if (lines.length === 0) {
      return `${headerHasTerminator ? '' : eol}${content}${hasFollowingHeading ? eol : ''}`;
    }
    return `${content}${eol}${region}`;
  }

  let lastContent = lines.length - 1;
  while (lastContent >= firstContent && lines[lastContent].content.trim() === '') lastContent -= 1;
  const prefix = lines.slice(0, firstContent).map(line => line.raw).join('');
  const suffix = lines.slice(lastContent + 1).map(line => line.raw).join('');
  const finalContentLineEnding = lines[lastContent].eol || (hasFollowingHeading ? eol : '');

  if (content === '') return `${prefix}${finalContentLineEnding}${suffix}`;
  return `${prefix}${content}${finalContentLineEnding}${suffix}`;
}

function headingOffsets(scan, lineRanges) {
  return scan.headings.map(heading => {
    const line = lineRanges[heading.index];
    if (!line) throw new Error('task body heading could not be mapped to its source bytes');
    return { ...heading, start: line.start, contentEnd: line.contentEnd };
  });
}

function headingPrefix(raw) {
  const match = /^( {0,3}#(?:[ \t]+|$))/.exec(raw);
  if (!match) throw new Error('task body H1 title has unsupported heading syntax');
  return match[0].endsWith('#') ? `${match[0]} ` : match[0];
}

function sectionRange(heading, headings, bodyLength, lineRanges) {
  const following = headings.find(candidate => candidate.index > heading.index && candidate.level <= 2);
  const end = following ? lineRanges[following.index].start : bodyLength;
  const headerLine = lineRanges[heading.index];
  return {
    start: headerLine.end,
    end,
    headerHasTerminator: headerLine.eol !== '',
    hasFollowingHeading: following !== undefined,
  };
}

function lineEndingForSection(body, range, lineRanges) {
  for (const line of lineRanges) {
    if (line.start >= range.start && line.start < range.end && line.eol) return line.eol;
  }
  const headerEnding = lineRanges.find(line => line.end === range.start)?.eol;
  return headerEnding || preferredLineEnding(body);
}

function trailingLineBreakCount(text) {
  const match = /(?:(?:\r\n|\n|\r)[ \t]*)*$/.exec(text);
  return (match?.[0].match(/\r\n|\n|\r/g) ?? []).length;
}

function sectionInsertionText(entries, eol, sourcePrefix, isAtEnd, sourceEndsWithNewline) {
  const leadingBreaks = trailingLineBreakCount(sourcePrefix);
  const leading = sourcePrefix.length === 0 ? '' : eol.repeat(Math.max(0, 2 - leadingBreaks));
  const sections = entries.map(({ section, value }) => `## ${section.heading}${eol}${replaceLineEndings(value, eol)}`);
  const between = `${eol}${eol}`;
  const trailing = isAtEnd ? (sourceEndsWithNewline ? eol : '') : between;
  return `${leading}${sections.join(between)}${trailing}`;
}

function validateReplacement(field, value) {
  if (field === 'title') {
    if (!value) throw new Error('task title must contain non-whitespace text');
    if (/[\r\n]/.test(value)) throw new Error('task title must be a single line');
    return;
  }

  const scan = scanMarkdownHeadings(value);
  if (scan.unclosedFence) throw new Error(`${field} contains an unclosed fenced code block`);
  if (scan.headings.some(heading => heading.level <= 2) || hasSetextHeading(value, scan.lines)) {
    throw new Error(`${field} cannot contain a top-level H1 or H2 heading`);
  }
}

function hasSetextHeading(value, lines) {
  const openingFence = /^ {0,3}(`{3,}|~{3,})/;
  const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/;
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = openingFence.exec(line);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    if (line.trim() !== '' && setextUnderline.test(lines[index + 1] ?? '')) return true;
  }
  return false;
}

/**
 * Apply already-authorized task-content values to a Markdown body.
 * Callers must verify the submitted baseline; a missing section is safe to add
 * only when both its current projection and submitted baseline are empty.
 */
export function patchTaskBody(body, fields) {
  requireString(body, 'task body');
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new TypeError('task content fields must be an object');
  }

  const entries = Object.entries(fields);
  for (const [field, value] of entries) {
    requireEditableField(field);
    requireString(value, field);
  }

  const before = readTaskContentValues(body);
  const sourceScan = scanMarkdownHeadings(body);
  const lineRanges = sourceLineRanges(body, sourceScan.lines.length);
  const headings = headingOffsets(sourceScan, lineRanges);
  const operations = [];
  const insertions = new Map();
  const normalizedChanges = new Map();

  for (const [field, rawValue] of entries) {
    const value = normalizeTaskContentValue(field, rawValue);
    validateReplacement(field, value);
    normalizedChanges.set(field, value);
    if (value === before[field]) continue;

    if (field === 'title') {
      const titleHeading = headings.find(heading => heading.level === 1);
      if (!titleHeading) throw new Error('task body has no H1 title heading to update');
      const prefix = headingPrefix(titleHeading.raw);
      operations.push({ start: titleHeading.start, end: titleHeading.contentEnd, text: `${prefix}${value}` });
      continue;
    }

    const section = sectionFieldByName.get(field);
    const target = headings.find(heading => heading.level === 2 && heading.text.toLowerCase() === section.key);
    if (!target) {
      if (value === '') continue;
      insertions.set(field, { section, value });
      continue;
    }

    const range = sectionRange(target, headings, body.length, lineRanges);
    const eol = lineEndingForSection(body, range, lineRanges);
    const currentRegion = body.slice(range.start, range.end);
    const replacement = replaceSectionRegion(
      currentRegion,
      value,
      eol,
      range.hasFollowingHeading,
      range.headerHasTerminator,
    );
    operations.push({ start: range.start, end: range.end, text: replacement });
  }

  if (insertions.size > 0) {
    const changelogs = headings.filter(heading => heading.level === 2 && heading.text.toLowerCase() === 'changelog');
    if (changelogs.length > 1) throw new Error('task body has multiple Changelog headings; insertion point is ambiguous');
    const changelog = changelogs[0];
    const maxBeforeChangelog = changelog?.index ?? Number.POSITIVE_INFINITY;
    const insertionGroups = new Map();

    for (const insertion of insertions.values()) {
      const laterCanonical = headings
        .filter(heading => heading.level === 2
          && sectionRank.has(heading.text.toLowerCase())
          && sectionRank.get(heading.text.toLowerCase()) > sectionRank.get(insertion.section.key)
          && heading.index < maxBeforeChangelog)
        .sort((left, right) => left.index - right.index)[0];
      const anchor = laterCanonical ?? changelog;
      const position = anchor ? lineRanges[anchor.index].start : body.length;
      const group = insertionGroups.get(position) ?? [];
      group.push(insertion);
      insertionGroups.set(position, group);
    }

    const sourceEndsWithNewline = /(?:\r\n|\n)$/.test(body);
    for (const [position, group] of insertionGroups) {
      group.sort((left, right) => sectionRank.get(left.section.key) - sectionRank.get(right.section.key));
      const anchorLine = lineRanges.find(line => line.start === position);
      const eol = anchorLine?.eol || preferredLineEnding(body);
      const text = sectionInsertionText(
        group,
        eol,
        body.slice(0, position),
        position === body.length,
        sourceEndsWithNewline,
      );
      operations.push({ start: position, end: position, text });
    }
  }

  let patched = body;
  for (const operation of operations.sort((left, right) => right.start - left.start || right.end - left.end)) {
    patched = `${patched.slice(0, operation.start)}${operation.text}${patched.slice(operation.end)}`;
  }

  const after = readTaskContentValues(patched);
  for (const [field, value] of normalizedChanges) {
    if (after[field] !== value) throw new Error(`patched ${field} did not round-trip through the task content projector`);
  }
  return patched;
}
