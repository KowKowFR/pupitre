import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/http';
import { requireCaller } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who is calling, and what they can do — the first call of a script or an agent,
 * before it tries anything.
 *
 * For an API token, `permissions` is what it can do **today**: what it asks for,
 * cut down to what its author still holds. `token.applicationIds` names the
 * applications it is limited to, `null` for all of them. `twoFactor.mustEnroll`
 * says why everything is refused while the second factor the instance requires is
 * missing.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireCaller(request);
  return NextResponse.json({
    user: { id: auth.userId, email: auth.email, name: auth.name, image: auth.image },
    roles: auth.roles,
    permissions: auth.permissions,
    twoFactor: auth.twoFactor,
    token: auth.token
      ? {
          id: auth.token.id,
          name: auth.token.name,
          applicationIds: auth.token.applications ? [...auth.token.applications] : null,
        }
      : null,
  });
});
