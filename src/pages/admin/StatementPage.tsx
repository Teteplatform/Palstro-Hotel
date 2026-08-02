import { useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { StatementScreen } from '../../components/admin/statement/StatementScreen';

// Routes:
//   /admin/:propertySlug/bookings/:bookingId/statement — one stay's bill.
//   /admin/:propertySlug/guests/:guestId/statement     — the guest's
//                                                        non-resident account.
//
// ONE PAGE, TWO ROUTES, because it is ONE document (3.txt): the statement adapts
// to whether there is a stay behind it rather than existing twice. Which param
// is present decides the target — and only one ever is, because the two routes
// live under different parents.
//
// A statement is a READ of a folio, so it is guarded by the same module as the
// surface it is reached from (bookings / guests) in App.tsx; RLS guards the data
// regardless (rule 19).
//
// Keyed by the subject id so navigating from one statement to another remounts
// cleanly rather than briefly showing the previous guest's document.
export function StatementPage() {
  const { bookingId, guestId } = useParams();
  const { property } = useActiveProperty();

  if (!property) return null;

  if (bookingId) {
    return (
      <StatementScreen
        key={bookingId}
        target={{ kind: 'stay', bookingId }}
        property={property}
        // Back to the STAY, not to the bookings list: this document was opened
        // from that page (or deep-linked into), and the stay is where its
        // internal counterpart and every action live.
        backHref={`/admin/${property.slug}/bookings/${bookingId}`}
        backLabel="Back to stay"
      />
    );
  }

  if (guestId) {
    return (
      <StatementScreen
        key={guestId}
        target={{ kind: 'standalone', guestId }}
        property={property}
        backHref={`/admin/${property.slug}/guests/${guestId}`}
        backLabel="Back to guest"
      />
    );
  }

  return null;
}
