/** Message d'erreur d'une réponse de l'API du panel, sans jamais lever. */
export async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload as { error?: { message?: unknown } };
    if (typeof error?.message === 'string') return error.message;
  }
  return `Échec (HTTP ${response.status}).`;
}
