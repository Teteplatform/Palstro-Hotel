import { useCallback, useRef, useState } from 'react';
import { useToast } from '../components/ui/Toast';
import { humanizeError } from '../lib/errors';
// Imported eagerly — unlike every other export module, which is loaded on
// demand. It is a few lines of string-building with no dependencies, and
// canShareStatementFile's answer is needed SYNCHRONOUSLY, before the first await
// spends the user's gesture; a dynamic import here would be a wasted chunk that
// the bundler correctly refuses to split anyway.
import {
  canShareStatementFile,
  openWhatsappMessage,
  shareStatementFile,
  statementShareText,
  whatsappShareUrl,
} from '../lib/export/statementShare';
import { loadStatement, type StatementTarget } from '../lib/statementLoad';
import { statementFileBase, type StatementData } from '../lib/statement';
import type { Property } from '../types/tenant';

// ===========================================================================
// RUNNING AN EXPORT, FROM WHEREVER IT WAS ASKED FOR.
// ===========================================================================
//
// The statement page has the assembled document in hand; the stay page and the
// guest's stays list do not. Both cases end in the same four exports, so both go
// through here: the hook resolves the document (given, cached, or loaded), then
// hands it to one exporter.
//
// EVERY EXPORTER IS LOADED ON DEMAND. pdfmake and the OOXML writers are imported
// inside the action, never at module scope, so a user who never exports anything
// never downloads a byte of them. The PDF library in particular is the largest
// dependency in the app and belongs in a chunk of its own.
//
// EVERY FAILURE IS SURFACED (rule 11). Nothing here swallows an error: a load
// that fails, a browser that blocks the WhatsApp window, a document that cannot
// be built — each says so in a toast, and errors do not auto-dismiss.

export type StatementExportFormat = 'pdf' | 'xlsx' | 'docx' | 'whatsapp';

export interface UseStatementExportOptions {
  // Passed when the caller already renders the document (the statement page), so
  // an export is instant and cannot possibly differ from what is on screen.
  statement?: StatementData | null;
  // Null only while the active-property context is still resolving, which is a
  // state a menu can be mounted in. An export attempted then says so rather than
  // reading against an undefined tenant.
  property: Property | null;
}

export interface UseStatementExportResult {
  // THE TARGET IS PER CALL, not per hook, so a LIST can share one instance: the
  // guest home offers an export on every stay's row menu, and a hook per row is
  // not a thing React allows.
  run: (format: StatementExportFormat, target: StatementTarget) => Promise<void>;
  // The format currently being produced, for a spinner / disabled state. Only
  // one export runs at a time — a second click while a PDF is rendering would
  // otherwise produce two files.
  busy: StatementExportFormat | null;
  // Fetch a document ahead of the click (call it when a menu opens). WhatsApp's
  // native share must be reached while the user's gesture is still live, and a
  // read in the middle of the handler is what spends it.
  prime: (target: StatementTarget) => void;
  // The assembled document, for an action that needs it IN HAND rather than
  // written to a file — the email dialog, which shows the guest's address and
  // the document's reference before anything is sent. Resolves through the same
  // cache as an export, so a menu that primed on open answers instantly.
  //
  // Returns null when the document could not be built, having already said why
  // (rule 11) — the caller simply does not open its dialog.
  prepare: (target: StatementTarget) => Promise<StatementData | null>;
}

// What to say when the document structurally does not exist. Deliberately
// distinct per case: an absent non-resident account is an ordinary state, while
// a stay with no folio is a fault the desk must not read as a zero balance.
function missingMessage(
  missing: 'subject' | 'folio' | 'totals',
  kind: StatementTarget['kind'],
): string {
  if (missing === 'subject') {
    return kind === 'stay'
      ? 'This stay could not be found at this property, so there is nothing to export.'
      : 'This guest could not be found in this tenant, so there is nothing to export.';
  }
  if (missing === 'folio') {
    return kind === 'standalone'
      ? 'This guest has no non-resident account at this property, so there is nothing to export.'
      : 'This stay has no folio, which should not be possible — every booking is given one automatically. Please contact support rather than treating this as a zero balance.';
  }
  return 'This folio’s totals could not be computed, so no statement can be issued. Nothing here should be treated as settled until it is investigated.';
}

class StatementUnavailableError extends Error {}

// One target's identity as a cache key.
function targetKey(target: StatementTarget): string {
  return target.kind === 'stay'
    ? `stay:${target.bookingId}`
    : `standalone:${target.guestId}`;
}

