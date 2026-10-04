import { Readout, ReadoutBar } from '@/components/instrument';
import { Badge } from '@/components/ui/badge';
import { AvatarEditor } from './avatar-editor';

/**
 * The top of "My account": who one is, and where the account's protection
 * stands — in three readouts read without opening anything. Everything is
 * already put into words by the page: this component only lays it out.
 */
export function AccountOverview({
  name,
  email,
  image,
  roles,
  since,
  twoFactor,
  sessions,
  signIn,
}: {
  name: string;
  email: string;
  image: string | null;
  roles: string[];
  since: string | null;
  twoFactor: { enabled: boolean; label: string; value: string; hint: string };
  sessions: { label: string; count: number; hint: string };
  signIn: { label: string; value: string; hint: string };
}) {
  return (
    <section className="card overflow-hidden">
      <div className="card-b flex flex-wrap items-center gap-4">
        <AvatarEditor name={name} image={image} />
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
          <Readout label={signIn.label} value={signIn.value} tone="ok" hint={signIn.hint} />
        </ReadoutBar>
      </div>
    </section>
  );
}
