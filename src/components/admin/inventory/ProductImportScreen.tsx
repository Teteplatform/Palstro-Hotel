import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../ui/Toast';
import { DownloadIcon } from '../../ui/icons';
import { useInventoryReference } from '../../../hooks/useInventoryReference';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatQuantity } from '../../../lib/format';
import { itemTypeLabel } from '../../../lib/inventoryLabels';
import {
  fetchNameIndex,
  SIMILAR_CONFIRMATION,
  type NameIndexEntry,
} from '../../../lib/inventoryDuplicates';
import {
  commitProducts,
  validateProductSheet,
  type ProductCommitResult,
  type ProductPreview,
  type ProductPreviewRow,
} from '../../../lib/import/products';
import {
  isSupportedSheetFile,
  readSheetFile,
  SheetReadError,
} from '../../../lib/import/readSheet';

// BRINGING A WHOLE CATALOGUE IN AT ONCE — validate, review, then commit.
//
// The sibling of the opening-stock import, and deliberately built to the same
// shape so somebody who has done one already knows this one: download a
// template that shows the format, fill it, upload it, read a per-row verdict,
// and only then press the button. Nothing is written before that press.
//
// WHAT MAKES THIS ONE DIFFERENT is the middle verdict. The opening-stock import
// has two answers — this row is fine, this row is wrong. A catalogue import has
// three, because the interesting failure is not a malformed row, it is a row
// that is perfectly valid and should not exist:
//
//   GREEN   a name nothing else has. Created.
//   AMBER   a name that LOOKS like something you already have. Created, but not
//           until you have looked at the near-matches and said so.
//   RED     a name (or code) you already have, or a row that cannot become an
//           item. Never created, and never attempted.
//
// The amber verdict is the reason this screen exists rather than a silent bulk
// insert. Two rows for one sack of rice cannot be merged afterwards — their
// movements are permanent — so the only place to catch it is before the write,
// while a person is looking.

type Stage = 'choose' | 'preview' | 'done';

