// parse.js — a fast, dependency-free Markdown renderer whose output is
// byte-identical to what marked 18.1.3 produces with its default options
// (gfm: true, breaks: false, pedantic: false, async: false).
//
// The design is deliberately unlike a regex-grammar renderer:
//
//   * Block structure is found by scanning lines. At each block boundary the
//     lexer inspects the start of the current line and only runs the
//     matchers that could apply there, instead of testing a battery of
//     anchored expressions for every block.
//   * Inline content is walked once with a cursor. Text runs, emphasis,
//     strikethrough, links and code spans each have a hand-written scanner
//     working on indices into the source string.
//
// A few behaviours of the reference renderer are surprising — the way
// blockquote chunks are re-joined, how list looseness is decided, where
// exactly a paragraph stops. Those behaviours are part of the output
// contract, so they are reproduced on purpose and flagged in comments.

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_CHARS = /[&<>"']/g;
const ESCAPE_TEST_PLAIN = /[<>\"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_CHARS_PLAIN = /[<>\"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// HTML-escape a string. With `encode` set, every special character is
// replaced; without it, an ampersand that already introduces an entity-like
// sequence is left alone.
function escapeHtml(text, encode) {
  if (encode) {
    if (!ESCAPE_TEST.test(text)) return text;
    return text.replace(ESCAPE_CHARS, (c) => ESCAPE_MAP[c]);
  }
  if (!ESCAPE_TEST_PLAIN.test(text)) return text;
  return text.replace(ESCAPE_CHARS_PLAIN, (c) => ESCAPE_MAP[c]);
}

const NUMERIC_REF_TEST = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const NUMERIC_REF_OR_AMP =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Inline text gets its numeric character references decoded (and stray
// ampersands escaped), but only when the text contains at least one numeric
// reference in the first place. Named entities are never decoded.
function decodeNumericRefs(text) {
  if (!NUMERIC_REF_TEST.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const value = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      return '\ufffd';
    }
    if (value === 38) return '&amp;';
    return String.fromCodePoint(value);
  });
}

// encodeURI a link destination, undoing the %25 doubling of literal percent
// signs; a URI that cannot be encoded at all makes the link render as its
// text only, signalled by null here.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Reference keys for link definitions: trimmed, whitespace-collapsed,
// case-folded (the double case conversion mirrors the reference exactly).
function normalizeLabel(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove trailing copies of a single character.
function stripTrailing(text, ch) {
  let end = text.length;
  while (end > 0 && text[end - 1] === ch) end--;
  return end === text.length ? text : text.slice(0, end);
}

// Balance scan for the bracket pair (open, close) over a string, honouring
// backslash escapes: -1 means "no pair characters, or balanced", a
// non-negative result is the index of an unbalanced closer, and -2 means an
// opener was left unclosed.
function bracketBalance(text, open, close) {
  if (!text.includes(open) && !text.includes(close)) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Drop trailing blank lines from a block's raw text, but keep the source
// untouched when at most two lines trail the last content line.
function trimBlankTail(source) {
  const lines = source.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  if (lines.length - last <= 2) return source;
  return lines.slice(0, last + 1).join('\n');
}

// Expand tabs to spaces, counting columns from `startCol`; a tab advances
// to the next multiple-of-four column.
function expandTabs(text, startCol) {
  let col = startCol || 0;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into cells on its unescaped pipes. Escaped pipes (\|)
// stay in the cell and are unescaped at the end.
function splitCells(row, count) {
  const spaced = row.replace(/\|/g, (match, offset, whole) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && whole[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Undo backslash escapes of punctuation characters.
function unescapePunct(text) {
  if (!text.includes('\\')) return text;
  return text.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;

function isPunctOrSymbol(ch) {
  return ch !== '' && PUNCT_OR_SYMBOL.test(ch);
}

// The reference's "punctuation" test for delimiter runs: whitespace,
// punctuation or symbol, but never the emphasis characters themselves.
function isDelimiterPunct(ch) {
  if (!ch || ch === '*' || ch === '_') return false;
  return /[\s\p{P}\p{S}]/u.test(ch);
}

function isAlphaNumeric(ch) {
  return ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}

// Length in UTF-16 units of the first code point of a string.
function firstCodePointLength(text) {
  return text.codePointAt(0) > 0xffff ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Rendering: tokens -> HTML strings
// ---------------------------------------------------------------------------

function renderTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) out += renderBlockToken(tokens[i]);
  return out;
}

function renderBlockToken(tok) {
  switch (tok.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return (
        '<h' + tok.depth + '>' + renderInline(tok.tokens, false) +
        '</h' + tok.depth + '>\n'
      );
    case 'code': {
      const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
      const escaped = escapeHtml(body, true);
      const word = tok.lang ? /^\S*/.exec(tok.lang)[0] : '';
      if (word) {
        return (
          '<pre><code class="language-' + escapeHtml(word, false) + '">' +
          escaped + '</code></pre>\n'
        );
      }
      return '<pre><code>' + escaped + '</code></pre>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n';
    case 'html':
      return tok.text;
    case 'paragraph':
      return '<p>' + renderInline(tok.tokens, false) + '</p>\n';
    case 'text':
      return renderTextToken(tok, false);
    case 'list':
      return renderList(tok);
    case 'checkbox':
      return renderCheckbox(tok);
    case 'table':
      return renderTable(tok);
    default:
      return '';
  }
}

function renderList(list) {
  let items = '';
  for (const item of list.items) {
    items += '<li>' + renderTokens(item.tokens) + '</li>\n';
  }
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ' start="' + list.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

function renderCheckbox(tok) {
  return (
    '<input ' + (tok.checked ? 'checked="" ' : '') +
    'disabled="" type="checkbox"> '
  );
}

function renderTable(table) {
  let head = '';
  for (const cell of table.header) head += renderTableCell(cell);
  let out = '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
  if (table.rows.length > 0) {
    let body = '';
    for (const row of table.rows) {
      let cells = '';
      for (const cell of row) cells += renderTableCell(cell);
      body += '<tr>\n' + cells + '</tr>\n';
    }
    out += '<tbody>' + body + '</tbody>';
  }
  return out + '</table>\n';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ' align="' + cell.align + '"' : '';
  return (
    '<' + tag + align + '>' + renderInline(cell.tokens, false) +
    '</' + tag + '>\n'
  );
}

// Text tokens render their already-lexed children when they have any; the
// plain-text flavour (used for image alt text) never escapes.
function renderTextToken(tok, plain) {
  if (tok.tokens) return renderInline(tok.tokens, plain);
  if (tok.escaped) return tok.text;
  return plain ? tok.text : escapeHtml(tok.text, false);
}

function renderInline(tokens, plain) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'escape':
      case 'text':
        out += renderTextToken(tok, plain);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'strong':
        out += plain
          ? renderInline(tok.tokens, true)
          : '<strong>' + renderInline(tok.tokens, false) + '</strong>';
        break;
      case 'em':
        out += plain
          ? renderInline(tok.tokens, true)
          : '<em>' + renderInline(tok.tokens, false) + '</em>';
        break;
      case 'del':
        out += plain
          ? renderInline(tok.tokens, true)
          : '<del>' + renderInline(tok.tokens, false) + '</del>';
        break;
      case 'codespan':
        out += plain ? tok.text : '<code>' + escapeHtml(tok.text, true) + '</code>';
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'checkbox':
        out += plain ? tok.raw : renderCheckbox(tok);
        break;
      case 'link':
        out += plain
          ? renderInline(tok.tokens, true)
          : renderLink(tok);
        break;
      case 'image':
        out += plain
          ? renderInline(tok.tokens, true)
          : renderImage(tok);
        break;
      default:
        break;
    }
  }
  return out;
}

function renderLink(tok) {
  const inner = tok.autolink
    ? escapeHtml(tok.text, true)
    : renderInline(tok.tokens, false);
  const url = cleanUrl(tok.href);
  if (url === null) return inner;
  let out = '<a href="' + escapeHtml(url, tok.autolink ? true : false) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title, false) + '"';
  return out + '>' + inner + '</a>';
}

function renderImage(tok) {
  const alt = tok.tokens ? renderInline(tok.tokens, true) : tok.text;
  const url = cleanUrl(tok.href);
  if (url === null) return escapeHtml(alt, false);
  let out =
    '<img src="' + escapeHtml(url, false) + '" alt="' + escapeHtml(alt, false) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title, false) + '"';
  return out + '>';
}

// ---------------------------------------------------------------------------
// Block lexing
//
// Tokens are plain objects. Block constructs that contain inline text queue
// a job ({ src, tokens }) on ctx.queue at creation time; the jobs run after
// the whole block pass, in creation order, which is what lets link
// references resolve forwards and lets the token-merge fixups below find
// the job they need to rewrite.
// ---------------------------------------------------------------------------

function queueInline(ctx, src) {
  const tokens = [];
  ctx.queue.push({ src, tokens });
  return tokens;
}

// The first line of `e`, without its newline.
function firstLine(e) {
  const idx = e.indexOf('\n');
  return idx === -1 ? e : e.slice(0, idx);
}

function countLeadingSpaces(line) {
  let i = 0;
  while (line[i] === ' ') i++;
  return i;
}

const BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col ' +
    'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form frame frameset head header hr html iframe legend li link ' +
    'main menu menuitem meta nav noframes ol optgroup option p param search ' +
    'section summary table tbody td tfoot th thead title tr track ul'
  ).split(' ')
);

function isBlockTagName(name) {
  return BLOCK_TAGS.has(name) || /^h[1-6]$/.test(name);
}

// A thematic-break line: at most `maxIndent` leading spaces, then three or
// more copies of one of -, _, * mixed with spaces/tabs and nothing else.
function isHrLine(line, maxIndent) {
  let i = countLeadingSpaces(line);
  if (i > maxIndent) return false;
  const marker = line[i];
  if (marker !== '-' && marker !== '_' && marker !== '*') return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === marker) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// An ATX heading start: at most `maxIndent` spaces, 1-6 '#', then whitespace
// or the end of the line.
function isHeadingLine(line, maxIndent) {
  let i = countLeadingSpaces(line);
  if (i > maxIndent) return false;
  let run = 0;
  while (line[i + run] === '#') run++;
  if (run < 1 || run > 6) return false;
  const after = line[i + run];
  return after === undefined || /\s/.test(after);
}

// The "an HTML block could start here" test shared by the paragraph and
// blockquote stop sets (case-sensitive tag names, as in the composed
// reference patterns) and by list-item continuation checks (where the
// reference builds the same test case-insensitively). `i` is the index of
// '<' in the line.
function htmlBeginAt(line, i, insensitive) {
  const rest = line.slice(i + 1);
  if (rest.startsWith('!--')) return true;
  if (rest.startsWith('?')) return true;
  if (rest.startsWith('![CDATA[')) return true;
  if (/^![A-Za-z]/.test(rest)) return true;
  const special = /^(script|pre|style|textarea)(?=[\s>]|$)/.exec(
    insensitive ? rest.toLowerCase() : rest
  );
  if (special) return true;
  let j = 0;
  if (rest[j] === '/') j++;
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest.slice(j));
  if (!nameMatch) return false;
  let name = nameMatch[0];
  if (insensitive) name = name.toLowerCase();
  if (!isBlockTagName(name)) return false;
  const after = rest.slice(j + nameMatch[0].length);
  return (
    after === '' || after[0] === ' ' || after[0] === '>' || after.startsWith('/>')
  );
}

function isHtmlStopLine(line, insensitive) {
  const i = countLeadingSpaces(line);
  return i <= 3 && line[i] === '<' && htmlBeginAt(line, i, insensitive);
}

// --- space -----------------------------------------------------------------

function matchSpace(e) {
  const c = e[0];
  if (c !== '\n' && c !== ' ' && c !== '\t') return null;
  const n = e.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && (e[j] === ' ' || e[j] === '\t')) j++;
    if (j === n) {
      i = n;
      break;
    }
    if (e[j] === '\n') {
      i = j + 1;
      continue;
    }
    break;
  }
  if (i === 0) return null;
  return { type: 'space', raw: e.slice(0, i) };
}

