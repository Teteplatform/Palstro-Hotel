interface PlatformMarkProps {
  className?: string;
}

/**
 * The Palstro-Hotels PLATFORM mark — the product's own brand, shown on surfaces
 * that belong to the platform rather than to any one hotel (currently the sign-in
 * screen). This is deliberately NOT a tenant value and is exempt from rule 17,
 * which forbids hardcoded *hotel* branding: this is the platform naming itself.
 *
 * IMPORTANT — do not turn this into a property logo. It exists precisely because
 * /login is not property-scoped: there is no active property on that route, so
 * there is no property logo to read. Wiring a property lookup into a route that
 * has no property would be a bug, not an improvement (3.txt §2).
 *
 * Self-contained inline SVG (matching ui/icons.tsx): no asset file, no network
 * fetch, so it paints instantly and never shows a broken image. currentColor +
 * theme utilities only — no colour literals except the knockout white on the
 * primary badge (white on primary is 6.4:1, well clear of AA).
 */
export function PlatformMark({ className = '' }: PlatformMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg
        viewBox="0 0 32 32"
        className="h-8 w-8 shrink-0 text-primary"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <g
          fill="none"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 24V13l6-4 6 4v11" />
          <path d="M9 24h14" />
          <path d="M14 24v-4h4v4" />
          <path d="M13 14h.01M19 14h.01M13 17.5h.01M19 17.5h.01" />
        </g>
      </svg>
      <span className="text-lg font-bold leading-none tracking-tight text-charcoal">
        Palstro<span className="font-semibold text-primary"> Hotels</span>
      </span>
    </span>
  );
}
