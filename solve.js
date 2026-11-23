// Sari's fast reimplementation of makefun-site 1.0.0's build, written from scratch
// for the site-generator-speed bounty. run(input) returns exactly the output tree
// makefun-site 1.0.0's build returns for the same input, byte for byte, but much
// faster: no per-line regexes, no per-character escaping, cached slugs and dates,
// and a fused lex-and-render Markdown pass. Single file, no dependencies.

// ---------------------------------------------------------------- text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MARK_RE = /\p{M}/gu;

/** Whether a UTF-16 code unit is whitespace the way JavaScript's \s sees it. */
function isWs(code) {
  if (code < 256) return code === 32 || (code >= 9 && code <= 13) || code === 160;
  return code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

const ESC_RE = /[&<>"']/;

/** HTML escaping: & < > " ' only. Returns the input untouched when it holds none. */
function escapeHtml(s) {
  const first = s.search(ESC_RE);
  if (first === -1) return s;
  let out = s.slice(0, first);
  let start = first;
  for (let i = first; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  return out + s.slice(start);
}

/** The slug of an already-normalised string: kept chars are a-z, 0-9 (A-Z lowered). */
function slugCore(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(c + 32);
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += plain[i];
    } else if (out.length > 0) {
      gap = true;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end < out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, runs of other chars one "-". */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const out = ascii ? slugCore(text) : slugCore(text.normalize('NFKD').replace(MARK_RE, ''));
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const dateCache = new Map();

/** "2026-11-09" in words: "9 November 2026". */
function longDate(date) {
  let hit = dateCache.get(date);
  if (hit === undefined) {
    hit = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
    dateCache.set(date, hit);
  }
  return hit;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // isWs, inlined: this test runs once per character, so no call
    const ws = c < 256
      ? c === 32 || (c >= 9 && c <= 13) || c === 160
      : c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  return 31;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never on " or [). */
function fmString(raw, key) {
  if (raw.charCodeAt(0) === 34) {
    const last = raw.length - 1;
    if (raw.length < 2 || raw.charCodeAt(last) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < last; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === last) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        out += raw[i + 1];
        i++;
      } else if (c === 34) {
        return { error: `key "${key}": a quoted string holds a stray quote` };
      } else {
        out += raw[i];
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(raw, key);
    case 'date': {
      const bad = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return bad;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) return bad;
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return bad;
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let k = 0; k < parts.length; k++) {
        const t = parts[k].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
          prevDash = false;
        } else {
          return { error: 'key "slug": not a slug' };
        }
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason. */
function parseFrontMatter(text) {
  const n = text.length;
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? n : firstNl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // The closing line is found before any line is read: a file whose front
  // matter is not closed refuses with that reason, whatever its lines hold.
  const fmStart = firstEnd + 1;
  let closeStart = -1;
  if (text.startsWith('---', fmStart) && (fmStart + 3 === n || text.charCodeAt(fmStart + 3) === 10)) {
    closeStart = fmStart;
  } else {
    let j = text.indexOf('\n---', fmStart);
    while (j !== -1) {
      const after = j + 4;
      if (after === n || text.charCodeAt(after) === 10) { closeStart = j + 1; break; }
      j = text.indexOf('\n---', j + 1);
    }
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const closeEnd = closeStart + 3 === n ? n : closeStart + 4;
  const data = {};
  let pos = fmStart;
  let lineNo = 2;
  while (pos < closeStart) {
    let end = text.indexOf('\n', pos);
    if (end === -1 || end >= closeStart) end = closeStart - 1;
    const line = text.slice(pos, end);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let i = 0;
      while (i < line.length) {
        const c = line.charCodeAt(i);
        if ((c >= 97 && c <= 122) || c === 95) i++;
        else break;
      }
      if (i === 0 || i >= line.length || line.charCodeAt(i) !== 58) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, i);
      let raw;
      if (i + 1 === line.length) raw = '';
      else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c === 32 || c === 9) rEnd--;
        else break;
      }
      if (rEnd < raw.length) raw = raw.slice(0, rEnd);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = end + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** A blank line: spaces and tabs only. */
function isBlankLine(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language, or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether the line closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length) {
    const d = line.charCodeAt(i);
    if (d === 32 || d === 9) i++;
    else break;
  }
  let end = line.length;
  while (end > i) {
    const d = line.charCodeAt(end - 1);
    if (d === 32 || d === 9) end--;
    else break;
  }
  if (end === i) return null;
  return { depth: n, text: line.slice(i, end) };
}

/** Whether the line is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and text after "N. ", or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), rest: line.slice(i + 2) };
}

/** A list continuation: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  return !(c < 256 ? c === 32 || (c >= 9 && c <= 13) || c === 160
    : c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
}

/** The characters a backslash escapes, by code (0-127). */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether `s` holds any whitespace. */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // isWs, inlined
    if (c < 256 ? c === 32 || (c >= 9 && c <= 13) || c === 160
      : c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) return true;
  }
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    // A match is escaped exactly when the run of backslashes right before it (from
    // `from` on) is odd: pairs swallow two at a time, so an odd run's last one
    // pairs with the match's first character, an even run's with each other.
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) { bs++; k--; }
    if (bs % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) { bs++; k--; }
    if (bs % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  // No per-character loop: indexOf jumps to the next structural character
  // (\, `, *, [) and the plain text between them is escaped in one call.
  let out = '';
  let plain = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const b1 = s.indexOf('\\', i);
    const b2 = s.indexOf('`', i);
    const b3 = s.indexOf('*', i);
    const b4 = s.indexOf('[', i);
    let next = -1;
    if (b1 !== -1) next = b1;
    if (b2 !== -1 && (next === -1 || b2 < next)) next = b2;
    if (b3 !== -1 && (next === -1 || b3 < next)) next = b3;
    if (b4 !== -1 && (next === -1 || b4 < next)) next = b4;
    if (next === -1) break;
    const c = s.charCodeAt(next);
    if (c === 92) {
      if (next + 1 < n && ESCAPABLE[s.charCodeAt(next + 1)] === 1) {
        out += escapeHtml(s.slice(plain, next));
        out += s[next + 1];
        i = next + 2;
        plain = i;
      } else {
        i = next + 1;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', next + 1);
      if (j > next + 1) {
        out += escapeHtml(s.slice(plain, next));
        out += '<code>' + escapeHtml(s.slice(next + 1, j)) + '</code>';
        i = j + 1;
        plain = i;
      } else {
        i = next + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(next + 1) === 42) {
        const j = findUnescaped(s, '**', next + 2);
        if (j > next + 2) {
          out += escapeHtml(s.slice(plain, next));
          out += '<strong>' + inline(s.slice(next + 2, j), env) + '</strong>';
          i = j + 2;
          plain = i;
        } else {
          i = next + 2;
        }
      } else {
        const j = findSingleStar(s, next + 1);
        if (j > next + 1) {
          out += escapeHtml(s.slice(plain, next));
          out += '<em>' + inline(s.slice(next + 1, j), env) + '</em>';
          i = j + 1;
          plain = i;
        } else {
          i = next + 1;
        }
      }
      continue;
    }
    // c === 91 '['
    const k = findUnescaped(s, ']', next + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWhitespace(target)) {
      out += escapeHtml(s.slice(plain, next));
      out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(next + 1, k), env) + '</a>';
      i = m + 1;
      plain = i;
    } else {
      i = next + 1;
    }
  }
  return out + escapeHtml(s.slice(plain));
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents
 * (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Every block marker sits at the line's first character, so one dispatch
    // replaces the chain of classifier calls; a line starting in a space or tab
    // can only be blank or a paragraph.
    if (line.length === 0) { i++; continue; }
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) { i++; continue; }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let code = '<pre><code';
        if (lang !== '') code += ' class="language-' + lang + '"';
        code += '>';
        while (i < n && !isFenceClose(lines[i])) {
          code += escapeHtml(lines[i]) + '\n';
          i++;
        }
        i++;
        html += code + '</code></pre>\n';
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const inner = inline(h.text, env);
        html += '<h' + h.depth + ' id="' + id + '">' + inner + '</h' + h.depth + '>\n';
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: inner });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) { html += '<hr>\n'; i++; continue; }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [[trimLine(b)]];
        i++;
        while (i < n) {
          const l = lines[i];
          const nb = bulletOf(l);
          if (nb !== null) { items.push([trimLine(nb)]); i++; continue; }
          if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
          break;
        }
        let listHtml = '<ul>\n';
        for (const parts of items) listHtml += '<li>' + inline(parts.join('\n'), env) + '</li>\n';
        html += listHtml + '</ul>\n';
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) html += '<blockquote>\n</blockquote>\n';
      else html += '<blockquote>\n<p>' + inline(kept.join('\n'), env) + '</p>\n</blockquote>\n';
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const items = [[trimLine(o.rest)]];
        i++;
        while (i < n) {
          const l = lines[i];
          const no = orderedOf(l);
          if (no !== null) { items.push([trimLine(no.rest)]); i++; continue; }
          if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
          break;
        }
        let listHtml = o.start !== 1 ? '<ol start="' + o.start + '">\n' : '<ol>\n';
        for (const parts of items) listHtml += '<li>' + inline(parts.join('\n'), env) + '</li>\n';
        html += listHtml + '</ol>\n';
        continue;
      }
    }
    // A paragraph: this line and the lines after it, up to a blank line, a
    // fence, a heading or a break (a quote or list line does not end one).
    const parts = [trimLine(line)];
    i++;
    while (i < n) {
      const l = lines[i];
      const d0 = l.charCodeAt(0);
      if (l.length === 0) break;
      if (d0 === 32 || d0 === 9) {
        if (isBlankLine(l)) break;
      } else if (d0 === 96) {
        if (fenceLang(l) !== null) break;
      } else if (d0 === 35) {
        if (headingOf(l) !== null) break;
      } else if (d0 === 45 || d0 === 42) {
        if (isHr(l)) break;
      }
      parts.push(trimLine(l));
      i++;
    }
    const pHtml = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = pHtml;
    html += '<p>' + pHtml + '</p>\n';
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(tplName, text) {
  const bad = () => {
    throw new TemplateError(`template "${tplName}": ${JSON.stringify(text)} is not a path`);
  };
  if (text.length === 0) bad();
  const segs = [];
  let i = 0;
  const n = text.length;
  while (true) {
    if (i >= n || !isNameStart(text.charCodeAt(i))) bad();
    let j = i + 1;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    segs.push(text.slice(i, j));
    if (j >= n) break;
    if (text.charCodeAt(j) !== 46) bad();
    i = j + 1;
    if (i >= n) bad();
  }
  return segs;
}

