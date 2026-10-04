import { tokenForgeCheckRoute } from '@/lib/token-forges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** "Test" a Gitea address and token, without saving anything. */
export const POST = tokenForgeCheckRoute('gitea');
