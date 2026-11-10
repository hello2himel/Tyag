/**
 * deUrge shared UI components.
 * Visual language comes from the supplied UI/UX skeleton: iOS-like surfaces,
 * system fonts, tabular numerals, bottom sheets on mobile and dialogs on
 * desktop, and a green/amber/purple accent vocabulary (abstinence/lapse/urge).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { curves, durations, haptic, project, reducedMotion, rubberBand } from './motion';
import type { StreakInterval } from '@deurge/core';

/* --------------------------------- icons --------------------------------- */

export type IconName =
  | 'clock'
  | 'journal'
  | 'insights'
  | 'settings'
  | 'plus'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'close'
  | 'edit'
  | 'pause'
  | 'play'
  | 'archive'
  | 'trash'
  | 'download'
  | 'upload'
  | 'lock'
  | 'shield'
  | 'bell'
  | 'search'
  | 'filter'
  | 'calendar'
  | 'alert'
  | 'data'
  | 'key'
  | 'refresh'
  | 'info'
  | 'list'
  | 'sparkle';

const ICON_PATHS: Record<IconName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  journal: <path d="M6 4h12v16H6zM9 8.5h6M9 12h6M9 15.5h4" />,
  insights: <path d="M5 20V10M12 20V4M19 20v-7" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-left': <path d="M15 18l-6-6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  check: <path d="M20 6L9 17l-5-5" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M8 5v14l11-7z" />,
  archive: <path d="M4 8h16v12H4zM4 8l1.5-4h13L20 8M9.5 12h5" />,
  trash: <path d="M4 6h16M9 6V4h6v2M6.5 6l1 14h9l1-14" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  upload: <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  shield: <path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z" />,
  bell: <path d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4z" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 11h18" />
    </>
  ),
  alert: <path d="M12 3l10 18H2zM12 9v5M12 17.5h.01" />,
  data: <path d="M6 2h8l6 6v14H6zM14 2v6h6M9 13h8M9 17h8" />,
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4" />
      <path d="M11 13l8-8M17 3l3 3-2 2-3-3" />
    </>
  ),
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  sparkle: <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />,
};

