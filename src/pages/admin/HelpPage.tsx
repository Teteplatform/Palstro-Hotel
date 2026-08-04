import { HelpScreen } from '../../components/admin/help/HelpScreen';

// The Help route — /admin/:propertySlug/help.
//
// DELIBERATELY NOT MODULE-GATED. Every other content route is wrapped in a
// ModuleGuard so a tenant who has not bought a module cannot reach it; the guide
// is not a module. It is documentation about the product, it reads no tenant
// data at all, and the one moment somebody needs it is the moment something else
// is not working — which is exactly when a guard would be in the way.
//
// It also needs no property: the guide is generic by design (rule 17 — it says
// "your hotel", never a hotel's name), so this page loads nothing. It still lives
// under the property path so it opens inside the admin shell, with the sidebar
// intact and the way back one tap away.
export function HelpPage() {
  return <HelpScreen />;
}
