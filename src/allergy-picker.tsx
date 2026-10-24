import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { ALLERGENS } from './allergy-catalog';

const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const pendingCustomMessage = 'Choose Add allergy to record this allergy, or cancel the custom entry before saving.';

export function AllergyPicker({ value, onChange, disabled = false, onPendingChange }: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherName, setOtherName] = useState('');
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const selected = new Set(value.map(normalized));
  const words = normalized(query).split(' ').filter(Boolean);
  const matches = ALLERGENS.filter((allergen) => {
    if (selected.has(normalized(allergen.name))) return false;
    const searchable = normalized([allergen.name, allergen.category, ...allergen.aliases].join(' '));
    return words.every((word) => searchable.includes(word));
  });
  // Other remains available even when there are no matches in the entry aid.
  const choices = [...matches, { name: 'Other', category: 'Enter an allergy not listed' }];
  const active = activeIndex < 0 ? -1 : Math.min(activeIndex, choices.length - 1);
  const atLimit = value.length >= 30;
  useEffect(() => {
    onPendingChange?.(otherOpen);
    return () => onPendingChange?.(false);
  }, [otherOpen, onPendingChange]);

  useEffect(() => {
    if (otherOpen) {
      otherRef.current?.setCustomValidity(pendingCustomMessage);
      otherRef.current?.focus();
    }
  }, [otherOpen]);
  useEffect(() => {
    if (!open || active < 0) return;
    optionsRef.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function add(name: string) {
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed || trimmed.length > 100) {
      setError('Enter an allergy name of 1–100 characters.');
      return false;
    }
    const canonical = ALLERGENS.find((allergen) => normalized(allergen.name) === normalized(trimmed))?.name || trimmed;
    if (selected.has(normalized(canonical))) {
      setAnnouncement(`${canonical} is already added.`);
      setError('');
      return true;
    }
    if (atLimit) {
      setError('Up to 30 active allergies can be recorded.');
      return false;
    }
    onChange([...value, canonical]);
    setAnnouncement(`${canonical} added.`);
    setError('');
    return true;
  }

  function choose(index: number) {
    if (disabled || atLimit) return;
    const chosen = choices[index];
    if (!chosen) return;
    setOpen(false);
    if (chosen.name === 'Other') {
      setOtherOpen(true);
      setError('');
      return;
    }
    if (add(chosen.name)) {
      setQuery('');
      setActiveIndex(-1);
      searchRef.current?.focus();
    }
  }

  function addOther() {
    if (disabled || !add(otherName)) {
      otherRef.current?.focus();
      return;
    }
    otherRef.current?.setCustomValidity('');
    setOtherOpen(false);
    setOtherName('');
    setQuery('');
    searchRef.current?.focus();
  }

  function cancelOther() {
    otherRef.current?.setCustomValidity('');
    setOtherOpen(false);
    setError('');
    searchRef.current?.focus();
  }

  function searchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); setActiveIndex(event.key === 'ArrowUp' ? choices.length - 1 : 0); }
      else setActiveIndex((index) => index < 0
        ? event.key === 'ArrowDown' ? 0 : choices.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
    } else if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : choices.length - 1);
    } else if (event.key === 'Enter') {
      // Search text is never silently serialized as an allergy or submitted as a patient.
      event.preventDefault();
      if (open && active >= 0) choose(active);
      else setOpen(true);
    }
  }

  return (
    <div className="allergy-picker span-2" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <label htmlFor={`${id}-search`}>Known allergies</label>
      <p className="allergy-picker-hint" id={`${id}-hint`}>
        Search common medication, food, environmental, or contact allergens. Choose Other for an allergy not listed.
      </p>
      <div className="allergy-picker-search">
        <Search size={16} aria-hidden="true" />
        <input
          id={`${id}-search`}
          ref={searchRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          value={query}
          maxLength={100}
          disabled={disabled || atLimit}
          placeholder="Search allergies…"
          onFocus={() => { if (!atLimit) setOpen(true); }}
          onClick={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(-1); setOpen(true); }}
          onKeyDown={searchKeys}
        />
        <button type="button" aria-label={open ? 'Close allergy choices' : 'Open allergy choices'}
          aria-expanded={open} aria-controls={`${id}-options`} disabled={disabled || atLimit}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else { searchRef.current?.focus(); setOpen(true); }
          }}><ChevronDown size={17} aria-hidden="true" /></button>
      </div>
      {open && <div className="allergy-picker-dropdown">
        {!matches.length && <p className="allergy-picker-hint">No matching catalog choices. Choose Other to enter the allergy.</p>}
        <div id={`${id}-options`} role="listbox" aria-label="Allergy choices" aria-multiselectable="true"
          className="allergy-picker-options" ref={optionsRef}>
          {choices.map((allergen, index) => <button key={allergen.name}
            type="button" role="option" aria-label={allergen.name}
            aria-selected={false} id={`${id}-option-${index}`} tabIndex={-1}
            data-option-index={index} className={`allergy-option ${active === index ? 'active' : ''} ${allergen.name === 'Other' ? 'allergy-option-other' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => choose(index)}>
            <span>{allergen.name}</span><small className="allergy-option-category">{allergen.category}</small>
          </button>)}
        </div>
      </div>}
      {otherOpen && <div className="allergy-other-entry">
        <label htmlFor={`${id}-other`}>Other allergy name</label>
        <input id={`${id}-other`} ref={otherRef} value={otherName} required
          maxLength={100} autoComplete="off" disabled={disabled}
          aria-describedby={`${id}-other-hint`}
          onChange={(event) => { setOtherName(event.target.value); setError(''); event.target.setCustomValidity(pendingCustomMessage); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); addOther(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelOther(); }
          }} />
        <p id={`${id}-other-hint`} className="allergy-picker-hint">Choose Add allergy before saving, or cancel this entry.</p>
        <div className="button-row">
          <button type="button" className="button secondary small" disabled={disabled} onClick={addOther}>Add allergy</button>
          <button type="button" className="text-button" disabled={disabled} onClick={cancelOther}>Cancel other allergy</button>
        </div>
      </div>}
      {value.length ? <ul className="allergy-selected-list" aria-label="Selected allergies">
        {value.map((name, index) => <li key={`${name}-${index}`} className="allergy-selected-chip">
          <span>{name}</span><button type="button" aria-label={`Remove allergy ${name}`} disabled={disabled}
            onClick={() => { onChange(value.filter((_, at) => at !== index)); setAnnouncement(`${name} removed.`); }}>
            <X size={13} aria-hidden="true" /></button>
        </li>)}
      </ul> : <p className="allergy-picker-hint">No allergies recorded</p>}
      {atLimit && <p className="allergy-picker-hint">30 allergies selected. Remove an entry to add another.</p>}
      {error && <p className="form-error allergy-picker-error" role="alert">{error}</p>}
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
