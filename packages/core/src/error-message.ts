/** The message of a caught error, whatever its shape. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
