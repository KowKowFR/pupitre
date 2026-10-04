/**
 * Site monitoring — the vocabulary's entry point.
 *
 * ── Why this feature does not duplicate `health:periodic` ───────────────────
 * The periodic healthcheck probes **from inside** the target machine, over SSH,
 * through the driver: it proves the container answers itself. A monitoring probe
 * goes **from the worker to the public target**. It is another point of view,
 * and that is the whole justification: it sees what the other cannot see — a
 * firewall closed again, a broken proxy, an expired certificate, a DNS that no
 * longer resolves, a drifting latency.
 *
 * ── The organization ────────────────────────────────────────────────────────
 *   monitors/ssrf.ts        the SSRF policy, shared by every type
 *   monitors/catalog.ts     the declarative catalog of probe types
 *   monitors/state.ts       verdict, state machine, availability, alert
 *   monitors/dns-records.ts the DNS vocabulary and the comparison of two answers
 *   monitors/capture.ts     incident screenshots — vocabulary and bounds
 *
 * Four files, all **pure**: this module is imported by client components, it
 * must pull no native module. The probes themselves — those that open
 * connections — live under `@pupitre/core/probe`, and the capture browser's
 * driver under `@pupitre/core/capture`.
 */

export * from './monitors/ssrf.js';
export * from './monitors/dns-records.js';
export * from './monitors/catalog.js';
export * from './monitors/state.js';
export * from './monitors/capture.js';
