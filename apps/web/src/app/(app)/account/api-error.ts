/**
 * Message d'erreur d'une réponse de l'API du panel, sans jamais lever.
 *
 * Le repli est passé par l'appelant plutôt que fabriqué ici : cette fonction
 * n'est pas un composant, elle n'a donc ni contexte ni langue. Le composant qui
 * l'appelle a déjà son `t` — il lui coûte un argument, et cela évite un second
 * chemin par lequel la langue arriverait dans le panel.
 */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload as { error?: { message?: unknown } };
    if (typeof error?.message === 'string') return error.message;
  }
  return fallback;
}
