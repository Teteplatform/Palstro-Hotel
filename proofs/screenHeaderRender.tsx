import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ScreenHeader } from '../src/components/ui/ScreenHeader';

// THE PROOF FOR RULE 25 — the shape of a screen's top, and it is a proof of the
// RULE rather than of one screen.
//
// The inventory pass applied "one line of purpose, then the controls" by hand,
// tab by tab. Hand application is exactly what the rule was written against: the
// Stock Take tab reached six things to read before its first button one helpful
// paragraph at a time, and every one of those was added by somebody who thought
// they were improving it. A convention that depends on being remembered decays
// at the speed of the team's memory.
//
// So there are two halves here, and the second is the one that keeps working
// after everybody has forgotten this file exists:
//
//   PART 1  ScreenHeader renders the shape — one purpose line, at most one ⓘ,
//           actions level with the title, and a tab's h2 where a page has an h1.
//   PART 2  A SOURCE SWEEP over every `<ScreenHeader …>` in src/. It reads the
//           props as written and fails if a purpose line has grown a second
//           sentence, or if an `about` was given without somewhere to send the
//           reader. This is the half that catches the drift, because drift never
//           arrives as a broken component — it arrives as one more sentence.
//
// ---------------------------------------------------------------------------
// MADE TO FAIL BEFORE IT WAS TRUSTED
// ---------------------------------------------------------------------------
//   1. A second sentence added to the Bookings purpose ("Every reservation for
//      this property. Create one, manage it, and see what it is worth."). PART 2
//      went RED naming the file and the line. This is the exact regression the
//      rule exists to stop and the one a reviewer waves through.
//   2. `purpose` widened to ReactNode and given a fragment of two <p>s. It does
//      not compile — which is the better answer, and is why the prop is a string.
//      Recorded here so a future reader knows the guard is the type, not a test.
//   3. The <p> removed from ScreenHeader entirely. PART 1 went RED on the purpose
//      assertions while every source check stayed green, which is the split
//      working as intended: the component proof guards the rendering, the sweep
//      guards the writing.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const strip = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const render = (node: React.ReactElement) =>
  renderToString(<MemoryRouter>{node}</MemoryRouter>);

// ---------------------------------------------------------------------------
// PART 1 — the shape
// ---------------------------------------------------------------------------
console.log('\n=== 1. ScreenHeader renders one line, one ⓘ, actions beside ===');

const full = render(
  <ScreenHeader
    title="Bookings"
    purpose="Every reservation for this property."
    about={{
      title: 'About the bookings list',
      paragraphs: ['One.', 'Two.', 'Three.'],
      guideAnchor: 'the-bookings-list',
      guideLabel: 'The bookings list',
    }}
    propertySlug="heledon"
    actions={<button type="button">New booking</button>}
  />,
);
console.log(`\n  ${strip(full)}\n`);

ok('the title is the page heading', /<h1[^>]*>Bookings<\/h1>/.test(full));
ok(
  'there is EXACTLY ONE paragraph of purpose',
  (full.match(/<p[^>]*>/g) ?? []).length === 1,
  `${(full.match(/<p[^>]*>/g) ?? []).length} <p> elements`,
);
ok('and it says what the screen is for', strip(full).includes('Every reservation'));
ok(
  'the ⓘ is present, once',
  (full.match(/aria-label="About the bookings list"/g) ?? []).length === 1,
);
ok('the action renders', strip(full).includes('New booking'));

// THE ORDER MATTERS AS MUCH AS THE CONTENT. "Then the controls" is the rule; an
// action that renders after a paragraph of explanation is the layout the rule
// was written against, and only the source order shows it.
const purposeAt = full.indexOf('Every reservation');
const actionAt = full.indexOf('New booking');
ok(
  'the action is not buried below the words',
  actionAt > purposeAt && actionAt - purposeAt < 400,
  `${actionAt - purposeAt} characters apart`,
);

// A tab is its own screen and gets the same shape one size down.
const tab = render(
  <ScreenHeader level={2} title="Adjustments" purpose="Correct a quantity." />,
);
ok('a tab renders an h2, not a second h1', /<h2[^>]*>Adjustments<\/h2>/.test(tab));
ok('and needs no ⓘ to be valid', !tab.includes('aria-haspopup'));

