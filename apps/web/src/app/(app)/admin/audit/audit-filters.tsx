'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      const text = String(value).trim();
      if (text !== '') next.set(key, text);
    }
    next.delete('page');
    router.push(`/admin/audit?${next.toString()}`);
  }

  function reset() {
    router.push('/admin/audit');
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="action">Action</Label>
        <Input id="action" name="action" defaultValue={defaults.action} placeholder="auth.login.failed" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="resourceType">Type de ressource</Label>
        <Input id="resourceType" name="resourceType" defaultValue={defaults.resourceType} placeholder="permission" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="actorId">Acteur (id)</Label>
        <Input id="actorId" name="actorId" defaultValue={defaults.actorId} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="from">Du</Label>
        <Input id="from" name="from" type="date" defaultValue={defaults.from.slice(0, 10)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="to">Au</Label>
        <Input id="to" name="to" type="date" defaultValue={defaults.to.slice(0, 10)} />
      </div>
      <input type="hidden" name="pageSize" value={params.get('pageSize') ?? '50'} />
      <div className="flex items-end gap-2 pt-1 sm:col-span-2 lg:col-span-5">
        <Button type="submit" size="sm">
          Filtrer
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          Réinitialiser
        </Button>
      </div>
    </form>
  );
}
