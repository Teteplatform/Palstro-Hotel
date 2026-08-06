import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateField, Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { DownloadIcon } from '../../ui/icons';
import { useLocations } from '../../../hooks/useLocations';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatQuantity } from '../../../lib/format';
import { fetchAllInventoryItems } from '../../../lib/inventory';
import { fetchOpeningBalanceKeys } from '../../../lib/stock';
import {
  commitOpeningBalances,
  validateOpeningSheet,
  type CommitResult,
  type Preview,
} from '../../../lib/import/openingBalances';
import {
  fileFingerprint,
  isSupportedSheetFile,
  readSheetFile,
  SheetReadError,
} from '../../../lib/import/readSheet';
import type { InventoryItem } from '../../../types/inventory';

// LOADING A HOTEL'S EXISTING STOCK FROM A SPREADSHEET — validate, then commit.
//
// This is the screen a hotel uses once, on the day it starts, to tell the system
// what is already on its shelves. It is also the screen where a mistake is made
// three hundred rows at a time, which is why the whole flow is built around one
// promise, stated on the page and enforced in the code:
//
//   NOTHING IS WRITTEN UNTIL EVERY ROW HAS BEEN CHECKED AND YOU HAVE SEEN THE
//   RESULT.
//
// Reading and validating happen entirely in the browser and touch no network
// beyond loading the catalogue: the file is parsed, every row is matched against
// the item list and the locations, and each one gets a verdict — import it, skip
// it and why, or reject it and exactly what is wrong. Only when the user presses
// Import does anything post.
//
// THREE LAYERS OF IDEMPOTENCY, because a double-load is invisible (stock that
// looks plausible and is twice what is really there):
//   1. every row's key is derived from the FILE'S OWN CONTENT, so re-uploading
//      the same file replays instead of re-posting (rules 2/3);
//   2. the key names the location and the item, not the row number, so
//      re-ordering rows changes nothing;
//   3. underneath both, the database allows exactly ONE opening balance per item
//      per location, whatever key is presented — so even a re-saved file cannot
//      double-load, and those rows come back as "already loaded".
//
// This screen writes OPENING balances only. Ongoing stock-in is a purchase
// receipt (tranche 2c) — it is deliberately NOT "upload the sheet again with
// bigger numbers", and the once-per-item rule makes sure it cannot become that.

type Stage = 'choose' | 'preview' | 'done';