export function Icon({
  name,
  size = 24,
  className,
  strokeWidth = 1.7,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* -------------------------------- buttons -------------------------------- */

type ButtonVariant = 'secondary' | 'primary' | 'plain' | 'danger';

export function Button({
  variant = 'secondary',
  size,
  block,
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm';
  block?: boolean;
  icon?: IconName;
}) {
  const classes = [
    'btn',
    variant === 'primary' ? 'btn-primary' : '',
    variant === 'danger' ? 'btn-danger' : '',
    variant === 'plain' ? 'btn-plain' : '',
    size === 'sm' ? 'btn-sm' : '',
    block ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} {...rest}>
      {icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={22} />
    </button>
  );
}

/* --------------------------------- cards --------------------------------- */

export function Card({
  className = '',
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

/* ------------------------------ segmented -------------------------------- */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={`seg ${className}`} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'on' : ''}
          onClick={() => { haptic('selection'); onChange(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  selected,
  onClick,
  children,
  title,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`chip ${selected ? 'on' : ''}`}
      aria-pressed={selected ?? false}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

/* ------------------------------- lists ----------------------------------- */

export function ListGroup({
  children,
  className = '',
  role,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  role?: string;
  'aria-label'?: string;
}) {
  return (
    <div className={`group ${className}`} role={role} aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function ListRow({
  label,
  value,
  onClick,
  chevron,
  selected,
  trailing,
  className = '',
}: {
  label: ReactNode;
  value?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  selected?: boolean;
  trailing?: ReactNode;
  className?: string;
}) {
  const content = (
    <>
      <span>{label}</span>
      <span className="value">
        {value}
        {trailing}
        {chevron ? <Icon name="chevron-right" size={16} /> : null}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`list-row selectable ${className}`}
        onClick={onClick}
        aria-pressed={selected}
      >
        {content}
      </button>
    );
  }
  return <div className={`list-row ${className}`}>{content}</div>;
}

/* -------------------------------- toggles -------------------------------- */

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => { haptic('selection'); onChange(!checked); }}
    >
      <span>
        <span style={{ display: 'block' }}>{label}</span>
        {description ? (
          <span className="tiny" style={{ display: 'block', marginTop: 2 }}>
            {description}
          </span>
        ) : null}
      </span>
      <span className={`switch ${checked ? 'on' : ''}`} />
    </button>
  );
}

/* -------------------------------- fields --------------------------------- */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      {label ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
}

/* ------------------------------- overlays -------------------------------- */

function useOverlayBehaviour(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);
}

export function Sheet({
  open,
  onClose,
  title,
  left,
  right,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}) {
  useOverlayBehaviour(open, onClose);
  const titleId = useId();
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, pointerId: 0, startY: 0, lastY: 0, lastT: 0, dy: 0, velocity: 0 });
  const animations = useRef<Animation[]>([]);
  const closing = useRef(false);

  function cancelAnimations(): void {
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
  }

  function animateIn(): void {
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (!panel || !backdrop) return;
    cancelAnimations();
    closing.current = false;
    panel.style.transform = '';
    if (reducedMotion()) {
      panel.style.opacity = '1';
      backdrop.style.opacity = '0.4';
      return;
    }
    const desktop = window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 700;
    animations.current.push(
      panel.animate(
        desktop
          ? [{ transform: 'translateY(-24px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }]
          : [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
        { duration: desktop ? 300 : durations.sheet, easing: desktop ? curves.easeOut : curves.sheet, fill: 'both' },
      ),
      backdrop.animate([{ opacity: 0 }, { opacity: 0.4 }], {
        duration: desktop ? 300 : durations.sheet,
        easing: curves.easeOut,
        fill: 'both',
      }),
    );
  }

  function animateOut(after?: () => void): void {
    if (closing.current) return;
    closing.current = true;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (!panel || !backdrop || reducedMotion()) {
      setMounted(false);
      after?.();
      return;
    }
    cancelAnimations();
    const desktop = window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 700;
    animations.current.push(
      panel.animate(
        desktop
          ? [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-24px)', opacity: 0 }]
          : [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }],
        { duration: desktop ? 200 : durations.standard, easing: curves.easeIn, fill: 'both' },
      ),
      backdrop.animate([{ opacity: 0.4 }, { opacity: 0 }], {
        duration: desktop ? 200 : durations.standard,
        easing: curves.easeIn,
        fill: 'both',
      }),
    );
    window.setTimeout(() => {
      setMounted(false);
      after?.();
    }, desktop ? 210 : durations.standard + 10);
  }

  useEffect(() => {
    if (open) {
      closing.current = false;
      setMounted(true);
    } else if (mounted) {
      animateOut();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!mounted || !open) return;
    panelRef.current?.style.setProperty('opacity', '0');
    const frame = requestAnimationFrame(() => animateIn());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, open]);

  useEffect(
    () => () => {
      cancelAnimations();
    },
    [],
  );

  if (!mounted) return null;

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.sheet-grip, .sheet-head')) return;
    if (target.closest('button, input, textarea, a')) return;
    const panel = panelRef.current;
    if (!panel) return;
    cancelAnimations();
    panel.style.transform = '';
    drag.current = {
      active: true,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastT: performance.now(),
      dy: 0,
      velocity: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!drag.current.active) return;
    const panel = panelRef.current;
    if (!panel) return;
    const height = panel.offsetHeight;
    const raw = event.clientY - drag.current.startY;
    const dy = raw > 0 ? raw : rubberBand(raw, height);
    drag.current.dy = raw;
    const now = performance.now();
    drag.current.velocity = ((event.clientY - drag.current.lastY) / Math.max(now - drag.current.lastT, 1)) * 1000;
    drag.current.lastY = event.clientY;
    drag.current.lastT = now;
    panel.style.transform = `translateY(${dy}px)`;
    if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0, 0.4 * (1 - dy / height)));
  }

  function onPointerUp(): void {
    if (!drag.current.active) return;
    drag.current.active = false;
    const panel = panelRef.current;
    if (!panel) return;
    const height = panel.offsetHeight;
    const projected = drag.current.dy + project(drag.current.velocity);
    if (projected > height * 0.5 || drag.current.velocity > 1000) {
      animateOut(() => onClose());
    } else {
      const from = drag.current.dy;
      const animation = panel.animate(
        [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
        { duration: durations.sheet, easing: curves.sheet, fill: 'both' },
      );
      animations.current.push(animation);
      if (backdropRef.current) {
        animations.current.push(
          backdropRef.current.animate([{ opacity: backdropRef.current.style.opacity || '0.4' }, { opacity: 0.4 }], {
            duration: durations.sheet,
            easing: curves.sheet,
            fill: 'both',
          }),
        );
      }
      panel.style.transform = '';
    }
  }

  function dismiss(): void {
    animateOut(() => onClose());
  }

  return createPortal(
    <div
      className="sheet-backdrop"
      role="presentation"
      ref={backdropRef}
      style={{ opacity: 0 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        ref={panelRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <span>{left}</span>
          {title ? (
            <span className="sheet-title" id={titleId}>
              {title}
            </span>
          ) : null}
          <span>{right}</span>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  role = 'dialog',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: 'dialog' | 'alertdialog';
}) {
  useOverlayBehaviour(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role={role} aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-title" id={titleId}>
          {title}
        </div>
        <div className="modal-body">{children}</div>
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  requirePhrase,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  requirePhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [phrase, setPhrase] = useState('');
  useEffect(() => {
    if (!open) setPhrase('');
  }, [open]);
  const canConfirm = !requirePhrase || phrase.trim().toLowerCase() === requirePhrase.toLowerCase();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      role="alertdialog"
      actions={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} disabled={!canConfirm} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{body}</div>
      {requirePhrase ? (
        <div style={{ marginTop: 14 }}>
          <Field label={`Type "${requirePhrase}" to confirm`}>
            <Input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              autoComplete="off"
              aria-label={`Type ${requirePhrase} to confirm`}
            />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------ empty state ------------------------------ */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

/* -------------------------------- stats ---------------------------------- */

export function StatTile({
  label,
  value,
  hint,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`stat-tile ${className}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="tiny">{hint}</div> : null}
    </div>
  );
}

/* -------------------------------- charts --------------------------------- */

export interface BarDatum {
  label: string;
  value: number;
  displayValue?: string;
}

export function BarChart({
  data,
  tone = 'lapse',
  max,
  ariaLabel,
  emptyText = 'No data recorded for this period yet.',
  height,
}: {
  data: BarDatum[];
  tone?: 'lapse' | 'urge' | 'abstinence';
  max?: number;
  ariaLabel: string;
  emptyText?: string;
  height?: number;
}) {
  const hasData = data.some((datum) => datum.value > 0);
  if (data.length === 0) return <div className="chart-empty">{emptyText}</div>;
  const ceiling = Math.max(max ?? 0, ...data.map((datum) => datum.value), 1);
  return (
    <div className="bars" style={height ? { height } : undefined} role="img" aria-label={ariaLabel}>
      {data.map((datum, index) => (
        <div className="bar-col" key={`${datum.label}-${index}`} title={`${datum.label}: ${datum.displayValue ?? datum.value}`}>
          <div className="bar-track">
            <div
              className={`bar ${tone === 'urge' ? 'urge' : tone === 'lapse' ? 'lapse' : ''}`}
              style={{ height: hasData ? `${Math.max((datum.value / ceiling) * 100, datum.value > 0 ? 4 : 0)}%` : '0%' }}
            />
          </div>
          <div className="bar-label">{datum.label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The horizontal streak history bar from the design: past abstinence periods
 * in faded green, the current period in solid green, and thin amber lapse
 * markers between them. The bar is proportional to active time (paused time is
 * excluded from both the segments and the gaps, matching the calculation
 * engine).
 */
export function StreakBar({
  intervals,
  className = '',
  ariaLabel = 'Abstinence periods, oldest first',
}: {
  intervals: StreakInterval[];
  className?: string;
  ariaLabel?: string;
}) {
  if (intervals.length === 0) return null;
  const segments = intervals.flatMap((interval, index) => {
    const mark = index > 0 ? [{ kind: 'lapse' as const, weight: 1 }] : [];
    return [...mark, { kind: interval.isCurrent ? ('current' as const) : ('past' as const), weight: Math.max(interval.activeMs, 1) }];
  });
  const total = segments.reduce((sum, segment) => sum + segment.weight, 0);
  const visible = segments.length > 60 ? segments.slice(-60) : segments;
  return (
    <div className={`streakbar ${className}`} role="img" aria-label={ariaLabel}>
      {visible.map((segment, index) => (
        <i
          key={index}
          className={segment.kind === 'lapse' ? 'lapse-mark' : segment.kind}
          style={segment.kind === 'lapse' ? undefined : { flex: Math.max((segment.weight / total) * 1000, 2) }}
        />
      ))}
    </div>
  );
}

/* --------------------------------- toast --------------------------------- */

type ToastTone = 'default' | 'error';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}
interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
  error: (message: string) => void;
}
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const show = useCallback((message: string, tone: ToastTone = 'default') => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);
  const value = useMemo<ToastContextValue>(
    () => ({ show, error: (message: string) => show(message, 'error') }),
    [show],
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0
        ? createPortal(
            <div className="toast-wrap" aria-live="polite" aria-atomic="false">
              {toasts.map((toast) => (
                <div key={toast.id} className={`toast ${toast.tone === 'error' ? 'error' : ''}`}>
                  {toast.message}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}

/* ------------------------------- utilities ------------------------------- */

export function formatRelativeDay(epochMs: number, nowMs: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(epochMs),
  );
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(nowMs),
  );
  if (day === today) return 'Today';
  return day;
}
