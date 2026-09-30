import { cn } from '@/lib/utils';

/**
 * Étiquettes de cible — pastilles clé/valeur à couleur dérivée.
 *
 * ## Pourquoi la couleur n'est pas choisie par l'utilisateur
 *
 * Le modèle en base est resté `Record<string, string>` : des paires
 * `clé=valeur`, comme Kubernetes. Passer à des étiquettes nommées de premier
 * ordre (nom + couleur choisie) aurait apporté un argument — pouvoir décréter
 * « rouge = production » — et trois coûts : une table, un écran de gestion, et
 * surtout la capacité de peindre une étiquette en rouge ou en vert. Or dans ce
 * panel le rouge dit « injoignable » et le vert dit « opérationnelle ». Offrir
 * le nuancier, c'est offrir la contradiction : « prod » en rouge à côté d'un
 * voyant vert se lit comme une alerte, pas comme une catégorie.
 *
 * La couleur est donc **dérivée du texte** : stable partout dans le panel,
 * gratuite, sans écran de gestion, et structurellement incapable d'emprunter
 * une teinte d'état puisque la rampe `--tag-*` est confinée à l'arc
 * bleu-violet → magenta (voir `globals.css`).
 *
 * ## La deuxième défense : la forme
 *
 * La teinte seule ne suffirait pas — un violet reste une couleur vive posée à
 * côté d'un état. Les deux objets sont donc de familles différentes :
 *
 * - une pastille d'**état** a le *texte* coloré (`text-ok-text`, `text-danger-text`) ;
 * - une pastille d'**étiquette** a le texte en encre neutre, et la couleur
 *   n'occupe que le fond, le liseré et un point de 5 px.
 *
 * On peut poser les deux côte à côte sans que l'œil les mélange. Bénéfice
 * secondaire : le texte étant toujours en `--text`, sa lisibilité est acquise
 * dans les deux thèmes sans calcul de contraste par teinte.
 */

/** Nombre de teintes de la rampe `--tag-*`. Doit suivre `globals.css`. */
const TAG_TONE_COUNT = 6;

/**
 * Hachage FNV-1a 32 bits.
 *
 * Choisi pour être court, sans dépendance et surtout **pur** : le serveur et le
 * client doivent produire exactement la même teinte, sans quoi React signale
 * une erreur d'hydratation sur chaque étiquette de la page.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // Multiplication par le nombre premier FNV, en arithmétique 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Teinte d'une étiquette, sous forme de référence au jeton.
 *
 * Le hachage porte sur la paire entière et non sur la seule clé : c'est
 * `env=prod` que l'on cherche du regard dans une liste, pas « la dimension
 * env ». Deux valeurs différentes d'une même clé doivent donc se distinguer.
 */
export function tagToneOf(key: string, value: string): string {
  const index = (fnv1a(`${key}=${value}`) % TAG_TONE_COUNT) + 1;
  return `var(--tag-${index})`;
}

const CHIP_BASE = [
  'tag-chip inline-flex w-fit max-w-full shrink-0 items-center gap-1.5',
  'rounded-sm border px-1.5 py-0.5 font-mono text-[0.6875rem] leading-4',
] as const;

type ChipContentProps = { labelKey: string; value: string };

function ChipContent({ labelKey, value }: ChipContentProps) {
  return (
    <>
      <span aria-hidden className="tag-chip-dot size-[5px] shrink-0 rounded-full" />
      <span className="truncate">
        <span className="text-text-2">{labelKey}</span>
        <span className="text-text-3">=</span>
        <span className="font-medium">{value}</span>
      </span>
    </>
  );
}

export type TargetLabelChipProps = {
  labelKey: string;
  value: string;
  className?: string;
  /**
   * Rend la pastille comme un bouton bascule de filtre. Absent : simple
   * affichage, et l'élément n'est ni focusable ni annoncé comme actionnable.
   */
  onToggle?: () => void;
  active?: boolean;
  /**
   * Libellé de survol du bouton bascule, fourni par l'appelant.
   *
   * Ce module est rendu des deux côtés de la frontière : la fiche d'une cible
   * l'appelle depuis un composant serveur, la table depuis un composant
   * client. Il ne peut donc appeler ni `getT` ni `useT`. Or seul l'appelant
   * qui passe `onToggle` a un titre à afficher — et celui-là est toujours un
   * composant client, qui a son `t`.
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
  // Une seule variable pilote fond, liseré et point : voir `.tag-chip`.
  const style = { '--tag': tagToneOf(labelKey, value) } as React.CSSProperties;

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
      // `aria-pressed` porte l'état pour les lecteurs d'écran ; la coche le
      // porte pour l'œil. La couleur ne le porte jamais seule.
      title={titleOf?.(active ?? false)}
      className={cn(CHIP_BASE, 'cursor-pointer transition-colors', className)}
      style={style}
    >
      <ChipContent labelKey={labelKey} value={value} />
      {active ? <span className="text-text-2">✕</span> : null}
    </button>
  );
}

export type TargetLabelListProps = {
  labels: Record<string, string>;
  /**
   * Au-delà, les étiquettes en trop sont résumées par un « +N ».
   *
   * Une ligne de tableau ne peut pas s'étirer indéfiniment ; une fiche, si.
   * D'où le réglage plutôt qu'une valeur en dur dans le composant.
   */
  max?: number;
  className?: string;
  /** Rend chaque pastille cliquable. Reçoit la paire sous forme `clé=valeur`. */
  onToggle?: (pair: string) => void;
  /** Paires actuellement filtrées, sous forme `clé=valeur`. */
  activePairs?: ReadonlySet<string>;
  /** Libellé de survol d'une pastille bascule. Voir `TargetLabelChipProps`. */
  titleOf?: (pair: string, active: boolean) => string;
};

/**
 * Ordre d'affichage : par clé, alphabétique.
 *
 * `Object.entries` suit l'ordre d'insertion du JSON, qui dépend de l'ordre de
 * saisie dans le formulaire — la même cible réaffichait donc ses étiquettes
 * dans un ordre différent après réédition. Un tri rend la position stable, et
 * une position stable est ce qui permet de repérer une étiquette sans la lire.
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
          className="font-mono text-[0.6875rem] leading-4 text-text-3"
          // Le survol donne le détail : masquer n'est acceptable que si
          // l'information reste atteignable sans changer de page.
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
