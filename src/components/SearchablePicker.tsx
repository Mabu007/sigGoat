/**
 * SEARCHABLE PICKER
 * =================
 * A filterable dropdown for lists too long to sit in a native `<select>` --
 * the skill catalogue and the per-venue asset lists are both hundreds of
 * entries, and a native select gives the user no way to find "EUR" among them.
 *
 * LIFTED FROM AN EXISTING PATTERN, WITH THE MISSING PARTS ADDED
 *   `ModelPicker.tsx` already had the filter-then-list idea, but as an always
 *   visible inline listbox. This is the floating form, so it also needs the
 *   three things the codebase had no pattern for at all: combobox ARIA wiring,
 *   outside-click dismissal, and roving keyboard focus.
 *
 * Deliberately NOT used where a short fixed list will do. A native `<select>`
 * is still the better control for 3-6 options; this earns its complexity only
 * when the list is genuinely long.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface PickerOption {
  value: string;
  label: string;
  /** Secondary line, e.g. an asset's display name or a skill's category. */
  hint?: string;
  disabled?: boolean;
  /** Group heading; options are rendered in the order supplied. */
  group?: string;
}

interface SearchablePickerProps {
  options: PickerOption[];
  /** Selected values. Always an array; length decides single vs multiple. */
  value: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

export function SearchablePicker({
  options,
  value,
  onChange,
  multiple = false,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: SearchablePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listId = `${triggerId}-list`;

  const selected = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(option =>
      `${option.value} ${option.label} ${option.hint ?? ''}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  const selectedOptions = useMemo(
    () => value.map(id => options.find(option => option.value === id)).filter(Boolean) as PickerOption[],
    [value, options],
  );

  // Open -> focus the filter so typing filters immediately.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // The panel animates in on the next frame; focus must wait for it.
      const frame = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);

  // Outside click closes. A mousedown on the trigger is excluded because the
  // trigger's own onClick already toggles, and handling both double-fires.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Keep the highlighted row inside the scroll viewport on arrow navigation.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const commit = (option: PickerOption) => {
    if (option.disabled) return;
    if (multiple) {
      onChange(selected.has(option.value) ? value.filter(v => v !== option.value) : [...value, option.value]);
      setActiveIndex(Math.max(0, filtered.findIndex(o => o.value === option.value)));
      searchRef.current?.focus();
      return;
    }
    onChange([option.value]);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(previous => {
        if (!filtered.length) return 0;
        return (previous + step + filtered.length) % filtered.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) commit(option);
    }
  };

  const triggerLabel = selectedOptions.length
    ? multiple
      ? selectedOptions.map(option => option.label).join(', ')
      : selectedOptions[0].label
    : placeholder;

  let lastGroup: string | undefined;

  return (
    <div ref={containerRef} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        id={triggerId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen(previous => !previous)}
        className="input flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className={`truncate ${selectedOptions.length ? 'text-fg' : 'text-fg-subtle'}`}>{triggerLabel}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-subtle" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="relative border-b border-line">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              className="w-full !border-0 !rounded-none !py-2 !pl-7 !text-xs outline-none focus:!shadow-none"
            />
          </div>

          <div ref={listRef} role="listbox" id={listId} aria-multiselectable={multiple || undefined} className="max-h-56 overflow-y-auto">
            {filtered.length ? filtered.map((option, index) => {
              const isSelected = selected.has(option.value);
              const showGroup = option.group && option.group !== lastGroup;
              lastGroup = option.group;
              return (
                <div key={option.value}>
                  {showGroup && (
                    <p className="px-2.5 pt-2 text-[9px] font-semibold uppercase tracking-wide text-fg-subtle">{option.group}</p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    data-active={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(option)}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors disabled:opacity-40 ${
                      index === activeIndex ? 'bg-raised' : ''
                    }`}
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isSelected ? 'border-accent bg-accent text-white' : 'border-line'}`}>
                      {isSelected && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-fg">{option.label}</span>
                      {option.hint && <span className="block truncate text-[10px] text-fg-subtle">{option.hint}</span>}
                    </span>
                    {option.value && multiple === false && <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{option.value}</span>}
                  </button>
                </div>
              );
            }) : (
              <p className="px-2.5 py-3 text-[11px] text-fg-subtle">Nothing matches “{query.trim()}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}