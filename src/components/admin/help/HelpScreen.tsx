import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../../ui/Markdown';
import { CloseIcon, SearchIcon } from '../../ui/icons';
import {
  countMatches,
  searchGuide,
  USER_GUIDE,
  type GuideMatch,
} from '../../../lib/userGuide';

// THE IN-APP HELP PAGE — the staff guide, rendered from docs/USER-GUIDE.md.
//
// IT HOLDS NO PROSE OF ITS OWN. Every word on this screen comes from that file
// (see lib/userGuide), so the repo document and the Help page cannot drift: there
// is only one of them. What this component adds is the way IN — contents, search
// and anchors — because a guide nobody can navigate is a guide nobody reads.
//
// FINDING A TASK IN A TAP OR TWO, which is the point of the whole exercise:
//   * the CONTENTS lists every section and, under it, every task. On a computer
//     it is a sticky rail beside the guide; at 360px it is a collapsed "Jump to a
//     task" panel above it, so the guide is what fills a phone screen.
//   * SEARCH filters to the TASKS containing every word typed — not to the
//     sections holding them. Typing "discount" leaves "Giving a discount" and
//     "Reversing a discount" on screen, which is an answer; leaving the whole
//     Front desk section on screen would not be. It matches the whole task text,
//     so "manager pin" finds a task whose heading says "approval PIN".
//   * every heading is an ANCHOR, so a manager can send a colleague a link
//     straight to "Reversing a payment".
//
// NO BROWSER STORAGE (constraint). The query lives in component state and the
// position lives in the URL hash — the browser's own mechanism, which survives a
// refresh without this app storing anything.
//
// PRINTABLE: the search box, the contents and the result count are print:hidden,
// so a hotel that wants the guide in the desk drawer prints the guide.

export function HelpScreen() {
  const [query, setQuery] = useState('');
  const guide = USER_GUIDE;

  const matches = useMemo(() => searchGuide(query, guide), [query, guide]);
  const filtering = query.trim().length > 0;
  const resultCount = countMatches(matches);

  // A hash in the URL is a deep link to one task. The browser scrolls to it by
  // itself only on a full page load; arriving here through the app is a
  // client-side navigation, so the element has to be found and scrolled to once
  // it exists.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.replace('#', ''));
    if (!id) return;
    // After paint, so the guide is in the document when we look for the target.
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          {guide.title}
        </h1>

        <div className="mt-3 print:hidden">
          <label className="relative block max-w-md">
            <span className="sr-only">Search the guide</span>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search — e.g. check in, discount, refund"
              // min-h-11: a thumb-sized target, like every other control the
              // front desk uses on a phone.
              className="min-h-11 w-full rounded-full border border-sand-border bg-white/70 pr-10 pl-9 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            />
            {filtering ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            ) : null}
          </label>

          {filtering ? (
            <p className="mt-2 text-xs text-charcoal-muted" aria-live="polite">
              {resultCount === 0
                ? `Nothing in the guide matches “${query.trim()}”.`
                : `${resultCount} ${resultCount === 1 ? 'task' : 'tasks'} match “${query.trim()}”.`}
            </p>
          ) : null}
        </div>
      </header>

      {/* MOBILE CONTENTS: a native <details>, collapsed, so the guide fills a
          360px screen and the jump list is one tap away. Native, so it needs no
          state and stays keyboard- and screen-reader-accessible. */}
      <details className="mb-5 rounded-2xl border border-sand-border bg-white/60 lg:hidden print:hidden">
        <summary className="min-h-11 cursor-pointer list-none px-4 py-3 text-sm font-semibold text-charcoal [&::-webkit-details-marker]:hidden">
          Jump to a task ▾
        </summary>
        <div className="border-t border-sand-border px-2 py-2">
          <Contents matches={matches} filtering={filtering} />
        </div>
      </details>

      <div className="grid items-start gap-8 lg:grid-cols-[16rem_1fr]">
        {/* DESKTOP CONTENTS: sticky under the admin's own sticky header, with its
            own scroll, so a long list never runs off the bottom of the rail. */}
        <aside className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto print:hidden">
          <p className="px-3 pb-2 text-xs font-semibold tracking-wide text-charcoal-muted uppercase">
            Contents
          </p>
          <Contents matches={matches} filtering={filtering} />
        </aside>

        <article className="min-w-0">
          {/* The document's opening is orientation, not an answer to a search —
              it is hidden while filtering so results start at the top. */}
          {!filtering ? (
            <div className="rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6">
              <Markdown blocks={guide.intro} />
            </div>
          ) : null}

          {matches.length === 0 ? (
            <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
              Nothing here matches that. Try a single word — <em>discount</em>,{' '}
              <em>refund</em>, <em>no-show</em> — or clear the search to read the
              whole guide.
            </p>
          ) : (
            matches.map(({ section, showLead, tasks }) => (
              <section
                key={section.id}
                className="mt-6 rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6"
              >
                <h2
                  id={section.id}
                  className="scroll-mt-24 text-xl font-bold tracking-tight text-charcoal"
                >
                  {section.title}
                </h2>
                {showLead ? <Markdown blocks={section.lead} /> : null}
                {tasks.map((task) => (
                  <Markdown key={task.id} blocks={task.blocks} />
                ))}
              </section>
            ))
          )}
        </article>
      </div>
    </div>
  );
}

// The contents list, shared by the desktop rail and the mobile panel so there is
// ONE of them: two copies would eventually disagree about what a search hides.
//
// While filtering it shows only what is on screen, so the list and the page
// always describe the same thing.
function Contents({
  matches,
  filtering,
}: {
  matches: GuideMatch[];
  filtering: boolean;
}) {
  if (matches.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-charcoal-muted">No matching tasks.</p>
    );
  }

  return (
    <nav aria-label="Guide contents" className="text-sm">
      <ul className="space-y-1">
        {matches.map(({ section, tasks }) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="block rounded-lg px-3 py-2 font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              {section.title}
              {filtering && tasks.length > 0 ? (
                <span className="ml-1 font-normal text-charcoal-muted">
                  ({tasks.length})
                </span>
              ) : null}
            </a>
            {tasks.length > 0 ? (
              <ul className="mb-1 ml-3 border-l border-sand-border pl-2">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <a
                      href={`#${task.id}`}
                      className="block rounded-lg px-3 py-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                    >
                      {task.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
