// A SMALL MARKDOWN PARSER — the one that turns docs/USER-GUIDE.md into blocks the
// Help page renders as React elements.
//
// WHY NOT A LIBRARY. Three reasons, in the order they mattered:
//
//   1. NO HTML IS EVER PRODUCED. Every markdown library in this class returns an
//      HTML string, which means rendering it needs dangerouslySetInnerHTML. This
//      returns a typed tree and the renderer builds React elements from it, so
//      there is no injection surface at all — not for today's trusted content and
//      not for whatever gets pasted into the guide in two years.
//   2. THE PAGE NEEDS THE STRUCTURE, NOT THE HTML. The table of contents, the
//      per-section search and the deep-link anchors are all built from the
//      heading tree. A library would hand back a blob the page would then have to
//      re-parse (or scrape from the DOM) to get the same tree back.
//   3. NO NEW DEPENDENCY. The bundle carries pdfmake and fflate already for real
//      reasons; ~250 lines that we own beats another package for rendering one
//      file we also own.
//
// THE SUBSET IT SUPPORTS is exactly what the guide uses, and the guide is checked
// against it: ATX headings (# .. ####), paragraphs, ordered and unordered lists
// (nested, multi-block items), tables with a header row, blockquotes, fenced code,
// horizontal rules, and inline code / bold / italic / links / images. Anything
// else falls through as plain text rather than throwing — a guide that renders
// slightly plainly is always better than a Help page that crashes.

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; src: string; alt: string };

export interface ListItem {
  // An item is a list of blocks so "a step, then a nested list of sub-steps" and
  // "a step with two paragraphs" both parse without a special case.
  blocks: Block[];
}

export type Block =
  | { kind: 'heading'; level: number; id: string; text: string; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; value: string }
  | { kind: 'rule' };

// --- inline ---------------------------------------------------------------

// One pass, longest-token-first. Order matters: code spans are taken before
// anything else so `**` inside backticks stays literal, and images before links
// because an image is a link with a bang in front of it.
const INLINE = new RegExp(
  [
    '`([^`]+)`', // 1: code
    '!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)', // 2,3: image
    '\\[([^\\]]+)\\]\\(([^)\\s]+)\\)', // 4,5: link
    '\\*\\*([^*]+)\\*\\*', // 6: strong
    '__([^_]+)__', // 7: strong
    '\\*([^*\\n]+)\\*', // 8: em
  ].join('|'),
  'g',
);

export function parseInline(src: string): Inline[] {
  // TWO PHASES, AND THE SPLIT IS LOAD-BEARING: scan the whole string first,
  // THEN recurse into the captured groups.
  //
  // A /g regex carries `lastIndex` on the regex OBJECT, and this function calls
  // itself for the contents of a link, a bold run or an italic run. Recursing in
  // the middle of the scan would leave the inner call's lastIndex behind for the
  // outer loop to resume from — which walks backwards over text it has already
  // consumed and matches the same token forever. (It does: a heap exhaustion, not
  // a wrong render.) Collecting the matches before any recursion means the scan
  // owns the regex for its whole life.
  const found: RegExpExecArray[] = [];
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(src)) !== null) {
    found.push(m);
    // A zero-length match cannot happen with these alternatives, but a guard
    // costs nothing and an infinite loop here costs the whole page.
    if (m[0].length === 0) INLINE.lastIndex += 1;
  }

  const out: Inline[] = [];
  let last = 0;
  for (const match of found) {
    if (match.index > last) pushText(out, src.slice(last, match.index));
    if (match[1] !== undefined) {
      out.push({ kind: 'code', value: match[1] });
    } else if (match[3] !== undefined) {
      out.push({ kind: 'image', alt: match[2] ?? '', src: match[3] });
    } else if (match[4] !== undefined) {
      out.push({
        kind: 'link',
        href: match[5] ?? '',
        children: parseInline(match[4]),
      });
    } else if (match[6] !== undefined) {
      out.push({ kind: 'strong', children: parseInline(match[6]) });
    } else if (match[7] !== undefined) {
      out.push({ kind: 'strong', children: parseInline(match[7]) });
    } else if (match[8] !== undefined) {
      out.push({ kind: 'em', children: parseInline(match[8]) });
    }
    last = match.index + match[0].length;
  }
  if (last < src.length) pushText(out, src.slice(last));
  return out;
}

function pushText(out: Inline[], value: string) {
  if (value.length === 0) return;
  out.push({ kind: 'text', value });
}

// The readable text of an inline run — what search matches on and what a heading
// id is built from.
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.value;
        case 'image':
          return n.alt;
        default:
          return inlineText(n.children);
      }
    })
    .join('');
}

