// THE TWO QUESTIONS A STOCK-OUT CAN BE ASKED, in one panel (1.1g2).
//
// Both the adjustment form and the write-off form sit in front of the same two
// overridable gates, and the brief for 050 asked for them to "read as the same
// kind of moment". That is not a styling note — it is why this is one component
// and not two copies: the day one of these sentences is improved, the other must
// improve with it, and a copy is a thing that silently stops matching.
//
// EXTRACTED RATHER THAN COPIED (rule 22) so the render proof drives THIS, the
// panel the screens run. A proof against a reconstruction would prove the
// reconstruction.
//
// ---------------------------------------------------------------------------
// THE SERVER'S SENTENCE IS NEVER REWRITTEN HERE (rule 21)
// ---------------------------------------------------------------------------
// `message` arrives from the database with its hint already appended, and is
// rendered verbatim. What this component adds underneath is the CONSEQUENCE —
// what confirming does to this hotel's records — which is the one thing the
// database cannot say, because it is about what happens next rather than about
// the rule. Rule 25 keeps it on screen rather than behind an ⓘ: somebody at the
// moment of an irreversible act is deciding on exactly that sentence.

export type StockGate = 'negative' | 'unvalued';

export function ConfirmGatePanel({
  message,
  gate,
  // "recording it" / "writing it off" — the only word that differs between the
  // two screens, because a sentence about a write-off should say write-off.
  verb,
  busy,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  gate: StockGate;
  verb: string;
  busy: boolean;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3"
      role="alert"
    >
      {/* THE DATABASE'S OWN WORDS, with its hint. */}
      <p className="text-sm font-medium text-charcoal">{message}</p>

      {/* THE CONSEQUENCE, which differs because the two gates are about
          different things. PT449 is a quantity that will not add up; PT450 is a
          value that will not. Merging them into one "are you sure" would make
          the second invisible on the day only it applies. */}
      {gate === 'negative' ? (
        <p className="mt-1 text-xs text-charcoal-muted">
          Recording it anyway is the honest thing to do if the stock really is
          gone — the shortfall stays visible instead of being rounded away, and
          it is what makes the difference show up in a report.
        </p>
      ) : (
        <p className="mt-1 text-xs text-charcoal-muted">
          This stock has no cost history, so {verb} will reduce what is on the
          shelf without reducing what the books say it was worth. The difference
          shows on the stock-against-ledger check until somebody records what it
          cost.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
        >
          {busy ? 'Recording…' : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:opacity-60"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
