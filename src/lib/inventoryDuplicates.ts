import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { passthrough } from './rowParse';

// ===========================================================================
// "HAVE WE ALREADY GOT ONE OF THESE?" — the duplicate check behind Add Product
// and the product-template import.
// ===========================================================================
//
// A hotel catalogue rots in one specific way: the same thing entered three
// times under three names. Rice, White Rice, Rice (local) are one sack in the
// store and three rows in the system, and once stock has been posted against
// all three there is no way back — the movements are permanent, so the items
// cannot be merged, only written down to zero and abandoned. That is why this
// runs BEFORE the insert rather than as a report afterwards.
//
// ---------------------------------------------------------------------------
// TWO DIFFERENT QUESTIONS, DELIBERATELY NOT MERGED
// ---------------------------------------------------------------------------
// 1. IS THIS THE SAME NAME? -> block. `lower(trim(name))` equality, which is
//    LITERALLY the expression behind 035's unique index:
//        create unique index inventory_items_tenant_name_live_uniq
//          on inventory_items (tenant_id, lower(name)) where deleted_at is null;
//    Written the same way on purpose. The UI check and the database backstop
//    then agree by construction rather than by coincidence, so the friendly
//    message and the constraint can never disagree about what counts as taken.
//    The same holds for `code`, which carries its own unique index.
//
// 2. IS THIS PROBABLY THE SAME THING? -> warn, never block. A judgement, and
//    judgements belong to the person, not the code. "Rice" and "Rice (local)"
//    might be one item entered twice or genuinely two grades of rice, and only
//    the storekeeper knows which.
//
// RULE 19 APPLIES HERE TOO, in its own shape: this file is the FRIENDLY FIRST
// LINE, never the guard. The unique indexes are the guard, and they hold when
// two people import overlapping files at the same moment — a case no read-side
// check can see, because both reads complete before either write. Every caller
// therefore still handles a 23505 from the insert as a real outcome, not as an
// impossible one.
//
// ---------------------------------------------------------------------------
// THE SIMILARITY METHOD, STATED IN FULL (no fuzzy library, on purpose)
// ---------------------------------------------------------------------------
// A Levenshtein/trigram library would buy recall we do not want. The failure
// mode that matters is not "we missed a near-match", it is "we flagged eleven
// items and the user learned to click through the warning" — a warning nobody
// reads is worse than no warning, because it launders the real ones. So the
// rules below are few, precise, and each one is a shape that genuinely occurs
// in a hotel catalogue:
//
//   normalise: lowercase -> every non-alphanumeric becomes a space -> collapse
//              runs of spaces -> trim.
//   tokens:    split on spaces, then lightly stem each token by dropping ONE
//              trailing "s" when the token is 4+ characters ("soaps" -> "soap",
//              but "gas" and "cls" are left alone).
//   compact:   the stemmed tokens joined with nothing between them.
//
//   RULE A — compact equality. "Coca-Cola", "Coca Cola", "cocacola" and
//            "Coca-Colas" all compact to "cocacola". These are spacing,
//            punctuation and plural variants of one name, and lower(name) — the
//            database's test — does NOT catch any of them. Near-zero false
//            positives.
//   RULE B — proper token subset. {rice} is a proper subset of {white, rice}
//            and of {rice, local}, so creating "Rice" surfaces both. Note what
//            this deliberately does NOT do: "White Rice" and "Rice (local)"
//            share only one token of two and neither contains the other, so
//            they are not reported as similar to each other. That asymmetry is
//            the point — it is what stops one common word ("water", "oil")
//            relating every item in a category to every other.
//
// Anything matching by rule A is a stronger signal than rule B, so results are
// ranked A first and capped, and the cap is stated to the user rather than
// silently truncating the list.

// The single-token stem length floor. Below this, a trailing "s" is far more
// likely to be part of the word than a plural.
const STEM_MIN_LENGTH = 4;

