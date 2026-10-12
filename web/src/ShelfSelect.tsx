import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

export type ShelfSelectOption = { value: string; label: string; disabled?: boolean };
export type ShelfSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: ShelfSelectOption[];
  'aria-label': string;
  className?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  required?: boolean;
  placeholder?: string;
};

// Encode every value, not just the empty option: no business value can collide.
const encodeValue = (value: string) => `shelf-option:${value}`;
const decodeValue = (value: string) => value.slice('shelf-option:'.length);

export default function ShelfSelect({
  value, onValueChange, options, 'aria-label': label, className = '',
  disabled, id, name, required, placeholder,
}: ShelfSelectProps) {
  const lastLabel = useRef<{ value: string; label: string } | null>(null);
  const distinctOptions = useMemo(() => [...new Map(options.map(option => [option.value, option])).values()], [options]);
  const selected = distinctOptions.find(option => option.value === value);
  const selectedLabel = selected?.label ?? (lastLabel.current?.value === value ? lastLabel.current.label : value);
  const hasValue = Boolean(selected) || value !== '' || lastLabel.current?.value === value;
  const renderedOptions = !selected && hasValue
    ? [...distinctOptions, { value, label: selectedLabel, disabled: true }]
    : distinctOptions;
  useEffect(() => {
    if (selected) lastLabel.current = { value, label: selected.label };
  }, [value, selected?.label]);

  return <>
    <Select.Root value={hasValue ? encodeValue(value) : ''} onValueChange={next => onValueChange(decodeValue(next))}
      disabled={disabled} required={required}>
      <Select.Trigger aria-label={label} id={id} data-slot="select-trigger" data-value={value}
        className={`shelf-select-trigger ${className}`}>
        <Select.Value data-slot="select-value" placeholder={placeholder}>
          {hasValue ? selectedLabel : undefined}
        </Select.Value>
        <Select.Icon asChild><ChevronDown aria-hidden="true" className="shelf-select-icon" data-slot="select-icon" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content aria-label={label} className="shelf-select-content" data-slot="select-content"
          position="popper" sideOffset={4} collisionPadding={8}
          onEscapeKeyDown={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
          }}>
          <Select.ScrollUpButton className="shelf-select-scroll-button" data-slot="select-scroll-up-button">
            <ChevronUp aria-hidden="true" />
          </Select.ScrollUpButton>
          <Select.Viewport className="shelf-select-viewport" data-slot="select-viewport">
            {renderedOptions.map(option => <Select.Item key={option.value} value={encodeValue(option.value)}
              disabled={option.disabled} className="shelf-select-item" data-slot="select-item" data-value={option.value}>
              <span className="shelf-select-indicator" data-slot="select-item-indicator">
                <Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator>
              </span>
              <Select.ItemText>{option.label}</Select.ItemText>
            </Select.Item>)}
          </Select.Viewport>
          <Select.ScrollDownButton className="shelf-select-scroll-button" data-slot="select-scroll-down-button">
            <ChevronDown aria-hidden="true" />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
    {/* Radix's form proxy uses encoded values; submit the original business value. */}
    {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
  </>;
}
