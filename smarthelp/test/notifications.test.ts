import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import {
  DEFAULT_CHANNELS,
  NOTIFICATION_CODES,
  dispatch,
  escapeHtml,
  render,
} from '@/lib/notifications';

/**
 * The dispatcher (§27.4, §27.5, D1).
 *
 * Three things matter and none is the happy path:
 *
 *   1. **Every catalogue code has a channel plan**, and every code the plan names
 *      is a real channel. A code with no plan is a notification that can never
 *      be sent, which is worse than one that fails loudly.
 *   2. **Delivery honesty (D1).** `in_app`/`push` are `sent` because writing the
 *      row is the delivery; `sms` and `email` are `failed` with a reason when no
 *      provider is configured — never a silent `sent`.
 *   3. **Failure isolation (§28.4).** `dispatch` never throws; an insert that
 *      errors is logged and the next channel still runs.
 *
 * The `in_app` row is universal except `OTP_LOGIN`: a login code is not a bell
 * item.
 */

const RECIPIENT = '00000000-0000-4000-8000-000000000011';

let fake: FakeSupabase;
let tables: Record<string, (call: any) => { data: any; error: any; count?: number }>;
let warnSpy: ReturnType<typeof vi.spyOn>;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

function templateResponder(rows: Record<string, { subject: string | null; body: string }> = {}) {
  return (call: any) => {
    const eq = Object.fromEntries(call.eqFilters as [string, unknown][]);
    const key = `${eq.code}|${eq.channel}|${eq.locale}`;
    const row = rows[key];
    return { data: row ?? null, error: null };
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase({
    profiles: () => ({ data: { email: 'ravi@example.test', phone: '+919876543210' }, error: null }),
    notification_templates: () => ({ data: null, error: null }),
    notifications: () => ({ data: [], error: null }),
    ...overrides,
  });
}

beforeEach(() => {
  tables = {};
  fake = build();
  // No provider and no SMTP host: the honest answer is `failed`, not `sent`.
  vi.stubEnv('SMTP_HOST', '');
  vi.stubEnv('SMTP_USER', '');
  vi.stubEnv('SMTP_PASS', '');
  vi.stubEnv('SMS_PROVIDER_URL', '');
  vi.stubEnv('SMS_API_KEY', '');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
});

describe('the catalogue', () => {
  it('gives every code a channel plan', () => {
    for (const code of NOTIFICATION_CODES) {
      expect(DEFAULT_CHANNELS[code], code).toBeDefined();
      expect(DEFAULT_CHANNELS[code].length, code).toBeGreaterThan(0);
    }
  });

  it('names only codes the catalogue defines', () => {
    for (const code of Object.keys(DEFAULT_CHANNELS)) {
      expect(NOTIFICATION_CODES).toContain(code);
    }
  });

  it('makes in-app universal except for the login code', () => {
    for (const code of NOTIFICATION_CODES) {
      if (code === 'OTP_LOGIN') continue;
      expect(DEFAULT_CHANNELS[code], code).toContain('in_app');
    }
    expect(DEFAULT_CHANNELS.OTP_LOGIN).toEqual(['sms']);
  });
});

describe('render', () => {
  it('substitutes tokens, and an absent token becomes empty rather than literal', () => {
    const out = render(
      'BOOKING_CONFIRMED',
      { subject: 'Hi {{customer_name}}', body: 'On {{date}} at {{time}}' },
      { customer_name: 'Asha', date: '2 Jun', time: null },
      false
    );
    expect(out).toEqual({ title: 'Hi Asha', body: 'On 2 Jun at ' });
  });

  it('escapes an email body, so a payload cannot inject markup', () => {
    const out = render(
      'TICKET_UPDATE',
      { subject: null, body: '{{ticketSubject}}' },
      { ticketSubject: '<script>alert(1)</script>' },
      true
    );
    expect(out.body).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.title).toBeNull();
  });

  it('does not escape in-app text, which is rendered as text', () => {
    const out = render(
      'TICKET_UPDATE',
      { subject: null, body: '{{ticketSubject}}' },
      { ticketSubject: '<b>hi</b>' },
      false
    );
    expect(out.body).toBe('<b>hi</b>');
  });

  it('falls back to a humanised code when the template is missing', () => {
    expect(render('BOOKING_CONFIRMED', null, {}, false)).toEqual({
      title: 'Booking confirmed',
      body: 'Booking confirmed',
    });
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('dispatch', () => {
  it('writes and marks in-app and push sent, and leaves sms/email failed with a reason (D1)', async () => {
    const rows = await dispatch(
      { code: 'BOOKING_CONFIRMED', recipientId: RECIPIENT },
      fakeSupabase(fake)
    );

    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'in_app', 'push', 'sms']);
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r]));
    expect(byChannel.in_app.status).toBe('sent');
    expect(byChannel.in_app.sent_at).not.toBeNull();
    expect(byChannel.push.status).toBe('sent');
    expect(byChannel.sms.status).toBe('failed');
    expect(byChannel.sms.error).toBe('no SMS provider configured');
    expect(byChannel.email.status).toBe('failed');
    expect(byChannel.email.error).toBe('SMTP is not configured');
    expect(byChannel.email.sent_at).toBeNull();
  });

  it('never sends an in-app row for a login code', async () => {
    const rows = await dispatch(
      { code: 'OTP_LOGIN', recipientId: RECIPIENT },
      fakeSupabase(fake)
    );
    expect(rows.map((r) => r.channel)).toEqual(['sms']);
    expect(fake.writesTo('notifications')).toHaveLength(1);
  });

  it('records recipient_id, the code and the booking on every row', async () => {
    await dispatch(
      {
        code: 'PRO_ON_THE_WAY',
        recipientId: RECIPIENT,
        bookingId: 'ffffffff-1111-4111-8111-ffffffffffff',
        payload: { etaMinutes: '12' },
      },
      fakeSupabase(fake)
    );
    const writes = fake.writesTo('notifications');
    expect(writes).toHaveLength(3); // in_app + push + sms
    for (const w of writes) {
      expect((w.payload as any).recipient_id).toBe(RECIPIENT);
      expect((w.payload as any).template_code).toBe('PRO_ON_THE_WAY');
      expect((w.payload as any).booking_id).toBe('ffffffff-1111-4111-8111-ffffffffffff');
    }
  });

  it('renders from the active template for the channel', async () => {
    fake = build({
      notification_templates: templateResponder({
        'SERVICE_STARTED|in_app|en-IN': { subject: null, body: 'Your service has started.' },
      }),
    });
    const rows = await dispatch(
      { code: 'SERVICE_STARTED', recipientId: RECIPIENT, channels: ['in_app'] },
      fakeSupabase(fake)
    );
    expect(rows[0].body).toBe('Your service has started.');
  });

  it('never throws when a write fails, and still runs the other channels', async () => {
    let calls = 0;
    fake = build({
      notifications: () => {
        calls += 1;
        return { data: null, error: { message: 'insert exploded' } };
      },
    });
    const rows = await dispatch(
      { code: 'PRO_ARRIVED', recipientId: RECIPIENT },
      fakeSupabase(fake)
    );
    // Both channels attempted, both threw on insert, neither propagated.
    expect(calls).toBe(2);
    expect(rows).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
