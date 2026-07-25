import { useActiveProperty } from '../../hooks/useActiveProperty';
import { RoomTypesScreen } from '../../components/admin/rooms/RoomTypesScreen';

// Route: /admin/:propertySlug/rooms (build 5a §3) — replaces the "not available"
// placeholder the site editor's "edit room types" link pointed at. AdminLayout
// resolves and guards the active property before this renders; the guard here is
// belt-and-braces.
//
// Keyed by property id so switching property tears the screen down and reloads
// cleanly — no list page, media map or draft bleeds across properties (matching
// SettingsPage / SiteEditorPage).
export function RoomTypesPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  return (
    <RoomTypesScreen
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
      currency={property.currency}
    />
  );
}
