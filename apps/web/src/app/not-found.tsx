import Link from 'next/link';
import { AccessCard, AccessShell } from '@/components/access-shell';
import { Button } from '@/components/ui/button';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';

/**
 * A 404 outside any section.
 *
 * Without this file, Next serves its default page: black background, "This page
 * could not be found." in English, no link. A typo in the URL therefore ejected
 * one from the panel, with no way back other than the "back" button. It takes the
 * shape of `/forbidden` — the same centered card, the same emergency exit —
 * because both answer the same question: "I am somewhere where there is nothing,
 * how do I get back?"
 */
export default async function NotFoundPage() {
  const t = await getT(messages);

  return (
    <AccessShell tagline={t('shell.tagline')}>
      <AccessCard title={t('notFound.title')} description={t('notFound.description')}>
        <p className="t-sm text-text-2">{t('notFound.body')}</p>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/">{t('link.backToDashboard')}</Link>
        </Button>
      </AccessCard>
    </AccessShell>
  );
}
