'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { cn } from '@/lib/utils';

/**
 * A table's scrolling container, with the two things `overflow-x: auto` does not
 * provide on its own.
 *
 * **A veil on the edge that hides something.** macOS hides the scrollbars as long
 * as one does not scroll: a truncated table there is visually indistinguishable
 * from a complete one. It was observed on the targets screen at 1024 px wide —
 * the "Actions" column disappeared without anything showing it still existed.
 *
 * **Keyboard access.** A scrolling area no `Tab` reaches makes its hidden content
 * unreachable without a mouse. The `tabIndex` is only set when there actually is
 * something to scroll: adding a tab stop before each table that already fits on
 * screen would be a regression.
 *
 * The `data-more-left` / `data-more-right` attributes are also read by the pinned
 * cells (`TableActions`), which only stand out from the background when they
 * really cover something.
 */
export function TableScroller({
  className,
  label,
  children,
}: {
  className?: string;
  /** What the table contains, for the scrolling area's spoken announcement. */
  label?: string;
  children: React.ReactNode;
}) {
  const t = useT(chrome);
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A one-pixel margin: the columns' widths are fractional and a 0.5 px gap would
    // make the veil flicker on a table that fits.
    const left = el.scrollLeft > 1;
    const right = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
    setMore((current) =>
      current.left === left && current.right === right ? current : { left, right },
    );
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();

    // We observe the container **and** the table. The window is not the only thing
    // that changes size: a row added by an API response widens the table without the
    // container moving a pixel.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [measure]);

  const scrollable = more.left || more.right;

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={measure}
        data-slot="table-container"
        data-more-left={more.left ? '' : undefined}
        data-more-right={more.right ? '' : undefined}
        // `focus-visible` only: clicking in the table must not ring the whole area.
        className={cn(
          'tbl-wrap rounded-[inherit] focus-visible:shadow-focus focus-visible:outline-none',
          className,
        )}
        tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? 'region' : undefined}
        aria-label={
          scrollable ? t('table.scrollable', { label: label ?? t('table.fallback') }) : undefined
        }
      >
        {children}
      </div>

      <Veil side="left" show={more.left} />
      <Veil side="right" show={more.right} />
    </div>
  );
}

/**
 * The veil. It does not hide the content, it announces that it goes on: a narrow
 * band, a gradient from the card's color, which fades when the edge is reached.
 * `pointer-events-none` so as to intercept nothing — a button placed under the
 * veil must stay clickable.
 */
function Veil({ side, show }: { side: 'left' | 'right'; show: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-0 w-12 transition-opacity duration-150',
        // The card's color holds over two fifths before fading: a gradient that starts
        // disappearing right at the edge is too timid to stand apart from a mere text
        // ending there.
        side === 'left'
          ? 'left-0 bg-gradient-to-r from-card from-40% to-transparent'
          : 'right-0 bg-gradient-to-l from-card from-40% to-transparent',
        show ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}
