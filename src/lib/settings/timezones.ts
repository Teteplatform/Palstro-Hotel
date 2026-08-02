import type { SelectOption } from '../../components/ui/form';

// The IANA timezone choices for the Operations tab (brief §3).
//
// WHY A LIST AND NOT A FREE-TEXT BOX. The timezone is not decoration: it decides
// which business day every charge, payment and room night belongs to
// (properties.timezone is read by create_booking, post_charge, record_payment and
// run_night_audit). A typo — 'Africa/Lagoss', 'WAT', 'GMT+1' — is not rejected by
// the column, and Postgres' `now() at time zone <bad name>` raises at posting
// time, or silently resolves to something else. A picker makes the wrong value
// unreachable.
//
// RULE 17 CHECK — this is NOT a tenant string. These are IANA tz database
// identifiers: a public standard, the same list every operating system ships.
// Nothing here names a hotel, a brand, a rate or a policy, and the property's
// ACTUAL timezone is never defaulted here — it always comes from the DB row
// (properties.timezone, whose column default lives in migration 001). This file
// only says which standard identifiers may be picked from.
//
// CURATED, NOT EXHAUSTIVE. The full tz database is ~600 zones, most of them
// aliases and links; a select with 600 options is not a usable control. The list
// below is every African zone a Nigerian hotel group might plausibly operate in,
// plus the world's common business zones for a future property abroad. If a
// property somehow holds a zone that is not listed, the settings control appends
// it as its own option rather than silently rewriting the stored value — see
// FieldControl's select case.
//
// LABELS CARRY NO FIXED UTC OFFSET, deliberately. An offset drifts with daylight
// saving ("Europe/London (UTC+0)" is wrong for half the year) and a label that is
// wrong half the time is worse than no label. The city name is the stable fact.