// --- indented code -----------------------------------------------------------

// A line that can carry indented-code content: a four-space indent (or up to
// three spaces and a tab) followed by at least one more character.
function isCodeContentLine(line) {
  if (line.startsWith('    ')) return line.length > 4;
  let sp = 0;
  while (line[sp] === ' ') sp++;
  return sp <= 3 && line[sp] === '\t' && line.length > sp + 1;
}

function stripCodeIndent(line) {
  let sp = 0;
  while (line[sp] === ' ') sp++;
  if (sp <= 3 && line[sp] === '\t') return line.slice(sp + 1);
  return line.slice(Math.min(sp, 4));
}

function matchIndentedCode(e) {
  const n = e.length;
  let pos = 0;
  let any = false;
  while (pos < n) {
    let le = e.indexOf('\n', pos);
    if (le === -1) le = n;
    if (!isCodeContentLine(e.slice(pos, le))) break;
    any = true;
    pos = le === n ? n : le + 1;
    // Blank lines after a content line belong to the same block.
    while (pos < n) {
      let le2 = e.indexOf('\n', pos);
      if (le2 === -1) le2 = n;
      if (!/^[ \t]*$/.test(e.slice(pos, le2))) break;
      pos = le2 === n ? n : le2 + 1;
    }
  }
  if (!any) return null;
  const raw = trimBlankTail(e.slice(0, pos));
  const text = raw.split('\n').map(stripCodeIndent).join('\n');
  return { type: 'code', raw, text, codeBlockStyle: 'indented' };
}

// --- fenced code -------------------------------------------------------------

function matchFences(e) {
  const sp = countLeadingSpaces(e);
  if (sp > 3) return null;
  const ch = e[sp];
  if (ch !== '`' && ch !== '~') return null;
  let run = 0;
  while (e[sp + run] === ch) run++;
  if (run < 3) return null;
  const n = e.length;
  let le = e.indexOf('\n', sp);
  if (le === -1) le = n;
  const info = e.slice(sp + run, le);
  if (ch === '`' && info.includes('`')) return null;
  let content;
  let raw;
  if (le === n) {
    content = '';
    raw = e;
  } else {
    // Look for a closing fence line: at most three spaces, a run of the
    // same character at least as long as the opening run, then only spaces.
    let pos = le + 1;
    let closeStart = -1;
    let closeEnd = -1;
    while (pos < n) {
      let le2 = e.indexOf('\n', pos);
      if (le2 === -1) le2 = n;
      const line = e.slice(pos, le2);
      const sp2 = countLeadingSpaces(line);
      if (sp2 <= 3 && line[sp2] === ch) {
        let run2 = 0;
        while (line[sp2 + run2] === ch) run2++;
        if (run2 >= run && /^ *$/.test(line.slice(sp2 + run2))) {
          closeStart = pos;
          closeEnd = le2;
          break;
        }
      }
      if (le2 === n) break;
      pos = le2 + 1;
    }
    if (closeStart === -1) {
      content = e.slice(le + 1);
      raw = e;
    } else {
      content = e.slice(le + 1, closeStart);
      raw = e.slice(0, closeEnd);
    }
    if (content.endsWith('\n')) content = content.slice(0, -1);
  }
  const text = adjustFenceIndent(raw, content);
  const lang = info ? unescapePunct(info.trim()) : info;
  return { type: 'code', raw, lang, text };
}

// When a backtick fence is itself indented, up to that much leading
// whitespace comes off every content line.
function adjustFenceIndent(raw, content) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (!m) return content;
  const indent = m[1].length;
  return content
    .split('\n')
    .map((line) => {
      const lead = /^\s+/.exec(line);
      if (!lead) return line;
      return line.slice(Math.min(lead[0].length, indent));
    })
    .join('\n');
}

// --- ATX heading ---------------------------------------------------------------

function matchHeading(ctx, e) {
  const sp = countLeadingSpaces(e);
  if (sp > 3 || e[sp] !== '#') return null;
  let run = 0;
  while (e[sp + run] === '#') run++;
  if (run > 6) return null;
  const after = e[sp + run];
  if (after !== undefined && !/\s/.test(after)) return null;
  const line = firstLine(e);
  let text = e.slice(sp + run, line.length).trim();
  if (text.endsWith('#')) {
    const stripped = stripTrailing(text, '#');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return {
    type: 'heading',
    raw: line,
    depth: run,
    text,
    tokens: queueInline(ctx, text),
  };
}

// --- thematic break ------------------------------------------------------------

function matchHr(e) {
  const line = firstLine(e);
  if (!isHrLine(line, 3)) return null;
  return { type: 'hr', raw: line };
}

// --- HTML block ------------------------------------------------------------------

// Skip the rest of the current line and any run of bare newlines after it.
function skipLineTailAndNewlines(e, end) {
  const idx = e.indexOf('\n', end);
  if (idx === -1) return e.length;
  end = idx;
  while (e[end] === '\n') end++;
  return end;
}

// The end of an HTML block whose content runs until a blank line: the match
// extends through the first run of blank lines, or to the end of input.
function htmlBlockEnd(e, from) {
  const n = e.length;
  let pos = from;
  while (pos < n) {
    const le = e.indexOf('\n', pos);
    if (le === -1) return n;
    let k = le + 1;
    while (k < n && (e[k] === ' ' || e[k] === '\t')) k++;
    if (k === n) return n;
    if (e[k] === '\n') {
      let end = k + 1;
      while (end < n) {
        let m = end;
        while (m < n && (e[m] === ' ' || e[m] === '\t')) m++;
        if (m < n && e[m] === '\n') end = m + 1;
        else break;
      }
      return end;
    }
    pos = le + 1;
  }
  return n;
}

// Scan a tag's attributes (block flavour: space separators, values may not
// contain newlines) starting at `pos`; returns the index just past the
// closing '>' or -1.
function scanBlockTagEnd(rest, pos) {
  let i = pos;
  for (;;) {
    let j = i;
    while (rest[j] === ' ') j++;
    if (rest[j] === '>') return j + 1;
    if (rest[j] === '/' && rest[j + 1] === '>') return j + 2;
    if (rest[i] !== ' ') return -1;
    while (rest[i] === ' ') i++;
    const nameMatch = /^[a-zA-Z:_][\w.:-]*/.exec(rest.slice(i));
    if (!nameMatch) return -1;
    i += nameMatch[0].length;
    let k = i;
    while (rest[k] === ' ') k++;
    if (rest[k] === '=') {
      k++;
      while (rest[k] === ' ') k++;
      const q = rest[k];
      if (q === '"' || q === "'") {
        const close = rest.indexOf(q, k + 1);
        if (close === -1 || rest.slice(k + 1, close).includes('\n')) return -1;
        i = close + 1;
      } else {
        const valueMatch = /^[^\s"'=<>`]+/.exec(rest.slice(k));
        if (!valueMatch) return -1;
        i = k + valueMatch[0].length;
      }
    }
  }
}

// Only spaces/tabs between `idx` and the end of the line (or of input).
function isLineEndAfter(rest, idx) {
  let i = idx;
  while (rest[i] === ' ' || rest[i] === '\t') i++;
  return i >= rest.length || rest[i] === '\n';
}

function htmlToken(e, end, pre) {
  const raw = trimBlankTail(e.slice(0, end));
  return { type: 'html', block: true, raw, text: raw, pre };
}

function matchHtmlBlock(e) {
  const sp = countLeadingSpaces(e);
  if (sp > 3 || e[sp] !== '<') return null;
  const rest = e.slice(sp);

  // Raw-text elements run to their matching close tag (or end of input).
  const rawTag = /^<(script|pre|style|textarea)(?=[\s>])/i.exec(rest);
  if (rawTag) {
    const name = rawTag[1];
    const afterName = name.length + 2;
    const closeMatch = new RegExp('</' + name + '>', 'i').exec(rest.slice(afterName));
    let end;
    if (closeMatch) {
      end = skipLineTailAndNewlines(
        e,
        sp + afterName + closeMatch.index + closeMatch[0].length
      );
    } else {
      end = e.length;
    }
    return htmlToken(e, end, name === 'pre' || name === 'script' || name === 'style');
  }

  // Comment.
  if (rest.startsWith('<!--')) {
    let end;
    if (rest[4] === '>') end = sp + 5;
    else if (rest.startsWith('->', 4)) end = sp + 6;
    else {
      const ci = rest.indexOf('-->', 4);
      end = ci === -1 ? e.length : sp + ci + 3;
    }
    if (end < e.length) end = skipLineTailAndNewlines(e, end);
    return htmlToken(e, end, false);
  }

  // Processing instruction.
  if (rest.startsWith('<?')) {
    const ci = rest.indexOf('?>', 2);
    const end = ci === -1 ? e.length : skipLineTailAndNewlines(e, sp + ci + 2);
    return htmlToken(e, end, false);
  }

  // Markup declaration.
  if (rest[1] === '!' && /[A-Za-z]/.test(rest[2] || '')) {
    const ci = rest.indexOf('>', 3);
    const end = ci === -1 ? e.length : skipLineTailAndNewlines(e, sp + ci + 1);
    return htmlToken(e, end, false);
  }

  // CDATA section.
  if (rest.startsWith('<![CDATA[')) {
    const ci = rest.indexOf(']]>', 9);
    const end = ci === -1 ? e.length : skipLineTailAndNewlines(e, sp + ci + 3);
    return htmlToken(e, end, false);
  }

  // A block-level tag (open or close) starts a block that runs to a blank
  // line; the tag name must be followed by space, a newline, '/>' or '>'.
  let j = 1;
  let closing = false;
  if (rest[j] === '/') {
    closing = true;
    j++;
  }
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest.slice(j));
  if (nameMatch) {
    const name = nameMatch[0];
    const afterIdx = j + name.length;
    const after = rest[afterIdx];
    const followOk =
      after === undefined ||
      after === ' ' ||
      after === '\t' ||
      after === '\n' ||
      after === '>' ||
      (after === '/' && rest[afterIdx + 1] === '>');
    if (followOk && isBlockTagName(name.toLowerCase())) {
      return htmlToken(e, htmlBlockEnd(e, sp + afterIdx), false);
    }
  }

  if (!closing) {
    // Any other well-formed tag alone on its line also opens a block.
    if (/[a-zA-Z]/.test(rest[1] || '')) {
      const genericName = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest.slice(1))[0];
      const lowered = genericName.toLowerCase();
      const excluded =
        lowered === 'script' || lowered === 'pre' ||
        lowered === 'style' || lowered === 'textarea';
      if (!excluded) {
        const tagEnd = scanBlockTagEnd(rest, 1 + genericName.length);
        if (tagEnd !== -1 && isLineEndAfter(rest, tagEnd)) {
          return htmlToken(e, htmlBlockEnd(e, sp + tagEnd), false);
        }
      }
    }
    return null;
  }

  // A closing tag alone on its line.
  const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(rest);
  if (closeMatch && isLineEndAfter(rest, closeMatch[0].length)) {
    return htmlToken(e, htmlBlockEnd(e, sp + closeMatch[0].length), false);
  }
  return null;
}

