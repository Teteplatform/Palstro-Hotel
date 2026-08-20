// Barrel for the shared form primitives (3.txt §4). Every settings tab, booking
// form, and later module imports fields from here so the set stays consistent.
export { FieldShell, controlClasses, type BaseFieldProps } from './FieldShell';
export { TextField } from './TextField';
export { DateField } from './DateField';
export { TimeField } from './TimeField';
export { TextArea } from './TextArea';
export { NumberField } from './NumberField';
export { CurrencyField } from './CurrencyField';
export { Select, type SelectOption } from './Select';
// The searchable picker (rule 26). Reach for it over Select whenever the option
// list can outgrow about twenty rows — see its header for why a client-side
// filter is not a smaller version of this.
export {
  Typeahead,
  type TypeaheadOption,
  type TypeaheadResult,
} from './Typeahead';
export { Toggle } from './Toggle';
export { ColorField } from './ColorField';
export { StringListField } from './StringListField';
