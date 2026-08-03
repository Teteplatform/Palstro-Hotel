import { useCallback, useEffect, useState } from 'react';
import {
  fetchChargeReversals,
  fetchDiscountThreshold,
  fetchFolioCharges,
  fetchFolioChargeTaxes,
  fetchFolioForBooking,
  fetchFolioPayments,
  fetchFolioTotals,
  fetchPaymentReversals,
} from '../lib/folio';
import type {
  Folio,
  FolioChargeTaxRow,
  FolioChargeWithCategory,
  FolioPayment,
  FolioTotals,
  Reversal,
} from '../types/folio';

// The folio of one booking, loaded as a single consistent snapshot for the panel
// (build 6c part 2 §1).
//
// NOTHING IS CACHED AND NOTHING IS PATCHED IN PLACE. Every mutation calls
// reload(), which re-reads the charges, the payments, the computed tax lines and
// folio_totals from the database. The tempting alternative — adjusting the local
// balance by the amount just posted — is exactly the drift rule 6 forbids: the
// client would be maintaining a second, un-recomputable copy of a number the
// engine already computes, and the day a tax rate or a void made them disagree,
// nothing would error.
//
// FIVE READS, ONE PASS (never N+1):
//   folio -> then charges, payments, tax lines and totals in parallel. The tax
//   lines come from the folio_charge_taxes VIEW (022), i.e. folio_charge_tax
//   applied per charge BY THE DATABASE — one query for the whole folio rather
//   than one call per charge, and no second implementation of the rule in TS.
//
// The discount threshold is loaded here too so the discount screen can decide
// whether to show a PIN field without its own round trip (a UX convenience only —
// apply_charge_discount re-checks it server-side, rule 19).

export interface UseFolioResult {
  folio: Folio | null;
  charges: FolioChargeWithCategory[];
  payments: FolioPayment[];
  // Every charge's tax lines for the whole folio, one row per (charge, tax).
  chargeTaxes: FolioChargeTaxRow[];
  // The reversal audit row of each REVERSED payment, keyed by the ORIGINAL
  // payment's id (031). Empty on a folio where nothing has been reversed, which
  // is the overwhelming majority — see the loader for why that case costs no
  // extra query.
  paymentReversals: Map<string, Reversal>;
  // The same, for CHARGES (032), split by act and keyed by the ORIGINAL charge's
  // id. Two maps because 'charge' and 'discount' are independent one-time acts
  // against the same charge, so one map would silently drop one of them.
  chargeReversals: Map<string, Reversal>;
  discountReversals: Map<string, Reversal>;
  totals: FolioTotals | null;
  // The property's PIN-free discount ceiling (0 = every discount needs approval).
  discountThreshold: number;
  loading: boolean;
  // The RAW error, preserved (a PostgREST error is a plain object, not an Error —
  // wrapping it in new Error(String(e)) yields "[object Object]"). Rendered
  // through describeError so message/details/hint/code all surface (rule 11).
  error: unknown;
  reload: () => Promise<void>;
}

export function useFolio(
  bookingId: string | null,
  tenantId: string | null,
  propertyId: string | null,
): UseFolioResult {
  const [folio, setFolio] = useState<Folio | null>(null);
  const [charges, setCharges] = useState<FolioChargeWithCategory[]>([]);
  const [payments, setPayments] = useState<FolioPayment[]>([]);
  const [chargeTaxes, setChargeTaxes] = useState<FolioChargeTaxRow[]>([]);
  const [paymentReversals, setPaymentReversals] = useState<Map<string, Reversal>>(
    () => new Map(),
  );
  const [chargeReversals, setChargeReversals] = useState<Map<string, Reversal>>(
    () => new Map(),
  );
  const [discountReversals, setDiscountReversals] = useState<
    Map<string, Reversal>
  >(() => new Map());
  const [totals, setTotals] = useState<FolioTotals | null>(null);
  const [discountThreshold, setDiscountThreshold] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!bookingId || !tenantId || !propertyId) {
        if (cancelled) return;
        setFolio(null);
        setCharges([]);
        setPayments([]);
        setChargeTaxes([]);
        setPaymentReversals(new Map());
        setChargeReversals(new Map());
        setDiscountReversals(new Map());
        setTotals(null);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const row = await fetchFolioForBooking(bookingId, tenantId, propertyId);
        if (cancelled) return;
        setFolio(row);

        if (!row) {
          // 021 §4.1 opens a folio for every booking via a trigger, so this is a
          // genuine fault, not an empty state. Clear everything and let the panel
          // say so rather than rendering a convincing zero balance.
          setCharges([]);
          setPayments([]);
          setChargeTaxes([]);
          setPaymentReversals(new Map());
          setTotals(null);
          setError(null);
          return;
        }

        const [chargeRows, paymentRows, taxRows, totalRow, threshold] =
          await Promise.all([
            fetchFolioCharges(row.id, tenantId, propertyId),
            fetchFolioPayments(row.id, tenantId, propertyId),
            fetchFolioChargeTaxes(row.id, tenantId, propertyId),
            fetchFolioTotals(row.id),
            fetchDiscountThreshold(propertyId),
          ]);
        if (cancelled) return;

        setCharges(chargeRows);
        setPayments(paymentRows);
        setChargeTaxes(taxRows);
        setTotals(totalRow);
        setDiscountThreshold(threshold);

        // TWO MORE READS, MADE ONLY WHEN THEY CAN RETURN SOMETHING. A payment has
        // been reversed if and only if a COUNTER-ENTRY exists on this folio
        // (reverse_payment writes both in one transaction — 031 §3.4), and a
        // counter-entry announces itself with reversal_of_payment_id. So the
        // originals are already known from the rows in hand, and a folio with no
        // reversals — the overwhelming majority — issues no query at all.
        //
        // What the extra read buys is the one fact the payments rows do NOT
        // carry: WHICH MANAGER APPROVED. A reversal that names nobody is the
        // failure this whole subsystem exists to prevent, so the bill fetches it.
        const reversedIds = paymentRows
          .map((p) => p.reversal_of_payment_id)
          .filter((id): id is string => id !== null);
        // The same read for CHARGES (032), on exactly the same terms: a charge
        // has been reversed — in full or in its discount — if and only if a
        // counter-ENTRY exists on this folio, and a counter-entry announces
        // itself with reversal_of_charge_id. So a folio with no reversals issues
        // neither query, and the reads run together rather than in series.
        const reversedChargeIds = chargeRows
          .map((c) => c.reversal_of_charge_id)
          .filter((id): id is string => id !== null);
        const [reversalMap, chargeReversalMaps] = await Promise.all([
          reversedIds.length > 0
            ? fetchPaymentReversals(reversedIds, tenantId, propertyId)
            : Promise.resolve(new Map<string, Reversal>()),
          reversedChargeIds.length > 0
            ? fetchChargeReversals(reversedChargeIds, tenantId, propertyId)
            : Promise.resolve({
                charge: new Map<string, Reversal>(),
                discount: new Map<string, Reversal>(),
              }),
        ]);
        if (cancelled) return;
        setPaymentReversals(reversalMap);
        setChargeReversals(chargeReversalMaps.charge);
        setDiscountReversals(chargeReversalMaps.discount);

        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bookingId, tenantId, propertyId, nonce]);

  return {
    folio,
    charges,
    payments,
    chargeTaxes,
    paymentReversals,
    chargeReversals,
    discountReversals,
    totals,
    discountThreshold,
    loading,
    error,
    reload,
  };
}
