import { tokenForgeCheckRoute } from '@/lib/token-forges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** « Tester » une adresse et un jeton GitLab, sans rien enregistrer. */
export const POST = tokenForgeCheckRoute('gitlab');
