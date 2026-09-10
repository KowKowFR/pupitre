import type { Metadata, Viewport } from 'next';
import { getAppSettings } from '@tp/db';
import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Trois faces, trois rôles — chargées par `next/font` pour être auto-hébergées
 * et préchargées : pas d'appel à un tiers au rendu, pas de saut de police.
 *
 * IBM Plex Sans porte le texte, sa version condensée les étiquettes
 * d'instrument, JetBrains Mono tout ce qui est identifiant, port, version,
 * durée ou ligne de log.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexCondensed = IBM_Plex_Sans_Condensed({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-plex-condensed',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

const FALLBACK_METADATA: Metadata = {
  title: 'Control plane — Bootstrap TP v2',
  description: 'Panel de déploiement Docker Compose / K3s',
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

/** Les deux thèmes sont tenus : le navigateur peut peindre l'UI en conséquence. */
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1e24' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="fr"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexCondensed.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
