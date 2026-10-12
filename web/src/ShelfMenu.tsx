import * as Context from '@radix-ui/react-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { Position } from './types';

// ContextMenu in the desktop uses this Radix Menu engine and a virtual point
// anchor. The controlled adapter also serves the browser's touch/ellipsis menu.
function ContextContent({ className = '', ...props }: ComponentProps<typeof Context.Content>) {
  return <Context.Portal><Context.Content {...props} collisionPadding={8} className={`shelf-menu ${className}`} onPointerUpCapture={event => {
    props.onPointerUpCapture?.(event);
    // A right-click can open the popup before release; never select on release.
    if (event.button !== 0) event.stopPropagation();
  }} onKeyDown={event => {
    props.onKeyDown?.(event);
    if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
  }} /></Context.Portal>;
}
function ContextSubContent({ className = '', ...props }: ComponentProps<typeof Context.SubContent>) {
  return <Context.Portal><Context.SubContent {...props} sideOffset={4} collisionPadding={8} className={`shelf-menu ${className}`} onPointerUpCapture={event => {
    props.onPointerUpCapture?.(event);
    if (event.button !== 0) event.stopPropagation();
  }} onKeyDown={event => {
    props.onKeyDown?.(event);
    if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
  }} /></Context.Portal>;
}
function ContextItem({ className = '', ...props }: ComponentProps<typeof Context.Item>) {
  return <Context.Item {...props} className={`shelf-menu-item ${className}`} />;
}
function ContextRadioItem({ children, ...props }: ComponentProps<typeof Context.RadioItem>) {
  return <Context.RadioItem {...props} className="shelf-menu-item shelf-menu-choice"><span className="shelf-menu-indicator"><Context.ItemIndicator><Check /></Context.ItemIndicator></span>{children}</Context.RadioItem>;
}
function ContextCheckboxItem({ children, icon, ...props }: ComponentProps<typeof Context.CheckboxItem> & { icon?: ReactNode }) {
  return <Context.CheckboxItem {...props} className="shelf-menu-item shelf-menu-choice"><span className="shelf-menu-indicator"><Context.ItemIndicator><Check /></Context.ItemIndicator>{!props.checked && icon}</span>{children}</Context.CheckboxItem>;
}
function ContextSubTrigger({ children, ...props }: ComponentProps<typeof Context.SubTrigger>) {
  return <Context.SubTrigger {...props} className="shelf-menu-item shelf-menu-sub-trigger">{children}<ChevronRight className="shelf-menu-chevron" /></Context.SubTrigger>;
}
function ContextLabel(props: ComponentProps<typeof Context.Label>) { return <Context.Label {...props} className="shelf-menu-label" />; }
function ContextSeparator(props: ComponentProps<typeof Context.Separator>) { return <Context.Separator {...props} className="shelf-menu-separator" />; }
function ContextSub(props: ComponentProps<typeof Context.Sub>) {
  // The low-level Menu engine, unlike ContextMenu.Sub, is controlled-only.
  const [open, setOpen] = useState(false);
  return <Context.Sub {...props} open={props.open ?? open} onOpenChange={next => { setOpen(next); props.onOpenChange?.(next); }} />;
}
export const ContextMenu = { ...Context, Content: ContextContent, Sub: ContextSub, SubContent: ContextSubContent, Item: ContextItem, RadioItem: ContextRadioItem, CheckboxItem: ContextCheckboxItem, SubTrigger: ContextSubTrigger, Label: ContextLabel, Separator: ContextSeparator };

export function PositionedMenu({ position, label, onClose, children }: { position: Position; label: string; onClose: () => void; children: ReactNode }) {
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const interactedOutside = useRef(false);
  // Narrow viewports need space for both levels; keep the cascade on-screen.
  const anchorX = window.innerWidth <= 420 ? position.x > window.innerWidth / 2 ? window.innerWidth - 8 : 8 : position.x;
  const virtualRef = useMemo(() => ({ current: { getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: anchorX, y: position.y }) } }), [anchorX, position.y]);
  return <ContextMenu.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <ContextMenu.Anchor virtualRef={virtualRef} />
    <ContextMenu.Content aria-label={label} side="right" align="start" sideOffset={2} onContextMenu={event => event.preventDefault()} onPointerDown={event => event.stopPropagation()} onInteractOutside={() => { interactedOutside.current = true; }} onCloseAutoFocus={event => {
      event.preventDefault();
      // FocusScope restores asynchronously; a newly opened menu/dialog wins.
      const nextOverlay = document.querySelector('[role="menu"][data-state="open"], [role="dialog"][aria-modal="true"]');
      if (!interactedOutside.current && !nextOverlay && previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    }}>{children}</ContextMenu.Content>
  </ContextMenu.Root>;
}

function DropdownContent({ className = '', ...props }: ComponentProps<typeof Dropdown.Content>) {
  return <Dropdown.Portal><Dropdown.Content {...props} align="end" sideOffset={5} collisionPadding={8} className={`shelf-menu ${className}`} onCloseAutoFocus={event => {
    props.onCloseAutoFocus?.(event);
    // A rapid right-click may open a new overlay before this FocusScope closes.
    if (document.querySelector('[role="menu"][data-state="open"], [role="dialog"][aria-modal="true"]')) event.preventDefault();
  }} onKeyDown={event => {
    props.onKeyDown?.(event);
    if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
  }} /></Dropdown.Portal>;
}
function DropdownRadioItem({ children, ...props }: ComponentProps<typeof Dropdown.RadioItem>) {
  return <Dropdown.RadioItem {...props} className="shelf-menu-item shelf-menu-choice"><span className="shelf-menu-indicator"><Dropdown.ItemIndicator><Check /></Dropdown.ItemIndicator></span>{children}</Dropdown.RadioItem>;
}
function DropdownCheckboxItem({ children, ...props }: ComponentProps<typeof Dropdown.CheckboxItem>) {
  return <Dropdown.CheckboxItem {...props} className="shelf-menu-item shelf-menu-choice"><span className="shelf-menu-indicator"><Dropdown.ItemIndicator><Check /></Dropdown.ItemIndicator></span>{children}</Dropdown.CheckboxItem>;
}
function DropdownItem(props: ComponentProps<typeof Dropdown.Item>) { return <Dropdown.Item {...props} className="shelf-menu-item" />; }
function DropdownLabel(props: ComponentProps<typeof Dropdown.Label>) { return <Dropdown.Label {...props} className="shelf-menu-label" />; }
function DropdownSeparator(props: ComponentProps<typeof Dropdown.Separator>) { return <Dropdown.Separator {...props} className="shelf-menu-separator" />; }
export const DropdownMenu = { ...Dropdown, Content: DropdownContent, RadioItem: DropdownRadioItem, CheckboxItem: DropdownCheckboxItem, Item: DropdownItem, Label: DropdownLabel, Separator: DropdownSeparator };
