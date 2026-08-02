import { useCallback, useEffect, useState } from 'react';
import { loadStatement } from '../lib/statementLoad';
import type { StatementData } from '../lib/statement';
import type { StatementMissing, StatementTarget } from '../lib/statementLoad';
import type { Property } from '../types/tenant';

// The statement, loaded for a SCREEN: the same read every other surface uses
// (lib/statementLoad), wrapped in the loading / missing / error states a page
// has to render.
//
// THE READ ITSELF LIVES IN lib/statementLoad, not here, because the exports can
// be asked for from surfaces that never render the document — the stay page's
// export menu and the guest home's stay actions both need the assembled
// statement without mounting a hook to get it. One loader, one document.
//
// "NOT FOUND" IS NOT AN ERROR, AND THE TWO ARE KEPT APART. A guest who never had
// a bar tab has no standalone folio, and the honest answer is "there is nothing
// to print" — not a red failure panel. A BOOKING with no folio, by contrast, is
// a genuine fault (the trigger opens one for every booking), and the screen says
// so rather than rendering a convincing ₦0.00.

// Re-exported so the screens that already import these names from the hook keep
// working; the definitions live with the loader.
export type { StatementMissing, StatementTarget } from '../lib/statementLoad';

export interface UseStatementResult {
  statement: StatementData | null;
  // Set when the document could not be built for a structural reason rather
  // than a failure. Exactly one of `statement`, `missing` and `error` is
  // meaningful once loading is false.
  missing: StatementMissing | null;
  loading: boolean;
  // The RAW error, preserved for describeError (rule 11) — a PostgREST error is
  // a plain object, and wrapping it in new Error(String(e)) yields
  // "[object Object]".
  error: unknown;
  reload: () => void;
}

export function useStatement(
  target: StatementTarget,
  property: Property,
): UseStatementResult {
  const [statement, setStatement] = useState<StatementData | null>(null);
  const [missing, setMissing] = useState<StatementMissing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Destructured so the effect depends on stable primitives rather than on the
  // `target` object identity, which a parent re-render remints.
  const kind = target.kind;
  const subjectId = target.kind === 'stay' ? target.bookingId : target.guestId;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const result = await loadStatement(
          kind === 'stay'
            ? { kind: 'stay', bookingId: subjectId }
            : { kind: 'standalone', guestId: subjectId },
          property,
        );
        if (cancelled) return;
        setStatement(result.statement);
        setMissing(result.missing);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Rule 11: kept raw and surfaced, never swallowed.
        setStatement(null);
        setMissing(null);
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `property` is a dependency and is safe as one: useActiveProperty returns
    // an ELEMENT of the provider's properties array, so its identity is stable
    // across re-renders and changes only when that list is genuinely refetched —
    // at which point re-reading the document is the correct behaviour.
  }, [kind, subjectId, property, nonce]);

  return { statement, missing, loading, error, reload };
}
