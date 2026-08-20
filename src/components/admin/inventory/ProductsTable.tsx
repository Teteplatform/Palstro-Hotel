import { useNavigate } from 'react-router-dom';
import { CameraIcon } from '../../ui/icons';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import { itemTypeLabel, itemTypeTone } from '../../../lib/inventoryLabels';
import { mediaVariantUrl } from '../../../lib/mediaUrl';
import type { ProductRow } from '../../../lib/inventoryProducts';

// THE PRODUCTS TABLE — one row per item, every figure under a heading, and two
// ways in: the picture, and everything else.
//
// ---------------------------------------------------------------------------
// WHAT 1.1f TOOK OUT OF IT, AND WHY THE TABLE IS BETTER FOR IT
// ---------------------------------------------------------------------------
// This row used to expand. Underneath it were the movement ledger, the
// per-location breakdown, and three buttons — Edit item, Add or correct stock,
// Remove item. All of that is now the ITEM'S OWN PAGE, which is where a
// ten-minute job belongs rather than inside a paginated table inside a tab strip.
//
// The row also used to carry values FLOATING UNDER THE NAME: category, code and
// unit rode along in a sub-line, appearing and disappearing at breakpoints as the
// real columns folded away. That is the pattern this shipment removes. Every value
// is now under a labelled heading, at every width, and the table SCROLLS SIDEWAYS
// inside its own container the way rule 23's note describes — the page never
// scrolls horizontally, and a figure never has to be identified by its position
// under a name.
//
// The badges stay on the item cell. A badge is a STATUS, not a value: "less than
// nothing" and "no selling price" are flags on the row, and giving each a column
// of its own would be nine columns of mostly-blank.
//
// ---------------------------------------------------------------------------
// TWO TARGETS ON ONE ROW, WHICH IS AS MANY AS A ROW CAN HAVE
// ---------------------------------------------------------------------------
// The PICTURE opens the picture. Everything else opens the item. That split works
// because the tile is unambiguous — an empty tile with a camera on it plainly
// wants a photograph, and a filled one plainly is one — and because adding
// pictures to forty items through a form about names and thresholds is the kind of
// friction that ends in a catalogue of grey squares.
//
// THE ROW IS NOT AN <a> WRAPPING A <tr>, which is invalid, and not a <tr onClick>
// alone, which is unreachable by keyboard. Each row carries a real link in its
// first cell for the keyboard and the screen reader, and the row's click handler
// is a convenience on top of it for the mouse — so there is exactly one navigable
// thing per row however you are driving it.

interface ProductsTableProps {
  rows: ProductRow[];
  propertySlug: string;
  currency: string;
  // The location being viewed, or null for the whole property. Carried into the
  // item page's URL so arriving there does not silently change the scope.
  locationId: string | null;
  // TRUE when a stock-state filter made positions the base of the list, so a row
  // is one location's holding rather than the item's whole position.
  byPosition: boolean;
  // Open the picture dialog for this row.
  onEditImage: (row: ProductRow) => void;
}

