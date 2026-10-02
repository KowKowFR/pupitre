import type { DriverDeployment } from './types.js';

/**
 * Le nom d'une release sur la cible : la version de l'AppSpec **et** le numéro
 * du déploiement — `1.0.0-r12`. Il nomme son répertoire et l'étiquette des
 * images qu'elle construit.
 *
 * La version seule ne suffisait pas : un commit de code ne change pas la
 * version de l'AppSpec. Deux déploiements de `1.0.0` partageaient alors le même
 * répertoire et la même étiquette — le second écrasait le premier, et revenir à
 * la version précédente relançait le nouveau code. Le numéro est propre à
 * l'application et ne revient jamais : une release ne se confond plus avec une
 * autre.
 *
 * Les caractères qu'une étiquette d'image refuse (le `+` d'une version semver)
 * deviennent `-`.
 */
export function releaseName(deployment: Pick<DriverDeployment, 'version' | 'sequence'>): string {
  return `${deployment.version}-r${deployment.sequence}`
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 128);
}

/**
 * Où chercher une release : son nom, puis celui d'avant ce nommage — la seule
 * version —, pour revenir à une release déposée avant la mise à jour.
 */
export function releaseCandidates(
  deployment: Pick<DriverDeployment, 'version' | 'sequence'>,
): string[] {
  return [releaseName(deployment), deployment.version];
}
