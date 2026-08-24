// THE LEDGER SPINE'S ROW TYPES (044).
//
// RULE 24 IS THE WHOLE POINT OF THIS FILE. PostgREST returns `numeric` as a
// STRING and int8/int4 as a NUMBER, and which one a field arrives as is decided
// by a column type and by casts inside a view — none of that visible from a
// component. So a field that is a number in the app is TYPED `number` here and
// parsed on the way in by lib/accounting's boundary declarations. A string
// method on one of these is then a compile error rather than a crash somebody
// finds while looking at the chart of accounts.

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

// The five groups an account belongs to. A contra-revenue account (discounts
// allowed) is typed `revenue` and simply carries a debit balance — the sign is
// what makes it contra, not the type.
export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

export interface Account {
  id: string;
  tenant_id: string;
  // The accountant's number. DISPLAY AND SORT ONLY — nothing in this codebase
  // resolves an account by it (rule 4). The one function allowed to is
  // seed_account_mappings, which is the function that created the rows.
  code: string;
  name: string;
  account_type: AccountType;
  note: string | null;
  is_active: boolean;
  // NO display_order. 045 removed it: the chart is ordered by (section rank,
  // code), which is what a numbered chart means, and the column defaulted to 0
  // so every added account sorted above 1000 Cash.
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// The mappings
// ---------------------------------------------------------------------------

export interface AccountMapping {
  id: string;
  tenant_id: string;
  // NULL = the tenant default, which is what almost every mapping is. Non-null
  // overrides that one key for that one property.
  property_id: string | null;
  role_key: string;
  account_id: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

// What the Accounts settings screen actually reads — the account_mapping_status
// view. Everything here except last_posted_on and line_count is the mapping and
// its account; those two are DERIVED by the view and are the reason it exists.
export interface AccountMappingStatus {
  mapping_id: string;
  tenant_id: string;
  property_id: string | null;
  role_key: string;
  account_id: string;
  note: string | null;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  account_is_active: boolean;
  // NULL MEANS NOTHING HAS EVER POSTED THROUGH THIS KEY — the signal that a
  // posting site is unwired, and the one column on the screen worth reading
  // first. A date (business date, rule 8) means the wiring works.
  last_posted_on: string | null;
  // count(*) over the lines. int8 over PostgREST, so a NUMBER on the wire —
  // which is exactly why rule 24 makes the data layer declare it rather than
  // letting a component guess.
  line_count: number;
}
