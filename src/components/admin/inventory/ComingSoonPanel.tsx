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

interface ComingSoonPanelProps {
  title: string;
  summary: string;
  detail: string;
  // What must be built first, one item per line. Rendered as a list because it
  // is a list — prose hides how many things are actually outstanding.
  needs?: string[];
  // The honest answer to "so what do I do until then?".
  meanwhile?: string;
}

export function ComingSoonPanel({
  title,
  summary,
  detail,
  needs,
  meanwhile,
}: ComingSoonPanelProps) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 p-4 sm:p-6">
      <span className="rounded-full bg-sand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
        Not built yet
      </span>
      <h2 className="mt-3 text-base font-semibold text-charcoal">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-charcoal">{summary}</p>
      <p className="mt-3 max-w-2xl text-sm text-charcoal-muted">{detail}</p>

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