// How many near-matches to put in front of a person. Past a handful the list
// stops being read (see the note above); the count of the rest is shown instead.
export const MAX_SIMILAR_SHOWN = 5;

// ---------------------------------------------------------------------------
// The catalogue index this check reads
// ---------------------------------------------------------------------------

// Just enough of every LIVE item to answer both questions — never the whole
// row, because this is fetched to compare strings and a catalogue can be
// hundreds of items.
export interface NameIndexEntry {
  id: string;
  name: string;
  code: string | null;
  is_active: boolean;
}

// The boundary (rule 24). This projection is four text/boolean columns and no
// numeric — declared rather than judged exempt.
const nameIndex = passthrough<NameIndexEntry>('inventory_items (name index)');

// INACTIVE ITEMS ARE INCLUDED, and that is not an oversight. 035's unique index
// is partial on `deleted_at is null` and says nothing about `is_active`, so an
// item switched off still owns its name. Leaving those out would produce the
// worst possible outcome: the screen says the name is free, and the insert then
// fails on a constraint naming an item the user cannot see anywhere.
//
// Soft-deleted items ARE excluded, matching the index — a removed item releases
// its name, which is what makes "remove it and add it again" work.
export async function fetchNameIndex(
  tenantId: string,
): Promise<NameIndexEntry[]> {
  // Rule 1a: the whole result is consumed, so it is paged rather than read in
  // one unbounded select.
  return fetchAllPagedRows<NameIndexEntry>(nameIndex, (from, to) =>
    supabase
      .from('inventory_items')
      .select('id, name, code, is_active')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5, and matches the partial index
      .order('id', { ascending: true }) // unique → stable range pagination
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// The form a name is STORED in. Trimmed, and runs of internal whitespace
// collapsed to one space.
//
// The collapse is not cosmetic, and it is the reason exactKey below can be
// trusted. 035's unique index is on `lower(name)`, a raw string comparison, so
// "White Rice" and "White  Rice" (two spaces) are DIFFERENT names to Postgres —
// it would happily store both, and the Products list would then show what looks
// to a human like the same item twice, with two separate stock balances that
// can never be merged. A double space in a product name is a typo, never an
// intention, so it is removed on the way in. Every write path in the app puts
// the name through this, which is what makes the stored set free of
// whitespace-variant collisions in the first place.
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

// "Is this name taken?" — asked the same way everywhere, so there is a single
// definition of "the same name".
//
// HOW THIS RELATES TO THE DATABASE'S OWN TEST, precisely, because the two are
// not quite identical and the difference matters:
//
//   the index says:  lower(name)
//   this says:       lower(cleanName(name))
//
// For any name this application writes they are the same test, because every
// write path cleans first. They can only diverge on a row that arrived with
// stray whitespace by some other route, and there this check is the STRICTER of
// the two — it refuses a name the database would have accepted. That is the
// direction to fail in: the cost is a rejected typo the user retypes, and the
// alternative is a duplicate nobody can undo.
export function exactKey(name: string): string {
  return cleanName(name).toLowerCase();
}

export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stem(token: string): string {
  return token.length >= STEM_MIN_LENGTH && token.endsWith('s')
    ? token.slice(0, -1)
    : token;
}

export function nameTokens(name: string): string[] {
  const normalised = normaliseName(name);
  if (!normalised) return [];
  return normalised.split(' ').map(stem);
}

export function compactName(name: string): string {
  return nameTokens(name).join('');
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export type SimilarityReason = 'compact' | 'subset';

export interface SimilarMatch {
  item: NameIndexEntry;
  reason: SimilarityReason;
}

export interface NameVerdict {
  // A live item with exactly this name (case-insensitively). Present => BLOCK.
  exact: NameIndexEntry | null;
  // A live item with exactly this code. Present => BLOCK. Null when the
  // candidate has no code.
  codeClash: NameIndexEntry | null;
  // Near-matches worth a human glance, best first, capped at MAX_SIMILAR_SHOWN.
  similar: SimilarMatch[];
  // How many near-matches there were in total, so a truncated list can say so
  // rather than quietly hiding the rest.
  similarTotal: number;
}

function isProperSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size >= b.size) return false;
  for (const token of a) {
    if (!b.has(token)) return false;
  }
  return true;
}

// Compare one candidate against the catalogue.
//
// `index` is the whole live catalogue; `ignoreId` lets an EDIT skip the row
// being edited, which would otherwise always report itself as an exact
// duplicate of itself.
export function checkName(
  candidateName: string,
  candidateCode: string | null,
  index: NameIndexEntry[],
  ignoreId?: string | null,
): NameVerdict {
  const name = candidateName.trim();
  const key = exactKey(name);
  const codeKey = candidateCode?.trim().toLowerCase() || null;

  const tokens = new Set(nameTokens(name));
  const compact = compactName(name);

  let exact: NameIndexEntry | null = null;
  let codeClash: NameIndexEntry | null = null;
  const similar: SimilarMatch[] = [];

  for (const entry of index) {
    if (ignoreId && entry.id === ignoreId) continue;

    if (!exact && exactKey(entry.name) === key && key.length > 0) {
      exact = entry;
      // An exact match is not ALSO reported as similar — it is a stronger
      // statement about the same row, and saying both would read as two
      // problems where there is one.
      continue;
    }

    if (
      !codeClash &&
      codeKey &&
      entry.code &&
      entry.code.trim().toLowerCase() === codeKey
    ) {
      codeClash = entry;
      // Deliberately no `continue`: a row can clash on code AND be a near-match
      // on name, and the name warning is still worth showing beside it.
    }

    if (tokens.size === 0) continue;

    const entryTokens = new Set(nameTokens(entry.name));
    if (compact.length > 0 && compactName(entry.name) === compact) {
      similar.push({ item: entry, reason: 'compact' });
      continue;
    }
    if (
      isProperSubset(tokens, entryTokens) ||
      isProperSubset(entryTokens, tokens)
    ) {
      similar.push({ item: entry, reason: 'subset' });
    }
  }

  // Rule A ahead of rule B, then alphabetically so the same catalogue always
  // produces the same list in the same order — a warning that reshuffles
  // between two identical checks reads as a bug.
  similar.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === 'compact' ? -1 : 1;
    return a.item.name.localeCompare(b.item.name);
  });

  return {
    exact,
    codeClash,
    similar: similar.slice(0, MAX_SIMILAR_SHOWN),
    similarTotal: similar.length,
  };
}

