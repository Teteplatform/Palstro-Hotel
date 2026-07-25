// Small date helpers for the admin. Kept separate from format.ts (which is
// presentation-only) because these produce machine values ('YYYY-MM-DD'), not
// display strings.

// Today's date as a 'YYYY-MM-DD' string in the browser's local timezone — the
// value an <input type="date"> expects. Used to default the rate-preview date.
// Local (not UTC) so "today" matches the operator's calendar day; slicing
// toISOString() would shift near midnight in Africa/Lagos (UTC+1).
export function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
