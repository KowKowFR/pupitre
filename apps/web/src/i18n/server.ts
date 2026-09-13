import 'server-only';
import { cache } from 'react';
import {
  DEFAULT_UI_LANGUAGE,
  languageOf,
  translator,
  type Bundle,
  type Dict,
  type Translate,
  type UiLanguage,
} from '@pupitre/core';
import { getAppSettings } from '@pupitre/db';

/**
 * La langue, côté serveur.
 *
 * ── Pourquoi les paramètres d'instance, et pas une préférence par compte ────
 * Le panel n'est pas la seule bouche qui parle. Le worker compose des alertes
 * sans personne devant lui ; l'e-mail d'invitation part vers quelqu'un qui n'a
 * pas encore de compte, donc pas de préférence ; le résumé quotidien s'adresse
 * à une liste. Ces trois-là ont besoin d'**une** langue d'instance, et il en
 * faudrait donc une de toute façon.
 *
 * Ajouter par-dessus une préférence par compte ne rendrait bilingue que le
 * panel : le prestataire anglophone lirait un écran anglais, puis recevrait
 * l'alerte du déploiement qu'il vient de lancer en français. C'est exactement
 * la moitié de traduction qu'on cherche à éviter — avec, en prime, une colonne,
 * une migration et une lecture de plus par rendu.
 *
 * Le prix est réel et assumé : sur une instance francophone, l'anglophone lit
 * du français. Le jour où ce prix devient trop cher, tout tient dans cette
 * fonction : `currentLanguage()` regarderait d'abord la préférence de la
 * session, et retomberait sur l'instance. Rien d'autre dans le panel ne sait
 * d'où vient la langue.
 *
 * ── Pourquoi un `cache()` ───────────────────────────────────────────────────
 * Chaque composant serveur qui affiche du texte appelle ceci. `getAppSettings()`
 * a déjà son cache de 5 s, mais il est global au processus : `cache()` évite en
 * plus la promesse répétée dans un même rendu. Les 5 s expliquent aussi
 * pourquoi changer la langue ne demande ni redéploiement ni reconnexion — le
 * rendu suivant relit, au pire cinq secondes plus tard.
 */
export const currentLanguage = cache(async (): Promise<UiLanguage> => {
  try {
    const { settings } = await getAppSettings();
    return languageOf(settings.locale);
  } catch {
    // Traversée de `next build` sans base : un titre de page n'est jamais une
    // raison de faire échouer une compilation. Même arbitrage qu'au layout.
    return DEFAULT_UI_LANGUAGE;
  }
});

/**
 * Le `t` d'un composant serveur. On passe le dictionnaire, pas son nom : c'est
 * ce qui permet au compilateur de connaître les clés de cet écran-là, et au
 * bundler de ne charger que le dictionnaire de cet écran-là.
 */
export async function getT<F extends Dict>(bundle: Bundle<F>): Promise<Translate<F>> {
  return translator(bundle, await currentLanguage());
}
