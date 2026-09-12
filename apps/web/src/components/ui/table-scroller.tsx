'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Le conteneur défilant d'un tableau, avec les deux choses que
 * `overflow-x: auto` ne fournit pas tout seul.
 *
 * **Un voile sur le bord qui cache quelque chose.** macOS masque les barres de
 * défilement tant qu'on ne défile pas : un tableau tronqué y est visuellement
 * indiscernable d'un tableau complet. On l'a constaté sur l'écran des cibles à
 * 1024 px de large — la colonne « Actions » disparaissait sans que rien
 * n'indique qu'elle existait encore.
 *
 * **Un accès au clavier.** Une zone qui défile et qu'aucun `Tab` n'atteint rend
 * son contenu caché inatteignable sans souris. Le `tabIndex` n'est posé que
 * lorsqu'il y a effectivement de quoi défiler : ajouter une étape de tabulation
 * devant chaque tableau qui tient déjà à l'écran serait une régression.
 *
 * Les attributs `data-more-left` / `data-more-right` sont aussi lus par les
 * cellules épinglées (`TableActions`), qui ne se détachent du fond que quand
 * elles recouvrent réellement quelque chose.
 */
export function TableScroller({
  className,
  label,
  children,
}: {
  className?: string;
  /** Ce que le tableau contient, pour l'annonce vocale de la zone défilante. */
  label?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Marge d'un pixel : les largeurs de colonnes sont fractionnaires et un
    // écart de 0,5 px ferait clignoter le voile sur un tableau qui tient.
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

    // On observe le conteneur **et** la table. La fenêtre n'est pas la seule
    // chose qui change de taille : une ligne ajoutée par une réponse d'API
    // élargit la table sans que le conteneur bouge d'un pixel.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [measure]);

  const scrollable = more.left || more.right;

  return (
    <div className="relative -mx-1">
      <div
        ref={ref}
        onScroll={measure}
        data-slot="table-container"
        data-more-left={more.left ? '' : undefined}
        data-more-right={more.right ? '' : undefined}
        // `focus-visible` seulement : cliquer dans le tableau ne doit pas
        // entourer la zone entière d'un anneau.
        className={cn(
          'overflow-x-auto px-1 focus-visible:ring-2 focus-visible:ring-signal focus-visible:outline-none',
          className,
        )}
        tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? 'region' : undefined}
        aria-label={scrollable ? `${label ?? 'Tableau'} — défile horizontalement` : undefined}
      >
        {children}
      </div>

      <Veil side="left" show={more.left} />
      <Veil side="right" show={more.right} />
    </div>
  );
}

/**
 * Le voile. Il ne masque pas le contenu, il annonce qu'il continue : une bande
 * étroite, dégradée depuis la couleur de la carte, qui s'efface quand on
 * atteint le bord. `pointer-events-none` pour ne rien intercepter — un bouton
 * placé sous le voile doit rester cliquable.
 */
function Veil({ side, show }: { side: 'left' | 'right'; show: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-0 w-12 transition-opacity duration-150',
        // La couleur de la carte tient sur les deux cinquièmes avant de
        // s'effacer : un dégradé qui commence à disparaître dès le bord est
        // trop timide pour se distinguer d'un simple texte qui se termine là.
        side === 'left'
          ? 'left-0 bg-gradient-to-r from-card from-40% to-transparent'
          : 'right-0 bg-gradient-to-l from-card from-40% to-transparent',
        show ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}