// --- link reference definition ---------------------------------------------------

// Scan a definition title at `i`: a separator (spaces, optionally wrapped
// onto the next line, or a newline and indent) and a quoted or parenthesised
// title. Returns { titleRaw, end } or null.
function scanDefTitle(e, i) {
  let j = i;
  let spaces = 0;
  while (e[j] === ' ') {
    j++;
    spaces++;
  }
  if (e[j] === '\n') {
    j++;
    while (e[j] === ' ' || e[j] === '\t') j++;
  } else if (spaces === 0) {
    return null;
  }
  const open = e[j];
  if (open === '"' || open === "'") {
    const end = scanDefQuoted(e, j, open);
    if (end === -1) return null;
    return { titleRaw: e.slice(j, end), end };
  }
  if (open === '(') {
    let k = j + 1;
    while (k < e.length) {
      const c = e[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '(') return null;
      if (c === ')') return { titleRaw: e.slice(j, k + 1), end: k + 1 };
      k++;
    }
    return null;
  }
  return null;
}

function scanDefQuoted(e, j, quote) {
  let k = j + 1;
  while (k < e.length) {
    const c = e[k];
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === quote) return k + 1;
    if (quote === "'" && c === '\n' && e[k + 1] === '\n') return -1;
    k++;
  }
  return -1;
}

function matchDef(e) {
  const sp = countLeadingSpaces(e);
  if (sp > 3 || e[sp] !== '[') return null;
  const n = e.length;
  let i = sp + 1;
  const labelStart = i;
  let labelEnd = -1;
  while (i < n) {
    const c = e[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === ']') {
      labelEnd = i;
      break;
    }
    if (c === '[') return null;
    if (c === '\n') {
      let j = i + 1;
      while (e[j] === ' ' || e[j] === '\t') j++;
      if (e[j] === '\n') return null;
      i++;
      continue;
    }
    i++;
  }
  if (labelEnd === -1) return null;
  const label = e.slice(labelStart, labelEnd);
  if (!label.trim()) return null;
  if (e[labelEnd + 1] !== ':') return null;
  i = labelEnd + 2;
  while (e[i] === ' ') i++;
  if (e[i] === '\n') {
    i++;
    while (e[i] === ' ' || e[i] === '\t') i++;
  }
  let href;
  if (e[i] === '<') {
    const lineEnd = e.indexOf('\n', i);
    const gt = e.indexOf('>', i + 1);
    if (gt === -1 || (lineEnd !== -1 && gt > lineEnd)) return null;
    href = e.slice(i, gt + 1);
    i = gt + 1;
  } else {
    if (i >= n || /\s/.test(e[i])) return null;
    let j = i;
    while (j < n && !/\s/.test(e[j])) j++;
    href = e.slice(i, j);
    i = j;
  }
  if (bracketBalance(href, '(', ')') !== -1) return null;
  let title;
  let endPos = -1;
  const scanned = scanDefTitle(e, i);
  if (scanned) {
    let j = scanned.end;
    while (e[j] === ' ') j++;
    if (j >= n || e[j] === '\n') {
      title = scanned.titleRaw;
      endPos = j;
    }
  }
  if (endPos === -1) {
    let j = i;
    while (e[j] === ' ') j++;
    if (j >= n || e[j] === '\n') endPos = j;
    else return null;
  }
  let hrefOut = href;
  if (hrefOut.startsWith('<')) hrefOut = hrefOut.slice(1, -1);
  return {
    type: 'def',
    tag: normalizeLabel(label),
    raw: e.slice(0, endPos),
    href: unescapePunct(hrefOut),
    title: title === undefined ? undefined : unescapePunct(title.slice(1, -1)),
  };
}

// --- blockquote ------------------------------------------------------------------

// A fence line for the stop sets: three or more tildes, or a backtick run
// whose rest of line holds no other backtick.
function isFenceStopLine(line) {
  const i = countLeadingSpaces(line);
  if (i > 3) return false;
  if (line.startsWith('~~~', i)) return true;
  if (line[i] === '`') {
    let run = 0;
    while (line[i + run] === '`') run++;
    if (run >= 3 && !line.slice(i + run).includes('`')) return true;
  }
  return false;
}

// The list pattern used inside lazy continuations: a bullet or number
// followed by a space, a tab, or the end of the line.
function isLazyListLine(line) {
  const i = countLeadingSpaces(line);
  if (i > 3) return false;
  const c = line[i];
  if (c === '*' || c === '+' || c === '-') {
    const after = line[i + 1];
    return after === undefined || after === ' ' || after === '\t';
  }
  const m = /^\d{1,9}[.)]/.exec(line.slice(i));
  if (!m) return false;
  const after = line[i + m[0].length];
  return after === undefined || after === ' ' || after === '\t';
}

// Lines that end a blockquote paragraph's lazy continuation.
function isBlockquoteStopLine(line) {
  if (/^[ \t]*$/.test(line)) return true;
  if (isHrLine(line, 3)) return true;
  if (isHeadingLine(line, 3)) return true;
  const sp = countLeadingSpaces(line);
  if (sp <= 3 && line[sp] === '>') return true;
  if (isFenceStopLine(line)) return true;
  if (isLazyListLine(line)) return true;
  if (isHtmlStopLine(line, false)) return true;
  return false;
}

// The lines a blockquote covers: quote lines, plus the lazy continuation
// lines of any paragraph a quote line starts.
function blockquoteLines(e) {
  const lines = [];
  const n = e.length;
  let pos = 0;
  while (pos < n) {
    let le = e.indexOf('\n', pos);
    if (le === -1) le = n;
    const line = e.slice(pos, le);
    const sp = countLeadingSpaces(line);
    if (sp > 3 || line[sp] !== '>') break;
    lines.push(line);
    if (le === n) break;
    pos = le + 1;
    const marker = /^ {0,3}> ?/.exec(line)[0];
    if (/^[ \t]*$/.test(line.slice(marker.length))) continue;
    while (pos < n) {
      let le2 = e.indexOf('\n', pos);
      if (le2 === -1) le2 = n;
      const l2 = e.slice(pos, le2);
      if (isBlockquoteStopLine(l2)) break;
      lines.push(l2);
      pos = le2 === n ? n : le2 + 1;
      if (le2 === n) break;
    }
    if (pos >= n) break;
  }
  return lines;
}

function transformQuoteChunk(h) {
  let u = h.replace(
    /^( {0,3}>)([ \t]+)/gm,
    (match, marker, ws) => marker + expandTabs(ws, marker.length)
  );
  // Lazy setext underlines are sheltered from the stripped text by
  // indenting them, so they stay paragraph text.
  u = u.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
  u = u.replace(/^ {0,3}>[ \t]?/gm, '');
  return u;
}

function matchBlockquote(ctx, e) {
  let rest = blockquoteLines(e);
  if (rest.length === 0) return null;
  let rawAll = '';
  let textAll = '';
  const tokens = [];
  while (rest.length > 0) {
    // A chunk is a run of lines up to (but not including) the first quote
    // line that follows a lazy line.
    let seenGt = false;
    const chunk = [];
    let p = 0;
    for (; p < rest.length; p++) {
      const line = rest[p];
      const sp = countLeadingSpaces(line);
      if (sp <= 3 && line[sp] === '>') {
        chunk.push(line);
        seenGt = true;
      } else if (!seenGt) {
        chunk.push(line);
      } else break;
    }
    rest = rest.slice(p);
    const h = chunk.join('\n');
    const u = transformQuoteChunk(h);
    rawAll = rawAll ? rawAll + '\n\n' + h : h;
    textAll = textAll ? textAll + '\n\n' + u : u;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    lexBlocks(ctx, u, tokens, true);
    ctx.state.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) continue;
    if (
      last.type === 'code' || last.type === 'heading' || last.type === 'hr' ||
      last.type === 'html' || last.type === 'table'
    ) {
      break;
    }
    if (last.type === 'blockquote') {
      // The inner quote absorbs the remaining lines: re-lex it together
      // with them and keep whatever it does not consume.
      const combined =
        last.raw + '\n' + rest.join('\n').replace(/^ {0,3}>[ \t]?/gm, '');
      const inner = matchBlockquote(ctx, combined);
      if (!inner) break;
      tokens[tokens.length - 1] = inner;
      const leftover = combined.slice(inner.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const used = leftoverCount ? rest.slice(0, rest.length - leftoverCount) : rest.slice();
      if (used.length > 0) rawAll += '\n\n' + used.join('\n');
      textAll = textAll.slice(0, textAll.length - last.text.length) + inner.text;
      rest = rest.slice(used.length);
      if (rest.length > 0) {
        const sp0 = countLeadingSpaces(rest[0]);
        if (sp0 <= 3 && rest[0][sp0] === '>') continue;
      }
      break;
    }
    if (last.type === 'list') {
      const combined = last.raw + '\n' + rest.join('\n');
      const inner = matchList(ctx, combined);
      if (!inner) break;
      tokens[tokens.length - 1] = inner;
      const extra =
        inner.raw.length > last.raw.length
          ? combined.slice(last.raw.length + 1, inner.raw.length).split('\n').length
          : 0;
      if (extra > 0) {
        const usedText = rest.slice(0, extra).join('\n');
        rawAll += '\n\n' + usedText;
        textAll += '\n\n' + usedText;
      }
      rest = rest.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAll, tokens, text: textAll };
}

// --- list --------------------------------------------------------------------------

function beginIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}

