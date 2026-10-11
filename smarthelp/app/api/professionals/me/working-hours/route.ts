import { handle, ok, ApiHttpError } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional } from '@/lib/professionalServer';
import { fail, int, str } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS = 'id, professional_id, weekday, start_time, end_time, is_active';

/** 0 = Sunday, matching the `weekday` column (0005). */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A person does not need more than a handful of windows per weekday. */
const MAX_WINDOWS = 40;

/**
 * GET/PUT /api/professionals/me/working-hours — "when are you generally willing
 * to work?" (§19.1), the weekly editor on the availability page.
 *
 * PUT replaces the whole week in one call. That is deliberate: a weekly
 * schedule is edited as a set, and a per-window PATCH surface would let a
 * half-applied week exist between two requests. The delete and the insert are
 * both filtered by the caller's `professionals.id`, so professional A can never
 * read or rewrite professional B's hours.
 */
export async function GET(req: Request) {
  return handle(req, 'professionals.working_hours.list', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from('professional_working_hours')
      .select(COLUMNS)
      .eq('professional_id', professional.id)
      .order('weekday', { ascending: true })
      .order('start_time', { ascending: true });

    if (error) throw error;
    return ok({ hours: (data ?? []).map(toHourView) });
  });
}

export async function PUT(req: Request) {
  return handle(req, 'professionals.working_hours.replace', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const windows = validateWorkingHours(await readBody(req));

    // Replace, not merge. A window the person removed has to actually go.
    const { error: deleteError } = await supabase
      .from('professional_working_hours')
      .delete()
      .eq('professional_id', professional.id);
    if (deleteError) rethrowDbError(deleteError);

    if (windows.length > 0) {
      const { error: insertError } = await supabase
        .from('professional_working_hours')
        .insert(
          windows.map((w) => ({
            professional_id: professional.id,
            weekday: w.weekday,
            start_time: w.startTime,
            end_time: w.endTime,
          }))
        );
      if (insertError) rethrowDbError(insertError);
    }

    // Read back the canonical rows rather than echoing the request, so the page
    // shows exactly what the server stored.
    const { data, error } = await supabase
      .from('professional_working_hours')
      .select(COLUMNS)
      .eq('professional_id', professional.id)
      .order('weekday', { ascending: true })
      .order('start_time', { ascending: true });
    if (error) throw error;

    return ok({ hours: (data ?? []).map(toHourView) });
  });
}

interface WorkingHourRow {
  id: string;
  weekday: number | string;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

function toHourView(row: WorkingHourRow) {
  return {
    id: row.id,
    weekday: Number(row.weekday),
    // `time` comes back as `HH:MM:SS`; the editor works in `HH:MM`.
    startTime: String(row.start_time).slice(0, 5),
    endTime: String(row.end_time).slice(0, 5),
    isActive: row.is_active,
  };
}

interface ParsedWindow {
  weekday: number;
  startMin: number;
  endMin: number;
  startTime: string;
  endTime: string;
}

/**
 * The week, validated as a set.
 *
 * Two rules are not expressible as a column check: a window may not fall
 * outside 00:00–24:00, and two windows on the same weekday may not overlap.
 * Both are refused here with a field error rather than handed to the database,
 * because a `23P01`/raw constraint message is not something to show a person.
 *
 * `is_active` is not part of the contract: the column defaults to true, and a
 * window the professional does not want is simply absent from the set they
 * save rather than parked in the row switched off.
 */
function validateWorkingHours(body: Record<string, unknown>): Omit<ParsedWindow, 'startMin' | 'endMin'>[] {
  const raw = body.hours;
  if (!Array.isArray(raw)) fail({ hours: 'Send the week as a list of windows' });
  if (raw.length > MAX_WINDOWS) fail({ hours: 'That is more windows than a week has room for' });

  const parsed: ParsedWindow[] = (raw as unknown[]).map((item, i) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const weekday = int(row.weekday, `hours.${i}.weekday`, { min: 0, max: 6 });
    const startMin = parseTime(row.startTime ?? row.start_time, `hours.${i}.startTime`);
    const endMin = parseTime(row.endTime ?? row.end_time, `hours.${i}.endTime`);

    if (endMin <= startMin) {
      fail({ [`hours.${i}.endTime`]: 'The end time must be after the start time' });
    }

    return {
      weekday,
      startMin,
      endMin,
      startTime: formatTime(startMin),
      endTime: formatTime(endMin),
    };
  });

  const byDay = new Map<number, ParsedWindow[]>();
  for (const window of parsed) {
    const day = byDay.get(window.weekday) ?? [];
    day.push(window);
    byDay.set(window.weekday, day);
  }
  for (const [day, list] of byDay) {
    list.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].startMin < list[i - 1].endMin) {
        fail({ hours: `${DAY_NAMES[day]} has two windows that overlap` });
      }
    }
  }

  return parsed.map(({ weekday, startTime, endTime }) => ({
    weekday,
    startTime,
    endTime,
  }));
}

/** `HH:MM` (optionally `:SS`), within 00:00–24:00, as minutes since midnight. */
function parseTime(value: unknown, field: string): number {
  const text = str(value, field, { min: 4, max: 8 });
  const match = /^([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?$/.exec(text);
  if (!match) fail({ [field]: 'Use the format HH:MM' });
  const hours = Number(match![1]);
  const minutes = Number(match![2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    fail({ [field]: 'Time must be within 00:00–24:00' });
  }
  return hours * 60 + minutes;
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A database integrity error becomes the next-slot message, never a raw 23P01. */
function rethrowDbError(error: { message: string; code?: string }): never {
  if (error.code && error.code.startsWith('23')) {
    throw new ApiHttpError(
      'PROFESSIONAL_UNAVAILABLE',
      'Those hours clash with something already on your calendar. Adjust them and try again.',
      422
    );
  }
  throw error;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
