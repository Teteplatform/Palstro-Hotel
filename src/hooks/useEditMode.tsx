import { createContext, useContext } from 'react';

// The single seam between the guest site and the inline visual editor (3.txt §
// "The rule that makes or breaks this build"). There is ONE landing page and ONE
// set of guest components; they are never forked into an editable copy. Instead
// they read this context: with `isEditing` false — which is ALWAYS the case on
// the public site, where no provider mounts — the `Editable` wrapper renders its
// children and nothing else (zero markup, zero listeners, zero cost). Only inside
// the admin Site editor does a provider flip `isEditing` true and supply
// `openEditor`.

export interface EditModeValue {
  // True only inside the admin Site editor. The default (no provider) is false,
  // so the public guest site is untouched.
  isEditing: boolean;
  // Open the side panel to edit the given SCHEMA FIELD KEYS (looked up in the
  // existing settings schema — the editor never defines its own field rendering),
  // titled `label`.
  openEditor: (fieldKeys: string[], label: string) => void;
}

// The default is a frozen, side-effect-free value. Because the guest site mounts
// no provider, every guest component that calls useEditMode() gets exactly this:
// isEditing false and a no-op opener. Nothing fetches, nothing renders extra.
const DEFAULT: EditModeValue = {
  isEditing: false,
  openEditor: () => {},
};

export const EditModeContext = createContext<EditModeValue>(DEFAULT);

export function useEditMode(): EditModeValue {
  return useContext(EditModeContext);
}
