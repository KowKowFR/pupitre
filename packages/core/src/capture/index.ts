/**
 * Incident screenshots — the part that opens connections.
 *
 * An entry point separate from `@pupitre/core` because it pulls `node:net`,
 * `node:http` and `node:dns`: the capture's vocabulary (types, bounds,
 * trade-offs) lives in `monitors/capture.ts`, which is pure and which client
 * components can import. The same split as `monitors/` and `probe/`.
 *
 *   captureUrl()            drives the remote browser over CDP and returns the image
 *   createCaptureEgress()   the proxy through which that browser goes out
 */
export * from './cdp.js';
export * from './egress.js';
