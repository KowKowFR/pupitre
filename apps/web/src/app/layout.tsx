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
 * Le panel n'a aucune page statique : chacune lit la base, et depuis que la
 * langue vient des paramètres d'instance, ce layout aussi. Le déclarer ici
 * plutôt que page par page évite qu'une page oubliée se retrouve figée dans la
 * langue qu'avait l'instance au moment du `next build`.
 */
export const dynamic = 'force-dynamic';

/**
 * Deux faces, deux rôles — chargées par `next/font` pour être auto-hébergées
 * et préchargées : pas d'appel à un tiers au rendu, pas de saut de police.
 *
 * Instrument Sans porte l'interface. Elle est chargée en police variable avec
 * son axe de largeur : les titres se condensent à 88–96 % (`font-stretch`)
 * sans une seconde famille. `wght` est implicite pour une police variable, on
 * ne déclare que l'axe en plus.
 *
 * Geist Mono porte tout ce qui est identifiant : slug, hôte, port, version,
 * date, clé de permission, ligne de log.
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
 * Le titre du document suit les paramètres d'instance, comme le nom en haut à
 * gauche : les deux doivent dire la même chose.
 *
 * L'accès à la base est enveloppé dans un `try` parce que ce layout est aussi
 * traversé pendant `next build`, où aucun PostgreSQL n'écoute. Un titre est un
 * agrément, jamais une raison de faire échouer une compilation — on retombe
 * alors sur le libellé historique.
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
 * Les deux thèmes sont tenus : le navigateur peut peindre son cadre en
 * conséquence. Un choix forcé dans le menu utilisateur l'emporte sur le média.
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
 * La langue se pose ici, une fois, pour les trois groupes de routes — le panel,
 * l'écran de connexion et l'assistant de démarrage. Le `lang` du document n'est
 * pas cosmétique : il commande la coupure des mots, la voix des lecteurs
 * d'écran et la traduction automatique du navigateur. Il était figé à « fr ».
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const language = await currentLanguage();
  // Le thème est posé par le serveur : la première image est la bonne.
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
