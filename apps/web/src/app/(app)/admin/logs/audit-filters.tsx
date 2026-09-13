'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';

type Defaults = {
  actorId: string;
  action: string;
  resourceType: string;
  from: string;
  to: string;
};

export function AuditFilters({ defaults }: { defaults: Defaults }) {
  const router = useRouter();
  const params = useSearchParams();
  const t = useT(admin);
  const c = useT(common);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      const text = String(value).trim();
      if (text !== '') next.set(key, text);
    }
    next.delete('page');
    router.push(`/admin/logs?${next.toString()}`);
  }

  function reset() {
    router.push('/admin/logs');
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="action">{t('logs.filter.action')}</Label>
        {/* Les exemples sont des valeurs réelles du journal, pas de la prose : ils ne se traduisent pas. */}
        <Input id="action" name="action" defaultValue={defaults.action} placeholder="auth.login.failed" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="resourceType">{t('logs.filter.resourceType')}</Label>
        <Input id="resourceType" name="resourceType" defaultValue={defaults.resourceType} placeholder="permission" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="actorId">{t('logs.filter.actor')}</Label>
        <Input id="actorId" name="actorId" defaultValue={defaults.actorId} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="from">{t('logs.filter.from')}</Label>
        <Input id="from" name="from" type="date" defaultValue={defaults.from.slice(0, 10)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="to">{t('logs.filter.to')}</Label>
        <Input id="to" name="to" type="date" defaultValue={defaults.to.slice(0, 10)} />
      </div>
      <input type="hidden" name="pageSize" value={params.get('pageSize') ?? '50'} />
      <div className="flex items-end gap-2 pt-1 sm:col-span-2 lg:col-span-5">
        <Button type="submit" size="sm">
          {t('logs.filter.submit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          {c('reset')}
        </Button>
      </div>
    </form>
  );
}