// The ⓘ is not rendered without a slug to link with — a panel that cannot reach
// the guide is the thing AboutNote refuses to be.
const noSlug = render(
  <ScreenHeader
    title="Orphan"
    about={{ title: 'x', paragraphs: ['y'], guideAnchor: 'z', guideLabel: 'Z' }}
  />,
);
ok('no slug, no ⓘ — it is never rendered half-wired', !noSlug.includes('aria-haspopup'));

// ---------------------------------------------------------------------------
// PART 2 — the sweep: every ScreenHeader in the app, as written
// ---------------------------------------------------------------------------
console.log('=== 2. Every <ScreenHeader> in src/, read as written ===');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    else if (name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

interface Usage {
  file: string;
  line: number;
  purpose: string | null;
  hasAbout: boolean;
  hasAnchor: boolean;
  hasSlug: boolean;
}

const usages: Usage[] = [];
for (const file of tsxFiles('src')) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('<ScreenHeader')) continue;
  // Each usage runs from the tag to its self-closing bracket. Written this way
  // rather than parsed because the shape being checked is a literal prop, and a
  // literal is exactly what a regex can see.
  const re = /<ScreenHeader\b([\s\S]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const props = m[1];
    const purpose = /purpose="([^"]*)"/.exec(props);
    usages.push({
      file,
      line: source.slice(0, m.index).split('\n').length,
      purpose: purpose ? purpose[1] : null,
      hasAbout: /\babout=\{/.test(props),
      hasAnchor: /guideAnchor:/.test(props),
      hasSlug: /propertySlug=\{/.test(props),
    });
  }
}

ok('the sweep found the screens', usages.length >= 8, `${usages.length} headers`);

// ONE SENTENCE. The test is "does it end once" rather than a word count: a long
// sentence can be the right line, and two short ones never are — the second is
// always the explanation that belongs behind the ⓘ.
const multiSentence = usages.filter(
  (u) => u.purpose && /[.!?]\s+\S/.test(u.purpose.replace(/\b([A-Z])\.\s/g, '$1_')),
);
ok(
  'every purpose line is ONE sentence',
  multiSentence.length === 0,
  multiSentence.map((u) => `${u.file}:${u.line} — "${u.purpose}"`).join(' | ') || 'all single',
);

// A purpose that runs long is a paragraph wearing a sentence's clothes.
const tooLong = usages.filter((u) => u.purpose && u.purpose.length > 90);
ok(
  'and none has grown into a paragraph',
  tooLong.length === 0,
  tooLong.map((u) => `${u.file}:${u.line} (${u.purpose?.length} chars)`).join(' | ') || 'all short',
);

// An ⓘ with no anchor is a summary with nowhere to go; an ⓘ with no slug never
// renders at all, which is worse — the explanation is written and invisible.
const noAnchor = usages.filter((u) => u.hasAbout && !u.hasAnchor);
ok(
  'every ⓘ names a guide section',
  noAnchor.length === 0,
  noAnchor.map((u) => `${u.file}:${u.line}`).join(' | ') || 'all anchored',
);

const noSlugUsage = usages.filter((u) => u.hasAbout && !u.hasSlug);
ok(
  'and every ⓘ is given the slug it needs to render',
  noSlugUsage.length === 0,
  noSlugUsage.map((u) => `${u.file}:${u.line}`).join(' | ') || 'all wired',
);

// Every anchor must exist in the guide. A link to a heading that was renamed is
// a link to the top of a 1,600-line document, and nothing would have said so.
const guide = readFileSync('docs/USER-GUIDE.md', 'utf8');
const guideAnchors = new Set(
  [...guide.matchAll(/^#{2,4}\s+(.+)$/gm)].map(([, heading]) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  ),
);

const anchors: { file: string; line: number; anchor: string }[] = [];
for (const file of tsxFiles('src')) {
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(/guideAnchor[:=]\s*["'{]?["']([a-z0-9-]+)["']/g)) {
    anchors.push({
      file,
      line: source.slice(0, m.index ?? 0).split('\n').length,
      anchor: m[1],
    });
  }
}

ok('the sweep found the guide links', anchors.length >= 8, `${anchors.length} links`);

const dangling = anchors.filter((a) => !guideAnchors.has(a.anchor));
ok(
  'every ⓘ link points at a heading that exists in the guide',
  dangling.length === 0,
  dangling.map((a) => `${a.file}:${a.line} → #${a.anchor}`).join(' | ') || 'all resolve',
);

console.log(`\n================  ${pass} PASSED, ${fail} FAILED  ================`);
process.exit(fail ? 1 : 0);
