/**
 * La marque Pupitre dans les e-mails : la tuile, et les teintes du design system.
 *
 * ── Pourquoi une image jointe, et pas une URL ─────────────────────────────────
 * Le panel est auto-hébergé : il tourne souvent sur un réseau privé que la
 * messagerie du destinataire ne joint pas, et les clients d'e-mail bloquent
 * les images distantes par défaut. Une URL donnerait un carré vide dans la
 * moitié des boîtes. Le SVG, lui, n'est pas affiché par Gmail ni Outlook.
 * Reste le PNG joint au message et référencé par `cid:` : il voyage avec
 * l'e-mail, s'affiche sans rien demander au réseau, et pèse 2 Ko.
 *
 * 56 × 56 pixels pour un affichage à 28 : net sur un écran haute densité.
 */

/** Une image jointe au message et affichée dans le HTML par son `cid`. */
export type InlineImage = {
  filename: string;
  contentType: 'image/png';
  /** Référencé dans le HTML par `src="cid:…"`. */
  cid: string;
  /** Octets de l'image, en base64. */
  content: string;
};

const MARK_PNG_BASE64 =
  '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' +
  'gg==';

export const BRAND_MARK: InlineImage = {
  filename: 'pupitre.png',
  contentType: 'image/png',
  cid: 'pupitre-mark@pupitre.local',
  content: MARK_PNG_BASE64,
};

/**
 * Les teintes du design system (thème clair), en dur : un client d'e-mail ne
 * lit ni variable CSS ni feuille externe. Même source que `tokens/`, mêmes
 * noms que les variables du panel.
 */
export const EMAIL_COLORS = {
  bg: '#F7F8FA',
  surface: '#FFFFFF',
  border: '#E3E5EA',
  text: '#1A1D24',
  text2: '#484D59',
  text3: '#676D7A',
  accent: '#2E44D6',
  accentText: '#2536B4',
  warn: '#D48A06',
  warnText: '#8A5504',
  danger: '#CF3121',
  dangerText: '#A6251A',
} as const;

/** Échappement HTML. Le nom d'instance vient des réglages : rien n'est sûr. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * L'en-tête de marque : la tuile, puis le nom de l'instance.
 *
 * Une table plutôt qu'un `flex` : c'est la seule mise en page côte à côte
 * qu'Outlook respecte. Le nom d'instance est ce qui distingue deux panels ;
 * la tuile dit seulement d'où vient le message — d'où son `alt`.
 */
export function brandHeaderHtml(instance: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px"><tr>` +
    `<td style="padding:0 10px 0 0;vertical-align:middle">` +
    `<img src="cid:${BRAND_MARK.cid}" width="28" height="28" alt="Pupitre" style="display:block;border:0;outline:none;text-decoration:none;border-radius:7px">` +
    `</td>` +
    `<td style="vertical-align:middle;font-size:13px;font-weight:600;color:${EMAIL_COLORS.text}">${escapeHtml(instance)}</td>` +
    `</tr></table>`
  );
}
