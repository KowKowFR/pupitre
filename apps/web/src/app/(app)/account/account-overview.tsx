import { Readout, ReadoutBar } from '@/components/instrument';
import { Badge } from '@/components/ui/badge';
import { initialsOf } from '@/components/ui/data';

/**
 * Le haut de « Mon compte » : qui l'on est, et où en est la protection du
 * compte — en trois relevés qu'on lit sans rien ouvrir. Tout est déjà mis en
 * mots par la page : ce composant ne fait que disposer.
 */
export function AccountOverview({
  name,
  email,
  roles,
  since,
  twoFactor,
  sessions,
  lastSignIn,
}: {
  name: string;
  email: string;
  roles: string[];
  since: string | null;
  twoFactor: { enabled: boolean; label: string; value: string; hint: string };
  sessions: { label: string; count: number; hint: string };
  lastSignIn: { label: string; value: string; hint: string };
}) {
  return (
    <section className="card overflow-hidden">
      <div className="card-b flex flex-wrap items-center gap-4">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-full border border-accent-line bg-accent-soft text-[16px] font-semibold text-accent-text"
        >
          {initialsOf(name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate text-[17px] leading-6 font-semibold text-text">{name}</h2>
          <span className="mono t-sm truncate text-text-2">{email}</span>
          <span className="flex flex-wrap items-center gap-2">
            {roles.map((role) => (
              <Badge key={role} variant="outline">
                {role}
              </Badge>
            ))}
            {since ? <span className="t-cap text-text-3">{since}</span> : null}
          </span>
        </div>
      </div>
      <div className="border-t border-border-subtle">
        <ReadoutBar bare compact>
          <Readout
            label={twoFactor.label}
            value={twoFactor.value}
            tone={twoFactor.enabled ? 'ok' : 'warn'}
            hint={twoFactor.hint}
          />
          <Readout label={sessions.label} value={sessions.count} tone="idle" hint={sessions.hint} />
          <Readout
            label={lastSignIn.label}
            value={lastSignIn.value}
            tone="idle"
            hint={lastSignIn.hint}
          />
        </ReadoutBar>
      </div>
    </section>
  );
}
