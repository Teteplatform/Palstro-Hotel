import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateField, Select, TextField } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { LocationPicker } from './LocationPicker';
import { useToast } from '../../ui/Toast';
import { DownloadIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useLocations } from '../../../hooks/useLocations';
import { useInventoryReference } from '../../../hooks/useInventoryReference';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatQuantity } from '../../../lib/format';
import {
  fetchAllInventoryItems,
  pickDefaultLocation,
} from '../../../lib/inventory';
import { itemTypeLabel, unitDimensionLabel } from '../../../lib/inventoryLabels';
import { fetchOpeningBalanceKeys } from '../../../lib/stock';
import {
  categoryKey,
  commitOpeningSheet,
  NO_RESOLUTIONS,
  validateOpeningSheet,
  type OpeningCommitResult,
  type OpeningPreview,
  type OpeningPreviewRow,
  type Resolutions,
} from '../../../lib/import/openingBalances';
import {
  fileFingerprint,
  isSupportedSheetFile,
  readSheetFile,
  SheetReadError,
  type SheetData,
} from '../../../lib/import/readSheet';
import type {
  InventoryCategory,
  InventoryItem,
  StockLocation,
  UnitDimension,
  UnitOfMeasure,
} from '../../../types/inventory';

// LOADING A HOTEL'S OPENING STOCK — one sheet, one download, one confirm.
//
// WHAT THIS SCREEN USED TO BE, and why it is not that any more: four numbered
// steps with a paragraph under each, a template that only listed items you
// already had, and a separate screen for creating the items in the first place.
// Two of those steps were reading. So the flow is now: press a button and the
// sheet downloads; fill it in; upload it; answer anything the file asks; press
// Import. The explaining lives ON THE SHEET, where somebody filling it in can
// actually see it, not on a page they left ten minutes ago.
//
// THE PROMISE THAT DID NOT CHANGE: nothing is written until every row has been
// checked and the user has seen the result. Reading and validating happen
// entirely in the browser; only Import posts anything.
//
// AND NOTHING IS CREATED BEHIND THEIR BACK. A unit or a category the file names
// but the tenant does not have becomes a QUESTION — create it, or map it to one
// you already have — asked once per distinct value however many rows use it.
// See lib/import/openingBalances.ts for why an auto-created "kgs" is a bug that
// only surfaces months later, in a variance report nobody can reconcile.

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
  const reference = useInventoryReference(tenantId);
  const today = todayIsoInZone(timezone);

  // The whole LIVE catalogue — switched-off items included, because they still
  // own their names (035's unique index is partial on deleted_at, not on
  // is_active), so a row naming one must resolve to it rather than trying to
  // create a second item with a name the database will refuse.
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [locationChoice, setLocationChoice] = useState('');
  // A non-store location has to be chosen deliberately (see the confirm below),
  // so the pick is held here until the user says yes.
  const [pendingLocation, setPendingLocation] = useState<StockLocation | null>(
    null,
  );
  const [businessDate, setBusinessDate] = useState(today);

  const [fileName, setFileName] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [existingOpenings, setExistingOpenings] = useState<Set<string>>(
    () => new Set(),
  );
  const [resolutions, setResolutions] = useState<Resolutions>(NO_RESOLUTIONS);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState<'xlsx' | 'csv' | null>(null);
  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<OpeningCommitResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllInventoryItems(tenantId);
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

  // WHERE STOCK ARRIVES, resolved once (037): the hotel's designated receiving
  // store, else the first active store, else the first location. Never
  // "whatever sorts first", which is an ordering accident.
  const defaultLocation = pickDefaultLocation(locations.rows);
  const location =
    locations.rows.find((l) => l.id === locationChoice) ?? defaultLocation;

  // Re-validated on every change to the file, the decisions, the location or
  // the catalogue — validation is a pure function, so this is the whole state
  // machine. Changing the location after uploading re-checks the file against
  // the new one rather than silently keeping the old verdict.
  const preview: OpeningPreview | null = useMemo(() => {
    if (!sheet || !location) return null;
    return validateOpeningSheet({
      sheet,
      items,
      units: reference.units,
      categories: reference.categories,
      locations: locations.rows,
      defaultLocation: location,
      existingOpenings,
      resolutions,
    });
  }, [
    sheet,
    items,
    reference.units,
    reference.categories,
    locations.rows,
    location,
    existingOpenings,
    resolutions,
  ]);

  const blockedReason: string | null = locations.loading
    ? 'Loading your stock locations…'
    : !location
      ? 'This hotel has no stock location yet.'
      : loadError
        ? `Your catalogue could not load: ${loadError}`
        : reference.error
          ? `Your units and categories could not load: ${reference.error.message}`
          : null;

  // --- the location, and the short warning when it is not a store ----------
  function chooseLocation(id: string) {
    const picked = locations.rows.find((l) => l.id === id);
    if (!picked) return;
    // Stock is received INTO a store and issued OUT of it (035 §4) — that is
    // what the kind means. Putting a delivery straight into a bar is not
    // forbidden, it is just usually a mistake, so it takes one deliberate yes.
    if (picked.kind !== 'store') {
      setPendingLocation(picked);
      return;
    }
    setLocationChoice(id);
  }

  async function handleDownload(format: 'xlsx' | 'csv') {
    if (blockedReason || !location) {
      toast.error(blockedReason ?? 'Choose a location first.');
      return;
    }
    setDownloading(format);
    try {
      // Loaded on demand — the OOXML writer is only needed by somebody actually
      // downloading, so it stays out of the main bundle.
      const [template, download] = await Promise.all([
        import('../../../lib/import/openingTemplate'),
        import('../../../lib/export/download'),
      ]);
      const safeName = location.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const base = `opening-stock-${safeName}-${today}`;
      const sheetInput = {
        // Only items in use are pre-filled: a switched-off line is not
        // something anybody is about to count.
        items: items.filter((i) => i.is_active),
        units: reference.units,
        categories: reference.categories,
        locationName: location.name,
      };

      if (format === 'csv') {
        download.downloadBlob(
          new Blob([template.buildOpeningSheetCsv(sheetInput)], {
            type: download.CSV_MIME,
          }),
          `${base}.csv`,
        );
      } else {
        download.downloadBytes(
          template.buildOpeningSheetXlsx(sheetInput, currency, today),
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
    if (!file || !location) return;
    setReadError(null);
    setResult(null);
    setResolutions(NO_RESOLUTIONS);

    if (!isSupportedSheetFile(file.name)) {
      setReadError(
        `“${file.name}” is not a spreadsheet this can read. Save it as .xlsx or .csv and try again.`,
      );
      return;
    }

    setReading(true);
    try {
      const { sheet: parsed, bytes } = await readSheetFile(file);
      // The content fingerprint — what makes re-uploading this exact file a
      // replay rather than a second load.
      const print = await fileFingerprint(bytes);
      // The one network read the preview needs: which (location, item) pairs
      // already carry an opening balance, so those rows show as "already
      // loaded" instead of failing at the server after other rows have written.
      const openings = await fetchOpeningBalanceKeys(tenantId, propertyId);

      setFileName(file.name);
      setFingerprint(print);
      setExistingOpenings(openings);
      setSheet(parsed);
    } catch (e) {
      setReadError(e instanceof SheetReadError ? e.message : describeError(e));
    } finally {
      setReading(false);
    }
  }

  async function handleCommit() {
    if (!preview || preview.readyCount === 0 || preview.chooseCount > 0) return;
    setCommitting(true);
    setProgress({ done: 0, total: preview.readyCount });
    try {
      const outcome = await commitOpeningSheet({
        tenantId,
        propertyId,
        preview,
        resolutions,
        businessDate,
        fingerprint,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(outcome);
      if (outcome.failed === 0) {
        toast.success(
          `${outcome.itemsCreated} items added, ${outcome.openingsPosted} opening ${outcome.openingsPosted === 1 ? 'balance' : 'balances'} recorded.`,
        );
      } else {
        toast.error(
          `${outcome.failed} ${outcome.failed === 1 ? 'row' : 'rows'} could not be saved — see the list below.`,
        );
      }
      // The catalogue is now stale by exactly the items just created, and the
      // openings by the movements just posted. Reloaded so a second file
      // uploaded without leaving the screen is checked against the first one's
      // work rather than against the state before it.
      try {
        const [rows, openings] = await Promise.all([
          fetchAllInventoryItems(tenantId),
          fetchOpeningBalanceKeys(tenantId, propertyId),
        ]);
        setItems(rows);
        setExistingOpenings(openings);
      } catch {
        // Non-fatal: the commit succeeded, and the database is the guard either
        // way (one opening per item per location, one item per name).
      }
    } catch (e) {
      // commitOpeningSheet captures per-row failures itself, so reaching here
      // means something failed outside the loop (rule 11).
      toast.error(describeError(e));
    } finally {
      setCommitting(false);
    }
  }

  function startOver() {
    setSheet(null);
    setResult(null);
    setFileName('');
    setFingerprint('');
    setReadError(null);
    setResolutions(NO_RESOLUTIONS);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Opening stock
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          One sheet: your items and what is on the shelf. Nothing is saved until
          you confirm.
        </p>
        <Link
          to={`/admin/${propertySlug}/inventory`}
          className="mt-1 inline-block text-sm font-semibold text-primary underline underline-offset-2"
        >
          ← Back to inventory
        </Link>
      </header>

      {blockedReason && !locations.loading ? (
        <p
          className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal"
          role="status"
        >
          {blockedReason}
        </p>
      ) : null}

      {/* Where, when, and the sheet — one row, no step numbers. */}
      <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Searchable, server-side (rule 26). This posts opening balances, so
              only locations in use are offered. The hint stays because it changes
              what somebody does: receiving into a kitchen rather than a store is
              legal and is what the "received outside the store" report exists to
              surface (§9), so it is worth noticing before the upload, not after. */}
          <LocationPicker
            tenantId={tenantId}
            propertyId={propertyId}
            value={location?.id ?? ''}
            onChange={chooseLocation}
            selectedLocation={location}
            activeOnly
            disabled={locations.loading || committing}
            helpText={
              location && location.kind !== 'store'
                ? 'Not a store.'
                : 'Your receiving store.'
            }
          />
          <DateField
            label="Count date"
            required
            value={businessDate}
            onChange={setBusinessDate}
            max={today}
            disabled={committing}
            helpText="The day it was counted."
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleDownload('csv')}
            disabled={blockedReason !== null || downloading !== null}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-4 w-4" />
            {downloading === 'csv' ? 'Preparing…' : 'Download sheet (CSV)'}
          </button>
          <button
            type="button"
            onClick={() => void handleDownload('xlsx')}
            disabled={blockedReason !== null || downloading !== null}
            className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-4 w-4" />
            {downloading === 'xlsx' ? 'Preparing…' : 'Excel'}
          </button>
        </div>
        {/* The one thing people hit that is NOT our file, in one line. */}
        <p className="mt-2 text-xs text-charcoal-muted">
          Excel opening read-only is your IT policy, not the file — use the CSV.
        </p>
      </section>

      {/* Upload. */}
      <section className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-charcoal">
            Upload the filled sheet
          </span>
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

      {preview ? (
        <PreviewPanel
          preview={preview}
          fileName={fileName}
          currency={currency}
          committing={committing}
          progress={progress}
          result={result}
          resolutions={resolutions}
          onResolutionsChange={setResolutions}
          units={reference.units}
          categories={reference.categories}
          onCommit={() => void handleCommit()}
          onStartOver={startOver}
          propertySlug={propertySlug}
        />
      ) : null}

      {pendingLocation ? (
        <NonStoreConfirm
          location={pendingLocation}
          onYes={() => {
            setLocationChoice(pendingLocation.id);
            setPendingLocation(null);
          }}
          onNo={() => setPendingLocation(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The non-store warning — one sentence, and No is the default
// ---------------------------------------------------------------------------

// DEFAULTS TO NO, deliberately and structurally: No holds the initial focus, the
// backdrop and Escape both mean No, and Yes is the plain secondary button. A
// dialog whose dangerous answer is one Enter away is not a confirmation.
function NonStoreConfirm({
  location,
  onYes,
  onNo,
}: {
  location: StockLocation;
  onYes: () => void;
  onNo: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(panelRef, true, onNo);

  useEffect(() => {
    noRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-charcoal/40"
        onClick={onNo}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="non-store-title"
        className="relative w-full max-w-md rounded-2xl bg-cream p-5 shadow-2xl"
      >
        <h2 id="non-store-title" className="text-base font-semibold text-charcoal">
          Stock is best received into the store and issued out. Put it in{' '}
          {location.name} anyway?
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            ref={noRef}
            type="button"
            onClick={onNo}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            No
          </button>
          <button
            type="button"
            onClick={onYes}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

function PreviewPanel({
  preview,
  fileName,
  currency,
  committing,
  progress,
  result,
  resolutions,
  onResolutionsChange,
  units,
  categories,
  onCommit,
  onStartOver,
  propertySlug,
}: {
  preview: OpeningPreview;
  fileName: string;
  currency: string;
  committing: boolean;
  progress: { done: number; total: number };
  result: OpeningCommitResult | null;
  resolutions: Resolutions;
  onResolutionsChange: (next: Resolutions) => void;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  onCommit: () => void;
  onStartOver: () => void;
  propertySlug: string;
}) {
  if (preview.fatal) {
    return (
      <section className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <p className="text-sm text-charcoal">{preview.fatal}</p>
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
  const unitOptions: SelectOption[] = units
    .filter((u) => u.is_active)
    .map((u) => ({ value: u.unit_code, label: `${u.name} (${u.unit_code})` }));
  const categoryOptions: SelectOption[] = categories
    .filter((c) => c.is_active)
    .map((c) => ({ value: c.id, label: c.name }));

  return (
    <section className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <p className="text-xs text-charcoal-muted">
        {fileName} · {preview.sheetName} · {preview.format.toUpperCase()}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-sand-border bg-sand/30 px-4 py-3">
        <Tally label="New items" value={preview.newItemCount} />
        <Tally label="Stock rows" value={preview.openingCount} />
        <Tally
          label="Stock value"
          value={formatMoney(preview.readyValue, currency)}
        />
        {preview.chooseCount > 0 ? (
          <Tally label="Need a choice" value={preview.chooseCount} tone="amber" />
        ) : null}
        {preview.skipCount > 0 ? (
          <Tally label="Nothing to do" value={preview.skipCount} />
        ) : null}
        {preview.errorCount > 0 ? (
          <Tally label="Problems" value={preview.errorCount} tone="primary" />
        ) : null}
      </div>

      {/* THE QUESTIONS. Asked once per distinct value, never per row, and never
          answered for the user — a silently created "kgs" splits an item's
          stock and its future recipe measures into two incompatible scales. */}
      {!result && preview.unknownUnits.length > 0 ? (
        <div className="mt-4 space-y-2">
          {preview.unknownUnits.map((unknown) => {
            const decision = resolutions.units[unknown.key];
            return (
              <ChoiceBlock
                key={unknown.key}
                title={`“${unknown.raw}” is not one of your units`}
                rowCount={unknown.rowCount}
                createLabel="Create it"
                mapLabel="Use one of mine"
                mode={decision?.action}
                disabled={committing}
                onCreate={() =>
                  onResolutionsChange({
                    ...resolutions,
                    units: {
                      ...resolutions.units,
                      [unknown.key]: {
                        action: 'create',
                        name: titleCase(unknown.raw),
                        dimension: 'count',
                      },
                    },
                  })
                }
                onMap={() =>
                  onResolutionsChange({
                    ...resolutions,
                    units: {
                      ...resolutions.units,
                      [unknown.key]: {
                        action: 'map',
                        unitCode: unitOptions[0]?.value ?? '',
                      },
                    },
                  })
                }
                createFields={
                  decision?.action === 'create' ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <TextField
                        label="Name"
                        value={decision.name}
                        onChange={(v) =>
                          onResolutionsChange({
                            ...resolutions,
                            units: {
                              ...resolutions.units,
                              [unknown.key]: { ...decision, name: v },
                            },
                          })
                        }
                        disabled={committing}
                      />
                      <Select
                        label="Measures"
                        value={decision.dimension}
                        onChange={(v) =>
                          onResolutionsChange({
                            ...resolutions,
                            units: {
                              ...resolutions.units,
                              [unknown.key]: {
                                ...decision,
                                dimension: v as UnitDimension,
                              },
                            },
                          })
                        }
                        options={(
                          ['mass', 'volume', 'count', 'length'] as UnitDimension[]
                        ).map((d) => ({ value: d, label: unitDimensionLabel(d) }))}
                        disabled={committing}
                      />
                    </div>
                  ) : null
                }
                mapField={
                  decision?.action === 'map' ? (
                    <Select
                      label="Use"
                      value={decision.unitCode}
                      onChange={(v) =>
                        onResolutionsChange({
                          ...resolutions,
                          units: {
                            ...resolutions.units,
                            [unknown.key]: { action: 'map', unitCode: v },
                          },
                        })
                      }
                      options={unitOptions}
                      disabled={committing}
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : null}

      {!result && preview.unknownCategories.length > 0 ? (
        <div className="mt-2 space-y-2">
          {preview.unknownCategories.map((unknown) => {
            const decision = resolutions.categories[unknown.key];
            return (
              <ChoiceBlock
                key={unknown.key}
                title={`“${unknown.raw}” is not one of your categories`}
                rowCount={unknown.rowCount}
                createLabel="Create it"
                mapLabel="Use one of mine"
                mode={decision?.action}
                disabled={committing}
                onCreate={() =>
                  onResolutionsChange({
                    ...resolutions,
                    categories: {
                      ...resolutions.categories,
                      [categoryKey(unknown.raw)]: { action: 'create' },
                    },
                  })
                }
                onMap={() =>
                  onResolutionsChange({
                    ...resolutions,
                    categories: {
                      ...resolutions.categories,
                      [categoryKey(unknown.raw)]: {
                        action: 'map',
                        categoryId: categoryOptions[0]?.value ?? '',
                      },
                    },
                  })
                }
                mapField={
                  decision?.action === 'map' ? (
                    <Select
                      label="Use"
                      value={decision.categoryId}
                      onChange={(v) =>
                        onResolutionsChange({
                          ...resolutions,
                          categories: {
                            ...resolutions.categories,
                            [unknown.key]: { action: 'map', categoryId: v },
                          },
                        })
                      }
                      options={categoryOptions}
                      disabled={committing}
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : null}

      {!result && preview.similarNames.length > 0 ? (
        <div className="mt-2 space-y-2">
          {preview.similarNames.map((similar) => {
            const decision = resolutions.names[similar.key];
            return (
              <ChoiceBlock
                key={similar.key}
                title={`“${similar.name}” looks like ${similar.matches
                  .map((m) => `“${m.item.name}”`)
                  .join(', ')}`}
                rowCount={1}
                createLabel="Create as new"
                mapLabel="Use the existing one"
                mode={
                  decision?.action === 'use'
                    ? 'map'
                    : decision?.action === 'create'
                      ? 'create'
                      : undefined
                }
                disabled={committing}
                onCreate={() =>
                  onResolutionsChange({
                    ...resolutions,
                    names: {
                      ...resolutions.names,
                      [similar.key]: { action: 'create' },
                    },
                  })
                }
                onMap={() =>
                  onResolutionsChange({
                    ...resolutions,
                    names: {
                      ...resolutions.names,
                      [similar.key]: {
                        action: 'use',
                        itemId: similar.matches[0].item.id,
                      },
                    },
                  })
                }
                mapField={
                  decision?.action === 'use' && similar.matches.length > 1 ? (
                    <Select
                      label="Which one"
                      value={decision.itemId}
                      onChange={(v) =>
                        onResolutionsChange({
                          ...resolutions,
                          names: {
                            ...resolutions.names,
                            [similar.key]: { action: 'use', itemId: v },
                          },
                        })
                      }
                      options={similar.matches.map((m) => ({
                        value: m.item.id,
                        label: m.item.name,
                      }))}
                      disabled={committing}
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-left">
              <Th>Row</Th>
              <Th>Item</Th>
              <Th align="right">Quantity</Th>
              <Th align="right">Unit cost</Th>
              <Th align="right">Value</Th>
              <Th>Status</Th>
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
                    : row.status === 'choose'
                      ? 'bg-accent/10'
                      : row.status === 'skip'
                        ? 'bg-sand/40'
                        : undefined;

              return (
                <tr key={row.rowNumber} className={tone}>
                  <td className="px-2 py-2 tabular-nums text-charcoal-muted">
                    {row.rowNumber}
                  </td>
                  <td className="px-2 py-2 text-charcoal">
                    {row.name ?? row.rawItem}
                    {row.createsItem ? (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        new
                      </span>
                    ) : null}
                    {row.itemType && row.createsItem ? (
                      <span className="block text-xs text-charcoal-muted">
                        {itemTypeLabel(row.itemType)} · {row.baseUnit}
                      </span>
                    ) : null}
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
          Every row in this file is blank. Fill in an opening quantity and a unit
          cost, then upload it again.
        </p>
      ) : null}

      {committing ? (
        <p className="mt-4 text-sm text-charcoal" aria-live="polite">
          Saving {progress.done} of {progress.total}…
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
              disabled={
                committing ||
                preview.readyCount === 0 ||
                preview.chooseCount > 0
              }
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {committing
                ? 'Saving…'
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
            {preview.chooseCount > 0 ? (
              <p className="w-full text-sm text-charcoal">
                Answer the questions above first.
              </p>
            ) : null}
          </>
        )}
      </div>

      {result ? (
        <p className="mt-3 text-sm text-charcoal">
          {result.itemsCreated} items added, {result.openingsPosted} opening
          {result.openingsPosted === 1 ? ' balance' : ' balances'} recorded
          {result.unitsCreated > 0 ? `, ${result.unitsCreated} new units` : ''}
          {result.categoriesCreated > 0
            ? `, ${result.categoriesCreated} new categories`
            : ''}
          {result.failed > 0 ? `, ${result.failed} could not be saved` : ''}.
          Ongoing deliveries are recorded as purchases, not by uploading this
          sheet again.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One question, two answers
// ---------------------------------------------------------------------------

// Neither answer is preselected, and that is the point: a default here would be
// the code deciding, which is exactly what "nothing is created behind your back"
// rules out. The row stays amber until a human picks one.
function ChoiceBlock({
  title,
  rowCount,
  createLabel,
  mapLabel,
  mode,
  disabled,
  onCreate,
  onMap,
  createFields,
  mapField,
}: {
  title: string;
  rowCount: number;
  createLabel: string;
  mapLabel: string;
  mode: 'create' | 'map' | undefined;
  disabled?: boolean;
  onCreate: () => void;
  onMap: () => void;
  createFields?: React.ReactNode;
  mapField?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-accent/40 bg-accent/10 p-3">
      <p className="text-sm font-semibold text-charcoal">
        {title}
        <span className="ml-1.5 font-normal text-charcoal-muted">
          · {rowCount} {rowCount === 1 ? 'row' : 'rows'}
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-charcoal">
          <input
            type="radio"
            checked={mode === 'create'}
            onChange={onCreate}
            disabled={disabled}
            className="h-4 w-4 accent-primary"
          />
          {createLabel}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-charcoal">
          <input
            type="radio"
            checked={mode === 'map'}
            onChange={onMap}
            disabled={disabled}
            className="h-4 w-4 accent-primary"
          />
          {mapLabel}
        </label>
      </div>
      {createFields ? <div className="mt-2">{createFields}</div> : null}
      {mapField ? <div className="mt-2 max-w-xs">{mapField}</div> : null}
    </div>
  );
}

function RowStatus({
  row,
  outcome,
}: {
  row: OpeningPreviewRow;
  outcome?: { ok: boolean; message?: string };
}) {
  if (outcome) {
    return outcome.ok ? (
      <span className="font-semibold text-charcoal">Saved</span>
    ) : (
      <span className="text-primary">{outcome.message}</span>
    );
  }
  if (row.status === 'ready') {
    return <span className="font-semibold text-charcoal">{row.message}</span>;
  }
  if (row.status === 'choose') {
    return <span className="text-accent">{row.message}</span>;
  }
  if (row.status === 'skip') {
    return <span className="text-charcoal-muted">{row.message}</span>;
  }
  return <span className="text-primary">{row.message}</span>;
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

// A sensible starting NAME for a unit the user is creating — 'crate' -> 'Crate'.
// Only a suggestion: the field beside it is editable.
function titleCase(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}
