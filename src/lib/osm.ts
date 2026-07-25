// Shared OpenStreetMap embed helpers. The guest LocationSection and the settings
// coordinate editor render the SAME keyless OSM embed — no API key, no billing
// account, no third-party script — so the bbox maths lives here once rather than
// being copied into two components that could then drift apart.
//
// WHY THE RANGE GUARDS MATTER (3.txt §3): a coordinate outside its valid range —
// or the classic swapped lat/lng — does not error. It silently drops the pin in
// the ocean, and nobody notices until a guest tries to find the hotel. So both
// builders return null out of range, and the coordinate editor renders a LIVE pin
// beside the number fields: a plausible-looking but wrong coordinate is invisible
// in the digits and obvious the instant the map shows the sea.

export function isValidLatitude(lat: number | null | undefined): lat is number {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLongitude(lng: number | null | undefined): lng is number {
  return (
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

// The keyless OSM embed iframe `src` for a marker at (lat, lng), or null when
// either coordinate is missing or out of range. A ~0.01° box (~1km) frames the
// pin without over-zooming.
export function osmEmbedSrc(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) return null;
  const bbox = `${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
}

// The Google Maps "directions to this point" link — the turn-by-turn routing the
// embed itself cannot provide. Null when the coordinates are unusable.
export function osmDirectionsHref(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
