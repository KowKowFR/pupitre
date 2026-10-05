import type { DriverDeployment } from './types.js';

/**
 * A release's name on the target: the AppSpec's version **and** the
 * deployment's number — `1.0.0-r12`. It names its directory and the tag of the
 * images it builds.
 *
 * The version alone was not enough: a code commit does not change the AppSpec's
 * version. Two deployments of `1.0.0` then shared the same directory and the
 * same tag — the second overwrote the first, and going back to the previous
 * version started the new code again. The number is specific to the application
 * and never comes back: a release can no longer be confused with another.
 *
 * Characters an image tag refuses (the `+` of a semver version) become `-`.
 */
export function releaseName(deployment: Pick<DriverDeployment, 'version' | 'sequence'>): string {
  return `${deployment.version}-r${deployment.sequence}`
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 128);
}

/**
 * Where to look for a release: its name, then the one from before this naming —
 * the version alone —, to go back to a release placed before the update.
 */
export function releaseCandidates(
  deployment: Pick<DriverDeployment, 'version' | 'sequence'>,
): string[] {
  return [releaseName(deployment), deployment.version];
}
