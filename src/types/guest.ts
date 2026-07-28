// DB row type for guests (supabase/migrations/014_guests.sql, restructured by
// 018_guests_identity.sql). Typed here for the booking flow (6b), which searches
// existing guests and registers new ones via the create_guest RPC. A guest is a
// person who stays — NOT an auth user/staff.

export interface Guest {
  id: string;
  tenant_id: string;
  // Structured name (018). first_name / last_name are NOT NULL for new rows;
  // middle_name is optional.
  first_name: string;
  last_name: string;
  middle_name: string | null;
  // Display/search name, GENERATED in the DB from first [+ middle] + last (018).
  // Read-only from the app's point of view — never written directly.
  full_name: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  // SENSITIVE (Nigerian hotels must record ID). Never exposed publicly (014/018).
  id_type: string | null;
  id_number: string | null;
  id_expiry: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
