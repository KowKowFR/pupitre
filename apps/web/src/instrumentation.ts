/**
 * Amorçage du processus serveur.
 *
 * `register()` est appelée une fois, avant que Next n'accepte la première
 * requête. C'est le seul endroit du panel où l'on peut installer quelque chose
 * « au démarrage » : un Route Handler n'est chargé qu'à la première requête qui
 * le vise, et un layout n'est pas réexécuté à chaque navigation.
 *
 * On y branche l'observateur du journal d'audit sur la file des notifications.
 * Sans lui, un changement de rôle ou une réinitialisation de second facteur
 * seraient tracés — mais n'alerteraient personne. Et le fournisseur qui donne
 * au journal le navigateur de chaque requête.
 */
export async function register(): Promise<void> {
  // `register()` est aussi appelée pour le runtime Edge, où ni `ioredis` ni
  // `pg` n'existent. L'import est donc dynamique et conditionné.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { installAuditNotifications } = await import('./lib/notifications');
  installAuditNotifications();

  // Le navigateur de chaque action tracée, lu dans la requête qui l'a portée.
  const { installAuditContext } = await import('./lib/audit-context');
  installAuditContext();

  // Chaque action tracée réveille les écrans ouverts qu'elle concerne.
  const { installRealtimeAudit } = await import('./lib/realtime');
  installRealtimeAudit();

  // La connexion unique se règle depuis le panel : sa configuration effective
  // est lue ici, avant la première requête. Un fournisseur injoignable ne
  // bloque pas le démarrage — l'écran de connexion retentera.
  const { refreshSso } = await import('./lib/sso');
  await refreshSso().catch(() => undefined);

  // La durée des sessions se règle aussi depuis le panel.
  const { refreshSessionPolicy } = await import('./lib/session-policy');
  await refreshSessionPolicy();
}