function isNextBulletLine(line, indent) {
  const i = countLeadingSpaces(line);
  if (i > beginIndent(indent)) return false;
  const c = line[i];
  if (c === '*' || c === '+' || c === '-') {
    const after = line[i + 1];
    return after === undefined || after === ' ' || after === '\t';
  }
  const m = /^\d{1,9}[.)]/.exec(line.slice(i));
  if (!m) return false;
  const after = line[i + m[0].length];
  return after === undefined || after === ' ' || after === '\t';
}

function isHrBeginLine(line, indent) {
  return isHrLine(line, beginIndent(indent));
}

function isFencesBeginLine(line, indent) {
  const i = countLeadingSpaces(line);
  return (
    i <= beginIndent(indent) &&
    (line.startsWith('```', i) || line.startsWith('~~~', i))
  );
}

function isHeadingBeginLine(line, indent) {
  return isHeadingLine(line, beginIndent(indent));
}

function isBlockquoteBeginLine(line, indent) {
  const i = countLeadingSpaces(line);
  return i <= beginIndent(indent) && line[i] === '>';
}

function isHtmlBeginLine(line, indent) {
  const i = countLeadingSpaces(line);
  return i <= beginIndent(indent) && line[i] === '<' && htmlBeginAt(line, i, true);
}

const itemReCache = new Map();

function listItemRe(bulletPattern) {
  let re = itemReCache.get(bulletPattern);
  if (!re) {
    re = new RegExp(
      '^( {0,3}' + bulletPattern + ')((?:[\\t ][^\\n]*)?(?:\\n|$))'
    );
    itemReCache.set(bulletPattern, re);
  }
  return re;
}

// Index of the first character that is not a space, or -1.
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') return i;
  }
  return -1;
}

// Is the whole string spaces and tabs?
function isBlankText(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// Column of the first non-space character when every tab counts as four
// columns (the reference's tab-to-four-spaces replacement, measured
// without building the replaced string); -1 when there is none.
function tabExpandedFirstNonSpace(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4;
    else return col;
  }
  return -1;
}

// Does the string end with a blank line (the doubleBlankLine test)?
function endsWithBlankLine(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}

function matchList(ctx, e) {
  const first = /^ {0,3}((?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/.exec(e);
  if (!first) return null;
  const original = e;
  const bulletText = first[1].trim();
  const ordered = bulletText.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bulletText.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered
    ? '\\d{1,9}\\' + bulletText.slice(-1)
    : '\\' + bulletText;
  const itemRe = listItemRe(bulletPattern);
  const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  let pendingLoose = false;
  let rest = e;
  while (rest) {
    const m = itemRe.exec(rest);
    if (!m || hrRe.test(rest)) break;
    const itemStart = original.length - rest.length;
    rest = rest.slice(m[0].length);
    const fcEnd = m[2].indexOf('\n');
    const firstContent = fcEnd === -1 ? m[2] : m[2].slice(0, fcEnd);
    const bulletLen = m[1].length;
    let content = firstContent;
    let leadLen = 0;
    while (
      firstContent[leadLen] === ' ' ||
      firstContent[leadLen] === '\t'
    ) {
      leadLen++;
    }
    if (leadLen > 0) {
      content =
        expandTabs(firstContent.slice(0, leadLen), bulletLen) +
        firstContent.slice(leadLen);
    }
    const blankFirst = isBlankText(content);
    let indent = 0;
    let text = '';
    let itemDone = false;
    if (blankFirst) {
      indent = bulletLen + 1;
      const nlEnd = rest.indexOf('\n');
      const nextLine = nlEnd === -1 ? rest : rest.slice(0, nlEnd);
      if (isBlankText(nextLine)) {
        rest = rest.slice(nextLine.length + 1);
        itemDone = true;
      }
    } else {
      indent = firstNonSpace(content);
      if (indent > 4) indent = 1;
      text = content.slice(indent);
      indent += bulletLen;
    }
    if (!itemDone) {
      let refLine = content;
      let refBlank = blankFirst;
      while (rest) {
        const le = rest.indexOf('\n');
        const line = le === -1 ? rest : rest.slice(0, le);
        let expanded = line;
        let lead2Len = 0;
        while (line[lead2Len] === ' ' || line[lead2Len] === '\t') lead2Len++;
        if (lead2Len > 0) {
          // Continuation lines start at column 0 of the source, so their
          // leading tabs expand from column 0 (unlike the first line,
          // whose content starts after the bullet).
          expanded =
            expandTabs(line.slice(0, lead2Len), 0) + line.slice(lead2Len);
        }
        if (
          isFencesBeginLine(line, indent) ||
          isHeadingBeginLine(line, indent) ||
          isHtmlBeginLine(line, indent) ||
          isBlockquoteBeginLine(line, indent) ||
          isNextBulletLine(line, indent) ||
          isHrBeginLine(line, indent)
        ) {
          break;
        }
        const lineBlank = isBlankText(line);
        if (firstNonSpace(expanded) >= indent || lineBlank) {
          text += '\n' + expanded.slice(indent);
        } else {
          // A lazy (under-indented) line: it joins the item only when the
          // reference line does not itself start a block.
          if (refBlank) break;
          if (tabExpandedFirstNonSpace(refLine) >= 4) break;
          if (
            isFencesBeginLine(refLine, indent) ||
            isHeadingBeginLine(refLine, indent) ||
            isHtmlBeginLine(refLine, indent) ||
            isHrBeginLine(refLine, indent)
          ) {
            break;
          }
          let addition = line;
          if (
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            matchLheadingText(refLine + '\n' + line)
          ) {
            addition = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          text += '\n' + addition;
        }
        refBlank = lineBlank;
        rest = le === -1 ? '' : rest.slice(le + 1);
        refLine = expanded.slice(indent);
      }
    }
    const itemRaw = original.slice(itemStart, original.length - rest.length);
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (endsWithBlankLine(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: /^\[[ xX]\][ \t]+\S/.test(text),
      loose: false,
      text,
      tokens: [],
    });
  }
  if (list.items.length === 0) return null;
  const lastItem = list.items[list.items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = original.slice(0, original.length - rest.length).trimEnd();
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = [];
    lexBlocks(ctx, item.text, item.tokens, false);
    if (!list.loose) {
      let hasSpace = false;
      let looseSpace = false;
      for (const t of item.tokens) {
        if (t.type === 'space') {
          hasSpace = true;
          if (/\n.*\n/.test(t.raw)) looseSpace = true;
        }
      }
      if (hasSpace && looseSpace) list.loose = true;
    }
  }
  // Task-list items: strip the checkbox marker from the item's text, its
  // first token, and the queued inline source, then splice a checkbox
  // token into the item.
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (
      item.task &&
      firstTok &&
      (firstTok.type === 'text' || firstTok.type === 'paragraph')
    ) {
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      firstTok.raw = firstTok.raw.replace(/^\[[ xX]\][ \t]+/, '');
      firstTok.text = firstTok.text.replace(/^\[[ xX]\][ \t]+/, '');
      for (let gi = ctx.queue.length - 1; gi >= 0; gi--) {
        if (/^\[[ xX]\][ \t]+\S/.test(ctx.queue[gi].src)) {
          ctx.queue[gi].src = ctx.queue[gi].src.replace(/^\[[ xX]\][ \t]+/, '');
          break;
        }
      }
      const cb = /\[[ xX]\]/.exec(item.raw);
      if (cb) {
        const checkbox = {
          type: 'checkbox',
          raw: cb[0] + ' ',
          checked: cb[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          const t0 = item.tokens[0];
          if (
            t0 &&
            (t0.type === 'paragraph' || t0.type === 'text') &&
            t0.tokens
          ) {
            t0.raw = checkbox.raw + t0.raw;
            t0.text = checkbox.raw + t0.text;
            t0.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkbox.raw,
              text: checkbox.raw,
              tokens: [checkbox],
            });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) {
        if (t.type === 'text') t.type = 'paragraph';
      }
    }
  }
  return list;
}

// --- table ---------------------------------------------------------------------------

// Validate a delimiter row and return its text (the row after up to three
// leading spaces), or null when the row is not a delimiter row.
function scanDelimiterLine(line) {
  const start = countLeadingSpaces(line);
  if (start > 3) return null;
  const s = line.slice(start);
  let j = 0;
  const segment = () => {
    if (s[j] === ':') j++;
    let dashes = 0;
    while (s[j] === '-') {
      j++;
      dashes++;
    }
    if (dashes === 0) return false;
    if (s[j] === ':') j++;
    while (s[j] === ' ') j++;
    return true;
  };
  if (s[j] === '|') {
    j++;
    while (s[j] === ' ') j++;
  }
  if (!segment()) return null;
  while (s[j] === '|') {
    j++;
    while (s[j] === ' ') j++;
    if (j >= s.length) break;
    if (!segment()) return null;
  }
  return j === s.length ? s : null;
}

function isTableBodyStopLine(line) {
  if (/^ *$/.test(line)) return true;
  if (isHrLine(line, 3)) return true;
  if (isHeadingLine(line, 3)) return true;
  const sp = countLeadingSpaces(line);
  if (sp <= 3 && line[sp] === '>') return true;
  if (isCodeContentLine(line)) return true;
  if (isFenceStopLine(line)) return true;
  if (sp <= 3) {
    const c = line[sp];
    if (c === '*' || c === '+' || c === '-') {
      if (line[sp + 1] === ' ' || line[sp + 1] === '\t') return true;
    } else if (c === '1' && (line[sp + 1] === '.' || line[sp + 1] === ')')) {
      if (line[sp + 2] === ' ' || line[sp + 2] === '\t') return true;
    }
  }
  if (isHtmlStopLine(line, false)) return true;
  return false;
}

function matchTable(ctx, e) {
  const headerEnd = e.indexOf('\n');
  if (headerEnd === -1) return null;
  const headerLine = e.slice(0, headerEnd);
  const hSp = countLeadingSpaces(headerLine);
  if (hSp >= headerLine.length) return null;
  const headerText = headerLine.slice(hSp);
  const delimStart = headerEnd + 1;
  let delimEnd = e.indexOf('\n', delimStart);
  if (delimEnd === -1) delimEnd = e.length;
  const delimText = scanDelimiterLine(e.slice(delimStart, delimEnd));
  if (delimText === null) return null;
  if (!delimText.includes(':') && !delimText.includes('|')) return null;
  const headerCells = splitCells(headerText);
  const alignParts = delimText.replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignParts.length) return null;
  const align = alignParts.map((part) => {
    if (/^ *-+: *$/.test(part)) return 'right';
    if (/^ *:-+: *$/.test(part)) return 'center';
    if (/^ *:-+ *$/.test(part)) return 'left';
    return null;
  });
  const bodyLines = [];
  let rawEnd = delimEnd;
  if (delimEnd < e.length) {
    let p = delimEnd + 1;
    while (p < e.length) {
      let le = e.indexOf('\n', p);
      if (le === -1) le = e.length;
      const line = e.slice(p, le);
      if (isTableBodyStopLine(line)) break;
      bodyLines.push(line);
      rawEnd = le;
      if (le === e.length) break;
      p = le + 1;
    }
  }
  const header = headerCells.map((text, i) => ({
    text,
    tokens: queueInline(ctx, text),
    header: true,
    align: align[i],
  }));
  let rows = [];
  if (bodyLines.length > 0 && bodyLines.join('\n').trim() !== '') {
    rows = bodyLines.map((line) =>
      splitCells(line, headerCells.length).map((text, i) => ({
        text,
        tokens: queueInline(ctx, text),
        header: false,
        align: align[i],
      }))
    );
  }
  return { type: 'table', raw: e.slice(0, rawEnd), header, align, rows };
}

// --- setext heading ---------------------------------------------------------------------

function isBulletSpaceLine(line) {
  const i = countLeadingSpaces(line);
  if (i > 3) return false;
  const c = line[i];
  if (c === '*' || c === '+' || c === '-') return line[i + 1] === ' ';
  const m = /^\d{1,9}[.)]/.exec(line.slice(i));
  if (!m) return false;
  return line[i + m[0].length] === ' ';
}

function isTableDelimShape(line) {
  return /^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line);
}

