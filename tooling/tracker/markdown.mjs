const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const headingLine = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/;

export function scanMarkdownHeadings(markdown) {
  const lines = String(markdown ?? '').replaceAll('\r\n', '\n').split('\n');
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence !== null) {
      const close = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`).test(line);
      if (close) fence = null;
      continue;
    }
    const opening = openingFence.exec(line);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    const heading = headingLine.exec(line);
    if (heading) headings.push({ index, level: heading[2].length, text: heading[3].trim(), raw: line });
  }
  return { lines, headings, unclosedFence: fence !== null };
}

export function extractMarkdownTitle(markdown) {
  const { headings } = scanMarkdownHeadings(markdown);
  const title = headings.filter(heading => heading.level === 1);
  return title[0]?.text ?? null;
}

export function normalizeTaskTitle(value) {
  return String(value ?? '').trim();
}

/**
 * Canonical narrative text used by projection, approval digests, and publishing.
 * Keep indentation and internal trailing spaces because both can carry Markdown
 * meaning. Only line-ending differences and whitespace outside the content are
 * semantically insignificant.
 */
export function normalizeNarrativeValue(value) {
  const lines = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1].replace(/[ \t]+$/, '');
  return lines.join('\n');
}

export function extractMarkdownSections(markdown) {
  const { lines, headings } = scanMarkdownHeadings(markdown);
  const sections = {};
  let current = null;
  let buffer = [];
  let lineIndex = 0;
  const flush = () => {
    if (current !== null) sections[current] = normalizeNarrativeValue(buffer.join('\n'));
  };
  for (const heading of headings.filter(candidate => candidate.level <= 2)) {
    if (current !== null) buffer.push(...lines.slice(lineIndex, heading.index));
    flush();
    current = heading.level === 2 ? heading.text.toLowerCase() : null;
    buffer = [];
    lineIndex = heading.index + 1;
  }
  if (current !== null) buffer.push(...lines.slice(lineIndex));
  flush();
  return sections;
}