export function useStatementExport({
  statement,
  property,
}: UseStatementExportOptions): UseStatementExportResult {
  const toast = useToast();
  const [busy, setBusy] = useState<StatementExportFormat | null>(null);
  // Documents primed by an open menu, keyed by target — a ref, not state, so
  // priming never re-renders the menu that triggered it.
  //
  // THIS IS A PER-INTERACTION CACHE, NOT A STORE (rule 6). An entry is written
  // when a menu OPENS and is replaced the next time that menu opens, so what an
  // export serialises is at most a few seconds old and a payment taken in
  // between is picked up the next time the menu is opened. Nothing here is
  // arithmetic on a balance and nothing survives the page.
  const primed = useRef(new Map<string, Promise<StatementData>>());

  const load = useCallback(
    async (target: StatementTarget): Promise<StatementData> => {
      if (!property) {
        throw new StatementUnavailableError(
          'No property is active yet. Please wait a moment and try again.',
        );
      }
      const result = await loadStatement(target, property);
      if (!result.statement) {
        throw new StatementUnavailableError(
          missingMessage(result.missing ?? 'totals', target.kind),
        );
      }
      return result.statement;
    },
    [property],
  );

  const resolve = useCallback(
    (target: StatementTarget): Promise<StatementData> => {
      // The rendered document always wins: exporting exactly what the user is
      // looking at is the entire contract of this build.
      if (statement) return Promise.resolve(statement);
      const key = targetKey(target);
      const existing = primed.current.get(key);
      if (existing) return existing;
      const pending = load(target);
      primed.current.set(key, pending);
      return pending;
    },
    [statement, load],
  );

  const prime = useCallback(
    (target: StatementTarget) => {
      if (statement) return;
      const key = targetKey(target);
      // A failed prime must surface nothing — nothing was asked for yet, and the
      // same failure will be reported properly if an export is then chosen. The
      // entry is dropped so the click retries rather than replaying the error.
      const pending = load(target).catch((e) => {
        primed.current.delete(key);
        throw e;
      });
      primed.current.set(key, pending);
      void pending.catch(() => {});
    },
    [statement, load],
  );

  const run = useCallback(
    async (format: StatementExportFormat, target: StatementTarget) => {
      if (busy) return;
      // MUST be probed before any await: once the handler yields, the browser no
      // longer treats what follows as part of the user's gesture, and the answer
      // decides which path can still be taken.
      const canShareFile = format === 'whatsapp' && canShareStatementFile();

      setBusy(format);
      try {
        const doc = await resolve(target);
        const fileBase = statementFileBase(doc);

        if (format === 'pdf') {
          const blob = await buildPdf(doc);
          const { downloadBlob } = await import('../lib/export/download');
          downloadBlob(blob, `${fileBase}.pdf`);
          toast.success('Statement PDF downloaded.');
          return;
        }

        if (format === 'xlsx') {
          const [{ buildStatementXlsx }, { downloadBytes, XLSX_MIME }] =
            await Promise.all([
              import('../lib/export/statementXlsx'),
              import('../lib/export/download'),
            ]);
          downloadBytes(buildStatementXlsx(doc), `${fileBase}.xlsx`, XLSX_MIME);
          toast.success('Statement spreadsheet downloaded.');
          return;
        }

        if (format === 'docx') {
          const [{ buildStatementDocx }, { loadStatementLogo }, download] =
            await Promise.all([
              import('../lib/export/statementDocx'),
              import('../lib/export/logo'),
              import('../lib/export/download'),
            ]);
          const logo = await loadStatementLogo(doc.property.logoUrl);
          download.downloadBytes(
            buildStatementDocx(doc, logo),
            `${fileBase}.docx`,
            download.DOCX_MIME,
          );
          toast.success('Statement Word document downloaded.');
          return;
        }

        await shareOnWhatsapp(doc, fileBase, canShareFile, toast.error);
      } catch (e) {
        toast.error(
          e instanceof StatementUnavailableError ? e.message : humanizeError(e),
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, resolve, toast],
  );

  const prepare = useCallback(
    async (target: StatementTarget): Promise<StatementData | null> => {
      try {
        return await resolve(target);
      } catch (e) {
        toast.error(
          e instanceof StatementUnavailableError ? e.message : humanizeError(e),
        );
        return null;
      }
    },
    [resolve, toast],
  );

  return { run, busy, prime, prepare };
}

// ---------------------------------------------------------------------------
// The pieces, kept out of the handler so the flow above reads as the decision
// it is
// ---------------------------------------------------------------------------

async function buildPdf(doc: StatementData): Promise<Blob> {
  const [{ createStatementPdfBlob }, { loadStatementLogo }] = await Promise.all([
    import('../lib/export/statementPdf'),
    import('../lib/export/logo'),
  ]);
  // The letterhead logo is decoded to PNG for the PDF; a failure yields null and
  // the document prints its wordmark instead of refusing to export.
  const logo = await loadStatementLogo(doc.property.logoUrl);
  return createStatementPdfBlob(doc, logo);
}

// WhatsApp: the file when the platform can carry one, the pre-filled message
// when it cannot. See lib/export/statementShare for why both exist.
async function shareOnWhatsapp(
  doc: StatementData,
  fileBase: string,
  canShareFile: boolean,
  reportError: (message: string) => void,
): Promise<void> {
  if (canShareFile) {
    const download = await import('../lib/export/download');
    const blob = await buildPdf(doc);
    const file = download.toShareFile(blob, `${fileBase}.pdf`, download.PDF_MIME);
    const outcome = await shareStatementFile(
      file,
      `${doc.title} ${doc.reference}`,
      statementShareText(doc, { attached: true }),
    );
    // Shared, or the user closed the sheet — either way the action is over.
    // Closing a share sheet is a decision, not a failure.
    if (outcome !== 'unsupported') return;
  }

  const text = statementShareText(doc, { attached: false });
  const opened = openWhatsappMessage(whatsappShareUrl(text, doc.guest.phone));
  if (!opened) {
    reportError(
      'Your browser blocked the WhatsApp window. Allow pop-ups for this site, or download the PDF and attach it in WhatsApp yourself.',
    );
  }
}
