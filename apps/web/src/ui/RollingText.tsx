/**
 * Apple-style numeric text: fixed-width digits, and only digits that changed
 * roll (old exits up/fades, new enters from below). Reduce Motion becomes a
 * short cross-fade. Non-digit characters never animate.
 */
import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from './motion';

export function RollingText({
  text,
  className = '',
  ariaLabel,
}: {
  text: string;
  className?: string;
  ariaLabel?: string;
}) {
  const previous = useRef(text);
  const [animateFrom, setAnimateFrom] = useState<string | null>(null);
  const old = animateFrom ?? previous.current;
  const direction = text >= old ? 'up' : 'down';
  const reduce = reducedMotion();

  useEffect(() => {
    if (previous.current !== text) {
      setAnimateFrom(previous.current);
      previous.current = text;
      const timer = window.setTimeout(() => setAnimateFrom(null), 380);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [text]);

  const chars = Array.from(text);
  const oldChars = Array.from(old);
  return (
    <span className={`rolling-text ${className}`.trim()} aria-label={ariaLabel ?? text} role="text">
      <span aria-hidden="true">
        {chars.map((char, index) => {
          const before = oldChars[index];
          const changed = animateFrom !== null && before !== undefined && before !== char && /\d/.test(char);
          if (!changed) return <span key={`s-${index}-${char}`}>{char}</span>;
          return (
            <span className={`rolling-char${reduce ? ' reduce' : direction === 'down' ? ' down' : ''}`} key={`a-${index}-${char}-${animateFrom}`}>
              <span className="rolling-old">{before}</span>
              <span className="rolling-new">{char}</span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
