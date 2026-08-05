// Inline SVG icons — no external icon library (self-contained, no runtime dep).
// All are decorative by default (aria-hidden); meaningful labels always come
// from the data via the calling component. Line icons use currentColor stroke;
// brand/social icons use currentColor fill.

export interface IconProps {
  className?: string;
}

// A rendered icon component. Exported so the icon-mapping helpers (iconMap.ts)
// can be typed without importing every icon by name.
export type IconComponent = (props: IconProps) => React.ReactNode;

function Line({
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* --- UI / navigation ------------------------------------------------------ */

export const MenuIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Line>
);

export const CloseIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Line>
);

// The row-actions affordance. VERTICAL dots (a "kebab"), deliberately distinct
// from the folio bill's horizontal ⋯: a kebab sits in its own narrow column at
// the head of a row and opens the actions for that WHOLE row, while the folio's
// ⋯ trails a single line. Two shapes, two meanings, no guessing.
export const KebabIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="12" cy="19" r="1.9" />
  </svg>
);

// The profile-photo affordance on a guest avatar.
export const CameraIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.1-1.8a1 1 0 0 1 .86-.5h6.68a1 1 0 0 1 .86.5L17.3 7h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="12.8" r="3.2" />
  </Line>
);

export const ChevronDownIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M6 9l6 6 6-6" />
  </Line>
);

export const ArrowLeftIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M15 6l-6 6 6 6" />
  </Line>
);

export const ArrowRightIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M9 6l6 6-6 6" />
  </Line>
);

export const ArrowUpIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M6 15l6-6 6 6" />
  </Line>
);

export const ArrowDownIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M6 9l6 6 6-6" />
  </Line>
);

/* --- Admin navigation ----------------------------------------------------- */

export const SettingsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </Line>
);

export const BookingsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="3.5" y="5" width="17" height="16" rx="2" />
    <path d="M3.5 9h17M8 3v4M16 3v4M8 13h3M8 17h8" />
  </Line>
);

export const RoomsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M3 21V8l9-5 9 5v13" />
    <path d="M3 21h18M9 21v-6h6v6M8 11h.01M16 11h.01" />
  </Line>
);

export const HousekeepingIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M6 3v8M4 5h4M6 11l-1 10h2l-1-10" />
    <path d="M14 3c3 0 6 2 6 6h-6V3Z" />
    <path d="M14 9v12" />
  </Line>
);

export const ReportsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M4 20V4M4 20h16" />
    <path d="M8 20v-6M12 20V8M16 20v-9" />
  </Line>
);

// Front Desk — a concierge service bell.
export const FrontDeskIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M3 19h18" />
    <path d="M5 16a7 7 0 0 1 14 0" />
    <path d="M12 6V4M9.5 4h5" />
  </Line>
);

// Guests — a group of people (distinct from the single-person UserIcon and the
// badged StaffIcon).
export const GuestsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.8 20c0-3.2 2.6-5 6.2-5s6.2 1.8 6.2 5" />
    <path d="M16.2 5.4a3 3 0 0 1 0 5.9M21.2 20c0-2.4-.9-4.1-2.4-5" />
  </Line>
);

// Rates and Availability — a price tag (the nightly-rate calendar; kept visually
// distinct from the Bookings calendar icon).
export const RatesIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M3.5 11.5V4.8a1.3 1.3 0 0 1 1.3-1.3h6.7l8 8a1.5 1.5 0 0 1 0 2.1l-5.6 5.6a1.5 1.5 0 0 1-2.1 0l-8-8Z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
  </Line>
);

// Maintenance — a wrench.
export const MaintenanceIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M15 6.5a4 4 0 0 0-5.2 5.2l-6.1 6.1 2 2 6.1-6.1A4 4 0 0 0 17 8.5l-2.6 2.6-2-2L15 6.5Z" />
  </Line>
);

// Staff — an ID badge with a person (distinct from the Guests group icon).
export const StaffIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="4" y="3.5" width="16" height="17" rx="2" />
    <path d="M9 3.5V6h6V3.5" />
    <circle cx="12" cy="11" r="2.1" />
    <path d="M8.5 17c0-2 1.6-3 3.5-3s3.5 1 3.5 3" />
  </Line>
);