// ---------------------------------------------------------------------------
// The sentences these verdicts turn into
// ---------------------------------------------------------------------------
// Generic UI copy, no tenant content (rule 17). Kept here beside the logic so a
// message can never describe a rule the code does not implement.

export function exactDuplicateMessage(existing: NameIndexEntry): string {
  return existing.is_active
    ? `An item named “${existing.name}” already exists in your catalogue. Use that one, or give this a different name.`
    : `An item named “${existing.name}” already exists in your catalogue — it is switched off, but it still holds the name. Turn it back on from the Products list, or give this a different name.`;
}

export function codeClashMessage(existing: NameIndexEntry): string {
  return `The code “${existing.code}” is already used by “${existing.name}”. A code has to be unique, so give this one a different code or leave it blank.`;
}

export function similarNamesMessage(verdict: NameVerdict): string {
  const names = verdict.similar.map((s) => `“${s.item.name}”`).join(', ');
  const hidden = verdict.similarTotal - verdict.similar.length;
  const more = hidden > 0 ? ` (and ${hidden} more)` : '';
  return `Similar items already exist: ${names}${more}. Please check you are not creating a duplicate — two rows for one thing cannot be merged later, because their movements are permanent.`;
}

// The wording of the blocker itself, so the single form and the import say the
// same thing at the same moment.
export const SIMILAR_CONFIRMATION =
  'This will create new products with these names. Confirm these are genuinely different inventory items.';
