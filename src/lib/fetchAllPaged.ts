import type { PostgrestError } from '@supabase/supabase-js';
import type { RowBoundary } from './rowParse';

// CLAUDE.md rule 1: no unbounded reads. Every list query pages through the
// result set with an explicit .range() so it can never silently truncate at
// Supabase's row cap and return partial data as if it were complete.
//
// `build` returns a Supabase query for one page. We keep the parameter type
// permissive (any thenable resolving to { data, error }) rather than tying it
// to a specific PostgrestFilterBuilder/TransformBuilder class, because .range()
// yields a transform builder and pinning the exact class only creates friction
// without adding safety.
type PagedResponse<T> = PromiseLike<{
  data: T[] | null;
  error: PostgrestError | null;
}>;

export async function fetchAllPaged<T>(
  build: (from: number, to: number) => PagedResponse<T>,
  page = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

// The same read, with the numeric fields parsed as each page arrives (rule 24).
//
// It exists so the two rules cannot be satisfied separately: a paged read that
// returned raw rows would page correctly and still hand a component the string
// PostgREST sent. The builder's rows are `unknown` here on purpose — what comes
// off the wire is not yet the app's type, and pretending otherwise at the
// `fetchAllPaged<T>` call site is how the raw shape used to travel.
export async function fetchAllPagedRows<T>(
  boundary: RowBoundary<T>,
  build: (from: number, to: number) => PagedResponse<unknown>,
  page = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...boundary.rows(data));
    if (data.length < page) break;
  }
  return rows;
}
