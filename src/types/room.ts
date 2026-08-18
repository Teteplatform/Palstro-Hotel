// DB row type for room_types (supabase/migrations/002_rooms.sql). Keep in sync
// with the migration — no fields the schema does not have.
//
// IMPORTANT: the guest site reads room_types ONLY, never rooms. A room_type is
// what a guest books and what the website advertises; rooms are physical units
// (204) that are operational data and are NOT public. There is deliberately no
// Room type here — the landing page has no reason to import one.

export interface RoomType {
  id: string;
  tenant_id: string;
  property_id: string;
  name: string;
  description: string | null;
  // numeric(14,2) columns, parsed at the boundary (rule 24).
  base_rate: number; // RACK RATE — the advertised nightly "from" price (012)
  // weekend_rate: numeric(14,2), nullable. NULL means "no weekend premium" (fall
  // back to base_rate), NOT zero (012).
  weekend_rate: number | null;
  // ISO weekday numbers that count as a weekend night for this type (Mon=1 ..
  // Fri=5, Sat=6, Sun=7). Postgres integer[] -> JS number[]; not null, default
  // {5,6} (012). Read by resolve_room_rate on the server; shown/edited in admin.
  weekend_days: number[];
  max_adults: number;
  max_children: number;
  bed_configuration: string | null;
  size_sqm: number | null;
  // Room amenity flags (002). Omitted from this type before build 5 because the
  // guest card did not read them; the admin editor does, so they are typed now.
  has_air_conditioning: boolean;
  is_smoking: boolean;
  amenities: string[]; // text[] default '{}'
  images: string[]; // jsonb ordered array of media_asset ids (build 4/5)
  display_order: number;
  is_published: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// DB row type for seasonal_rates (supabase/migrations/012_room_type_rates.sql).
// A named, dated nightly-rate override for a room type. OPERATIONAL pricing — the
// guest site never reads this (no public RLS policy); it is admin-only.
export interface SeasonalRate {
  id: string;
  tenant_id: string;
  property_id: string;
  room_type_id: string;
  name: string;
  // sql `date` columns arrive as 'YYYY-MM-DD' strings.
  start_date: string;
  end_date: string;
  // numeric(14,2), parsed at the boundary (rule 24).
  rate: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
