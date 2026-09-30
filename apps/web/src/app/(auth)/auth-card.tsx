import type { ReactNode } from 'react';

/**
 * La carte des écrans d'accès : 400 px, rayon 14, ombre marquée, 28 px de
 * marge. Un titre, une phrase qui dit ce qu'on attend, puis le formulaire — ou
 * l'état qui le remplace (« envoyé », « périmé », « fait ») dans la même carte.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="card rounded-[14px] shadow-md">
      <div className="flex flex-col gap-4 p-7">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.015em] text-text">
            {title}
          </h1>
          {description ? <p className="t-sm text-text-2">{description}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}
