import type { TargetHealth } from '@pupitre/core';
import type { Tone } from '@/components/ui/led';

/**
 * The tone of each target state. A neutral module — neither client nor server —
 * so that the list (client) and the record (server) read the same table: a server
 * component that imports a constant from a client module only receives an opaque
 * reference.
 */
export const STATUS_TONE: Record<TargetHealth, Tone> = {
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};
