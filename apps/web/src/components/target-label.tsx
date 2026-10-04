import { cn } from '@/lib/utils';

/**
 * Target labels — key/value chips with a derived color.
 *
 * ## Why the color is not chosen by the user
 *
 * The database model stayed `Record<string, string>`: `key=value` pairs, like
 * Kubernetes. Moving to first-class named labels (name + chosen color) would have
 * brought one argument — being able to decree "red = production" — and three
 * costs: a table, a management screen, and above all the ability to paint a
 * label red or green. Yet in this panel red says "unreachable" and green says
 * "operational". Offering the color chart is offering the contradiction: "prod"
 * in red next to a green indicator reads as an alert, not as a category.
 *
 * The color is therefore **derived from the text**: stable everywhere in the
 * panel, free, without a management screen, and structurally unable to borrow a
 * state tint since the `--tag-*` ramp is confined to the blue-violet → magenta
 * arc (see `globals.css`).
 *
 * ## The second defense: the shape
 *
 * The tint alone would not be enough — a violet stays a bright color set next to
 * a state. The two objects are therefore of different families: a **state** chip
 * is in Instrument Sans and says a word ("operational"), a **label** chip is in
 * Geist Mono and says a `key=value` pair, the key dimmed. Background, border and
 * ink are derived from the tint by mixing (`.tag`), dosed differently depending
 * on the theme.
 */

/** The number of tints of the `--tag-*` ramp. Must follow `globals.css`. */
const TAG_TONE_COUNT = 6;

/**
 * 32-bit FNV-1a hashing.
 *
 * Chosen for being short, dependency-free and above all **pure**: the server and
 * the client must produce exactly the same tint, otherwise React reports a
 * hydration error on each label of the page.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // Multiplication by the FNV prime, in 32-bit arithmetic.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * A label's tint, as a reference to the token.
 *
 * The hash covers the whole pair and not the key alone: it is `env=prod` that one
 * looks for in a list, not "the env dimension". Two different values of the same
 * key must therefore be told apart.
 */
function tagToneOf(key: string, value: string): string {
  const index = (fnv1a(`${key}=${value}`) % TAG_TONE_COUNT) + 1;
  return `var(--tag-${index})`;
}

const CHIP_BASE = 'tag';

type ChipContentProps = { labelKey: string; value: string };

function ChipContent({ labelKey, value }: ChipContentProps) {
  return (
    <span className="truncate">
      <span className="k">{labelKey}=</span>
      {value}
    </span>
  );
}

export type TargetLabelChipProps = {
  labelKey: string;
  value: string;
  className?: string;
  /**
   * Renders the chip as a filter toggle button. Absent: a mere display, and the
   * element is neither focusable nor announced as actionable.
   */
  onToggle?: () => void;
  active?: boolean;
  /**
   * The toggle button's hover label, provided by the caller.
   *
   * This module is rendered on both sides of the boundary: a target's record calls
   * it from a server component, the table from a client component. It can
   * therefore call neither `getT` nor `useT`. Yet only the caller that passes
   * `onToggle` has a title to show — and that one is always a client component,
   * which has its `t`.
   */
  titleOf?: (active: boolean) => string;
};

export function TargetLabelChip({
  labelKey,
  value,
  className,
  onToggle,
  active,
  titleOf,
}: TargetLabelChipProps) {
  // A single variable drives background, border and ink: see `.tag`.
  const style = { '--tg': tagToneOf(labelKey, value) } as React.CSSProperties;

  if (!onToggle) {
    return (
      <span className={cn(CHIP_BASE, className)} style={style}>
        <ChipContent labelKey={labelKey} value={value} />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      // `aria-pressed` carries the state for screen readers; the check mark carries it
      // for the eye. Color never carries it alone.
      title={titleOf?.(active ?? false)}
      className={cn(CHIP_BASE, 'gap-1', className)}
      style={style}
    >
      <ChipContent labelKey={labelKey} value={value} />
      {active ? <span aria-hidden>✕</span> : null}
    </button>
  );
}

export type TargetLabelListProps = {
  labels: Record<string, string>;
  /**
   * Beyond this, the extra labels are summed up as a "+N".
   *
   * A table row cannot stretch indefinitely; a record can. Hence the setting
   * rather than a value hard-coded in the component.
   */
  max?: number;
  className?: string;
  /** Makes each chip clickable. Receives the pair as `key=value`. */
  onToggle?: (pair: string) => void;
  /** The currently filtered pairs, as `key=value`. */
  activePairs?: ReadonlySet<string>;
  /** A toggle chip's hover label. See `TargetLabelChipProps`. */
  titleOf?: (pair: string, active: boolean) => string;
};

/**
 * Display order: by key, alphabetical.
 *
 * `Object.entries` follows the JSON's insertion order, which depends on the input
 * order in the form — the same target therefore showed its labels again in a
 * different order after editing. Sorting makes the position stable, and a stable
 * position is what allows spotting a label without reading it.
 */
export function sortedLabelEntries(labels: Record<string, string>): [string, string][] {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b, 'fr'));
}

export function TargetLabelList({
  labels,
  max,
  className,
  onToggle,
  activePairs,
  titleOf,
}: TargetLabelListProps) {
  const entries = sortedLabelEntries(labels);
  if (entries.length === 0) return null;

  const shown = max === undefined ? entries : entries.slice(0, max);
  const hidden = entries.length - shown.length;

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map(([key, value]) => {
        const pair = `${key}=${value}`;
        return (
          <TargetLabelChip
            key={pair}
            labelKey={key}
            value={value}
            onToggle={onToggle ? () => onToggle(pair) : undefined}
            active={activePairs?.has(pair)}
            titleOf={titleOf ? (active) => titleOf(pair, active) : undefined}
          />
        );
      })}
      {hidden > 0 ? (
        <span
          className="mono text-[11.5px] text-text-3"
          // Hovering gives the detail: hiding is only acceptable if the information stays
          // reachable without changing page.
          title={entries
            .slice(shown.length)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n')}
        >
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}
