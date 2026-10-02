/** Le message d'une erreur attrapée, quelle qu'en soit la forme. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
