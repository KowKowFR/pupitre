/**
 * The error message of a panel API response, without ever throwing.
 *
 * The fallback is passed by the caller rather than made here: this function is
 * not a component, so it has neither context nor language. The component calling
 * it already has its `t` — it costs it an argument, and it avoids a second path
 * through which the language would reach the panel.
 */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload as { error?: { message?: unknown } };
    if (typeof error?.message === 'string') return error.message;
  }
  return fallback;
}
