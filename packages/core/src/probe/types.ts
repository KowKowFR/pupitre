import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import type { MonitorType } from '../monitors/catalog.js';
import type { UiLanguage } from '../i18n.js';

/**
 * **The abstraction.** A probe, whatever it observes.
 *
 *     run(config) → CheckResult { outcome, latencyMs, detail, metrics }
 *
 * The same shape as `DeploymentDriver` and `Scanner`: an interface, one
 * implementation per type, a factory. Adding a kind of monitoring — DNS, domain
 * expiry, content fingerprint — means writing a class here and registering it,
 * without touching the table, the runner, the routes or the screen.
 *
 * The configuration arrives as `unknown`: each implementation validates it with
 * **its** type's Zod schema, taken from the catalog. That is what lets the rest
 * of the project handle probes without ever knowing their shape.
 */
export type ProbeContext = {
  /** Allowed internal ranges. The SSRF policy applies to every type. */
  allowlist: readonly Cidr[];
  /** The instance's language: that of each reading's `detail`. */
  language: UiLanguage;
};

export interface MonitorProbe {
  readonly type: MonitorType;
  /**
   * **Never throws** for a target failure: a dead target is a result, not a
   * program error. Does not throw for an SSRF refusal either — that is a verdict
   * too, but it carries its reason in `detail`.
   */
  run(config: unknown, ctx: ProbeContext): Promise<CheckResult>;
}
