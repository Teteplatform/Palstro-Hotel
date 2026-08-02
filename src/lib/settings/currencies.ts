import type { SelectOption } from '../../components/ui/form';

// The currency choices for the Operations tab (brief §3).
//
// WHY A LIST AND NOT A FREE-TEXT BOX. properties.currency is the code every
// money figure in the app is formatted with — formatMoney/formatCurrency pass it
// straight to Intl.NumberFormat. A three-letter string that is not a real ISO
// 4217 code makes Intl throw, and our formatters then fall back to "XYZ 45,000"
// on every rate, every folio line, every invoice. The old free-text field's
// /^[A-Za-z]{3}$/ pattern accepted 'ABC' happily. A picker cannot produce one.
//
// RULE 17 CHECK — this is NOT a tenant string. ISO 4217 codes are a public
// standard. No default is imposed here: the property's currency always comes
// from its DB row (properties.currency, whose column default lives in migration
// 001). This file only enumerates which standard codes may be picked.
//
// CURATED. The full ISO list is ~180 codes. Below are the West African
// currencies a Nigerian group actually transacts in plus the major reserve and
// tourist-source currencies. As with timezones, a stored code that is not listed
// is appended as its own option by the settings control rather than silently
// rewritten.
//
// LABEL FORMAT is "CODE — Name" so the code (the thing that is stored, and the
// thing that appears on a bill) reads first.

export const CURRENCY_OPTIONS: SelectOption[] = [
  // --- West and Central Africa ---------------------------------------------
  { value: 'NGN', label: 'NGN — Nigerian Naira' },
  { value: 'GHS', label: 'GHS — Ghanaian Cedi' },
  { value: 'XOF', label: 'XOF — West African CFA Franc' },
  { value: 'XAF', label: 'XAF — Central African CFA Franc' },
  { value: 'SLE', label: 'SLE — Sierra Leonean Leone' },
  { value: 'LRD', label: 'LRD — Liberian Dollar' },
  { value: 'GMD', label: 'GMD — Gambian Dalasi' },
  { value: 'CVE', label: 'CVE — Cape Verdean Escudo' },

  // --- Rest of Africa -------------------------------------------------------
  { value: 'ZAR', label: 'ZAR — South African Rand' },
  { value: 'KES', label: 'KES — Kenyan Shilling' },
  { value: 'UGX', label: 'UGX — Ugandan Shilling' },
  { value: 'TZS', label: 'TZS — Tanzanian Shilling' },
  { value: 'RWF', label: 'RWF — Rwandan Franc' },
  { value: 'ETB', label: 'ETB — Ethiopian Birr' },
  { value: 'EGP', label: 'EGP — Egyptian Pound' },
  { value: 'MAD', label: 'MAD — Moroccan Dirham' },
  { value: 'TND', label: 'TND — Tunisian Dinar' },
  { value: 'DZD', label: 'DZD — Algerian Dinar' },
  { value: 'AOA', label: 'AOA — Angolan Kwanza' },
  { value: 'BWP', label: 'BWP — Botswana Pula' },
  { value: 'NAD', label: 'NAD — Namibian Dollar' },
  { value: 'ZMW', label: 'ZMW — Zambian Kwacha' },
  { value: 'MUR', label: 'MUR — Mauritian Rupee' },

  // --- Major international --------------------------------------------------
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — Pound Sterling' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'SAR', label: 'SAR — Saudi Riyal' },
  { value: 'QAR', label: 'QAR — Qatari Riyal' },
  { value: 'CNY', label: 'CNY — Chinese Yuan' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'SGD', label: 'SGD — Singapore Dollar' },
  { value: 'BRL', label: 'BRL — Brazilian Real' },
];
