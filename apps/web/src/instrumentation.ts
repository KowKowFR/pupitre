/**
 * Bootstrapping the server process.
 *
 * `register()` is called once, before Next accepts the first request. It is the
 * only place in the panel where something can be installed "at startup": a Route
 * Handler is only loaded at the first request that targets it, and a layout is
 * not re-run at each navigation.
 *
 * We plug the audit log's observer into the notifications queue there. Without
 * it, a role change or a second factor reset would be traced — but would alert
 * nobody. And the provider that gives the log each request's browser.
 */
export async function register(): Promise<void> {
  // `register()` is also called for the Edge runtime, where neither `ioredis` nor
  // `pg` exist. The import is therefore dynamic and conditional.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { installAuditNotifications } = await import('./lib/notifications');
  installAuditNotifications();

  // The browser of each traced action, read from the request that carried it.
  const { installAuditContext } = await import('./lib/audit-context');
  installAuditContext();

  // Each traced action wakes up the open screens it concerns.
  const { installRealtimeAudit } = await import('./lib/realtime');
  installRealtimeAudit();

  // Single sign-on is set from the panel: its effective configuration is read
  // here, before the first request. An unreachable provider does not block the
  // startup — the sign-in screen will try again.
  const { refreshSso } = await import('./lib/sso');
  await refreshSso().catch(() => undefined);

  // The sessions' duration is also set from the panel.
  const { refreshSessionPolicy } = await import('./lib/session-policy');
  await refreshSessionPolicy();
}
