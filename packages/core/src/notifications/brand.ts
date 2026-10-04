/**
 * The Pupitre brand in emails: the tile, and the design system's tints.
 *
 * ── Why an attached image, and not a URL ─────────────────────────────────────
 * The panel is self-hosted: it often runs on a private network the recipient's
 * mail system does not reach, and email clients block remote images by
 * default. A URL would give an empty square in half the inboxes. SVG is not
 * shown by Gmail or Outlook. What remains is the PNG attached to the message and
 * referenced by `cid:`: it travels with the email, shows without asking the
 * network for anything, and weighs 2 KB.
 *
 * 56 × 56 pixels for a display at 28: sharp on a high-density screen.
 */

/** An image attached to the message and shown in the HTML by its `cid`. */
export type InlineImage = {
  filename: string;
  contentType: 'image/png';
  /** Referenced in the HTML by `src="cid:…"`. */
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
 * The design system's tints (light theme), hard-coded: an email client reads
 * neither CSS variables nor external sheets. Same source as `tokens/`, same names
 * as the panel's variables.
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

/** HTML escaping. The instance's name comes from the settings: nothing is safe. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The brand header: the tile, then the instance's name.
 *
 * A table rather than a `flex`: it is the only side-by-side layout Outlook
 * respects. The instance's name is what tells two panels apart; the tile only
 * says where the message comes from — hence its `alt`.
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
