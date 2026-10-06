const SAFE_LINK_PROTOCOL = /^(?:https?:|mailto:)/i;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function safeHref(value) {
  const href = String(value ?? '').trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (SAFE_LINK_PROTOCOL.test(href)) return href;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (href.startsWith('#')) return href;
  return null;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function isWordCharacter(value) {
  return value !== '' && WORD_CHARACTER.test(value);
}

function lower(value) {
  return String(value ?? '').toLocaleLowerCase();
}

function mentionCandidates(options) {
  const values = typeof options.mentionCandidates === 'function'
    ? options.mentionCandidates()
    : options.mentionCandidates;
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(value => String(value ?? '').trim())
    .filter(value => value.length > 0))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function sourceRanges(source, pattern) {
  const ranges = [];
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function overlapsRange(start, end, ranges) {
  return ranges.some(range => start < range.end && end > range.start);
}

function protectedMentionRanges(source) {
  // These are source ranges, rather than rendered HTML ranges. That keeps the
  // mention pass independent from any generated tags and prevents nested links.
  return [
    ...sourceRanges(source, /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]+/giu),
    ...sourceRanges(source, /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu),
    ...sourceRanges(source, /(?<![\p{L}\p{N}_])(?:\.{0,2}\/)?[\p{L}\p{N}_~:@%+.,-]+(?:[\\/][\p{L}\p{N}_~:@%+.,-]+)+(?:[?#][^\s]*)?/gu),
  ];
}

function mentionResultFor(candidate, options) {
  if (typeof options.resolveMention !== 'function') return null;
  return options.resolveMention(candidate);
}

function mentionHref(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.href === 'string') return result.href;
  return null;
}

function segmentedMentionMatches(source, options) {
  if (typeof options.segmentMentions !== 'function') return null;
  const segments = options.segmentMentions(source);
  if (!Array.isArray(segments)) return null;

  const matches = [];
  let cursor = 0;
  for (const segment of segments) {
    const text = String(segment?.text ?? '');
    if (!text || source.slice(cursor, cursor + text.length) !== text) return null;
    if (segment?.person) {
      const result = typeof options.resolveMention === 'function'
        ? options.resolveMention(text, segment.person)
        : null;
      if (result && mentionHref(result)) {
        matches.push({ start: cursor, end: cursor + text.length, text, result });
      }
    }
    cursor += text.length;
  }
  return cursor === source.length ? matches : null;
}

function mentionMatches(source, options) {
  const segmented = segmentedMentionMatches(source, options);
  if (segmented !== null) return segmented;

  const candidates = mentionCandidates(options);
  if (!candidates.length || typeof options.resolveMention !== 'function') return [];

  const protectedRanges = protectedMentionRanges(source);
  const matches = [];
  let cursor = 0;
  while (cursor < source.length) {
    let lexical = null;
    for (const candidate of candidates) {
      const end = cursor + candidate.length;
      if (end > source.length || lower(source.slice(cursor, end)) !== lower(candidate)) continue;
      if (cursor > 0 && isWordCharacter(source[cursor - 1]) && isWordCharacter(candidate[0])) continue;
      if (end < source.length && isWordCharacter(source[end - 1]) && isWordCharacter(source[end])) continue;
      lexical = { start: cursor, end, text: source.slice(cursor, end), candidate };
      break;
    }
    const selected = lexical && !overlapsRange(lexical.start, lexical.end, protectedRanges)
      ? (() => {
          const result = mentionResultFor(lexical.text, options);
          return result && mentionHref(result) ? { ...lexical, result } : null;
        })()
      : null;
    if (selected) {
      matches.push(selected);
      cursor = selected.end;
    } else {
      cursor += 1;
    }
  }
  return matches;
}

function renderMention(result, text) {
  const href = safeHref(mentionHref(result));
  if (!href) return escapeHtml(text);
  return `<a href="${escapeAttribute(href)}">${escapeHtml(text)}</a>`;
}

function renderText(value, options, allowMentions = true) {
  const source = String(value ?? '');
  if (!allowMentions) return escapeHtml(source);
  const matches = mentionMatches(source, options);
  if (!matches.length) return escapeHtml(source);

  let output = '';
  let cursor = 0;
  for (const match of matches) {
    output += escapeHtml(source.slice(cursor, match.start));
    output += renderMention(match.result, match.text);
    cursor = match.end;
  }
  return output + escapeHtml(source.slice(cursor));
}

function renderInline(value, options = {}) {
  const source = String(value ?? '');
  const linkPattern = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let output = '';
  let cursor = 0;
  let match;

  while ((match = linkPattern.exec(source))) {
    if (isInsideInlineCode(source, match.index)) continue;
    output += renderInlineMarks(source.slice(cursor, match.index), options);
    const resolved = typeof options.resolveLink === 'function' ? options.resolveLink(match[2]) : match[2];
    const href = safeHref(resolved ?? match[2]);
    if (href) {
      const external = SAFE_LINK_PROTOCOL.test(href);
      const target = external ? ' target="_blank" rel="noreferrer"' : '';
      // A Markdown anchor owns its label. Do not create nested profile links.
      output += `<a href="${escapeAttribute(href)}"${target}>${renderInlineMarks(match[1], options, false)}</a>`;
    } else {
      output += renderInlineMarks(match[1], options, false);
    }
    cursor = match.index + match[0].length;
  }
  output += renderInlineMarks(source.slice(cursor), options);
  return output;
}

/** Render inline Markdown without wrapping the result in a paragraph block. */
export function renderMarkdownInline(markdown, options = {}) {
  return renderInline(String(markdown ?? ''), options);
}

function isInsideInlineCode(source, index) {
  let cursor = 0;
  while (cursor < index) {
    const start = source.indexOf('`', cursor);
    if (start < 0 || start >= index) return false;
    const span = inlineCodeSpanAt(source, start);
    if (span.end > index || !span.matched) return true;
    cursor = span.end;
  }
  return false;
}

function backtickRunLength(source, index) {
  let length = 0;
  while (source[index + length] === '`') length += 1;
  return length;
}

function inlineCodeSpanAt(source, index) {
  const length = backtickRunLength(source, index);
  let cursor = index + length;
  while (cursor < source.length) {
    if (source[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    const closingLength = backtickRunLength(source, cursor);
    if (closingLength === length) return { matched: true, end: cursor + closingLength, contentEnd: cursor };
    cursor += closingLength;
  }
  return { matched: false, end: source.length, contentEnd: source.length };
}

function renderInlineMarks(value, options = {}, allowMentions = true) {
  const source = String(value ?? '');
  const tokenPattern = /\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const codeStart = source.indexOf('`', cursor);
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(source);
    if (codeStart >= 0 && (match === null || codeStart < match.index)) {
      output += renderText(source.slice(cursor, codeStart), options, allowMentions);
      const runLength = backtickRunLength(source, codeStart);
      const span = inlineCodeSpanAt(source, codeStart);
      if (!span.matched) {
        output += escapeHtml(source.slice(codeStart));
        return output;
      }
      output += `<code>${escapeHtml(source.slice(codeStart + runLength, span.contentEnd))}</code>`;
      cursor = span.end;
      continue;
    }
    if (match === null) return output + renderText(source.slice(cursor), options, allowMentions);
    output += renderText(source.slice(cursor, match.index), options, allowMentions);
    if (match[1] !== undefined) output += `<strong>${renderInlineMarks(match[1], options, allowMentions)}</strong>`;
    else if (match[2] !== undefined) output += `<strong>${renderInlineMarks(match[2], options, allowMentions)}</strong>`;
    else if (match[3] !== undefined) output += `<em>${renderInlineMarks(match[3], options, allowMentions)}</em>`;
    else output += `<em>${renderInlineMarks(match[4], options, allowMentions)}</em>`;
    cursor = match.index + match[0].length;
  }
  return output;
}

function renderList(items, ordered, options = {}) {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map(item => `<li>${renderInline(item, options)}</li>`).join('')}</${tag}>`;
}

/**
 * Render the small Markdown subset used by tracker records.
 * All source text is escaped before markup is added, and unsafe URLs become text.
 */
export function renderMarkdown(markdown, options = {}) {
  const lines = String(markdown ?? '').replaceAll('\r\n', '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  let ordered = false;
  let fence = null;
  let fencedLines = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${paragraph.map(line => renderInline(line, options)).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(renderList(list, ordered, options));
      list = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) {
        blocks.push(`<pre><code>${escapeHtml(fencedLines.join('\n'))}</code></pre>`);
        fence = null;
        fencedLines = [];
      } else {
        fencedLines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      flushList();
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      fencedLines = [];
      continue;
    }
    const heading = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    const unorderedItem = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
    const orderedItem = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);

    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(`<h${level}>${renderInline(heading[2], options)}</h${level}>`);
    } else if (unorderedItem || orderedItem) {
      flushParagraph();
      const nextOrdered = Boolean(orderedItem);
      if (list.length && ordered !== nextOrdered) flushList();
      ordered = nextOrdered;
      list.push((unorderedItem ?? orderedItem)[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  if (fence) blocks.push(`<pre><code>${escapeHtml(fencedLines.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return blocks.join('');
}
