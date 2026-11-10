/**
 * Central motion system (see docs/MOTION.md).
 *
 * Every duration, curve and spring in the UI must come from here. The CSS
 * custom properties mirror these values for stylesheet-driven motion; the
 * spring simulator is used where a gesture must stay interruptible.
 */

export type SpringName = 'smooth' | 'snappy' | 'quick';

export const springs: Record<SpringName, { duration: number; bounce: number }> = {
  smooth: { duration: 0.5, bounce: 0 },
  snappy: { duration: 0.5, bounce: 0.15 },
  quick: { duration: 0.3, bounce: 0 },
};

export const curves = {
  easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
  easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
  sheet: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

export const durations = {
  instant: 0,
  fast: 150,
  standard: 250,
  slow: 350,
  sheet: 500,
  unlock: 400,
} as const;

/** Projection formula from Apple's fluid-interface guidance. */
export function project(velocity: number, rate = 0.998): number {
  return (velocity / 1000) * (rate / (1 - rate));
}

/** Rubber-band an overscroll past an edge. */
export function rubberBand(offset: number, size: number, coefficient = 0.55): number {
  if (size <= 0) return 0;
  const x = Math.abs(offset);
  const damped = (1 - 1 / ((x * coefficient) / size + 1)) * size;
  return Math.sign(offset) * damped;
}

export function reducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface SpringHandle {
  /** Stop without completing. */
  cancel: () => void;
  /** Continue to a new target, preserving the current position and velocity. */
  retarget: (to: number, velocity?: number) => void;
}

export interface SpringOptions {
  from: number;
  to: number;
  velocity?: number;
  preset?: SpringName;
  onUpdate: (value: number, velocity: number) => void;
  onDone?: () => void;
  /** Set false for motion that is already a reduced-motion cross-fade. */
  respectReducedMotion?: boolean;
}

/**
 * Interruptible spring integrator (mass = 1) using Apple's duration/bounce
 * parameterisation. The returned handle can be retargeted without restarting.
 */
export function spring(options: SpringOptions): SpringHandle {
  const { preset = 'smooth', onUpdate, onDone, respectReducedMotion = true } = options;
  if (respectReducedMotion && reducedMotion()) {
    onUpdate(options.to, 0);
    onDone?.();
    return { cancel: () => undefined, retarget: () => undefined };
  }

  const { duration, bounce } = springs[preset];
  const stiffness = (2 * Math.PI / duration) ** 2;
  const dampingRatio = 1 - bounce;
  const damping = 2 * dampingRatio * Math.sqrt(stiffness);

  let target = options.to;
  let position = options.from;
  let velocity = options.velocity ?? 0;
  let raf = 0;
  let last = performance.now();
  let cancelled = false;
  const maxMs = Math.max(duration * 2000, 800);

  function tick(now: number): void {
    if (cancelled) return;
    const stepMs = Math.min(now - last, 32);
    last = now;
    const dt = stepMs / 1000;
    const acceleration = -stiffness * (position - target) - damping * velocity;
    velocity += acceleration * dt;
    position += velocity * dt;
    onUpdate(position, velocity);
    const settled = Math.abs(position - target) < 0.001 && Math.abs(velocity) < 0.01;
    if (settled || now - (last - stepMs) > maxMs) {
      onUpdate(target, 0);
      onDone?.();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  raf = requestAnimationFrame((now) => {
    last = now;
    raf = requestAnimationFrame(tick);
  });

  return {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
    retarget(to: number, nextVelocity = velocity) {
      target = to;
      velocity = nextVelocity;
    },
  };
}

/** A short, optional native-feeling haptic. No-op on desktop/browsers without it. */
export function haptic(kind: 'selection' | 'impact' | 'error' | 'none' = 'selection'): void {
  if (kind === 'none' || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const patterns: Record<Exclude<typeof kind, 'none'>, number | number[]> = {
    selection: 8,
    impact: 14,
    error: [30, 40, 30],
  };
  try {
    navigator.vibrate(patterns[kind]);
  } catch {
    /* haptics are best effort */
  }
}
