import type { Metadata, Viewport } from 'next';
import { getAppSettings } from '@pupitre/db';
import { Geist_Mono, Instrument_Sans } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/i18n/client';
import { currentLanguage } from '@/i18n/server';
import { THEME_COOKIE, parseTheme, themeClass } from '@/lib/theme';
import { cn } from '@/lib/utils';
import './globals.css';

/**
 * The panel has no static page: each one reads the database, and since the
 * language comes from the instance settings, this layout does too. Declaring it
 * here rather than page by page avoids a forgotten page ending up frozen in the
 * language the instance had at `next build` time.
 */
export const dynamic = 'force-dynamic';

/**
 * Two faces, two roles — loaded through `next/font` to be self-hosted and
 * preloaded: no call to a third party at render time, no font jump.
 *
 * Instrument Sans carries the interface. It is loaded as a variable font with its
 * width axis: the titles condense to 88–96% (`font-stretch`) without a second
 * family. `wght` is implicit for a variable font, only the extra axis is
 * declared.
 *
 * Geist Mono carries everything that is an identifier: slug, host, port,
 * version, date, permission key, log line.
 */
const instrumentSans = Instrument_Sans({
  subsets: ['latin', 'latin-ext'],
  axes: ['wdth'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-geist-mono',
  display: 'swap',
});

/**
 * The fallback title, rendered when the database does not answer. It cannot be
 * translated: the language lives precisely in the database that cannot be
 * reached. It is therefore in the project's language, English.
 */
const FALLBACK_METADATA: Metadata = {
  title: 'Pupitre — deployment control plane',
  description: 'Docker Compose / K3s deployment panel',
};

/**
 * The document's title follows the instance settings, like the name at the top
 * left: both must say the same thing.
 *
 * The database access is wrapped in a `try` because this layout is also crossed
 * during `next build`, where no PostgreSQL is listening. A title is a nicety,
 * never a reason to fail a build — we then fall back on the historical label.
 */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const { settings } = await getAppSettings();
    const title =
      settings.instanceTagline === ''
        ? settings.instanceName
        : `${settings.instanceName} — ${settings.instanceTagline}`;
    return { title, description: FALLBACK_METADATA.description };
  } catch {
    return FALLBACK_METADATA;
  }
}

/**
 * Both themes are supported: the browser can paint its frame accordingly. A
 * choice forced in the user menu wins over the media query.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  if (theme === 'light') return { colorScheme: 'light', themeColor: '#f7f8fa' };
  if (theme === 'dark') return { colorScheme: 'dark', themeColor: '#0e1014' };
  return {
    colorScheme: 'light dark',
    themeColor: [
      { media: '(prefers-color-scheme: light)', color: '#f7f8fa' },
      { media: '(prefers-color-scheme: dark)', color: '#0e1014' },
    ],
  };
}

/**
 * The language is set here, once, for the three route groups — the panel, the
 * sign-in screen and the onboarding assistant. The document's `lang` is not
 * cosmetic: it drives hyphenation, screen readers' voice and the browser's
 * automatic translation. It used to be frozen at "fr".
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const language = await currentLanguage();
  // The theme is set by the server: the first frame is the right one.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang={language}
      suppressHydrationWarning
      className={cn(instrumentSans.variable, geistMono.variable, themeClass(theme))}
    >
      <body className="min-h-dvh antialiased">
        <LanguageProvider language={language}>{children}</LanguageProvider>
      </body>
    </html>
  );
}
