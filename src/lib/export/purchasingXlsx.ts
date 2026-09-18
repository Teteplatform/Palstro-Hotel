import { buildSheetXlsx, numberCell, type SheetCell } from './simpleSheet';
import { purchaseStatusLabel } from '../purchasingLabels';
import type { PurchaseOrderSummary, Supplier } from '../../types/purchasing';

// THE PURCHASING EXPORTS (rule 20): every row matching the CURRENT FILTER,
// across all pages — never the twenty rows the user happens to be looking at.
// The caller fetches the filtered set with the same filter builder the list and
// the totals use, so all three describe the same orders.
//
// WHAT THE PURCHASE EXPORT IS FOR: an accountant reconciling supplier invoices
// against what the hotel actually ordered, and a manager chasing a supplier who
// is late. Both need to sort and subtract, so the four money columns and the
// counts are real NUMBERS in the cells rather than formatted text, with the
// property's own currency as a cell FORMAT (rule 17 — the code arrives from the
// database, never a literal).

const ORDER_COLUMNS = [
  { label: 'Order', width: 14 },
  { label: 'Raised', width: 12 },
  { label: 'Expected', width: 12 },
  { label: 'Supplier', width: 30 },
  { label: 'Destination', width: 18 },
  { label: 'Status', width: 16 },
  { label: 'Lines', width: 8 },
  { label: 'Ordered value', width: 16 },
  { label: 'Received value', width: 16 },
  { label: 'Outstanding value', width: 18 },
  { label: 'Deliveries', width: 11 },
  { label: 'Last delivery', width: 14 },
] as const;

export function buildPurchaseOrdersXlsx(
  rows: PurchaseOrderSummary[],
  currency: string,
  issueDate: string,
): Uint8Array {
  const body: SheetCell[][] = rows.map((row) => [
    { kind: 'text', value: row.order_number },
    { kind: 'text', value: row.order_date },
    row.expected_date ? { kind: 'text', value: row.expected_date } : null,
    { kind: 'text', value: row.supplier_name },
    { kind: 'text', value: row.destination_name },
    // The words the screen uses, not the stored value: an export nobody can read
    // beside the screen it came from is two vocabularies for one fact.
    { kind: 'text', value: purchaseStatusLabel(row.status) },
    numberCell(row.line_count, 'quantity'),
    numberCell(row.ordered_value, 'money'),
    numberCell(row.received_value, 'money'),
    numberCell(row.outstanding_value, 'money'),
    numberCell(row.receipt_count, 'quantity'),
    row.last_receipt_date ? { kind: 'text', value: row.last_receipt_date } : null,
  ]);

  return buildSheetXlsx({
    sheetName: 'Purchase orders',
    columns: ORDER_COLUMNS.map((c) => ({ label: c.label, width: c.width })),
    rows: body,
    currency,
    issueDate,
  });
}

// The supplier export is the ADDRESS BOOK, and it deliberately carries the bank
// and tax fields: the commonest reason anyone exports a supplier list is to hand
// it to whoever is setting up payments.
const SUPPLIER_COLUMNS = [
  { label: 'Name', width: 30 },
  { label: 'Code', width: 10 },
  { label: 'Contact', width: 22 },
  { label: 'Phone', width: 16 },
  { label: 'Email', width: 26 },
  { label: 'Address', width: 30 },
  { label: 'TIN', width: 18 },
  { label: 'Withholding %', width: 14 },
  { label: 'Bank', width: 18 },
  { label: 'Account name', width: 26 },
  { label: 'Account number', width: 18 },
  { label: 'In use', width: 9 },
] as const;

export function buildSuppliersXlsx(
  rows: Supplier[],
  currency: string,
  issueDate: string,
): Uint8Array {
  const body: SheetCell[][] = rows.map((row) => [
    { kind: 'text', value: row.name },
    row.code ? { kind: 'text', value: row.code } : null,
    row.contact_name ? { kind: 'text', value: row.contact_name } : null,
    row.phone ? { kind: 'text', value: row.phone } : null,
    row.email ? { kind: 'text', value: row.email } : null,
    row.address ? { kind: 'text', value: row.address } : null,
    row.tax_id ? { kind: 'text', value: row.tax_id } : null,
    numberCell(row.withholding_tax_rate, 'quantity'),
    row.bank_name ? { kind: 'text', value: row.bank_name } : null,
    row.bank_account_name ? { kind: 'text', value: row.bank_account_name } : null,
    // Text, NOT a number: an account number with a leading zero is a different
    // account after a spreadsheet has parsed it, and 0123456789 is a real NUBAN.
    row.bank_account_number
      ? { kind: 'text', value: row.bank_account_number }
      : null,
    // Words rather than TRUE/blank, which reads as a bug.
    row.is_active ? { kind: 'text', value: 'In use' } : { kind: 'text', value: 'Off' },
  ]);

  return buildSheetXlsx({
    sheetName: 'Suppliers',
    columns: SUPPLIER_COLUMNS.map((c) => ({ label: c.label, width: c.width })),
    rows: body,
    currency,
    issueDate,
  });
}