// The readable text of a block tree — used by the Help page's search, so a query
// matches words in a table cell or a nested step, not only in headings.
export function blockText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'heading':
        case 'paragraph':
          return inlineText(b.children);
        case 'list':
          return b.items.map((i) => blockText(i.blocks)).join(' ');
        case 'table':
          return [
            b.head.map(inlineText).join(' '),
            ...b.rows.map((r) => r.map(inlineText).join(' ')),
          ].join(' ');
        case 'quote':
          return blockText(b.blocks);
        case 'code':
          return b.value;
        case 'rule':
          return '';
      }
    })
    .join('\n');
}

// --- blocks ---------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * Parse a markdown document into blocks.
 *
 * `slugs` is threaded through so heading ids stay unique across ONE document —
 * two sections both called "Checking out" must not produce two `#checking-out`
 * anchors, or a table-of-contents link would jump to the wrong one.
 */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines, new Set<string>());
}

function parseBlocks(lines: string[], slugs: Set<string>): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code.
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      out.push({ kind: 'code', value: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const children = parseInline(heading[2].trim());
      const text = inlineText(children);
      out.push({
        kind: 'heading',
        level: heading[1].length,
        id: uniqueSlug(text, slugs),
        text,
        children,
      });
      i += 1;
      continue;
    }

    // Blockquote — consecutive '>' lines, stripped and re-parsed.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push({ kind: 'quote', blocks: parseBlocks(body, slugs) });
      continue;
    }

    // Table — a pipe row followed by a divider row.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[i + 1])
    ) {
      const head = splitRow(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push({ kind: 'table', head, rows });
      continue;
    }

    // Lists.
    const ul = UL_ITEM.exec(line);
    const ol = OL_ITEM.exec(line);
    if (ul || ol) {
      const [list, next] = parseList(lines, i, slugs);
      out.push(list);
      i = next;
      continue;
    }

    // Paragraph — runs to the next blank line or the next block opener.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !opensBlock(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length > 0) {
      out.push({ kind: 'paragraph', children: parseInline(para.join(' ')) });
    } else {
      // A line that opens a block but was not consumed above (e.g. a stray table
      // row). Take it as text rather than looping forever.
      out.push({ kind: 'paragraph', children: parseInline(lines[i].trim()) });
      i += 1;
    }
  }

  return out;
}

function opensBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*```/.test(line)
  );
}

function splitRow(line: string): Inline[][] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => parseInline(cell.trim()));
}

// One list, from `start` until a line that is neither an item at this level nor
// indented content belonging to one. Each item's own lines are DEDENTED and
// re-parsed as blocks, which is what gives nested lists and multi-paragraph steps
// for free.
function parseList(
  lines: string[],
  start: number,
  slugs: Set<string>,
): [Block, number] {
  const first = UL_ITEM.exec(lines[start]) ?? OL_ITEM.exec(lines[start]);
  // parseList is only called when one of the two matched.
  const marker = first as RegExpExecArray;
  const ordered = OL_ITEM.test(lines[start]);
  const baseIndent = marker[1].length;
  const startNumber = ordered ? Number.parseInt(marker[2], 10) || 1 : 1;

  const items: ListItem[] = [];
  let buffer: string[] = [];
  let i = start;

  const flush = () => {
    if (buffer.length === 0) return;
    items.push({ blocks: parseBlocks(buffer, slugs) });
    buffer = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const item = UL_ITEM.exec(line) ?? OL_ITEM.exec(line);
    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    if (item && item[1].length === baseIndent) {
      // A sibling item: close the previous one and start collecting this one.
      const sameKind = ordered === OL_ITEM.test(line);
      if (!sameKind && items.length > 0) break;
      flush();
      buffer.push(item[3]);
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      // A blank line ends the list unless the next line is still inside it.
      const next = lines[i + 1];
      const nextIndent = next ? (next.match(/^\s*/)?.[0].length ?? 0) : 0;
      const nextIsItem = next ? UL_ITEM.test(next) || OL_ITEM.test(next) : false;
      if (!next || (nextIndent <= baseIndent && !nextIsItem)) break;
      buffer.push('');
      i += 1;
      continue;
    }

    if (indent > baseIndent) {
      // Continuation or nested content — dedent by the base indent so the
      // recursive parse sees it at column zero.
      buffer.push(line.slice(Math.min(indent, baseIndent + 2)));
      i += 1;
      continue;
    }

    break;
  }

  flush();
  return [{ kind: 'list', ordered, start: startNumber, items }, i];
}

// A url-safe anchor for a heading, unique within the document.
export function uniqueSlug(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  taken.add(slug);
  return slug;
}
