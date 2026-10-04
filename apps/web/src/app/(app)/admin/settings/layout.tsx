import type { ReactNode } from 'react';
import { getAppSettings } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FieldHelpMode } from '@/components/ui/field';
import { HelpTip } from '@/components/ui/help-tip';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { SettingsNav, SettingsTabs } from './settings-nav';

export const dynamic = 'force-dynamic';

/**
 * The settings' shell.
 *
 * Four groups in the rail, a group's sections as tabs. Each section stays a page:
 * an address, rendered on the server, shareable in a ticket, and whose client
 * code only loads what it shows.
 *
 * The screen is dense: the fields' help folds into tooltips there
 * (`FieldHelpMode`), and so does the page's introduction.
 *
 * The layout carries what is common to all the sections: the page banner, the
 * rail, and the read-only notice. Putting it here rather than in each form
 * avoids repeating it five times and guarantees that no section forgets it.
 *
 * The permission is checked here **and** in each page. It is not decorative
 * redundancy: a layout is not re-run when navigating between two of its children
 * on the client side, only the page is.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const auth = await requirePagePermission('/admin/settings', 'settings:read');
  const record = await getAppSettings();
  const t = await getT(messages);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('page.title')}
        description={
          <>
            {t('page.description.short')}
            <HelpTip>
              {t('page.description.before')} <code className="mono">app_settings</code>{' '}
              {t('page.description.after')}
            </HelpTip>
          </>
        }
        actions={
          <Badge variant="outline">
            {record.updatedAt ? t('page.state.customized') : t('page.state.defaults')}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-[216px_minmax(0,1fr)]">
        <SettingsNav />
        <div className="flex min-w-0 flex-col gap-4">
          <SettingsTabs />
          {auth.can('settings:manage') ? null : (
            <Alert>
              {t('page.readonly.before')} <code className="mono">settings:manage</code>{' '}
              {t('page.readonly.after')}
            </Alert>
          )}
          <FieldHelpMode mode="tip">{children}</FieldHelpMode>
        </div>
      </div>
    </div>
  );
}
