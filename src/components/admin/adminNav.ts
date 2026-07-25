import type { IconComponent } from '../ui/icons';
import {
  SettingsIcon,
  BookingsIcon,
  RoomsIcon,
  HousekeepingIcon,
  ReportsIcon,
  RestaurantIcon,
  LaundryIcon,
  FrontDeskIcon,
  GuestsIcon,
  RatesIcon,
  MaintenanceIcon,
  StaffIcon,
  AccountingIcon,
  StoreIcon,
  RequisitionsIcon,
  PurchasesIcon,
  SuppliersIcon,
  StockCountsIcon,
  SiteIcon,
} from '../ui/icons';

// The admin's navigation, defined once as data. Settling the FULL information
// architecture now — grouped, with every eventual module present — means the ten
// modules built over the coming weeks slot in by flipping a `status` here rather
// than by restructuring the shell. Each item's `module` key is the handle the
// module-flag filter (useEnabledModules) reads to hide modules a tenant has not
// bought; gating is a filter over this array, not a markup change.

// Module identity, one key per nav entry. These strings are ALSO the values
// stored in tenant_settings.enabled_modules (migration 006) — keep the two in
// lockstep: a key here with no matching array value is a module no tenant can
// ever see, and vice versa.
export type AdminModule =
  | 'front_desk'
  | 'bookings'
  | 'rooms'
  | 'housekeeping'
  | 'guests'
  | 'rates'
  | 'food_beverage'
  | 'laundry'
  | 'store'
  | 'requisitions'
  | 'purchases'
  | 'suppliers'
  | 'stock_counts'
  | 'maintenance'
  | 'staff'
  | 'reports'
  | 'accounting'
  | 'settings';

// The four sidebar sections, in render order. Grouping is data too, so moving an
// item between sections is a one-line change here.
export type AdminNavGroup =
  | 'daily'
  | 'revenue'
  | 'inventory'
  | 'back_office'
  | 'configuration';

export const ADMIN_NAV_GROUPS: { group: AdminNavGroup; label: string }[] = [
  { group: 'daily', label: 'Daily' },
  { group: 'revenue', label: 'Revenue' },
  { group: 'inventory', label: 'Inventory' },
  { group: 'back_office', label: 'Back office' },
  { group: 'configuration', label: 'Configuration' },
];

export interface AdminNavItem {
  // Generic UI copy, not tenant content (rule 17) — safe to live in code.
  label: string;
  icon: IconComponent;
  // Relative segment appended to /admin/:propertySlug/ — the active slug is
  // supplied at render, keeping the property in the URL.
  segment: string;
  module: AdminModule;
  group: AdminNavGroup;
  // 'ready' items link; 'coming_soon' items render visibly disabled with a
  // "soon" affordance, so the owner sees the shape of the finished product
  // without a dead link.
  status: 'ready' | 'coming_soon';
}