// Accounting — a bound ledger.
export const AccountingIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v15H7.5A2.5 2.5 0 0 0 5 19.5V4.5Z" />
    <path d="M5 19.5A2.5 2.5 0 0 1 7.5 17H19v5H7.5A2.5 2.5 0 0 1 5 19.5Z" />
    <path d="M9 6.5h6M9 9.5h4" />
  </Line>
);

/* --- Inventory navigation -------------------------------------------------- */

// Store — a stock crate / cube (the main store).
export const StoreIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" />
    <path d="m3.5 7.5 8.5 4.5 8.5-4.5" />
    <path d="M12 12v9" />
  </Line>
);

// Companies — a corporate office building (distinct from the Store storefront and
// the Guests people). Used for the corporate-accounts screen (build 6b).
export const CompaniesIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" />
    <path d="M15 21V10h4a1 1 0 0 1 1 1v10" />
    <path d="M3 21h18" />
    <path d="M7.5 9h3M7.5 13h3M7.5 17h3" />
  </Line>
);

// Inventory items — a product tag. The CATALOGUE (what a thing IS), distinct
// from the Store crate (where stock SITS) and the Stock Counts grid (how much
// there is).
export const ItemsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M20.5 12.5 12 21a2 2 0 0 1-2.83 0L3 14.83a2 2 0 0 1 0-2.83L11.5 3.5H20a.5.5 0 0 1 .5.5v8.5Z" />
    <circle cx="16.6" cy="7.4" r="1.2" />
  </Line>
);

// Locations — a shelving rack: the boxes that HOLD stock (main store, kitchen,
// each bar, housekeeping), as opposed to the items sitting on them.
export const LocationsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9.5h18M3 14.5h18" />
    <path d="M8 4v5.5M15 9.5V14.5" />
  </Line>
);

// Requisitions — a clipboard form (request, then approve).
export const RequisitionsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="5" y="5" width="14" height="16" rx="2" />
    <path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
    <path d="M9 11h6M9 14h6M9 17h3" />
  </Line>
);

// Purchases — a shopping cart (purchase orders).
export const PurchasesIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="17" cy="20" r="1.4" />
    <path d="M3 4h2l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h7.7a1.5 1.5 0 0 0 1.5-1.2L21 8H6" />
  </Line>
);

// Suppliers — a delivery truck.
export const SuppliersIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M3 6h11v9H3z" />
    <path d="M14 9h4l3 3v3h-7z" />
    <circle cx="7" cy="18" r="1.6" />
    <circle cx="17.5" cy="18" r="1.6" />
  </Line>
);

// Stock Counts — a grid of bins, one ticked (counted and reconciled).
export const StockCountsIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="7" rx="1" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
    <path d="M13.5 17l2 2 4-4.5" />
  </Line>
);

export const UserIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
  </Line>
);

export const SignOutIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 12H3M6 8l-3 4 3 4" />
  </Line>
);

export const PlusIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M12 5v14M5 12h14" />
  </Line>
);

export const ChevronUpDownIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
  </Line>
);

// Pencil — the inline "edit this region" affordance in the visual editor (3.txt).
export const EditIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.5V20Z" />
    <path d="M13.5 6.5l4 4" />
  </Line>
);

// Palette — the floating "colours & fonts" control in the visual editor (3.txt),
// which belongs to no single section.
export const PaletteIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.4 0-1.1.9-2 2-2h1.2A4.8 4.8 0 0 0 21 8.7C20.4 5.4 16.6 3 12 3Z" />
    <path d="M7.5 12h.01M10 8h.01M14 7.5h.01" />
  </Line>
);

// Site editor — a browser window with a cursor, for the visual editor nav item.
export const SiteIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 8h18M6.5 6h.01M9 6h.01" />
    <path d="M11 12l3.5 6 1-2.5 2.5-1L11 12Z" />
  </Line>
);

/* --- Contact -------------------------------------------------------------- */

export const PhoneIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M4 5c0 8.284 6.716 15 15 15a1.5 1.5 0 0 0 1.5-1.5v-2.2a1 1 0 0 0-.76-.97l-3.2-.8a1 1 0 0 0-1 .3l-.9 1.05a11.5 11.5 0 0 1-5.1-5.1l1.05-.9a1 1 0 0 0 .3-1l-.8-3.2a1 1 0 0 0-.97-.76H5.5A1.5 1.5 0 0 0 4 5Z" />
  </Line>
);

