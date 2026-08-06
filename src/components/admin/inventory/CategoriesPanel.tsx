import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, PlusIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import {
  createCategory,
  softDeleteCategory,
  updateCategory,
} from '../../../lib/inventory';
import type { InventoryCategory } from '../../../types/inventory';

// Manage the tenant's item categories, inline on the items screen rather than as
// a separate route. Categories only exist to group items, so managing them where
// the items are is the shortest path between noticing a missing category and
// having one — a separate screen would mean losing the item you were filing.
//
// Collapsed by default: it is setup work done rarely, and it must not compete
// with the catalogue itself for attention.
//
// Every write is awaited in try/catch and surfaced (rule 11); the DB's admin
// policies are the real guard (rule 19). Removal is a soft delete — items filed
// under a removed category keep their category_id and simply read as
// uncategorised, because the FK is deliberately NO ACTION (035 §3).

interface CategoriesPanelProps {
  tenantId: string;
  categories: InventoryCategory[];
  // Re-pulls the reference data so the item form's picker and the filter bar
  // stay in step with what was just changed here.
  onChanged: () => void;
  // On its own TAB there is nothing to compete with, so the collapse is noise:
  // the panel opens straight into the list. Inline beside a catalogue it stays
  // collapsed by default, which is what the prop defaults to.
  alwaysOpen?: boolean;
}

export function CategoriesPanel({
  tenantId,
  categories,
  onChanged,
  alwaysOpen = false,
}: CategoriesPanelProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(alwaysOpen);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');

  async function run(work: () => Promise<void>, success?: string) {
    setBusy(true);
    try {
      await work();
      if (success) toast.success(success);
      onChanged();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) {
      toast.error('A category name is required.');
      return;
    }
    await run(async () => {
      // Append: the next multiple of ten past the last one, so a later manual
      // re-ordering has room between entries.
      const nextOrder =
        categories.reduce((max, c) => Math.max(max, c.display_order), 0) + 10;
      await createCategory(tenantId, { name, display_order: nextOrder });
      setNewName('');
    }, 'Category added.');
  }

  async function handleRename(category: InventoryCategory, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === category.name) return;
    await run(
      () => updateCategory(category.id, tenantId, { name: trimmed }).then(() => undefined),
      'Category renamed.',
    );
  }

  async function handleToggleActive(category: InventoryCategory) {
    await run(() =>
      updateCategory(category.id, tenantId, {
        is_active: !category.is_active,
      }).then(() => undefined),
    );
  }

  async function handleMove(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= categories.length) return;
    const a = categories[index];
    const b = categories[j];
    // Swap their display_order values outright. The list is complete (not
    // paged), so index arithmetic here is over the whole set and cannot skip a
    // row that lives on another page.
    await run(async () => {
      await updateCategory(a.id, tenantId, { display_order: b.display_order });
      await updateCategory(b.id, tenantId, { display_order: a.display_order });
    });
  }

  async function handleRemove(category: InventoryCategory) {
    if (
      !window.confirm(
        `Remove the category "${category.name}"? Items filed under it are kept and simply become uncategorised.`,
      )
    ) {
      return;
    }
    await run(
      () => softDeleteCategory(category.id, tenantId),
      'Category removed.',
    );
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60">
      {alwaysOpen ? (
        <div className="p-4 pb-0">
          <p className="text-sm font-semibold text-charcoal">Categories</p>
          <p className="text-xs text-charcoal-muted">
            {categories.length === 0
              ? 'None yet — add the groups you want your reports broken down by.'
              : `${categories.length} ${categories.length === 1 ? 'category' : 'categories'} · how your stock reports are grouped`}
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-3 rounded-2xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <ChevronDownIcon
            className={`h-5 w-5 shrink-0 text-charcoal-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-charcoal">
              Categories
            </span>
            <span className="block text-xs text-charcoal-muted">
              {categories.length === 0
                ? 'None yet — add the groups you want your reports broken down by.'
                : `${categories.length} ${categories.length === 1 ? 'category' : 'categories'} · how your stock reports are grouped`}
            </span>
          </span>
        </button>
      )}

      {expanded ? (
        <div className={alwaysOpen ? 'p-4' : 'border-t border-sand-border p-4'}>
          <ul className="space-y-2">
            {categories.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                busy={busy}
                isFirst={index === 0}
                isLast={index === categories.length - 1}
                onRename={(name) => void handleRename(category, name)}
                onMove={(dir) => void handleMove(index, dir)}
                onToggleActive={() => void handleToggleActive(category)}
                onRemove={() => void handleRemove(category)}
              />
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[10rem] flex-1">
              <span className="mb-1 block text-sm font-medium text-charcoal">
                New category
              </span>
              <input
                type="text"
                value={newName}
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAdd();
                  }
                }}
                placeholder="e.g. Drinks"
                className="w-full rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              <PlusIcon className="h-4 w-4" />
              Add
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// One category as an editable row. The name is a CONTROLLED draft re-seeded
// whenever the row changes from outside (the adjust-state-on-prop-change
// pattern), so a rename that the server rejects snaps back to the truth instead
// of leaving the screen showing a name the database never accepted.
function CategoryRow({
  category,
  busy,
  isFirst,
  isLast,
  onRename,
  onMove,
  onToggleActive,
  onRemove,
}: {
  category: InventoryCategory;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onRename: (name: string) => void;
  onMove: (dir: -1 | 1) => void;
  onToggleActive: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(category.name);
  const [lastName, setLastName] = useState(category.name);
  if (category.name !== lastName) {
    setLastName(category.name);
    setDraft(category.name);
  }

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === category.name) {
      setDraft(category.name); // snap back; an empty rename is not a rename
      return;
    }
    onRename(trimmed);
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-xl border border-sand-border bg-white/70 p-2">
      <input
        type="text"
        value={draft}
        disabled={busy}
        aria-label={`Category name: ${category.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 rounded-lg border border-sand-border bg-white/70 px-3 py-1.5 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
      />

      <div className="flex items-center gap-1">
        <IconButton
          label={`Move ${category.name} up`}
          onClick={() => onMove(-1)}
          disabled={busy || isFirst}
        >
          <ArrowUpIcon className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={`Move ${category.name} down`}
          onClick={() => onMove(1)}
          disabled={busy || isLast}
        >
          <ArrowDownIcon className="h-4 w-4" />
        </IconButton>
      </div>

      <button
        type="button"
        onClick={onToggleActive}
        disabled={busy}
        className="rounded-lg border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
      >
        {category.is_active ? 'In use' : 'Not in use'}
      </button>

      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        className="rounded-lg px-2 py-1.5 text-xs font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
      >
        Remove
      </button>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-sand-border bg-white/70 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