export const ADMIN_NAV: AdminNavItem[] = [
  // --- Daily: what front-of-house touches every shift ------------------------
  {
    label: 'Front Desk',
    icon: FrontDeskIcon,
    segment: 'front-desk',
    module: 'front_desk',
    group: 'daily',
    status: 'coming_soon',
  },
  {
    label: 'Bookings',
    icon: BookingsIcon,
    segment: 'bookings',
    module: 'bookings',
    group: 'daily',
    status: 'coming_soon',
  },
  // Rooms here is the PHYSICAL room status board — which unit is occupied,
  // clean, or out of service. Room *types* (the bookable "Deluxe Double"
  // category and its base_rate) are configuration and live under Settings. 002
  // separates the two tables on purpose; the nav must not blur them, or staff
  // will hunt for the housekeeping board under Settings.
  {
    label: 'Rooms',
    icon: RoomsIcon,
    segment: 'rooms',
    module: 'rooms',
    group: 'daily',
    status: 'coming_soon',
  },
  {
    label: 'Housekeeping',
    icon: HousekeepingIcon,
    segment: 'housekeeping',
    module: 'housekeeping',
    group: 'daily',
    status: 'coming_soon',
  },
  {
    label: 'Guests',
    icon: GuestsIcon,
    segment: 'guests',
    module: 'guests',
    group: 'daily',
    status: 'coming_soon',
  },

  // --- Revenue: what earns money beyond the room -----------------------------
  // Rates and Availability is the CALENDAR of nightly rates, closed dates and
  // minimum stays — the per-night, per-date pricing surface. It is NOT a room
  // type's base_rate, which is the single flat advertised rate that lives in
  // configuration. Different concept, different screen.
  {
    label: 'Rates and Availability',
    icon: RatesIcon,
    segment: 'rates',
    module: 'rates',
    group: 'revenue',
    status: 'coming_soon',
  },
  {
    label: 'Food and Beverage',
    icon: RestaurantIcon,
    segment: 'food-beverage',
    module: 'food_beverage',
    group: 'revenue',
    status: 'coming_soon',
  },
  {
    label: 'Laundry',
    icon: LaundryIcon,
    segment: 'laundry',
    module: 'laundry',
    group: 'revenue',
    status: 'coming_soon',
  },

  // --- Inventory: the shared stock engine, one catalogue and one movement
  // ledger feeding housekeeping, kitchen, bar and maintenance. See
  // docs/ARCHITECTURE.md — inventory is built BEFORE F&B and housekeeping, since
  // both consume it (a recipe deduction and an amenity issue are stock
  // movements). Distinct from Revenue above: this is stock control, not a sales
  // channel.
  {
    label: 'Store',
    icon: StoreIcon,
    segment: 'store',
    module: 'store',
    group: 'inventory',
    status: 'coming_soon',
  },
  {
    label: 'Requisitions',
    icon: RequisitionsIcon,
    segment: 'requisitions',
    module: 'requisitions',
    group: 'inventory',
    status: 'coming_soon',
  },
  {
    label: 'Purchases',
    icon: PurchasesIcon,
    segment: 'purchases',
    module: 'purchases',
    group: 'inventory',
    status: 'coming_soon',
  },
  {
    label: 'Suppliers',
    icon: SuppliersIcon,
    segment: 'suppliers',
    module: 'suppliers',
    group: 'inventory',
    status: 'coming_soon',
  },
  {
    label: 'Stock Counts',
    icon: StockCountsIcon,
    segment: 'stock-counts',
    module: 'stock_counts',
    group: 'inventory',
    status: 'coming_soon',
  },

  // --- Back office: management, people and money -----------------------------
  {
    label: 'Maintenance',
    icon: MaintenanceIcon,
    segment: 'maintenance',
    module: 'maintenance',
    group: 'back_office',
    status: 'coming_soon',
  },
  {
    label: 'Staff',
    icon: StaffIcon,
    segment: 'staff',
    module: 'staff',
    group: 'back_office',
    status: 'coming_soon',
  },
  {
    label: 'Reports',
    icon: ReportsIcon,
    segment: 'reports',
    module: 'reports',
    group: 'back_office',
    status: 'coming_soon',
  },
  {
    label: 'Accounting',
    icon: AccountingIcon,
    segment: 'accounting',
    module: 'accounting',
    group: 'back_office',
    status: 'coming_soon',
  },

  // --- Configuration: the screens that exist today ---------------------------
  // Site editor is the visual, click-to-edit face of the settings engine (3.txt);
  // Settings is the full form (including the values with no visual counterpart —
  // VAT, timezone, night audit, booking). Both are the SAME 'settings' module.
  {
    label: 'Site editor',
    icon: SiteIcon,
    segment: 'site',
    module: 'settings',
    group: 'configuration',
    status: 'ready',
  },
  {
    label: 'Settings',
    icon: SettingsIcon,
    segment: 'settings',
    module: 'settings',
    group: 'configuration',
    status: 'ready',
  },
];
