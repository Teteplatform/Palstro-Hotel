// A TAB THAT IS NOT BUILT YET, SAID PLAINLY.
//
// The alternative — hiding the tab until its tranche lands — was rejected for the
// same reason adminNav renders coming-soon modules: the owner is buying a system,
// and seeing where a feature will live is part of understanding what they bought.
// What is NOT acceptable is a screen that looks finished and shows numbers nobody
// computed, and what is equally not acceptable is a panel that says "coming soon"
// and stops — that is a dead end with a polite face on it.
//
// So this panel answers the three questions somebody actually has when they land
// on an unbuilt tab, and refuses to render looking finished without them:
//   1. what will this do?
//   2. what has to exist before it can?
//   3. what do I do today?
//
// RULE 25 APPLIES HERE TOO, with one adjustment. A screen with no actions cannot
// put its explanation behind the controls, because there are none — so the three
// answers stay on the panel, which is the whole reason it exists. What moved
// behind the ⓘ is the fourth thing it used to say: the paragraph of REASONING
// about why the feature cannot be faked from data already present. That is the
// part written for somebody who asks "why not just work it out?", and they can
// now ask.

interface ComingSoonPanelProps {
  title: string;
  summary: string;
  // The reasoning, behind the ⓘ. Not on the panel.
  detail: string;
  // For the ⓘ's link into the staff guide.
  propertySlug: string;
  // What must be built first, one item per line. Rendered as a list because it
  // is a list — prose hides how many things are actually outstanding.
  needs?: string[];
  // The honest answer to "so what do I do until then?".
  meanwhile?: string;
}

import { AboutNote } from '../../ui/AboutNote';


export function ComingSoonPanel({
  title,
  summary,
  detail,
  propertySlug,
  needs,
  meanwhile,
}: ComingSoonPanelProps) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 p-4 sm:p-6">
      <span className="rounded-full bg-sand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
        Not built yet
      </span>
      <div className="mt-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-charcoal">{title}</h2>
        <AboutNote
          title={`Why ${title.toLowerCase()} is not built yet`}
          paragraphs={[detail]}
          propertySlug={propertySlug}
          guideAnchor="not-built-yet"
          guideLabel="Not built yet"
        />
      </div>
      <p className="mt-1 max-w-2xl text-sm text-charcoal">{summary}</p>

      {needs && needs.length > 0 ? (
        <div className="mt-4 max-w-2xl">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            What has to exist first
          </h3>
          <ul className="mt-2 space-y-1.5">
            {needs.map((need) => (
              <li
                key={need}
                className="flex gap-2 text-sm text-charcoal-muted"
              >
                <span aria-hidden="true" className="text-charcoal-muted">
                  •
                </span>
                <span>{need}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {meanwhile ? (
        <div className="mt-4 max-w-2xl rounded-xl border border-sand-border bg-white/60 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            What to do until then
          </h3>
          <p className="mt-1 text-sm text-charcoal">{meanwhile}</p>
        </div>
      ) : null}
    </div>
  );
}