/** Whether src[a..b) holds spaces and tabs only. */
function onlySpaces(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(tplName, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = raw ? src.indexOf('}}}', open + 3) : src.indexOf('}}', open + 2);
      if (close === -1) throw new TemplateError(`template "${tplName}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(tplName, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${tplName}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** "for x in path": { name, path }, or null. */
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const name = tag.slice(4, i);
  if (!tag.startsWith(' in ', i)) return null;
  const path = tag.slice(i + 4);
  if (path.length === 0) return null;
  for (let j = 0; j < path.length; j++) if (isWs(path.charCodeAt(j))) return null;
  return { name, path };
}

/** "if path" or "if not path": { not, path }, or null. */
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.startsWith('not ', i)) { not = true; i += 4; }
  const path = tag.slice(i);
  if (path.length === 0) return null;
  for (let j = 0; j < path.length; j++) if (isWs(path.charCodeAt(j))) return null;
  return { not, path };
}

/** 'include "name"': the name, or null. */
function matchInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(tplName, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(tplName, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const forM = matchFor(tag);
      if (forM !== null) {
        // One reusable scope per for node: rendering is synchronous, so each
        // render saves and restores the element and the loop fields instead
        // of allocating a fresh scope, vars and loop object per iteration.
        const loopObj = { index: 0, first: false, last: false, length: 0 };
        const vars = { [forM.name]: undefined, loop: loopObj };
        const node = { kind: 'for', name: forM.name, path: pathOf(tplName, forM.path), body: [], vars, loopObj, scope: { vars, parent: null } };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const ifM = matchIf(tag);
      if (ifM !== null) {
        const node = { kind: 'if', not: ifM.not, path: pathOf(tplName, ifM.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${tplName}": an else outside an if`);
        top.else = [];
        body = top.else;
        continue;
      }
      if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${tplName}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
        continue;
      }
      const inc = matchInclude(tag);
      if (inc !== null) {
        body.push({ kind: 'include', name: inc });
        continue;
      }
      throw new TemplateError(`template "${tplName}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${tplName}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); `templates` maps names to nodes. */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out += escapeHtml(v);
        else if (typeof v === 'number' || typeof v === 'boolean') out += textOf(v);
        else out += escapeHtml(textOf(v));
        break;
      }
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const vars = n.vars;
        const loopObj = n.loopObj;
        const sc = n.scope;
        const prevEl = vars[n.name];
        const prevIdx = loopObj.index;
        const prevFirst = loopObj.first;
        const prevLast = loopObj.last;
        const prevLen = loopObj.length;
        const prevParent = sc.parent;
        sc.parent = scope;
        for (let k = 0; k < xs.length; k++) {
          if (n.name !== 'loop') vars[n.name] = xs[k];
          loopObj.index = k + 1;
          loopObj.first = k === 0;
          loopObj.last = k === xs.length - 1;
          loopObj.length = xs.length;
          out += renderNodes(n.body, sc, templates, depth);
        }
        if (n.name !== 'loop') vars[n.name] = prevEl;
        loopObj.index = prevIdx;
        loopObj.first = prevFirst;
        loopObj.last = prevLast;
        loopObj.length = prevLen;
        sc.parent = prevParent;
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < 8) out += renderNodes(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens on a scheme ("https:", "mailto:", ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return target.charCodeAt(i) === 58;
}

/** A page's link record as templates read it (built once per page, shared). */
function linkOf(s) {
  if (s === null) return null;
  if (s.linkView === undefined) {
    s.linkView = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  }
  return s.linkView;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const site = input.site;
  let base = site.base_url;
  let bi = base.length;
  while (bi > 0 && base.charCodeAt(bi - 1) === 47) bi--;
  if (bi < base.length) base = base.slice(0, bi);

  // Templates, parsed in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n"; the rest is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter and the refusal checks, in order; a draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return page.url + frag;
          if (staticPaths.has(path)) return base + '/' + path + frag;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's neighbours.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const names = p.data.tags ?? [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const seen = new Set();
    const names = s.data.tags ?? [];
    s.tagRefs = [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = bySlug.get(slug);
      s.tagRefs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them.
  function cardOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => t.view ?? (t.view = { name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  function pageOf(s) {
    const c = cards.get(s) ?? cardOf(s);
    return {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // Layouts: every page through its layout, the index and tag pages through theirs.
  const output = {};
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));
  // One root scope for every render of this site: rendering is synchronous, so
  // each render sets the keys it owns and clears the others to undefined (a
  // key holding undefined reads exactly as a missing key). No fresh object per
  // page, and the spread is gone.
  const rootVars = { site: siteCtx, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  function render(name, vars) {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    return renderNodes(nodes, rootScope, templates, 0);
  }
  for (const s of kept) {
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  function indexUrl(k) {
    return k === 1 ? base + '/' : base + '/page/' + k + '/';
  }
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
