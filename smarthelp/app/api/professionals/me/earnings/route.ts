import { handle, ok } from '@/lib/api';
import { requireProfessional } from '@/lib/professionalServer';
import { getEarnings } from '@/lib/earningsServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/professionals/me/earnings — the professional's earnings ledger
 * (§25.7, Phase 4 completion).
 *
 * `professional_earnings` is scoped by `professional_id`, and `getEarnings`
 * filters by the authenticated professional's id and nothing else, so a
 * cross-professional read is an empty ledger by construction. The summary is
 * not stored anywhere — it is an exact paise sum over the returned rows inside
 * `lib/money.ts` — so the browser and the ledger can never disagree.
 */
export async function GET(req: Request) {
  return handle(req, 'professionals.earnings.list', async () => {
    const { professional } = await requireProfessional(req);
    const { summary, earnings } = await getEarnings(professional.id);
    return ok({ summary, earnings, serverNow: new Date().toISOString() });
  });
}