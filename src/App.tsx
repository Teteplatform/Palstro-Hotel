import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
} from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import { TenantContextProvider } from './hooks/useTenantContext';
import { PropertyContextProvider } from './hooks/usePropertyContext';
import { ActivePropertyProvider } from './hooks/useActiveProperty';
import { EnabledModulesProvider } from './hooks/useEnabledModules';
import { BookingDraftProvider } from './hooks/useBookingDraft';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ui/Toast';
import { AdminLayout } from './components/admin/AdminLayout';
import { ModuleGuard } from './components/admin/ModuleGuard';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { AdminIndexRedirect } from './pages/admin/AdminIndexRedirect';
import { SettingsPage } from './pages/admin/SettingsPage';
import { SiteEditorPage } from './pages/admin/SiteEditorPage';
import { RoomTypesPage } from './pages/admin/RoomTypesPage';
import { CompaniesPage } from './pages/admin/CompaniesPage';
import { BookingsPage } from './pages/admin/BookingsPage';
import { NewBookingPage } from './pages/admin/NewBookingPage';
import { BookingDetailPage } from './pages/admin/BookingDetailPage';
import { ModuleNotAvailablePage } from './pages/admin/ModuleNotAvailablePage';

/**
 * Route map:
 *   /                             public guest landing — resolved by host,
 *                                 anonymous, NOT protected.
 *   /login                        email + password sign in.
 *   /admin                        protected; redirects to the user's first
 *                                 accessible property's settings.
 *   /admin/:propertySlug          admin shell (AdminLayout) for one property;
 *                                 the active property lives in the URL (§1).
 *   /admin/:propertySlug/settings the settings screen (placeholder in build 1).
 *
 * A DATA router (createBrowserRouter + RouterProvider) is used deliberately:
 * useDirtyForm relies on react-router's useBlocker to intercept in-app
 * navigation away from an unsaved form (3.txt §5), and useBlocker only works
 * under a data router.
 *
 * ActivePropertyProvider wraps the whole /admin subtree so both the bare-/admin
 * redirect and the property shell share ONE fetch of the user's accessible
 * properties. It sits inside ProtectedRoute, so it never fetches for a
 * signed-out or non-admin user.
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <PropertyContextProvider>
        <LandingPage />
      </PropertyContextProvider>
    ),
    errorElement: <ErrorBoundary />,
  },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/admin',
    element: (
      <ProtectedRoute requireAdmin>
        <ActivePropertyProvider>
          {/* Shares ONE fetch of the tenant's enabled_modules across the whole
              /admin subtree — the sidebar filter and every ModuleGuard read it
              without refetching. Inside ProtectedRoute, so it never queries for
              a signed-out user. */}
          <EnabledModulesProvider>
            {/* Holds the in-memory create-booking draft ABOVE the route Outlet,
                so a half-filled booking survives navigating between admin screens
                (it is not unmounted on a route change, only the screen under it
                is). Session-scoped, no browser storage — see useBookingDraft. */}
            <BookingDraftProvider>
              <Outlet />
            </BookingDraftProvider>
          </EnabledModulesProvider>
        </ActivePropertyProvider>
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <AdminIndexRedirect /> },
      {
        path: ':propertySlug',
        element: <AdminLayout />,
        children: [
          // Pathless boundary nested INSIDE AdminLayout: an error in a content
          // page renders here, in AdminLayout's Outlet, so the sidebar survives
          // and the user can navigate away (§2). An error in AdminLayout itself
          // bubbles past this to the root's full-screen boundary.
          {
            errorElement: <ErrorBoundary />,
            children: [
              // A bare /admin/:slug lands on Settings, the one working screen.
              { index: true, element: <Navigate to="settings" replace /> },
              // ModuleGuard renders the "not available" page if the module is
              // disabled for this tenant (006). Settings can never be disabled,
              // so this always passes today — it sets the pattern every future
              // module route follows.
              {
                path: 'settings',
                element: (
                  <ModuleGuard module="settings">
                    <SettingsPage />
                  </ModuleGuard>
                ),
              },
              // The inline visual editor (3.txt §1): the real LandingPage in the
              // admin shell with edit mode on. Same 'settings' module as the form
              // tabs — it is a second face on the settings engine, not a new one.
              {
                path: 'site',
                element: (
                  <ModuleGuard module="settings">
                    <SiteEditorPage />
                  </ModuleGuard>
                ),
              },
              // Room types (build 5a): the bookable categories and their rate
              // structure. Under the 'settings' module for now (see adminNav) —
              // it is configuration, admin-gated like the settings surfaces.
              {
                path: 'rooms',
                element: (
                  <ModuleGuard module="settings">
                    <RoomTypesPage />
                  </ModuleGuard>
                ),
              },
              // Companies (build 6b): corporate accounts + negotiated rates.
              // Configuration, so under the 'settings' module like Room types.
              {
                path: 'companies',
                element: (
                  <ModuleGuard module="settings">
                    <CompaniesPage />
                  </ModuleGuard>
                ),
              },
              // Bookings (build 6b): the staff-facing booking screen. Its own
              // 'bookings' module — a tenant that has not bought it sees the
              // "not available" page (RLS still guards the data regardless).
              {
                path: 'bookings',
                element: (
                  <ModuleGuard module="bookings">
                    <BookingsPage />
                  </ModuleGuard>
                ),
              },
              // Creating a booking, as its own page (build B §1) — the modal
              // dialog is gone. Declared BEFORE the :bookingId route for
              // readability; react-router ranks the static 'new' segment above
              // the dynamic one regardless, so /bookings/new can never be read
              // as a booking id.
              {
                path: 'bookings/new',
                element: (
                  <ModuleGuard module="bookings">
                    <NewBookingPage />
                  </ModuleGuard>
                ),
              },
              // One booking, as its own page (build A §1) — deep-linkable and
              // refreshable, which a modal panel never was. Same 'bookings'
              // module guard as the list: a tenant without the module cannot
              // reach the detail by typing the URL either.
              {
                path: 'bookings/:bookingId',
                element: (
                  <ModuleGuard module="bookings">
                    <BookingDetailPage />
                  </ModuleGuard>
                ),
              },
              // Not-yet-built (and disabled) modules render inside AdminLayout so
              // the sidebar stays visible and the user can navigate away — never
              // react-router's raw 404 (§1).
              { path: '*', element: <ModuleNotAvailablePage /> },
            ],
          },
        ],
      },
    ],
  },
]);

/**
 * AuthProvider / TenantContextProvider / ToastProvider wrap the router. None of
 * them use router hooks, so they are correctly OUTSIDE RouterProvider; the app
 * shares one session and one toast surface across every route.
 */
function App() {
  return (
    <AuthProvider>
      <TenantContextProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TenantContextProvider>
    </AuthProvider>
  );
}

export default App;
