import { createMaintenanceSchema } from '@pupitre/core';
import { createMaintenanceWindow, listMaintenanceWindows, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { assertSubjects, maintenanceJson } from '@/lib/maintenance';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The maintenance windows: ongoing and upcoming, then the last twenty finished
 * ones. Each subject is only returned to whoever can read it.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'maintenance:read');
  const windows = await listMaintenanceWindows();
  return NextResponse.json({ items: windows.map((window) => maintenanceJson(window, auth)) });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'maintenance:manage');
  const input = await readJsonBody(request, createMaintenanceSchema);
  const names = await assertSubjects(auth, input);

  const window = await createMaintenanceWindow(input, auth.userId);
  await logAudit({
    actorId: auth.userId,
    action: 'maintenance.created',
    resourceType: 'maintenance_window',
    resourceId: window.id,
    after: {
      title: window.title,
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
      ...names,
    },
    ip: auth.ip,
  });
  return NextResponse.json(maintenanceJson(window, auth), { status: 201 });
});
