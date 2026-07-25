// The settings TABS (build 3, §2). Each tab is a titled group of fields from
// schema.ts; the SettingsForm renders any of them without knowing what is in it,
// and the SettingsPage lists them. Adding a settings surface = adding a tab
// here, never a new page.

import type { SettingsField, SettingsTab } from './schema';
import { GUEST_SECTIONS } from './sections';

// --- Brand and theme -------------------------------------------------------
// Colours and the font pairing live in property_settings.branding (presentation
// only, per 001). template is a property_settings COLUMN (constrained), so it is
// stored there, not in branding. Each colour declares the foreground that will
// sit on it so the field can warn on a failing contrast pairing (§4).
const brandFields: SettingsField[] = [
  {
    key: 'logo',
    label: 'Logo',
    help: 'Shown in the site header. A transparent PNG reads best over the hero.',
    type: 'image',
    mediaCategory: 'logo',
    storage: { target: 'branding', brandingKey: 'logo_url' },
  },
  {
    key: 'primary_color',
    label: 'Primary colour',
    help: 'The main brand colour — buttons, links, active states carry white text on it.',
    type: 'color',
    storage: { target: 'branding', brandingKey: 'primary_color' },
    contrast: {
      foreground: { kind: 'fixed', hex: '#ffffff' },
      description: 'white button text',
    },
  },
  {
    key: 'background_color',
    label: 'Background colour',
    help: 'The page background. Keep it light so text stays readable on it.',
    type: 'color',
    storage: { target: 'branding', brandingKey: 'background_color' },
    contrast: {
      // Pairs with the text colour the admin sets below — read live.
      foreground: { kind: 'field', fieldKey: 'text_color' },
      description: 'body text',
    },
  },
  {
    key: 'text_color',
    label: 'Text colour',
    help: 'The main text colour, shown on the background above.',
    type: 'color',
    storage: { target: 'branding', brandingKey: 'text_color' },
    contrast: {
      foreground: { kind: 'field', fieldKey: 'background_color' },
      description: 'the background',
    },
  },
  {
    key: 'surface_color',
    label: 'Surface colour',
    help: 'Cards and separated sections sit on this, a shade off the background.',
    type: 'color',
    storage: { target: 'branding', brandingKey: 'surface_color' },
    contrast: {
      foreground: { kind: 'field', fieldKey: 'text_color' },
      description: 'body text',
    },
  },
  {
    key: 'accent_color',
    label: 'Accent colour',
    help: 'Reserved for calls to action. White text sits on it.',
    type: 'color',
    storage: { target: 'branding', brandingKey: 'accent_color' },
    contrast: {
      foreground: { kind: 'fixed', hex: '#ffffff' },
      description: 'white button text',
    },
  },
  {
    key: 'font_pairing',
    label: 'Font pairing',
    help: 'A curated heading + body pairing. The preview updates as you choose.',
    type: 'font',
    storage: { target: 'branding', brandingKey: 'font_pairing' },
  },
  {
    key: 'template',
    label: 'Template',
    help: 'The overall layout style of the guest site.',
    type: 'select',
    storage: { target: 'property_settings', column: 'template' },
    options: [
      { value: 'warm_family', label: 'Warm & family-friendly' },
      { value: 'luxury_modern', label: 'Luxury & modern' },
      { value: 'minimalist', label: 'Minimalist' },
    ],
  },
];

// --- Content ---------------------------------------------------------------
// Tagline, about copy, and the section visibility/order controls. Visibility is
// one toggle per optional guest section, generated from GUEST_SECTIONS so there
// is no hand-maintained list; order is a single ordered list of section ids.
const sectionVisibilityFields: SettingsField[] = GUEST_SECTIONS.map(
  (section): SettingsField => ({
    key: `show_${section.id}`,
    label: `Show “${section.label}” section`,
    type: 'toggle',
    // A section shows unless explicitly hidden, so an unset flag defaults to on.
    defaultValue: true,
    storage: { target: 'branding', brandingKey: `show_${section.id}` },
  }),
);

