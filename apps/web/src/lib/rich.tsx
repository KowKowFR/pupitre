import { Fragment, type ReactNode } from 'react';

const SLOT = '\u0000';

/**
 * Inserts a React node into a translated sentence, in place of a variable.
 *
 * We translate the sentence with a marker at the variable's place, then cut it on
 * this marker: the word order stays the language's, and the value keeps its
 * formatting (a port in mono, a name in bold).
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