// Shapes that keep a setext heading from starting on this line.
function isLheadingExcludedStart(line, hasNewline) {
  if (isBulletSpaceLine(line)) return true;
  if (line.startsWith('    ') || /^ {0,3}\t/.test(line)) return true;
  const sp = countLeadingSpaces(line);
  if (sp <= 3 && (line.startsWith('```', sp) || line.startsWith('~~~', sp))) {
    return true;
  }
  if (sp <= 3 && line[sp] === '>') return true;
  if (isHeadingLine(line, 3)) return true;
  if (hasNewline && sp <= 3 && line[sp] === '<' && line.slice(sp).includes('>')) {
    return true;
  }
  if (hasNewline && isTableDelimShape(line)) return true;
  return false;
}

// Shapes that end a setext heading's content run.
function isLheadingStopLine(line) {
  if (/^[ \t]*$/.test(line)) return true;
  if (isBulletSpaceLine(line)) return true;
  const sp = countLeadingSpaces(line);
  if (sp <= 3 && (line.startsWith('```', sp) || line.startsWith('~~~', sp))) {
    return true;
  }
  if (sp <= 3 && line[sp] === '>') return true;
  if (isHeadingLine(line, 3)) return true;
  if (isHrLine(line, 3)) return true;
  if (sp <= 3 && line[sp] === '<' && line.slice(sp).includes('>')) return true;
  if (isTableDelimShape(line)) return true;
  return false;
}

function scanLheading(e) {
  const firstEnd = e.indexOf('\n');
  const first = firstEnd === -1 ? e : e.slice(0, firstEnd);
  if (isLheadingExcludedStart(first, firstEnd !== -1)) return null;
  if (firstEnd === -1) return null;
  const lines = [first];
  let pos = firstEnd + 1;
  while (pos < e.length) {
    let le = e.indexOf('\n', pos);
    if (le === -1) le = e.length;
    const line = e.slice(pos, le);
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (underline) {
      return {
        text: lines.join('\n').trim(),
        depth: underline[1][0] === '=' ? 1 : 2,
        raw: e.slice(0, le),
      };
    }
    if (isLheadingStopLine(line)) return null;
    lines.push(line);
    if (le === e.length) return null;
    pos = le + 1;
  }
  return null;
}

function matchLheading(ctx, e) {
  const scanned = scanLheading(e);
  if (!scanned) return null;
  return {
    type: 'heading',
    raw: scanned.raw,
    depth: scanned.depth,
    text: scanned.text,
    tokens: queueInline(ctx, scanned.text),
  };
}

function matchLheadingText(s) {
  return scanLheading(s) !== null;
}

// --- paragraph and plain text --------------------------------------------------------------

function isParagraphStopLine(line, nextLine, followedByNewline, allowTableInterrupt = true) {
  if (line === '') return true;
  // A line of only spaces ends the paragraph only when a newline follows
  // it; trailing spaces at the very end of the input stay in the text.
  if (followedByNewline && /^[ \t]+$/.test(line)) return true;
  if (isHrLine(line, 3)) return true;
  if (isHeadingLine(line, 3)) return true;
  const sp = countLeadingSpaces(line);
  if (sp <= 3 && line[sp] === '>') return true;
  if (isFenceStopLine(line)) return true;
  if (sp <= 3) {
    const c = line[sp];
    let bulletEnd = -1;
    if (c === '*' || c === '+' || c === '-') bulletEnd = sp + 1;
    else if (c === '1' && (line[sp + 1] === '.' || line[sp + 1] === ')')) {
      bulletEnd = sp + 2;
    }
    if (bulletEnd !== -1) {
      let k = bulletEnd;
      let spaces = 0;
      while (line[k] === ' ' || line[k] === '\t') {
        k++;
        spaces++;
      }
      if (spaces >= 1 && k < line.length) return true;
    }
  }
  if (isHtmlStopLine(line, false)) return true;
  // A table starting on this line ends the paragraph: this line is the
  // header row and the next one is a delimiter row.
  if (
    allowTableInterrupt &&
    nextLine !== null &&
    line.length > 0 &&
    line[countLeadingSpaces(line)] !== undefined &&
    scanDelimiterLine(nextLine) !== null
  ) {
    return true;
  }
  return false;
}

// If `line` is a setext underline (a run of '=' or '-' with only
// surrounding spaces), return its marker character, else null.
function setextUnderline(line) {
  let i = 0;
  while (line[i] === ' ' && i < 4) i++;
  if (i > 3) return null;
  const c = line[i];
  if (c !== '=' && c !== '-') return null;
  let j = i;
  while (line[j] === c) j++;
  while (line[j] === ' ' || line[j] === '\t') j++;
  return j === line.length ? c : null;
}

// The top-level text block: either a setext heading or a paragraph. Both
// forms scan the same lines, so they share one pass — the setext form
// stays possible until a content line trips its stop set, and an
// underline line then settles the block as a heading.
function matchParagraphOrHeading(ctx, e) {
  const n = e.length;
  let le = e.indexOf('\n');
  if (le === -1) le = n;
  const first = e.slice(0, le);
  if (first === '') return null;
  let lheadingAlive = le < n && !isLheadingExcludedStart(first, true);
  const lines = [first];
  let pos = le;
  while (pos < n) {
    const start = pos + 1;
    if (start >= n) break;
    let le2 = e.indexOf('\n', start);
    if (le2 === -1) le2 = n;
    const line = e.slice(start, le2);
    if (lheadingAlive) {
      const marker = setextUnderline(line);
      if (marker) {
        const text = lines.join('\n').trim();
        return {
          type: 'heading',
          raw: e.slice(0, le2),
          depth: marker === '=' ? 1 : 2,
          text,
          tokens: queueInline(ctx, text),
        };
      }
    }
    let nextLine = null;
    if (le2 < n) {
      let le3 = e.indexOf('\n', le2 + 1);
      if (le3 === -1) le3 = n;
      nextLine = e.slice(le2 + 1, le3);
    }
    // When the next line is a dash underline and the setext form is
    // still possible, it is a heading underline, not a table delimiter:
    // do not let the table interruption end the block before it.
    const suppressTable =
      lheadingAlive && nextLine !== null && setextUnderline(nextLine) === '-';
    if (isParagraphStopLine(line, nextLine, le2 < n, !suppressTable)) break;
    if (lheadingAlive && isLheadingStopLine(line)) lheadingAlive = false;
    lines.push(line);
    pos = le2;
  }
  const text = lines.join('\n');
  return { type: 'paragraph', raw: text, text, tokens: queueInline(ctx, text) };
}

function matchBlockText(ctx, e) {
  const line = firstLine(e);
  if (line === '') return null;
  return { type: 'text', raw: line, text: line, tokens: queueInline(ctx, line) };
}

// A table needs a header line and a delimiter line, and the delimiter
// line must contain a ':' or a '|'; check that before the full attempt.
function tablePossible(e) {
  const nl = e.indexOf('\n');
  if (nl === -1) return false;
  if (e.slice(0, nl).includes('|')) return true;
  const nl2 = e.indexOf('\n', nl + 1);
  const second = nl2 === -1 ? e.slice(nl + 1) : e.slice(nl + 1, nl2);
  return second.includes(':') || second.includes('|');
}

// --- the block driver -------------------------------------------------------------------------

