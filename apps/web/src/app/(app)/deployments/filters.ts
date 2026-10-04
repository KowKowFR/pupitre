/**
 * The runs list's filters, shared by the page (server), the table (client) and
 * the export link: all three must write the same URL.
 *
 * Three filters are statuses; "blocked by a scan" is not one — it is a failure
 * with a precise cause, which the list translates into `blocked=scan`.
 */
export type StatusFilter = 'running' | 'failed' | 'rolled_back' | 'scan_blocked' | null;

/** A filter's URL parameters: the list's, taken as is by the export. */
export function filterParams(filter: StatusFilter, search: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filter === 'scan_blocked') params.set('blocked', 'scan');
  else if (filter) params.set('status', filter);
  if (search) params.set('q', search);
  return params;
}