interface ProductImportScreenProps {
  tenantId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function ProductImportScreen({
  tenantId,
  propertySlug,
  currency,
  timezone,
}: ProductImportScreenProps) {
  const toast = useToast();
  const reference = useInventoryReference(tenantId);
  const today = todayIsoInZone(timezone);

  const [nameIndex, setNameIndex] = useState<NameIndexEntry[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState<'xlsx' | 'csv' | null>(null);

  const [stage, setStage] = useState<Stage>('choose');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ProductPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const [confirmedSimilar, setConfirmedSimilar] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ProductCommitResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchNameIndex(tenantId);
        if (!cancelled) {
          setNameIndex(rows);
          setIndexError(null);
        }
      } catch (e) {
        // Rule 11: surfaced. Without the existing names nothing can be checked
        // for duplicates, and importing blind is exactly the outcome this
        // screen exists to prevent — so it says so and the upload stays shut.
        if (!cancelled) setIndexError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const units = reference.units;
  const categories = reference.categories;

  const blockedReason: string | null = reference.loading || nameIndex === null
    ? indexError
      ? null
      : 'Loading your units, categories and existing item names…'
    : indexError
      ? `Your existing item names could not be loaded, so nothing can be checked for duplicates: ${indexError}`
      : reference.error
        ? `Your units and categories could not be loaded: ${reference.error.message}`
        : units.filter((u) => u.is_active).length === 0
          ? 'This catalogue has no units of measure set up, and every item has to be measured in one. Add them before importing.'
          : null;

  async function handleDownloadTemplate(format: 'xlsx' | 'csv') {
    if (blockedReason) {
      toast.error(blockedReason);
      return;
    }
    setDownloading(format);
    try {
      // Loaded on demand — the OOXML writer is only needed by somebody actually
      // downloading a template, so it stays out of the main bundle.
      const [template, download] = await Promise.all([
        import('../../../lib/import/productTemplate'),
        import('../../../lib/export/download'),
      ]);
      const base = `new-products-${today}`;

      if (format === 'csv') {
        download.downloadBlob(
          new Blob([template.buildProductTemplateCsv(units, categories)], {
            type: download.CSV_MIME,
          }),
          `${base}.csv`,
        );
      } else {
        download.downloadBytes(
          template.buildProductTemplateXlsx(units, categories, currency, today),
          `${base}.xlsx`,
          download.XLSX_MIME,
        );
      }
    } catch (e) {
      toast.error(describeError(e)); // rule 11: never fail silent
    } finally {
      setDownloading(null);
    }
  }

  async function handleFile(file: File | null) {
    if (!file || nameIndex === null) return;
    setReadError(null);
    setResult(null);
    setConfirmedSimilar(false);

    if (!isSupportedSheetFile(file.name)) {
      setReadError(
        `“${file.name}” is not a spreadsheet this can read. Save it as .xlsx or .csv and try again.`,
      );
      return;
    }

    setReading(true);
    try {
      const { sheet } = await readSheetFile(file);
      const outcome = validateProductSheet({
        sheet,
        units,
        categories,
        nameIndex,
      });
      setFileName(file.name);
      setPreview(outcome);
      setStage('preview');
    } catch (e) {
      setReadError(e instanceof SheetReadError ? e.message : describeError(e));
    } finally {
      setReading(false);
    }
  }

  async function handleCommit() {
    if (!preview) return;
    const creatable = preview.newCount + preview.similarCount;
    if (creatable === 0) return;
    // The blocker: an amber row is only created once the user has said, in as
    // many words, that these are genuinely different items.
    if (preview.similarCount > 0 && !confirmedSimilar) return;

    setCommitting(true);
    setProgress({ done: 0, total: creatable });
    try {
      const outcome = await commitProducts({
        tenantId,
        preview,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(outcome);
      setStage('done');
      // The name index is now stale by exactly the rows just written — reloaded
      // so a second file uploaded without leaving the screen is checked against
      // the first one's items.
      try {
        setNameIndex(await fetchNameIndex(tenantId));
      } catch {
        // Non-fatal: the commit succeeded, and the next upload would re-read it
        // anyway. The unique index is still the guard either way (rule 19).
      }
      if (outcome.failed === 0) {
        toast.success(
          `${outcome.created} ${outcome.created === 1 ? 'product' : 'products'} added.`,
        );
      } else {
        toast.error(
          `${outcome.created} added, ${outcome.failed} could not be — see the list below.`,
        );
      }
    } catch (e) {
      // commitProducts captures per-row failures itself, so reaching here means
      // something failed outside the loop (rule 11).
      toast.error(describeError(e));
    } finally {
      setCommitting(false);
    }
  }

  function startOver() {
    setStage('choose');
    setPreview(null);
    setResult(null);
    setFileName('');
    setReadError(null);
    setConfirmedSimilar(false);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Add many products from a template
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-charcoal-muted">
          Creates the ITEMS — what each thing is, the unit it is measured in, the
          type it is. It records no quantities: loading what is on your shelves
          is a separate step, once these exist.
        </p>
        <Link
          to={`/admin/${propertySlug}/inventory`}
          className="mt-2 inline-block text-sm font-semibold text-primary underline underline-offset-2"
        >
          ← Back to inventory
        </Link>
      </header>

      {/* Step 1 — the template. */}
      <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
        <h2 className="text-base font-semibold text-charcoal">
          1. Start from the template
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-charcoal-muted">
          It opens with a few worked example rows showing exactly how a product
          is written — one for each type — plus your own unit codes and category
          names. The example rows are marked and are always skipped by the
          import, so you can type over them or leave them alone.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleDownloadTemplate('csv')}
            disabled={blockedReason !== null || downloading !== null}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-4 w-4" />
            {downloading === 'csv' ? 'Preparing…' : 'CSV template'}
          </button>
          <button
            type="button"
            onClick={() => void handleDownloadTemplate('xlsx')}
            disabled={blockedReason !== null || downloading !== null}
            className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-4 w-4" />
            {downloading === 'xlsx' ? 'Preparing…' : 'Excel template'}
          </button>
        </div>

        {blockedReason ? (
          <p className="mt-2 text-sm text-charcoal" role="status" aria-live="polite">
            {blockedReason}
          </p>
        ) : (
          // CSV leads for a reason people hit in practice, not a preference.
          <p className="mt-2 text-sm text-charcoal-muted">
            CSV is offered first because many company laptops open any
            unlabelled Excel file{' '}
            <strong className="font-semibold text-charcoal">read-only</strong>{' '}
            and will not let you type in it. If Excel works for you, the Excel
            file is the nicer sheet — it carries a second tab with the full
            notes.
          </p>
        )}
      </section>

      {/* Step 2 — upload. */}
      <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
        <h2 className="text-base font-semibold text-charcoal">
          2. Upload and check
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-charcoal-muted">
          Excel (.xlsx) or CSV. Nothing is saved at this step — the file is read
          here, in your browser, and every row is checked against your catalogue
          first. Names you already have are never created a second time.
        </p>

        <label className="mt-3 block">
          <span className="sr-only">Choose a spreadsheet</span>
          <input
            type="file"
            accept=".xlsx,.xlsm,.csv,.txt"
            disabled={reading || committing || blockedReason !== null}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              void handleFile(file);
              // Clear the input so choosing the SAME file again re-reads it (a
              // browser fires no change event for an unchanged value, and
              // re-checking a corrected file is the normal flow here).
              e.target.value = '';
            }}
            className="block w-full text-sm text-charcoal file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-primary-hover disabled:opacity-50"
          />
        </label>

        {reading ? (
          <p className="mt-2 text-sm text-charcoal-muted" aria-live="polite">
            Reading {fileName || 'the file'}…
          </p>
        ) : null}
        {readError ? (
          <p className="mt-2 text-sm font-medium text-primary" role="alert">
            {readError}
          </p>
        ) : null}
      </section>

      {stage !== 'choose' && preview ? (
        <ProductPreviewPanel
          preview={preview}
          fileName={fileName}
          committing={committing}
          progress={progress}
          result={result}
          confirmedSimilar={confirmedSimilar}
          onConfirmSimilar={setConfirmedSimilar}
          onCommit={() => void handleCommit()}
          onStartOver={startOver}
          propertySlug={propertySlug}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview — green creates, amber needs a look, red never happens
// ---------------------------------------------------------------------------

function ProductPreviewPanel({
  preview,
  fileName,
  committing,
  progress,
  result,
  confirmedSimilar,
  onConfirmSimilar,
  onCommit,
  onStartOver,
  propertySlug,
}: {
  preview: ProductPreview;
  fileName: string;
  committing: boolean;
  progress: { done: number; total: number };
  result: ProductCommitResult | null;
  confirmedSimilar: boolean;
  onConfirmSimilar: (v: boolean) => void;
  onCommit: () => void;
  onStartOver: () => void;
  propertySlug: string;
}) {
  if (preview.fatal) {
    return (
      <section className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <h2 className="text-base font-semibold text-charcoal">
          This file cannot be read
        </h2>
        <p className="mt-1 text-sm text-charcoal">{preview.fatal}</p>
        <button
          type="button"
          onClick={onStartOver}
          className="mt-3 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          Choose a different file
        </button>
      </section>
    );
  }

  const outcomeByRow = new Map(
    (result?.outcomes ?? []).map((o) => [o.rowNumber, o]),
  );
  const creatable = preview.newCount + preview.similarCount;
  const needsConfirmation = preview.similarCount > 0 && !confirmedSimilar;

  return (
    <section className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="text-base font-semibold text-charcoal">
        {result ? 'What was created' : '3. Check, then create'}
      </h2>
      <p className="mt-1 text-sm text-charcoal-muted">
        {fileName} · {preview.sheetName} · {preview.format.toUpperCase()}
      </p>

      {/* The counts that decide whether to press the button — one per verdict,
          and each shown only when it is not zero, so the row reads as a summary
          rather than as a form. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-sand-border bg-sand/30 px-4 py-3">
        <Tally label="New products" value={preview.newCount} />
        {preview.similarCount > 0 ? (
          <Tally label="Need review" value={preview.similarCount} tone="amber" />
        ) : null}
        {preview.duplicateCount > 0 ? (
          <Tally
            label="Already exist"
            value={preview.duplicateCount}
            tone="primary"
          />
        ) : null}
        {preview.errorCount > 0 ? (
          <Tally label="Problems" value={preview.errorCount} tone="primary" />
        ) : null}
        {preview.sampleCount > 0 ? (
          <Tally label="Example rows" value={preview.sampleCount} />
        ) : null}
      </div>

      {!result && preview.duplicateCount > 0 ? (
        <p className="mt-3 text-sm text-charcoal">
          Rows marked <strong>already exist</strong> are not created and are not
          attempted — your catalogue already has that name or code. Nothing else
          in the file is held up by them.
        </p>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-left">
              <Th>Row</Th>
              <Th>Name</Th>
              <Th>Code</Th>
              <Th>Type</Th>
              <Th>Unit</Th>
              <Th>Category</Th>
              <Th align="right">Reorder</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/50">
            {preview.rows.map((row) => {
              const outcome = outcomeByRow.get(row.rowNumber);
              // After a commit the row's status is what actually HAPPENED, not
              // what was predicted — a row the database refused must not keep
              // showing green.
              const tone =
                outcome && !outcome.ok
                  ? 'bg-primary/5'
                  : row.status === 'duplicate' || row.status === 'error'
                    ? 'bg-primary/5'
                    : row.status === 'similar'
                      ? 'bg-accent/10'
                      : row.status === 'sample'
                        ? 'bg-sand/40'
                        : undefined;

              return (
                <tr key={row.rowNumber} className={tone}>
                  <Td muted>{row.rowNumber}</Td>
                  <Td>{row.name ?? row.rawName}</Td>
                  <Td muted>{row.code ?? row.rawCode}</Td>
                  <Td muted>
                    {row.itemType ? itemTypeLabel(row.itemType) : row.rawType}
                  </Td>
                  <Td muted>{row.baseUnit ?? row.rawUnit}</Td>
                  <Td muted>{row.categoryName ?? row.rawCategory}</Td>
                  <Td align="right">
                    {row.reorderLevel !== undefined && row.reorderLevel !== null
                      ? formatQuantity(row.reorderLevel)
                      : row.rawReorder}
                  </Td>
                  <td className="px-2 py-2 text-xs">
                    <RowStatus row={row} outcome={outcome} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {preview.rows.length === 0 ? (
        <p className="mt-3 text-sm text-charcoal-muted">
          There are no product rows in this file. Fill in at least one row under
          the headings and upload it again.
        </p>
      ) : null}

      {/* THE BLOCKER. Not a toast and not a confirm() — a thing the user has to
          tick, on the page, beside the names it is about. */}
      {!result && preview.similarCount > 0 ? (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3">
          <h3 className="text-sm font-semibold text-charcoal">
            {preview.similarCount}{' '}
            {preview.similarCount === 1 ? 'name looks' : 'names look'} like
            something you already have
          </h3>
          <ul className="mt-2 space-y-1.5">
            {preview.rows
              .filter((r) => r.status === 'similar')
              .map((r) => (
                <li key={r.rowNumber} className="text-sm text-charcoal">
                  <span className="font-semibold">Row {r.rowNumber}:</span>{' '}
                  “{r.name}” — similar to{' '}
                  {(r.similar ?? []).map((s) => `“${s.item.name}”`).join(', ')}
                  {r.similarTotal && r.similarTotal > (r.similar?.length ?? 0)
                    ? ` (and ${r.similarTotal - (r.similar?.length ?? 0)} more)`
                    : ''}
                </li>
              ))}
          </ul>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-charcoal">
            <input
              type="checkbox"
              checked={confirmedSimilar}
              onChange={(e) => onConfirmSimilar(e.target.checked)}
              disabled={committing}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            />
            <span>{SIMILAR_CONFIRMATION}</span>
          </label>
        </div>
      ) : null}

      {committing ? (
        <p className="mt-4 text-sm text-charcoal" aria-live="polite">
          Creating {progress.done} of {progress.total}…
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {result ? (
          <>
            <Link
              to={`/admin/${propertySlug}/inventory`}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              See the catalogue
            </Link>
            <Link
              to={`/admin/${propertySlug}/stock/import`}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Now load opening stock
            </Link>
            <button
              type="button"
              onClick={onStartOver}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Load another file
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onCommit}
              disabled={committing || creatable === 0 || needsConfirmation}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {committing
                ? 'Creating…'
                : `Create ${creatable} ${creatable === 1 ? 'product' : 'products'}`}
            </button>
            <button
              type="button"
              onClick={onStartOver}
              disabled={committing}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Choose a different file
            </button>
            {needsConfirmation ? (
              <p className="w-full text-sm text-charcoal">
                Tick the box above to confirm the similar names, or remove those
                rows from the file and upload it again.
              </p>
            ) : null}
          </>
        )}
      </div>

      {result ? (
        <p className="mt-3 text-sm text-charcoal">
          {result.created} created
          {result.skipped > 0
            ? `, ${result.skipped} already existed and were left alone`
            : ''}
          {result.failed > 0 ? `, ${result.failed} could not be created` : ''}
          {preview.duplicateCount > 0
            ? `, ${preview.duplicateCount} skipped as duplicates`
            : ''}
          {preview.errorCount > 0
            ? `, ${preview.errorCount} had problems and were not attempted`
            : ''}
          . Your items now exist; what is on their shelves is loaded separately.
        </p>
      ) : null}
    </section>
  );
}

function RowStatus({
  row,
  outcome,
}: {
  row: ProductPreviewRow;
  outcome?: { ok: boolean; alreadyExisted?: boolean; message?: string };
}) {
  if (outcome) {
    if (outcome.ok) {
      return <span className="font-semibold text-charcoal">Created</span>;
    }
    return (
      <span className={outcome.alreadyExisted ? 'text-charcoal-muted' : 'text-primary'}>
        {outcome.message}
      </span>
    );
  }
  switch (row.status) {
    case 'new':
      return <span className="font-semibold text-charcoal">Will be created</span>;
    case 'similar':
      return <span className="text-accent">{row.message}</span>;
    case 'sample':
      return <span className="text-charcoal-muted">{row.message}</span>;
    default:
      return <span className="text-primary">{row.message}</span>;
  }
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: 'right';
}) {
  return (
    <th
      scope="col"
      className={`px-2 py-2 text-xs font-semibold text-charcoal-muted ${
        align === 'right' ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  muted,
  align,
}: {
  children: React.ReactNode;
  muted?: boolean;
  align?: 'right';
}) {
  return (
    <td
      className={`px-2 py-2 ${muted ? 'text-charcoal-muted' : 'text-charcoal'} ${
        align === 'right' ? 'text-right tabular-nums' : ''
      }`}
    >
      {children}
    </td>
  );
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'amber' | 'primary';
}) {
  return (
    <div>
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
        {label}
      </span>
      <span
        className={`mt-0.5 block text-base font-bold tabular-nums ${
          tone === 'primary'
            ? 'text-primary'
            : tone === 'amber'
              ? 'text-accent'
              : 'text-charcoal'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
