import { Fragment, type ReactNode } from 'react';

const SLOT = '\u0000';

/**
 * Insère un nœud React dans une phrase traduite, à la place d'une variable.
 *
 * On traduit la phrase avec un marqueur à l'emplacement de la variable, puis
 * on la coupe sur ce marqueur : l'ordre des mots reste celui de la langue, et
 * la valeur garde sa mise en forme (un port en mono, un nom en gras).
 */
export function withSlot(render: (slot: string) => string, node: ReactNode): ReactNode {
  const [before, ...rest] = render(SLOT).split(SLOT);
  return (
    <>
      {before}
      {rest.map((part, index) => (
        <Fragment key={index}>
          {node}
          {part}
        </Fragment>
      ))}
    </>
  );
}