function lexBlocks(ctx, src, out, mergePara) {
  let e = src;
  while (e.length > 0) {
    let tok;
    if ((tok = matchSpace(e))) {
      e = e.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else out.push(tok);
      continue;
    }
    // First-character gates: every remaining block construct starts, after
    // at most three spaces, with a distinctive character, so most attempts
    // can be skipped without running the full matcher.
    let sp = 0;
    while (e[sp] === ' ') sp++;
    const fc = e[sp];
    if ((sp >= 4 || (sp <= 3 && fc === '\t')) && (tok = matchIndentedCode(e))) {
      e = e.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        out.push(tok);
      }
      continue;
    }
    if (sp <= 3 && (fc === '`' || fc === '~') && (tok = matchFences(e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (sp <= 3 && fc === '#' && (tok = matchHeading(ctx, e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (sp <= 3 && (fc === '-' || fc === '_' || fc === '*') && (tok = matchHr(e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (sp <= 3 && fc === '>' && (tok = matchBlockquote(ctx, e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (
      sp <= 3 &&
      (fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9')) &&
      (tok = matchList(ctx, e))
    ) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (sp <= 3 && fc === '<' && (tok = matchHtmlBlock(e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (sp <= 3 && fc === '[' && (tok = matchDef(e))) {
      e = e.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) {
          ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        }
        out.push(tok);
      }
      continue;
    }
    if (tablePossible(e) && (tok = matchTable(ctx, e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (!ctx.state.top && (tok = matchLheading(ctx, e))) {
      e = e.slice(tok.raw.length);
      out.push(tok);
      continue;
    }
    if (ctx.state.top && (tok = matchParagraphOrHeading(ctx, e))) {
      if (tok.type === 'heading') {
        e = e.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      const prev = out[out.length - 1];
      if (mergePara && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        out.push(tok);
      }
      mergePara = false;
      e = e.slice(tok.raw.length);
      continue;
    }
    if ((tok = matchBlockText(ctx, e))) {
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        out.push(tok);
      }
      e = e.slice(tok.raw.length);
      continue;
    }
    break; // unreachable for well-formed flow; guards against stalling
  }
  ctx.state.top = true;
  return out;
}

// ---------------------------------------------------------------------------
// Inline lexing
// ---------------------------------------------------------------------------

const LINK_RE =
  /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const REFLINK_RE =
  /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const NOLINK_RE =
  /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const AUTOLINK_RE =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const URL_RE =
  /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const REFLINK_SEARCH_RE =
  /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const BLOCK_SKIP_RE =
  /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const ANY_PUNCT_OUTSIDE_CODE_RE =
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;

// --- masking ---------------------------------------------------------------------
//
// Emphasis resolution works on a masked copy of the text where constructs
// that cannot take part in emphasis (defined references, code spans,
// escapes, whole links and tags) are blanked into inert characters of the
// same length, so positions still line up with the original.

function maskText(ctx, src) {
  let t = src;
  // Reference masking can only change the text when the document defines
  // at least one link label; with no definitions it is the identity.
  if (ctx.hasLinks && src.includes('[')) {
    t = t.replace(REFLINK_SEARCH_RE, (match) => maskReflinkMatch(ctx, match));
  }
  // The two masking passes below can only change something when the text
  // holds a backtick, a backslash, a bracket or a '<'; skip the scans
  // otherwise (they would be identity replacements).
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (match, codeRun, escChar) => {
      if (escChar) return '+'.repeat(match.length);
      if (codeRun) {
        return (
          codeRun +
          match
            .slice(codeRun.length, match.length - codeRun.length)
            .replace(/`/g, '+') +
          codeRun
        );
      }
      return match;
    });
  }
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (match, _run, parenGroup) => {
      // The reference preserves a prefix as long as the match's inner
      // parenthesised group, when the skipped link destination has one.
      const o = parenGroup ? parenGroup.length : 0;
      return match.slice(0, o) + '[' + 'a'.repeat(match.length - o - 2) + ']';
    });
  }
  return t;
}

function maskReflinkMatch(ctx, r) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(ctx.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(ctx, inner)) {
      return (
        '[' +
        inner.replace(REFLINK_SEARCH_RE, (m) => maskReflinkMatch(ctx, m)) +
        '][' +
        'a'.repeat(r.length - o - 2) +
        ']'
      );
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

// Does this text contain a real link? Used only while masking.
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  BLOCK_SKIP_RE.lastIndex = 0;
  for (const m of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH_RE.lastIndex = 0;
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(
        s.charAt(0) === '!' ||
        !Object.hasOwn(ctx.links, normalizeLabel(s.slice(r + 1, -1)))
      ) &&
      !(r > 1 && linkInText(ctx, s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

// For each delimiter character, the start index of the last run that could
// close emphasis: a run whose preceding character is not whitespace.
function scanDelimiters(masked) {
  const res = { '*': -1, _: -1, '~': -1 };
  const n = masked.length;
  let s = 0;
  while (s < n) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') {
      s++;
      continue;
    }
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    const prev = s === 0 ? '\n' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      res[r] = s;
    }
    s = i;
  }
  return res;
}

// --- the emphasis closer scanners ---------------------------------------------------
//
// The reference finds emphasis closers with a family of regexes whose
// alternatives classify the character before a delimiter run and the
// character after it. The scanners below walk the masked text and yield the
// same matches in the same order.

// The "skip region" first alternative: it jumps over a region delimited by
// the other emphasis character's double, when that region contains one of
// this delimiter. Returns the end index of the skipped region or -1.
function skipRegionEnd(t, delim) {
  const other = delim === '*' ? '__' : '**';
  let a = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '*' || c === '_') {
      if (t.startsWith(other, i)) a = i;
      break;
    }
  }
  if (a === -1) return -1;
  let b = -1;
  for (let i = a + 2; i < t.length; i++) {
    const c = t[i];
    if (c === '*' || c === '_') {
      if (c === delim) b = i;
      break;
    }
  }
  if (b === -1) return -1;
  for (let i = b + 1; i < t.length; i++) {
    const c = t[i];
    if (c === '*' || c === '_') {
      return t.startsWith(other, i) ? i : -1;
    }
  }
  return -1;
}

// One closer-regex match attempt at `pos` of the masked text.
function rDelimMatchAt(t, pos, delim) {
  const c = t[pos];
  if (c !== delim) {
    let end = pos;
    while (end < t.length && t[end] !== delim) end++;
    if (end - pos >= 2) return { text: t.slice(pos, end - 1), group: null };
  }
  const prevCp = t.codePointAt(pos);
  const prev = String.fromCodePoint(prevCp);
  const prevLen = prevCp > 0xffff ? 2 : 1;
  const runStart = pos + prevLen;
  if (t[runStart] !== delim) return null;
  let runEnd = runStart;
  while (t[runEnd] === delim) runEnd++;
  const runText = t.slice(runStart, runEnd);
  const afterCp = runEnd < t.length ? t.codePointAt(runEnd) : -1;
  const after = afterCp === -1 ? '' : String.fromCodePoint(afterCp);
  const prevPunct = isPunctOrSymbol(prev);
  const prevSpace = /\s/.test(prev);
  const prevWord = !prevPunct && !prevSpace;
  const afterPunct = afterCp !== -1 && isPunctOrSymbol(after);
  const afterSpace = afterCp !== -1 && /\s/.test(after);
  const afterWord = afterCp !== -1 && !afterPunct && !afterSpace;
  const atEnd = afterCp === -1;
  let slots;
  if (delim === '*') {
    // In GFM, a tilde counts as a word character for '*' delimiters, and
    // cannot itself be the punctuation around a '*' run.
    const prevWordT = prevWord || prev === '~';
    const afterWordT = afterWord || after === '~';
    const afterPunctSpaceNT = (afterPunct || afterSpace) && after !== '~';
    const afterPunctNT = afterPunct && after !== '~';
    slots = [
      prevPunct && prev !== '*' && prev !== '~' && (afterSpace || atEnd),
      prevWordT && (afterPunctSpaceNT || atEnd),
      (prevPunct || prevSpace) && prev !== '*' && prev !== '~' && afterWordT,
      prevSpace && afterPunctNT,
      prevPunct && prev !== '*' && prev !== '~' && afterPunctNT,
      prevWordT && afterWordT,
    ];
  } else {
    // Underscore closers have no word-then-word alternative: an intraword
    // '_' run can never close emphasis.
    slots = [
      prevPunct && prev !== '_' && (afterSpace || atEnd),
      prevWord && (afterPunct || afterSpace || atEnd),
      (prevPunct || prevSpace) && prev !== '_' && afterWord,
      prevSpace && afterPunct,
      prevPunct && prev !== '_' && afterPunct,
    ];
  }
  for (let s = 0; s < 6; s++) {
    if (slots[s]) {
      return { text: t.slice(pos, runEnd), group: { slot: s + 1, runText } };
    }
  }
  return null;
}

function makeRDelimScanner(t, delim) {
  let lastIndex = 0;
  let first = true;
  return {
    next() {
      let pos = lastIndex;
      if (first) {
        first = false;
        if (pos === 0) {
          const skip = skipRegionEnd(t, delim);
          if (skip !== -1) {
            lastIndex = skip;
            return { index: 0, text: t.slice(0, skip), group: null };
          }
        }
      }
      while (pos < t.length) {
        const m = rDelimMatchAt(t, pos, delim);
        if (m) {
          lastIndex = pos + m.text.length;
          return { index: pos, text: m.text, group: m.group };
        }
        pos += t.codePointAt(pos) > 0xffff ? 2 : 1;
      }
      return null;
    },
  };
}

// The strikethrough closer scan: like the emphasis scan, but the run in a
// match is one or two tildes and the alternatives differ slightly.
function delRDelimMatchAt(t, pos) {
  const c = t[pos];
  if (c !== '~') {
    let end = pos;
    while (end < t.length && t[end] !== '~') end++;
    if (end - pos >= 2) return { text: t.slice(pos, end - 1), group: null };
  }
  const prevCp = t.codePointAt(pos);
  const prev = String.fromCodePoint(prevCp);
  const prevLen = prevCp > 0xffff ? 2 : 1;
  const runStart = pos + prevLen;
  if (t[runStart] !== '~') return null;
  let avail = 0;
  while (t[runStart + avail] === '~') avail++;
  const prevPunct = isPunctOrSymbol(prev);
  const prevSpace = /\s/.test(prev);
  const prevWord = !prevPunct && !prevSpace;
  for (let alt = 2; alt <= 7; alt++) {
    for (let runLen = Math.min(2, avail); runLen >= 1; runLen--) {
      const afterIdx = runStart + runLen;
      const afterCp = afterIdx < t.length ? t.codePointAt(afterIdx) : -1;
      const after = afterCp === -1 ? '' : String.fromCodePoint(afterCp);
      const afterPunct = afterCp !== -1 && isPunctOrSymbol(after);
      const afterSpace = afterCp !== -1 && /\s/.test(after);
      const afterWord = afterCp !== -1 && !afterPunct && !afterSpace;
      const atEnd = afterCp === -1;
      let ok = false;
      switch (alt) {
        case 2:
          ok = prevPunct && prev !== '~' && (afterSpace || atEnd);
          break;
        case 3:
          ok = prevWord && after !== '~' && (afterPunct || afterSpace || atEnd);
          break;
        case 4:
          ok = (prevPunct || prevSpace) && prev !== '~' && afterWord;
          break;
        case 5:
          ok = prevSpace && after !== '~' && afterPunct;
          break;
        case 6:
          ok = prevPunct && prev !== '~' && after !== '~' && afterPunct;
          break;
        case 7:
          ok = prevWord && afterWord;
          break;
      }
      if (ok) {
        return {
          text: t.slice(pos, runStart + runLen),
          group: { slot: alt - 1, runText: t.slice(runStart, runStart + runLen) },
        };
      }
    }
  }
  return null;
}

function makeDelRDelimScanner(t) {
  let lastIndex = 0;
  return {
    next() {
      let pos = lastIndex;
      while (pos < t.length) {
        const m = delRDelimMatchAt(t, pos);
        if (m) {
          lastIndex = pos + m.text.length;
          return { index: pos, text: m.text, group: m.group };
        }
        pos += t.codePointAt(pos) > 0xffff ? 2 : 1;
      }
      return null;
    },
  };
}

// --- inline tokenizers -----------------------------------------------------------------

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function matchEscape(e) {
  if (e[0] !== '\\' || e.length < 2) return null;
  if (!ESCAPABLE.includes(e[1])) return null;
  return { type: 'escape', raw: e.slice(0, 2), text: e[1] };
}

function matchBr(e) {
  let i;
  if (e[0] === ' ' && e[1] === ' ') {
    i = 0;
    while (e[i] === ' ') i++;
    if (e[i] !== '\n') return null;
    i++;
  } else if (e[0] === '\\' && e[1] === '\n') {
    i = 2;
  } else {
    return null;
  }
  if (/^\s*$/.test(e.slice(i))) return null;
  let j = i;
  while (e[j] === ' ' || e[j] === '\t') j++;
  return { type: 'br', raw: e.slice(0, j) };
}

function matchCodespan(e) {
  let run = 0;
  while (e[run] === '`') run++;
  if (run === 0) return null;
  const n = e.length;
  let pos = run + 1;
  while (pos < n) {
    if (e[pos] === '`') {
      let r = 0;
      while (e[pos + r] === '`') r++;
      if (r === run) {
        let text = e.slice(run, pos).replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
          text = text.slice(1, -1);
        }
        return { type: 'codespan', raw: e.slice(0, pos + run), text };
      }
      pos += r;
    } else {
      pos++;
    }
  }
  return null;
}

// Scan a tag's attributes (inline flavour: whitespace separators, quoted
// values may span lines) starting at `pos`; returns the index just past
// the closing '>' or -1.
function scanInlineTagEnd(e, pos) {
  let i = pos;
  for (;;) {
    let j = i;
    while (j < e.length && /\s/.test(e[j])) j++;
    if (e[j] === '>') return j + 1;
    if (e[j] === '/' && e[j + 1] === '>') return j + 2;
    if (i >= e.length || !/\s/.test(e[i])) return -1;
    while (i < e.length && /\s/.test(e[i])) i++;
    const nameMatch = /^[a-zA-Z:_][\w.:-]*/.exec(e.slice(i));
    if (!nameMatch) return -1;
    i += nameMatch[0].length;
    let k = i;
    while (k < e.length && /\s/.test(e[k])) k++;
    if (e[k] === '=') {
      k++;
      while (k < e.length && /\s/.test(e[k])) k++;
      const q = e[k];
      if (q === '"' || q === "'") {
        const close = e.indexOf(q, k + 1);
        if (close === -1) return -1;
        i = close + 1;
      } else {
        const valueMatch = /^[^\s"'=<>`]+/.exec(e.slice(k));
        if (!valueMatch) return -1;
        i = k + valueMatch[0].length;
      }
    }
  }
}

// Match an inline HTML tag at the start of `e`; returns the matched string
// or null. Shared by the tag tokenizer and the link-label tag check.
function matchTagString(e) {
  if (e[1] === '!') {
    if (e.startsWith('<!--')) {
      if (e[4] === '>') return e.slice(0, 5);
      if (e.startsWith('->', 4)) return e.slice(0, 6);
      const ci = e.indexOf('-->', 4);
      return ci === -1 ? null : e.slice(0, ci + 3);
    }
    if (e.startsWith('<![CDATA[')) {
      const ci = e.indexOf(']]>', 9);
      return ci === -1 ? null : e.slice(0, ci + 3);
    }
    const decl = /^<![a-zA-Z]+/.exec(e);
    if (decl && /\s/.test(e[decl[0].length] || '')) {
      const ci = e.indexOf('>', decl[0].length);
      return ci === -1 ? null : e.slice(0, ci + 1);
    }
    return null;
  }
  if (e[1] === '?') {
    const ci = e.indexOf('?>', 2);
    return ci === -1 ? null : e.slice(0, ci + 2);
  }
  if (e[1] === '/') {
    const m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(e);
    return m ? m[0] : null;
  }
  if (/[a-zA-Z]/.test(e[1] || '')) {
    const nameMatch = /^<[a-zA-Z][a-zA-Z0-9-]*/.exec(e);
    const end = scanInlineTagEnd(e, nameMatch[0].length);
    return end === -1 ? null : e.slice(0, end);
  }
  return null;
}

function matchInlineTag(ctx, e) {
  const raw = matchTagString(e);
  if (raw === null) return null;
  const st = ctx.state;
  if (!st.inLink && /^<a /i.test(raw)) st.inLink = true;
  else if (st.inLink && /^<\/a>/i.test(raw)) st.inLink = false;
  if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(raw)) {
    st.inRawBlock = true;
  } else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(raw)) {
    st.inRawBlock = false;
  }
  return {
    type: 'html',
    raw,
    inLink: st.inLink,
    inRawBlock: st.inRawBlock,
    block: false,
    text: raw,
  };
}

function matchAutolink(e) {
  const t = AUTOLINK_RE.exec(e);
  if (!t) return null;
  const text = t[1];
  return {
    type: 'link',
    raw: t[0],
    text,
    href: t[2] === '@' ? 'mailto:' + text : text,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

const BACKPEDAL_PUNCT = '?!.,:;*_\'"~()&';
const BACKPEDAL_TAIL_PUNCT = '?!.,:;*_\'"~)';

// Trim a bare URL the way the reference does: walk it in segments of plain
// characters, balanced parenthesis groups, ampersands that do not start an
// entity, and punctuation runs that do not reach the end.
function backpedalPrefix(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const close = s.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
    } else if (c === '&') {
      if (/^[a-zA-Z0-9]+;$/.test(s.slice(i + 1))) break;
      i++;
    } else if (BACKPEDAL_TAIL_PUNCT.includes(c)) {
      let j = i;
      while (j < n && BACKPEDAL_TAIL_PUNCT.includes(s[j])) j++;
      const k = Math.min(j, n - 1);
      if (k === i) break;
      i = k;
    } else {
      let j = i;
      while (j < n && !BACKPEDAL_PUNCT.includes(s[j])) j++;
      i = j;
    }
  }
  return s.slice(0, i);
}

function matchUrl(e) {
  const t = URL_RE.exec(e);
  if (!t) return null;
  let text;
  let href;
  if (t[2] === '@') {
    text = t[0];
    href = 'mailto:' + text;
  } else {
    let current = t[0];
    for (;;) {
      const next = backpedalPrefix(current);
      if (next === current) break;
      current = next;
    }
    text = current;
    href = t[1] === 'www.' ? 'http://' + current : current;
  }
  return {
    type: 'link',
    raw: text,
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

// If a link label contains a tag or autolink that runs past the label's own
// closing bracket, the link does not count.
function labelHasLongTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = CODE_SPAN_RE.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const tagMatch = matchTagString(rest);
    const m = tagMatch !== null ? tagMatch : AUTOLINK_RE.exec(rest)?.[0] ?? null;
    if (m) {
      if (m.length > label.length - s) return true;
      s += m.length - 1;
    }
  }
  return false;
}

// Build a link or image token from a successful match, lexing the label.
// Returns null when a non-image label itself contains a link.
function outputLink(ctx, match, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const st = ctx.state;
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const tokens = [];
  lexInline(ctx, text, tokens);
  const emitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      st.inRawBlock = savedRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function matchLink(ctx, e) {
  if (ctx.state.linkParenPossible === false) return null;
  const t = LINK_RE.exec(e);
  if (!t) return null;
  const offset = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasLongTag(e, t[1], offset)) return null;
  const s = t[2].trim();
  if (s.startsWith('<')) {
    if (!s.endsWith('>')) return null;
    const stripped = stripTrailing(s.slice(0, -1), '\\');
    if ((s.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = bracketBalance(t[2], '(', ')');
    if (bal === -2) return null;
    if (bal > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + bal;
      t[2] = t[2].substring(0, bal);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const trail = stripTrailing(t[0].slice(0, -1), '\\');
  if ((t[0].length - trail.length) % 2 === 0) return null;
  let href = t[2].trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const title = t[3] ? t[3].slice(1, -1) : '';
  return outputLink(
    ctx,
    t,
    {
      href: href ? unescapePunct(href) : href,
      title: title ? unescapePunct(title) : title,
    },
    t[0]
  );
}

function matchReflink(ctx, e) {
  const n = REFLINK_RE.exec(e) || NOLINK_RE.exec(e);
  if (!n) return null;
  const offset = n[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasLongTag(e, n[1], offset)) return null;
  const def = ctx.links[normalizeLabel(n[2] || n[1])];
  if (!def) {
    const ch = n[0].charAt(0);
    return { type: 'text', raw: ch, text: ch, fallback: true };
  }
  return outputLink(ctx, n, def, n[0]);
}

function matchEmStrong(ctx, e, masked, info, prevChar) {
  const delim = e[0];
  if (delim !== '*' && delim !== '_') return null;
  if (!info) return null;
  let run = 0;
  while (e[run] === delim) run++;
  const afterCp = e.codePointAt(run);
  const after = afterCp === undefined ? '' : String.fromCodePoint(afterCp);
  let punctGroup = '';
  let nonSpaceGroup = '';
  if (afterCp !== undefined) {
    if (after !== delim && after !== '~' && isPunctOrSymbol(after)) {
      punctGroup = after;
    } else if (!/\s/.test(after) && after !== delim) {
      nonSpaceGroup = after;
    }
  }
  if (!punctGroup && !nonSpaceGroup) return null;
  let n = prevChar;
  const sameChar = n === delim;
  const i = masked.length - e.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const beforeArr = Array.from(masked.slice(Math.max(0, l - 2), l));
  const p = beforeArr.length ? beforeArr[beforeArr.length - 1] : '';
  const h = p === '*' || p === '_' || isDelimiterPunct(p);
  if (l < i) n = p;
  const u = l < i ? h : isDelimiterPunct(n);
  if (delim === '_' && nonSpaceGroup && isAlphaNumeric(n)) return null;
  const d = punctGroup;
  if (d !== '' && n !== '' && !u) return null;
  const k = run;
  let pending = k;
  let skipped = 0;
  const y = i - l + k;
  const bigR = p.trim() !== '' && (d !== '' || (delim === '*' && !h));
  const v = info[delim];
  const q = i + k;
  if (v < q) return null;
  const t = masked.slice(q);
  const ee = v - q;
  const scanner = makeRDelimScanner(t, delim);
  let match;
  while ((match = scanner.next()) !== null) {
    if (match.index > ee) break;
    const g = match.group;
    if (!g) continue;
    let b = g.runText.length;
    if (g.slot === 3 || g.slot === 4) {
      pending += b;
      continue;
    }
    if (g.slot === 5 || g.slot === 6 || bigR) {
      if (sameChar && (g.slot === 5 || g.slot === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) {
        skipped += b;
        continue;
      }
    }
    pending -= b;
    if (pending > 0) continue;
    b = Math.min(b, b + pending + skipped);
    const raw = e.slice(0, k + match.index + firstCodePointLength(match.text) + b);
    const strong = Math.min(k, b) % 2 === 0;
    const inner = strong ? raw.slice(2, -2) : raw.slice(1, -1);
    const tokens = [];
    lexInline(ctx, inner, tokens);
    return { type: strong ? 'strong' : 'em', raw, text: inner, tokens };
  }
  return null;
}

function matchDel(ctx, e, masked, info, prevChar) {
  if (e[0] !== '~') return null;
  if (!info) return null;
  let run = 0;
  while (e[run] === '~') run++;
  if (run > 2) return null;
  const afterCp = e.codePointAt(run);
  if (afterCp === undefined) return null;
  const after = String.fromCodePoint(afterCp);
  if (after === '~' || /\s/.test(after)) return null;
  const punctGroup = isPunctOrSymbol(after) ? after : '';
  if (punctGroup && prevChar && !isDelimiterPunct(prevChar)) return null;
  const o = run;
  const u = info['~'];
  const d = masked.length - e.length + o;
  if (u < d) return null;
  const t = masked.slice(d);
  const k = u - d;
  let pending = o;
  const scanner = makeDelRDelimScanner(t);
  let match;
  while ((match = scanner.next()) !== null) {
    if (match.index > k) break;
    const g = match.group;
    if (!g) continue;
    let len = g.runText.length;
    if (len !== o) continue;
    if (g.slot === 3 || g.slot === 4) {
      pending += len;
      continue;
    }
    pending -= len;
    if (pending > 0) continue;
    len = Math.min(len, len + pending);
    const raw = e.slice(0, o + match.index + firstCodePointLength(match.text) + len);
    const inner = raw.slice(o, raw.length - o);
    const tokens = [];
    lexInline(ctx, inner, tokens);
    return { type: 'del', raw, text: inner, tokens };
  }
  return null;
}

// --- inline text ---------------------------------------------------------------------------

const EMAIL_LOCAL_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-";
const EMAIL_LOCAL_TABLE = (() => {
  const t = new Array(128).fill(false);
  for (const ch of EMAIL_LOCAL_CHARS) t[ch.charCodeAt(0)] = true;
  return t;
})();

function isAlnumCode(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

// Does an email local part start at `pos` and run into an '@'? Mirrors the
// grammar's email lookahead without allocating a slice.
function emailLocalAt(e, pos) {
  let k = pos;
  while (k < e.length) {
    const code = e.charCodeAt(k);
    if (code >= 128 || !EMAIL_LOCAL_TABLE[code]) break;
    k++;
  }
  return k > pos && e[k] === '@';
}

// Is there a hard-break marker ('  \n', two or more spaces then a newline)
// starting at `pos`?
function hardBreakAt(s, pos) {
  let i = pos;
  while (s[i] === ' ') i++;
  return i - pos >= 2 && s[i] === '\n';
}

// How much of `e` one plain-text token covers. Text runs end exactly where
// the grammar forces them to: before a special character, before a GFM
// autolink start (protocol, www., an email address, mailto:/xmpp:), or
// right after a character that precedes a hard break.
function scanText(e) {
  const n = e.length;
  const c0 = e[0];
  if (
    !isAlnumCode(e.charCodeAt(0)) &&
    (e.startsWith('mailto:', 1) || e.startsWith('xmpp:', 1))
  ) {
    return 1;
  }
  let i;
  if (c0 === '`' || c0 === '~') {
    i = 0;
    while (e[i] === c0) i++;
  } else {
    i = 1;
  }
  if (i >= n) return n;
  const ci = e[i];
  if (ci === '`' || ci === '~') return i;
  if (ci === ' ' && hardBreakAt(e, i)) return i;
  if (emailLocalAt(e, i)) return i;
  let j = i;
  while (j < n) {
    const c = e[j];
    const code = e.charCodeAt(j);
    if (isAlnumCode(code)) {
      // An alphanumeric character can only matter as the start of an
      // http/ftp/www. autolink, or as the character before a hard break.
      if (c === 'h' || c === 'H') {
        if (
          (e[j + 1] === 't' || e[j + 1] === 'T') &&
          (e[j + 2] === 't' || e[j + 2] === 'T') &&
          (e[j + 3] === 'p' || e[j + 3] === 'P')
        ) {
          return j;
        }
      } else if (c === 'f' || c === 'F') {
        if (
          (e[j + 1] === 't' || e[j + 1] === 'T') &&
          (e[j + 2] === 'p' || e[j + 2] === 'P') &&
          e[j + 3] === ':' &&
          e[j + 4] === '/' &&
          e[j + 5] === '/'
        ) {
          return j;
        }
      } else if (c === 'w' && e.startsWith('www.', j)) {
        if (j === 0 || /[\s*_~(]/.test(e[j - 1])) return j;
      }
      if (e[j + 1] === ' ' && e[j + 2] === ' ' && hardBreakAt(e, j + 1)) {
        return j + 1;
      }
      j++;
      continue;
    }
    if (
      c === '\\' || c === '<' || c === '!' || c === '[' || c === '`' ||
      c === '*' || c === '~' || c === '_'
    ) {
      return j;
    }
    if (c !== ' ' && e[j + 1] === ' ' && e[j + 2] === ' ' && hardBreakAt(e, j + 1)) {
      return j + 1;
    }
    if (e.startsWith('mailto:', j + 1) || e.startsWith('xmpp:', j + 1)) {
      return j + 1;
    }
    if (!EMAIL_LOCAL_TABLE[code] && emailLocalAt(e, j + 1)) {
      return j + 1;
    }
    j++;
  }
  return n;
}

// --- the inline driver --------------------------------------------------------------------------

function lexInline(ctx, src, out) {
  const saved = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = saved && src.includes(')');
  try {
    lexInlineRun(ctx, src, out);
  } finally {
    ctx.state.linkParenPossible = saved;
  }
}

function lexInlineRun(ctx, src, out) {
  let masked = src;
  let info = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskText(ctx, src);
    info = scanDelimiters(masked);
  }
  let e = src;
  let prevChar = '';
  let lastWasText = false;
  while (e.length > 0) {
    if (!lastWasText) prevChar = '';
    lastWasText = false;
    const c = e[0];
    let tok = null;
    if (c === '\\') {
      tok = matchEscape(e) || matchBr(e);
    } else if (c === '<') {
      tok = matchInlineTag(ctx, e) || matchAutolink(e);
    } else if (c === '[' || (c === '!' && e[1] === '[')) {
      tok = matchLink(ctx, e) || matchReflink(ctx, e);
    } else if (c === '*' || c === '_') {
      tok = matchEmStrong(ctx, e, masked, info, prevChar);
    } else if (c === '`') {
      tok = matchCodespan(e);
    } else if (c === '~') {
      tok = matchDel(ctx, e, masked, info, prevChar);
    } else if (c === ' ') {
      tok = matchBr(e);
    }
    if (!tok && !ctx.state.inLink) {
      const code = e.charCodeAt(0);
      if (
        isAlnumCode(code) || c === '.' || c === '_' || c === '+' || c === '-'
      ) {
        tok = matchUrl(e);
      }
    }
    if (tok) {
      e = e.slice(tok.raw.length);
      if (tok.fallback) {
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          out.push(tok);
        }
      } else {
        out.push(tok);
      }
      continue;
    }
    const len = scanText(e);
    const raw = e.slice(0, len);
    e = e.slice(len);
    if (!raw.endsWith('_')) {
      prevChar = raw.charAt(raw.length - 1);
    }
    lastWasText = true;
    const inRaw = ctx.state.inRawBlock;
    const text = inRaw ? raw : decodeNumericRefs(raw);
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text') {
      prev.raw += raw;
      prev.text += text;
    } else {
      out.push({ type: 'text', raw, text, escaped: inRaw });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const ctx = {
    links: Object.create(null),
    queue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
  };
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const tokens = [];
  lexBlocks(ctx, src, tokens, false);
  ctx.hasLinks = Object.keys(ctx.links).length > 0;
  for (let i = 0; i < ctx.queue.length; i++) {
    ctx.state.inRawBlock = false;
    lexInline(ctx, ctx.queue[i].src, ctx.queue[i].tokens);
  }
  return renderTokens(tokens);
}