export const TIMEZONE_OPTIONS: SelectOption[] = [
  // --- West Africa (the home market) ---------------------------------------
  { value: 'Africa/Lagos', label: 'Africa/Lagos — Nigeria' },
  { value: 'Africa/Accra', label: 'Africa/Accra — Ghana' },
  { value: 'Africa/Abidjan', label: 'Africa/Abidjan — Côte d’Ivoire' },
  { value: 'Africa/Dakar', label: 'Africa/Dakar — Senegal' },
  { value: 'Africa/Bamako', label: 'Africa/Bamako — Mali' },
  { value: 'Africa/Conakry', label: 'Africa/Conakry — Guinea' },
  { value: 'Africa/Freetown', label: 'Africa/Freetown — Sierra Leone' },
  { value: 'Africa/Monrovia', label: 'Africa/Monrovia — Liberia' },
  { value: 'Africa/Lome', label: 'Africa/Lome — Togo' },
  { value: 'Africa/Porto-Novo', label: 'Africa/Porto-Novo — Benin' },
  { value: 'Africa/Ouagadougou', label: 'Africa/Ouagadougou — Burkina Faso' },
  { value: 'Africa/Niamey', label: 'Africa/Niamey — Niger' },
  { value: 'Africa/Banjul', label: 'Africa/Banjul — Gambia' },
  { value: 'Africa/Bissau', label: 'Africa/Bissau — Guinea-Bissau' },
  { value: 'Africa/Nouakchott', label: 'Africa/Nouakchott — Mauritania' },

  // --- Central, East, North and Southern Africa ----------------------------
  { value: 'Africa/Douala', label: 'Africa/Douala — Cameroon' },
  { value: 'Africa/Libreville', label: 'Africa/Libreville — Gabon' },
  { value: 'Africa/Kinshasa', label: 'Africa/Kinshasa — DR Congo (west)' },
  { value: 'Africa/Lubumbashi', label: 'Africa/Lubumbashi — DR Congo (east)' },
  { value: 'Africa/Luanda', label: 'Africa/Luanda — Angola' },
  { value: 'Africa/Ndjamena', label: 'Africa/Ndjamena — Chad' },
  { value: 'Africa/Bangui', label: 'Africa/Bangui — Central African Republic' },
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi — Kenya' },
  { value: 'Africa/Kampala', label: 'Africa/Kampala — Uganda' },
  { value: 'Africa/Dar_es_Salaam', label: 'Africa/Dar_es_Salaam — Tanzania' },
  { value: 'Africa/Kigali', label: 'Africa/Kigali — Rwanda' },
  { value: 'Africa/Addis_Ababa', label: 'Africa/Addis_Ababa — Ethiopia' },
  { value: 'Africa/Khartoum', label: 'Africa/Khartoum — Sudan' },
  { value: 'Africa/Cairo', label: 'Africa/Cairo — Egypt' },
  { value: 'Africa/Tunis', label: 'Africa/Tunis — Tunisia' },
  { value: 'Africa/Algiers', label: 'Africa/Algiers — Algeria' },
  { value: 'Africa/Casablanca', label: 'Africa/Casablanca — Morocco' },
  { value: 'Africa/Tripoli', label: 'Africa/Tripoli — Libya' },
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg — South Africa' },
  { value: 'Africa/Harare', label: 'Africa/Harare — Zimbabwe' },
  { value: 'Africa/Lusaka', label: 'Africa/Lusaka — Zambia' },
  { value: 'Africa/Gaborone', label: 'Africa/Gaborone — Botswana' },
  { value: 'Africa/Windhoek', label: 'Africa/Windhoek — Namibia' },
  { value: 'Africa/Maputo', label: 'Africa/Maputo — Mozambique' },
  { value: 'Indian/Mauritius', label: 'Indian/Mauritius — Mauritius' },

  // --- Europe ---------------------------------------------------------------
  { value: 'Europe/London', label: 'Europe/London — United Kingdom' },
  { value: 'Europe/Dublin', label: 'Europe/Dublin — Ireland' },
  { value: 'Europe/Lisbon', label: 'Europe/Lisbon — Portugal' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid — Spain' },
  { value: 'Europe/Paris', label: 'Europe/Paris — France' },
  { value: 'Europe/Brussels', label: 'Europe/Brussels — Belgium' },
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam — Netherlands' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin — Germany' },
  { value: 'Europe/Zurich', label: 'Europe/Zurich — Switzerland' },
  { value: 'Europe/Rome', label: 'Europe/Rome — Italy' },
  { value: 'Europe/Athens', label: 'Europe/Athens — Greece' },
  { value: 'Europe/Istanbul', label: 'Europe/Istanbul — Türkiye' },
  { value: 'Europe/Moscow', label: 'Europe/Moscow — Russia (Moscow)' },

  // --- Middle East and Asia -------------------------------------------------
  { value: 'Asia/Dubai', label: 'Asia/Dubai — United Arab Emirates' },
  { value: 'Asia/Riyadh', label: 'Asia/Riyadh — Saudi Arabia' },
  { value: 'Asia/Qatar', label: 'Asia/Qatar — Qatar' },
  { value: 'Asia/Jerusalem', label: 'Asia/Jerusalem — Israel' },
  { value: 'Asia/Karachi', label: 'Asia/Karachi — Pakistan' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata — India' },
  { value: 'Asia/Dhaka', label: 'Asia/Dhaka — Bangladesh' },
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok — Thailand' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore — Singapore' },
  { value: 'Asia/Kuala_Lumpur', label: 'Asia/Kuala_Lumpur — Malaysia' },
  { value: 'Asia/Jakarta', label: 'Asia/Jakarta — Indonesia (west)' },
  { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong — Hong Kong' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai — China' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo — Japan' },
  { value: 'Asia/Seoul', label: 'Asia/Seoul — South Korea' },

  // --- Americas and Oceania -------------------------------------------------
  { value: 'America/New_York', label: 'America/New_York — US Eastern' },
  { value: 'America/Chicago', label: 'America/Chicago — US Central' },
  { value: 'America/Denver', label: 'America/Denver — US Mountain' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles — US Pacific' },
  { value: 'America/Toronto', label: 'America/Toronto — Canada (Eastern)' },
  { value: 'America/Mexico_City', label: 'America/Mexico_City — Mexico' },
  { value: 'America/Bogota', label: 'America/Bogota — Colombia' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo — Brazil' },
  { value: 'America/Buenos_Aires', label: 'America/Buenos_Aires — Argentina' },
  { value: 'Australia/Perth', label: 'Australia/Perth — Australia (west)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney — Australia (east)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland — New Zealand' },

  // UTC is offered last and on purpose: it is a legitimate choice for a
  // test/staging property, and having it in the list stops anyone typing 'GMT'
  // into a free-text field to get the same effect.
  { value: 'UTC', label: 'UTC — Coordinated Universal Time' },
];
