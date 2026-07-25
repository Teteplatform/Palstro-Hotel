import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { Pagination } from '../../ui/Pagination';
import { useAdminRoomTypes } from '../../../hooks/useAdminRoomTypes';
import { usePropertyMedia } from '../../../hooks/usePropertyMedia';
import { humanizeError } from '../../../lib/errors';
import { updateRoomType, softDeleteRoomType } from '../../../lib/roomTypes';
import { todayIso } from '../../../lib/date';
import type { RoomType } from '../../../types/room';
import { RoomTypeEditor } from './RoomTypeEditor';
import { CreateRoomType } from './CreateRoomType';

// The room types admin screen (build 5a §3). Orchestrates:
//   - a SERVER-PAGINATED list (useAdminRoomTypes + the shared Pagination), per the
//     list-surface standard (rule 1b) even though a small hotel has few types,
//   - create + soft-delete,
//   - reorder via up/down (display_order),
//   - a shared rate PREVIEW date, threaded to every card so the owner can confirm
//     a weekend or seasonal rule fires on a chosen date (via resolve_room_rate).
//
// Reads are scoped to the ACTIVE property + tenant inside the data layer (rule
// 19); every write is awaited in try/catch with the error surfaced (rule 11).

interface RoomTypesScreenProps {
  propertyId: string;
  tenantId: string;
  currency: string;
}

export function RoomTypesScreen({
  propertyId,
  tenantId,
  currency,
}: RoomTypesScreenProps) {
  const toast = useToast();
  const list = useAdminRoomTypes(propertyId, tenantId);
  // One media load for the whole screen: every card's image editor resolves ids
  // through this map; reload() re-pulls after an upload/delete.
  const media = usePropertyMedia(propertyId, tenantId);

  // Local mirror of the current page's rows, so a single-row save reflects
  // instantly without refetching (and without collapsing open cards). Re-synced
  // whenever the hook fetches a fresh page — via React's "adjust state on prop
  // change" pattern (conditional setState during render, not an effect), matching
  // the codebase's NumberField/CurrencyField reconciliation.
  const [items, setItems] = useState<RoomType[]>(list.rows);
  const [lastRows, setLastRows] = useState(list.rows);
  if (list.rows !== lastRows) {
    setLastRows(list.rows);
    setItems(list.rows);
  }

  // The date the preview resolves rates for. Defaults to today.
  const [previewDate, setPreviewDate] = useState<string>(() => todayIso());
  // Locks reorder/delete controls while a multi-row write is in flight.
  const [rowBusy, setRowBusy] = useState(false);

  function handleUpdated(row: RoomType) {
    setItems((prev) => prev.map((r) => (r.id === row.id ? row : r)));
  }

  function handleCreated() {
    // The new type is appended (display_order = total), so it lands on the last
    // page. Jump there so the owner sees it, then the hook refetches.
    const lastPage = Math.max(1, Math.ceil((list.count + 1) / list.pageSize));
    list.setPage(lastPage);
    void list.reload();
  }

  async function handleMove(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= items.length) return;
    const a = items[index];
    const b = items[j];
    // Assign absolute-index display_order values to the swapped pair so their
    // relative order flips deterministically and stays distinct.
    const base = (list.page - 1) * list.pageSize;
    setRowBusy(true);
    try {
      await updateRoomType(a.id, tenantId, propertyId, { display_order: base + j });
      await updateRoomType(b.id, tenantId, propertyId, {
        display_order: base + index,
      });
      await list.reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setRowBusy(false);
    }
  }

  async function handleRequestDelete(roomType: RoomType) {
    if (
      !window.confirm(
        `Remove "${roomType.name}"? It leaves the guest site and this list, but its history and any bookings against it are kept.`,
      )
    ) {
      return;
    }
    setRowBusy(true);
    try {
      await softDeleteRoomType(roomType.id, tenantId, propertyId);
      toast.success('Room type removed.');
      await list.reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setRowBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          Room types
        </h1>
        <p className="mt-1 text-sm text-charcoal-muted">
          The bookable categories your guest site advertises — their photos,
          occupancy, amenities and pricing. Physical rooms are managed separately.
        </p>
      </header>

      {/* Rate preview control — shared across every card. */}
      <div className="mb-6 rounded-2xl border border-sand-border bg-sand/30 p-4">
        <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-charcoal">
          <span>Preview rates for</span>
          <input
            type="date"
            value={previewDate}
            onChange={(e) => setPreviewDate(e.target.value)}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          />
        </label>
        <p className="mt-2 text-xs text-charcoal-muted">
          Each card shows the rate that applies on this date. Precedence: a
          seasonal override wins, then the weekend rate on a weekend night,
          otherwise the rack rate.
        </p>
      </div>

      <div className="mb-6">
        <CreateRoomType
          tenantId={tenantId}
          propertyId={propertyId}
          currency={currency}
          nextDisplayOrder={list.count}
          onCreated={handleCreated}
        />
      </div>

      {list.error ? (
        <ErrorState message={list.error.message} onRetry={() => void list.reload()} />
      ) : list.loading && items.length === 0 ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((rt, i) => (
              <li key={rt.id}>
                <RoomTypeEditor
                  roomType={rt}
                  tenantId={tenantId}
                  propertyId={propertyId}
                  currency={currency}
                  mediaMap={media.map}
                  reloadMedia={media.reload}
                  previewDate={previewDate}
                  index={i}
                  total={items.length}
                  onUpdated={handleUpdated}
                  onMove={(idx, dir) => void handleMove(idx, dir)}
                  onRequestDelete={(row) => void handleRequestDelete(row)}
                  busyRow={rowBusy}
                />
              </li>
            ))}
          </ul>

          <div className="mt-6">
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              totalCount={list.count}
              onPageChange={list.setPage}
              onPageSizeChange={list.setPageSize}
              disabled={list.loading || rowBusy}
              itemNoun="room types"
            />
          </div>
        </>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading room types…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">No room types yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        Add your first room type above. Once it’s published it appears on your
        guest site with its photos, occupancy and “from” price.
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
      <p className="text-sm font-medium text-charcoal">
        We couldn’t load your room types.
      </p>
      <p className="mt-1 text-sm text-charcoal-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        Try again
      </button>
    </div>
  );
}
