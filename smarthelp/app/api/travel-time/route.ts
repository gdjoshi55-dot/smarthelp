import { handle, ok, ApiHttpError } from '@/lib/api';
import { getTravelTime } from '@/lib/googleMaps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(req, 'travel.time', async () => {
    const url = new URL(req.url);
    const ox = Number(url.searchParams.get('ox'));
    const oy = Number(url.searchParams.get('oy'));
    const dx = Number(url.searchParams.get('dx'));
    const dy = Number(url.searchParams.get('dy'));
    const mode = (url.searchParams.get('mode') || 'driving') as 'driving' | 'walking' | 'bicycling' | 'transit';

    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new ApiHttpError('VALIDATION_ERROR', 'ox,oy,dx,dy required', 400);
    }

    const result = await getTravelTime({ lat: ox, lng: oy }, { lat: dx, lng: dy }, mode);
    return ok(result);
  });
}