export const MailIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </Line>
);

export const MapPinIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </Line>
);

/* --- Amenities ------------------------------------------------------------ */

export const WifiIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10 10 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
    <path d="M12 19.5h.01" />
  </Line>
);

export const RestaurantIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M5 3v7a2 2 0 0 0 2 2h0V3M9 3v18M9 3v0" />
    <path d="M7 12v9" />
    <path d="M17 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4v9" />
  </Line>
);

export const BarIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M5 4h14l-7 8-7-8Z" />
    <path d="M12 12v6M8 21h8" />
  </Line>
);

export const LaundryIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <circle cx="12" cy="13" r="4" />
    <path d="M8 6h.01M11 6h.01" />
  </Line>
);

export const PlaneIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7 4v2l-7-2v4l2 1.5V20l-3.5-1L8 20v-1.5L10 17v-4l-7 2v-2l7-4V3.5Z" />
  </Line>
);

export const AirConIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" />
  </Line>
);

export const ParkingIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M9 16V8h3a2.5 2.5 0 0 1 0 5H9" />
  </Line>
);

export const PoolIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M2 17c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1" />
    <path d="M2 21c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1" />
    <path d="M7 15V6a2 2 0 0 1 4 0M11 12h6" />
  </Line>
);

export const GymIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M6 9v6M4 10v4M18 9v6M20 10v4M6 12h12" />
  </Line>
);

export const CheckIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Line>
);

// A closed padlock. Used where an action is GATED rather than merely warned
// about — the manager-PIN prompt on a discount — so the requirement reads at a
// glance before any of the words are.
export const LockIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="4" y="10.5" width="16" height="10" rx="2" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    <path d="M12 14.5v2" />
  </Line>
);

// A tray with an arrow into it. The affordance for producing a FILE — the
// statement exports — as distinct from the printer, which produces paper, and
// the WhatsApp mark, which sends rather than saves.
export const DownloadIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <path d="M12 4v10" />
    <path d="m8 10.5 4 4 4-4" />
    <path d="M4.5 17.5v1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1" />
  </Line>
);

// A question mark in a circle — the staff guide. Deliberately the universal
// "help" mark rather than a book or a lifebuoy: it is the one shape a person
// looks for when they are stuck, which is the only moment this link matters.
export const HelpIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.95.7-.95 1.3v.55" />
    <path d="M11.75 16.75h.01" />
  </Line>
);

// A magnifier, for the guide's search box.
export const SearchIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <circle cx="11" cy="11" r="6" />
    <path d="m15.5 15.5 4 4" />
  </Line>
);

/* --- Social --------------------------------------------------------------- */

export const FacebookIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.25-1.5 1.55-1.5H17V3.6c-.3 0-1.3-.1-2.45-.1-2.4 0-4.05 1.47-4.05 4.17v2.23H7.8V13h2.7v8h3Z" />
  </svg>
);

export const InstagramIcon = ({ className }: IconProps) => (
  <Line className={className}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M17 7h.01" />
  </Line>
);

export const TwitterIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M17.5 3h3l-6.6 7.5L21.8 21h-6l-4.3-5.6L6.5 21h-3l7-8L2.5 3h6.2l3.9 5.1L17.5 3Zm-1.1 16h1.7L7.7 4.8H5.9L16.4 19Z" />
  </svg>
);

export const WhatsappIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Zm0 1.8a7.2 7.2 0 0 1 6 11.2l.2.3-.7 2.5-2.6-.7-.3.2A7.2 7.2 0 1 1 12 4.8Zm-2.6 3.3c-.2 0-.5 0-.7.4-.3.4-.9 1-.9 2.3 0 1.4 1 2.7 1.1 2.9.2.2 2 3.1 4.9 4.2 2.4.9 2.9.8 3.4.7.5 0 1.6-.6 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3-.3-.2-1.6-.8-1.9-.9-.2-.1-.4-.1-.6.1-.2.3-.6.9-.8 1-.1.2-.3.2-.5.1-.3-.1-1.2-.5-2.2-1.4-.8-.7-1.4-1.6-1.5-1.9-.2-.2 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5v-.5c-.1-.1-.6-1.5-.8-2-.2-.5-.4-.4-.6-.4h-.5Z" />
  </svg>
);

