// A TAB THAT IS NOT BUILT YET, SAID PLAINLY.
//
// The alternative — hiding the tab until its tranche lands — was rejected for the
// same reason adminNav renders coming-soon modules: the owner is buying a system,
// and seeing where transfers and requisitions will live is part of understanding
// what they bought. What is NOT acceptable is a screen that looks finished and
// shows numbers nobody computed, so this panel does three things and no more:
// names what the tab will do, says what has to exist first, and points at what to
// use in the meantime.

interface ComingSoonPanelProps {
  title: string;
  summary: string;
  detail: string;
}

export function ComingSoonPanel({ title, summary, detail }: ComingSoonPanelProps) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 p-6">
      <span className="rounded-full bg-sand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
        Not built yet
      </span>
      <h2 className="mt-3 text-base font-semibold text-charcoal">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-charcoal">{summary}</p>
      <p className="mt-3 max-w-2xl text-sm text-charcoal-muted">{detail}</p>
    </div>
  );
}