const contentFields: SettingsField[] = [
  {
    key: 'tagline',
    label: 'Tagline',
    help: 'The short line under the hotel name in the hero.',
    type: 'text',
    storage: { target: 'branding', brandingKey: 'tagline' },
    placeholder: 'A warm island welcome',
  },
  {
    key: 'about_text',
    label: 'About text',
    help: 'A paragraph or two introducing the property.',
    type: 'textarea',
    rows: 6,
    storage: { target: 'branding', brandingKey: 'about_text' },
  },
  {
    key: 'about_image',
    label: 'About image',
    help: 'Sits beside the about text. A warm, welcoming photo works well.',
    type: 'image',
    mediaCategory: 'about',
    storage: { target: 'branding', brandingKey: 'about_image' },
  },
  {
    key: 'hero_images',
    label: 'Hero images',
    help: 'The full-screen images at the top of the site. The FIRST is what a visitor sees before the carousel advances, so order matters.',
    type: 'imageList',
    mediaCategory: 'hero',
    // Capped at 5, down from 10 (3.txt §5). A visitor sees two hero images at
    // most before scrolling past, and each loads the ~200KB `full` variant — ten
    // is ~2MB of images nobody looks at, a real cost on a mobile connection. Five
    // is already generous for a slow crossfade.
    max: 5,
    storage: { target: 'branding', brandingKey: 'hero_images' },
  },
  {
    key: 'gallery_images',
    label: 'Gallery',
    help: 'The photo grid guests browse. Shown as thumbnails; a tap opens the full image.',
    type: 'imageList',
    mediaCategory: 'gallery',
    max: 30,
    storage: { target: 'branding', brandingKey: 'gallery_images' },
  },
  {
    // Add/remove chips (3.txt §2): not every hotel has every amenity, so the
    // owner curates the list themselves. Stored as a plain string array in
    // branding.amenities; the guest AmenitiesSection reads the same key and
    // infers a decorative icon per label. The AmenitiesSection editable region
    // opens exactly this field.
    key: 'amenities',
    label: 'Amenities',
    help: 'What the property offers — pool, free Wi-Fi, restaurant. Guests see these as an icon grid.',
    type: 'stringList',
    storage: { target: 'branding', brandingKey: 'amenities' },
    placeholder: 'e.g. Free Wi-Fi',
  },
  ...sectionVisibilityFields,
  {
    key: 'section_order',
    label: 'Section order',
    help: `The order optional sections appear, top to bottom. Use these ids: ${GUEST_SECTIONS.map(
      (s) => s.id,
    ).join(', ')}.`,
    type: 'stringList',
    storage: { target: 'branding', brandingKey: 'section_order' },
    placeholder: 'e.g. about',
  },
];

// --- Contact ---------------------------------------------------------------
// Phone/email/address are first-class properties columns (003), because
// invoices, receipts and confirmations read them too — not branding. Directions
// is genuinely presentational, so it stays in branding.
const contactFields: SettingsField[] = [
  {
    key: 'name',
    label: 'Hotel name',
    help: 'The property name shown throughout the guest site. Required.',
    type: 'text',
    required: true,
    storage: { target: 'properties', column: 'name' },
  },
  {
    key: 'phone',
    label: 'Phone',
    type: 'text',
    storage: { target: 'properties', column: 'phone' },
    placeholder: '+234 …',
  },
  {
    key: 'email',
    label: 'Email',
    type: 'text',
    storage: { target: 'properties', column: 'email' },
    validation: {
      // Light structural check only; the real gate is a real address working.
      pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
      patternMessage: 'Enter a valid email address.',
    },
  },
  {
    key: 'address_line',
    label: 'Address',
    type: 'text',
    storage: { target: 'properties', column: 'address_line' },
  },
  {
    key: 'city',
    label: 'City / Town',
    type: 'text',
    storage: { target: 'properties', column: 'city' },
  },
  {
    key: 'state',
    label: 'State',
    type: 'text',
    storage: { target: 'properties', column: 'state' },
  },
  {
    key: 'postal_code',
    label: 'Postal code',
    type: 'text',
    storage: { target: 'properties', column: 'postal_code' },
  },
  {
    // numeric(10,7) properties column (003), written via update_property_details
    // (migration 011 adds lat/lng handling + range checks). Ranges are in
    // `validation` (not min/max) so OUR message shows on both the settings tab and
    // the visual editor panel, rather than a native browser bubble. step 'any'
    // lets the input accept the 7-dp precision the column stores.
    key: 'latitude',
    label: 'Latitude',
    help: 'Between −90 and 90. Use the map preview below to confirm the pin lands on the property.',
    type: 'number',
    step: 'any',
    storage: { target: 'properties', column: 'latitude' },
    placeholder: 'e.g. 4.4213',
    validation: { min: -90, max: 90 },
  },
  {
    key: 'longitude',
    label: 'Longitude',
    help: 'Between −180 and 180.',
    type: 'number',
    step: 'any',
    storage: { target: 'properties', column: 'longitude' },
    placeholder: 'e.g. 7.1699',
    validation: { min: -180, max: 180 },
  },
  {
    // The live pin preview (3.txt §3): presentational, no storage of its own — it
    // reads the two coordinate fields above and updates as they are typed, so a
    // wrong coordinate shows as a pin in the sea before it is ever saved.
    key: 'location_map',
    label: 'Map preview',
    help: 'Updates as you type the coordinates. If the pin is in the wrong place, the numbers are wrong.',
    type: 'coordinateMap',
    latKey: 'latitude',
    lngKey: 'longitude',
  },
  {
    key: 'directions',
    label: 'Directions',
    help: 'How to find the property — landmarks, turnings. Shown on the guest map.',
    type: 'textarea',
    rows: 4,
    storage: { target: 'branding', brandingKey: 'directions' },
  },
];