interface StockImportScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function StockImportScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
}: StockImportScreenProps) {
  const toast = useToast();
  const locations = useLocations(propertyId, tenantId);
  const today = todayIsoInZone(timezone);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [locationId, setLocationId] = useState('');
  const [businessDate, setBusinessDate] = useState(today);

  const [stage, setStage] = useState<Stage>('choose');
  const [fileName, setFileName] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<CommitResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllInventoryItems(tenantId, true);
        if (!cancelled) setItems(rows);
      } catch (e) {
        // Rule 11: surfaced. Without the catalogue nothing can be matched, so
        // the screen says why rather than silently rejecting every row.
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // Default to the property's first location once they load.
  if (!locationId && locations.rows.length > 0) {
    setLocationId(locations.rows[0].id);
  }

  const location = locations.rows.find((l) => l.id === locationId) ?? null;

  const locationOptions: SelectOption[] = locations.rows.map((l) => ({
    value: l.id,
    label: l.is_active ? l.name : `${l.name} (closed)`,
  }));

  async function handleDownloadTemplate() {
    if (!location) return;
    try {
      // Loaded on demand — the OOXML writer is only needed by someone actually
      // downloading a template, so it stays out of the main bundle.
      const [{ buildOpeningTemplate }, { downloadBytes, XLSX_MIME }] =
        await Promise.all([
          import('../../../lib/import/openingTemplate'),
          import('../../../lib/export/download'),
        ]);
      const bytes = buildOpeningTemplate(items, location.name, currency, today);
      const safeName = location.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      downloadBytes(
        bytes,
        `opening-balances-${safeName}-${today}.xlsx`,
        XLSX_MIME,
      );
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function handleFile(file: File | null) {
    if (!file || !location) return;
    setReadError(null);
    setResult(null);

    if (!isSupportedSheetFile(file.name)) {
      setReadError(
        `“${file.name}” is not a spreadsheet this can read. Save it as .xlsx or .csv and try again.`,
      );
      return;
    }

    setReading(true);
    try {
      const { sheet, bytes } = await readSheetFile(file);
      // The content fingerprint — what makes re-uploading this exact file a
      // replay rather than a second load.
      const print = await fileFingerprint(bytes);

      // The one network read the preview needs: which (location, item) pairs
      // already carry an opening balance, so those rows are shown as "will be
      // skipped" instead of failing at the server after other rows have written.
      const existingOpenings = await fetchOpeningBalanceKeys(
        tenantId,
        propertyId,
      );

      const result = validateOpeningSheet({
        sheet,
        items,
        locations: locations.rows,
        defaultLocation: location,
        existingOpenings,
      });

      setFileName(file.name);
      setFingerprint(print);
      setPreview(result);
      setStage('preview');
    } catch (e) {
      setReadError(
        e instanceof SheetReadError ? e.message : describeError(e),
      );
    } finally {
      setReading(false);
    }
  }

  async function handleCommit() {
    if (!preview || preview.readyCount === 0) return;
    setCommitting(true);
    setProgress({ done: 0, total: preview.readyCount });
    try {
      const outcome = await commitOpeningBalances({
        preview,
        propertyId,
        businessDate,
        fingerprint,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(outcome);
      setStage('done');
      if (outcome.failed === 0) {
        toast.success(
          `${outcome.imported} opening ${outcome.imported === 1 ? 'balance' : 'balances'} recorded.`,
        );
      } else {
        toast.error(
          `${outcome.imported} recorded, ${outcome.failed} could not be — see the list below.`,
        );
      }
    } catch (e) {
      // Rule 11. commitOpeningBalances captures per-row failures itself, so
      // reaching here means something failed outside the loop.
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
    setFingerprint('');
    setReadError(null);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Load opening stock from a spreadsheet
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          For the day you start: tell the system what is already on the shelves.
          Every row is checked before anything is saved, and you see exactly what
          will happen first.
        </p>
        <Link
          to={`/admin/${propertySlug}/inventory`}
          className="mt-2 inline-block text-sm font-semibold text-primary underline underline-offset-2"
        >
          ← Back to inventory
        </Link>
      </header>

      {loadError ? (
        <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          The item catalogue could not load, so nothing can be matched:{' '}
          {loadError}
        </p>
      ) : null}

      {locations.rows.length === 0 && !locations.loading ? (
        <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
          <p className="text-base font-semibold text-charcoal">
            This hotel has no stock locations
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
            Add at least one under{' '}
            <Link
              to={`/admin/${propertySlug}/inventory`}
              className="font-semibold text-primary underline underline-offset-2"
            >
              Inventory → Manage locations
            </Link>{' '}
            before loading stock into it.
          </p>
        </div>
      ) : (
        <>
          {/* Step 1 — where and when. Both apply to the whole file. */}
          <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
            <h2 className="text-base font-semibold text-charcoal">
              1. Where and when
            </h2>
            <p className="mt-1 text-sm text-charcoal-muted">
              Rows without a Location of their own are loaded into the location
              you choose here. The date is the day the stock was counted — it is
              the business date every movement carries, not the moment you press
              Import.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Select
                label="Location"
                value={locationId}
                onChange={(v) => {
                  setLocationId(v);
                  startOver();
                }}
                options={locationOptions}
                disabled={locations.loading || stage !== 'choose'}
              />
              <DateField
                label="Count date"
                required
                value={businessDate}
                onChange={setBusinessDate}
                max={today}
                disabled={stage === 'done'}
                helpText="Cannot be in the future."
              />
            </div>
          </section>

          {/* Step 2 — the template. */}
          <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
            <h2 className="text-base font-semibold text-charcoal">
              2. Start from the template
            </h2>
            <p className="mt-1 text-sm text-charcoal-muted">
              The template already lists every item in your catalogue with{' '}
              <strong className="font-semibold text-charcoal">
                the unit it is tracked in
              </strong>{' '}
              — so you never have to remember whether rice is counted in
              kilograms or in bags. Type a quantity and a unit cost beside the
              things you actually have and leave the rest blank; blank rows are
              skipped, not treated as zero. Use a full stop for decimals.
            </p>
            <button
              type="button"
              onClick={() => void handleDownloadTemplate()}
              disabled={!location || items.length === 0}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              <DownloadIcon className="h-4 w-4" />
              Download the template ({items.length} items)
            </button>
          </section>

          {/* Step 3 — upload and preview. */}
          <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
            <h2 className="text-base font-semibold text-charcoal">
              3. Upload and check
            </h2>
            <p className="mt-1 text-sm text-charcoal-muted">
              Excel (.xlsx) or CSV. Nothing is saved at this step — the file is
              read here, in your browser, and every row is checked against your
              catalogue first.
            </p>

            <label className="mt-3 block">
              <span className="sr-only">Choose a spreadsheet</span>
              <input
                type="file"
                accept=".xlsx,.xlsm,.csv,.txt"
                disabled={reading || committing || !location}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  void handleFile(file);
                  // Clear the input so choosing the SAME file again re-reads it
                  // (a browser fires no change event for an unchanged value, and
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
            <PreviewPanel
              preview={preview}
              fileName={fileName}
              currency={currency}
              committing={committing}
              progress={progress}
              result={result}
              onCommit={() => void handleCommit()}
              onStartOver={startOver}
              propertySlug={propertySlug}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview — green rows import, red rows do not, and it says why per row
// ---------------------------------------------------------------------------

function PreviewPanel({
  preview,
  fileName,
  currency,
  committing,
  progress,
  result,
  onCommit,
  onStartOver,
  propertySlug,
}: {
  preview: Preview;
  fileName: string;
  currency: string;
  committing: boolean;
  progress: { done: number; total: number };
  result: CommitResult | null;
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

  return (
    <section className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="text-base font-semibold text-charcoal">
        {result ? 'What was imported' : '4. Check, then import'}
      </h2>
      <p className="mt-1 text-sm text-charcoal-muted">
        {fileName} · {preview.sheetName} · {preview.format.toUpperCase()}
      </p>

      {/* The four numbers that decide whether to press the button. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-sand-border bg-sand/30 px-4 py-3">
        <Tally label="Will import" value={preview.readyCount} />
        <Tally
          label="Value being loaded"
          value={formatMoney(preview.readyValue, currency)}
        />
        {preview.skipCount > 0 ? (
          <Tally label="Already loaded" value={preview.skipCount} />
        ) : null}
        {preview.errorCount > 0 ? (
          <Tally label="Problems" value={preview.errorCount} emphasis />
        ) : null}
      </div>

      {!result && preview.errorCount > 0 ? (
        <p className="mt-3 text-sm text-charcoal">
          Rows with a problem are <strong>not</strong> imported and nothing else
          is held up by them — you can import the good rows now and fix the rest
          in the file, or fix everything first and upload again. Re-uploading is
          safe: rows that already loaded are recognised and left alone.
        </p>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-left">
              <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                Row
              </th>
              <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                Item
              </th>
              <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                Location
              </th>
              <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Quantity
              </th>
              <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Unit cost
              </th>
              <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                Value
              </th>
              <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border/50">
            {preview.rows.map((row) => {
              const outcome = outcomeByRow.get(row.rowNumber);
              // After a commit the row's status is what actually HAPPENED, not
              // what was predicted — a row that failed at the server must not
              // keep showing green.
              const tone =
                outcome && !outcome.ok
                  ? 'bg-primary/5'
                  : row.status === 'error'
                    ? 'bg-primary/5'
                    : row.status === 'skip'
                      ? 'bg-sand/40'
                      : undefined;

              return (
                <tr key={row.rowNumber} className={tone}>
                  <td className="px-2 py-2 tabular-nums text-charcoal-muted">
                    {row.rowNumber}
                  </td>
                  <td className="px-2 py-2 text-charcoal">
                    {row.itemName ?? row.rawItem}
                  </td>
                  <td className="px-2 py-2 text-charcoal-muted">
                    {row.locationName ?? row.rawLocation}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-charcoal">
                    {row.quantity !== undefined
                      ? `${formatQuantity(row.quantity)} ${row.baseUnit ?? ''}`
                      : row.rawQuantity}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-charcoal">
                    {row.unitCost !== undefined
                      ? formatMoney(row.unitCost, currency)
                      : row.rawUnitCost}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-charcoal">
                    {row.lineValue !== undefined
                      ? formatMoney(row.lineValue, currency)
                      : ''}
                  </td>
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
          Every row in this file is blank. Fill in a quantity and a unit cost
          beside the items you hold, then upload it again.
        </p>
      ) : null}

      {committing ? (
        <p className="mt-4 text-sm text-charcoal" aria-live="polite">
          Recording {progress.done} of {progress.total}…
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {result ? (
          <>
            <Link
              to={`/admin/${propertySlug}/inventory`}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              See the stock
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
              disabled={committing || preview.readyCount === 0}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {committing
                ? 'Recording…'
                : `Import ${preview.readyCount} ${preview.readyCount === 1 ? 'row' : 'rows'}`}
            </button>
            <button
              type="button"
              onClick={onStartOver}
              disabled={committing}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Choose a different file
            </button>
          </>
        )}
      </div>

      {result ? (
        <p className="mt-3 text-sm text-charcoal">
          {result.imported} recorded
          {result.failed > 0 ? `, ${result.failed} could not be` : ''}
          {preview.skipCount > 0
            ? `, ${preview.skipCount} already had an opening balance`
            : ''}
          {preview.errorCount > 0
            ? `, ${preview.errorCount} had problems and were not attempted`
            : ''}
          . Ongoing deliveries are recorded as purchases, not by uploading this
          sheet again.
        </p>
      ) : null}
    </section>
  );
}

function RowStatus({
  row,
  outcome,
}: {
  row: Preview['rows'][number];
  outcome?: { ok: boolean; message?: string };
}) {
  if (outcome) {
    return outcome.ok ? (
      <span className="font-semibold text-charcoal">Recorded</span>
    ) : (
      <span className="text-primary">{outcome.message}</span>
    );
  }
  if (row.status === 'ready') {
    return <span className="font-semibold text-charcoal">Will import</span>;
  }
  if (row.status === 'skip') {
    return <span className="text-charcoal-muted">{row.message}</span>;
  }
  return <span className="text-primary">{row.message}</span>;
}

function Tally({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
        {label}
      </span>
      <span
        className={`mt-0.5 block text-base font-bold tabular-nums ${
          emphasis ? 'text-primary' : 'text-charcoal'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