export function ProductsTable({
  rows,
  propertySlug,
  currency,
  locationId,
  byPosition,
  onEditImage,
}: ProductsTableProps) {
  const navigate = useNavigate();

  const itemHref = (row: ProductRow) => {
    // The row's OWN location when the list is by position — that row is one
    // shelf's holding, and landing on the property roll-up would show a different
    // number from the one just clicked.
    const scope = byPosition ? (row.locations[0]?.locationId ?? locationId) : locationId;
    return `/admin/${propertySlug}/inventory/items/${row.itemId}${
      scope ? `?location=${scope}` : ''
    }`;
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
      <table className="w-full min-w-[64rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-sand-border bg-sand/40 text-left">
            <Th className="w-14 px-3 sm:px-4">
              <span className="sr-only">Picture</span>
            </Th>
            <Th>Item</Th>
            <Th>Code</Th>
            <Th>Category</Th>
            <Th>Type</Th>
            <Th>Unit</Th>
            <Th className="text-right">Average cost</Th>
            <Th className="text-right">Selling price</Th>
            <Th className="text-right">On hand</Th>
            <Th>Locations</Th>
            <Th className="text-right">Value</Th>
          </tr>
        </thead>

        <tbody className="divide-y divide-sand-border/50">
          {rows.map((row) => {
            // A position row is keyed by item AND location: the same item can
            // legitimately appear twice when the list is filtered by stock state.
            const key = byPosition
              ? `${row.itemId}:${row.locations[0]?.locationId ?? ''}`
              : row.itemId;
            return (
              <ProductTableRow
                key={key}
                row={row}
                href={itemHref(row)}
                currency={currency}
                locationId={locationId}
                onEditImage={() => onEditImage(row)}
                onOpen={() => navigate(itemHref(row))}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-2 py-2 text-xs font-semibold whitespace-nowrap text-charcoal-muted ${className}`}
    >
      {children}
    </th>
  );
}

function ProductTableRow({
  row,
  href,
  currency,
  locationId,
  onEditImage,
  onOpen,
}: {
  row: ProductRow;
  href: string;
  currency: string;
  locationId: string | null;
  onEditImage: () => void;
  onOpen: () => void;
}) {
  // Already a number, or genuinely absent (rule 24). null means NO POSITION at
  // this scope — "we hold none" and "we have no figure" are different statements.
  const negative = row.quantity !== null && row.quantity < 0;
  const untracked = row.quantity === null;
  const sellable = row.itemType === 'finished' || row.itemType === 'both';

  return (
    <tr
      onClick={onOpen}
      className={`cursor-pointer transition-colors hover:bg-sand/40 ${
        negative ? 'bg-accent/5' : ''
      }`}
    >
      {/* THE PICTURE CELL — its own target, so the click does NOT fall through to
          the row. stopPropagation is what keeps "change the picture" from also
          meaning "leave this screen". */}
      <td className="px-3 py-2.5 align-top sm:px-4">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEditImage();
          }}
          aria-label={
            row.imagePath ? `Replace the picture for ${row.name}` : `Add a picture for ${row.name}`
          }
          title={row.imagePath ? 'Replace this picture' : 'Add a picture'}
          className="group relative block h-10 w-10 overflow-hidden rounded-lg border border-sand-border bg-sand/60 transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none"
        >
          {row.imagePath ? (
            <img
              src={mediaVariantUrl(row.imagePath, 'thumb')}
              alt=""
              aria-hidden="true"
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : null}
          {/* The camera sits over a filled tile only on hover/focus, and is always
              visible on an empty one — an empty tile has to say what it wants. */}
          <span
            className={`absolute inset-0 flex items-center justify-center transition-opacity ${
              row.imagePath
                ? 'bg-charcoal/50 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
                : 'opacity-100'
            }`}
          >
            <CameraIcon
              className={`h-4 w-4 ${row.imagePath ? 'text-white' : 'text-charcoal-muted'}`}
            />
          </span>
        </button>
      </td>

      <td className="px-2 py-2.5 align-top">
        {/* THE REAL LINK, for the keyboard and the screen reader. The row's own
            onClick is the mouse convenience on top of it. */}
        <a
          href={href}
          onClick={(e) => {
            // Let the row handler navigate through the router; the href exists so
            // the row is a real destination that can be middle-clicked, copied and
            // tabbed to.
            e.preventDefault();
            e.stopPropagation();
            onOpen();
          }}
          className="font-medium text-charcoal hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        >
          {row.name}
        </a>
        <span className="mt-1 flex flex-wrap gap-1">
          {row.isBelowReorder ? (
            <Badge tone="bg-accent/15 text-accent">At or below reorder level</Badge>
          ) : null}
          {negative ? <Badge tone="bg-accent/15 text-accent">Less than nothing</Badge> : null}
          {sellable && row.sellingPrice === null ? (
            <Badge tone="bg-accent/15 text-accent">No selling price</Badge>
          ) : null}
          {!row.isActive ? <Badge tone="bg-sand text-charcoal-muted">Not in use</Badge> : null}
        </span>
      </td>

      <Td muted>{row.code ?? MISSING_VALUE}</Td>
      <Td muted>{row.categoryName ?? MISSING_VALUE}</Td>

      <td className="px-2 py-2.5 align-top">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${itemTypeTone(
            row.itemType,
          )}`}
        >
          {itemTypeLabel(row.itemType)}
        </span>
      </td>

      <Td muted>{row.baseUnit}</Td>

      <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal">
        {row.averageCost === null ? (
          <span className="text-charcoal-muted">{MISSING_VALUE}</span>
        ) : (
          formatMoney(row.averageCost, currency)
        )}
      </td>

      <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal">
        {row.sellingPrice === null ? (
          // Blank means NOT SOLD — the shared dash, never a zero, which would be
          // a price.
          <span className="text-charcoal-muted">{MISSING_VALUE}</span>
        ) : (
          formatMoney(row.sellingPrice, currency)
        )}
      </td>

      <td className="px-2 py-2.5 text-right align-top tabular-nums">
        {untracked ? (
          <span className="text-charcoal-muted">{MISSING_VALUE}</span>
        ) : (
          <span className={`font-semibold ${negative ? 'text-accent' : 'text-charcoal'}`}>
            {formatQuantity(row.quantity)}
          </span>
        )}
      </td>

      <td className="max-w-[16rem] px-2 py-2.5 align-top text-xs text-charcoal-muted">
        <LocationBreakdown row={row} locationId={locationId} />
      </td>

      <td className="px-2 py-2.5 text-right align-top font-semibold tabular-nums text-charcoal">
        {row.value === null ? (
          <span className="font-normal text-charcoal-muted">{MISSING_VALUE}</span>
        ) : (
          formatMoney(row.value, currency)
        )}
      </td>
    </tr>
  );
}

function Td({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <td
      className={`px-2 py-2.5 align-top text-xs ${muted ? 'text-charcoal-muted' : 'text-charcoal'}`}
    >
      {children}
    </td>
  );
}

// "Main Store: 62 · Kitchen: 1" — where the stock actually is. Truncated in the
// cell with the full string as its title, so a wide spread is readable without
// breaking the row height.
function LocationBreakdown({
  row,
  locationId,
}: {
  row: ProductRow;
  locationId: string | null;
}) {
  const held = row.locations.filter((l) => l.quantity !== 0);

  if (locationId) {
    const here = row.locations[0];
    return <span className="truncate">{here ? here.locationName : MISSING_VALUE}</span>;
  }

  if (held.length === 0) {
    return <span className="text-charcoal-muted">Nowhere yet</span>;
  }

  const text = held.map((l) => `${l.locationName}: ${formatQuantity(l.quantity)}`).join(' · ');

  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${tone}`}
    >
      {children}
    </span>
  );
}