// --- Operations ------------------------------------------------------------
// Timezone/currency/night-audit are operational properties columns; booking is a
// property_settings column.
const operationsFields: SettingsField[] = [
  {
    key: 'timezone',
    label: 'Timezone',
    help: 'IANA timezone name, e.g. Africa/Lagos. Drives the night-audit cutoff.',
    type: 'text',
    required: true,
    storage: { target: 'properties', column: 'timezone' },
    placeholder: 'Africa/Lagos',
  },
  {
    key: 'currency',
    label: 'Currency',
    help: 'Three-letter ISO code, e.g. NGN. Every amount on the site uses it.',
    type: 'text',
    required: true,
    storage: { target: 'properties', column: 'currency' },
    placeholder: 'NGN',
    validation: {
      pattern: /^[A-Za-z]{3}$/,
      patternMessage: 'Use a three-letter currency code (e.g. NGN).',
    },
  },
  {
    key: 'night_audit_time',
    label: 'Night audit time',
    help: 'The 24-hour cutoff (HH:MM) that decides which business day a late sale belongs to.',
    type: 'text',
    required: true,
    storage: { target: 'properties', column: 'night_audit_time' },
    placeholder: '06:00',
    validation: {
      pattern: /^([01]\d|2[0-3]):[0-5]\d$/,
      patternMessage: 'Use 24-hour HH:MM, e.g. 06:00.',
    },
  },
  {
    key: 'booking_enabled',
    label: 'Online booking',
    help: 'When off, the guest site shows the property but takes no online bookings.',
    type: 'toggle',
    storage: { target: 'property_settings', column: 'booking_enabled' },
  },
];

// --- Tax -------------------------------------------------------------------
// default_vat_rate is a tenant_settings column (federal VAT is company-wide, not
// per-property). Stored as a fraction (0.075); edited as a percentage via scale.
const taxFields: SettingsField[] = [
  {
    key: 'default_vat_rate',
    label: 'Default VAT rate',
    help: 'Entered as a percentage — e.g. 7.5 for Nigeria’s 7.5% federal VAT.',
    type: 'number',
    min: 0,
    max: 100,
    step: 0.1,
    scale: 0.01, // db (fraction) = field (percent) × 0.01
    storage: { target: 'tenant_settings', column: 'default_vat_rate' },
    placeholder: '7.5',
    validation: {
      // The column is NOT NULL; 0% is valid but blank is not. Reject null so a
      // cleared field never tries to write NULL into default_vat_rate.
      validate: (v) =>
        v === null ? 'Enter a VAT rate (use 0 for none).' : null,
    },
  },
];

// NOTE — properties.slug is DELIBERATELY NOT an editable field on any tab.
// Changing the slug changes the property's admin URL (/admin/<slug>/…) and, for
// a domain-less property, would break any link already shared to the guest site.
// A slug change is a migration-grade operation, not a settings toggle, so it is
// intentionally absent here. Do not add it without a redirect story.

export const SETTINGS_TABS: SettingsTab[] = [
  {
    id: 'brand',
    label: 'Brand & theme',
    description:
      'Colours, fonts and template. Changes preview live; contrast is checked as you pick.',
    fields: brandFields,
  },
  {
    id: 'content',
    label: 'Content',
    description: 'Tagline, about copy, and which sections show on the guest site.',
    fields: contentFields,
  },
  {
    id: 'contact',
    label: 'Contact',
    description: 'Phone, email and address — also read by invoices and confirmations.',
    fields: contactFields,
  },
  {
    id: 'operations',
    label: 'Operations',
    description: 'Timezone, currency, the night-audit cutoff and online booking.',
    fields: operationsFields,
  },
  {
    id: 'tax',
    label: 'Tax',
    description: 'Company-wide tax configuration the accounting module reads.',
    fields: taxFields,
  },
];
