import { createServerClient } from './supabaseServer';
import {
  OTP_LENGTH,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_LOCKOUT_MINUTES,
} from './constants';
import type { OtpPurpose } from './validation';

export {
  OTP_LENGTH,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_LOCKOUT_MINUTES,
};

/**
 * OTP generation and delivery (§26.1).
 *
 * Rules this module exists to enforce:
 *   - the code is generated on the server, never on the client;
 *   - only a salted SHA-256 digest reaches the database;
 *   - 10 minute TTL, 3 attempts, 15 minute lockout, 60 second resend throttle;
 *   - the plaintext is never logged and never returned, except in dev mode
 *     where there is no SMS provider to receive it.
 *
 * Server-only: it reaches the service-role client and `nodemailer`. Client
 * components that need the *policy* (how many slots to draw) import
 * `lib/constants.ts` instead.
 */

export type OtpChannel = 'phone' | 'email';
export type OtpOutcome = 'ok' | 'invalid' | 'expired' | 'locked' | 'missing';

/**
 * A numeric code of `length` digits, from the platform CSPRNG.
 *
 * `byte % 10` is very slightly biased (256 is not a multiple of 10) — the
 * worst digit is one in 25.6 more likely than the best, which is not a
 * meaningful weakening of a 6-digit code with a 3-attempt cap, and rejecting
 * biased draws would need a rejection loop for no real gain. If the length
 * ever grows to 10 digits, switch to the unbiased draw in that comment's
 * spirit: sample a uint32 and reject anything above the largest multiple of 10.
 */
export function generateOtpCode(length = OTP_LENGTH): string {
  const digits = '0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += digits[bytes[i] % 10];
  }
  return out;
}

export async function issueOtp(
  target: string,
  channel: OtpChannel,
  purpose: OtpPurpose
): Promise<{ id: string; code: string }> {
  const supabase = createServerClient();
  const code = generateOtpCode();

  const { data, error } = await supabase.rpc('issue_otp', {
    p_target: target,
    p_channel: channel,
    p_purpose: purpose,
    p_code: code,
    p_ttl_minutes: OTP_TTL_MINUTES,
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_resend_seconds: OTP_RESEND_SECONDS,

    p_lockout_minutes: OTP_LOCKOUT_MINUTES,
  });

  if (error) {
    // The throttle is the one expected failure here. The SQL raises it with
    // SQLSTATE 55000 and the message 'OTP_THROTTLED'; the message is what is
    // matched on, because the raise cannot carry a custom code — an errcode has
    // to be a five-character SQLSTATE, so the word 'rate_limited' there made
    // the raise itself fail and the throttle surface as an internal error.
    if (error.message?.includes('OTP_THROTTLED')) {
      const e = new Error('Too many codes requested') as Error & { code?: string };
      e.code = 'OTP_THROTTLED';
      throw e;
    }
    console.error('issue_otp failed:', error.message);
    const e = new Error('Could not issue a code') as Error & { code?: string };
    e.code = 'OTP_ISSUE_FAILED';
    throw e;
  }

  return { id: String(data), code };
}

export async function verifyOtp(
  target: string,
  purpose: OtpPurpose,
  code: string
): Promise<OtpOutcome> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('consume_otp', {
    p_target: target,
    p_purpose: purpose,
    p_code: code,
  });

  if (error) {
    console.error('consume_otp failed:', error.message);
    return 'missing';
  }
  return (data as OtpOutcome) ?? 'missing';
}

export interface DeliveryResult {
  delivered: boolean;
  provider: 'sms' | 'email' | 'console';
  detail?: string;
}

/**
 * Sends the code. Phone goes to the generic SMS/WhatsApp webhook (the same
 * `SMS_PROVIDER_URL` contract SmartPOS uses), email goes through SMTP.
 * With neither configured, the code is written to the server log — which is
 * how a developer runs the flow locally, and is never a production state.
 */
export async function deliverOtp(
  target: string,
  channel: OtpChannel,
  code: string,
  purpose: OtpPurpose
): Promise<DeliveryResult> {
  const ttl = OTP_TTL_MINUTES;

  if (channel === 'phone') {
    const url = process.env.SMS_PROVIDER_URL;
    const key = process.env.SMS_API_KEY;
    if (!url || !key) {
      console.log(`[smarthelp] OTP for ${target} (${purpose}) is ${code} — no SMS provider configured`);
      return { delivered: false, provider: 'console' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        to: target,
        message: `Your SmartHelp code is ${code}. It expires in ${ttl} minutes. Do not share it with anyone.`,
      }),
    });
    return { delivered: res.ok, provider: 'sms', detail: `status ${res.status}` };
  }

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.log(`[smarthelp] OTP for ${target} (${purpose}) is ${code} — no SMTP configured`);
    return { delivered: false, provider: 'console' };
  }

  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"SmartHelp" <${user}>`,
    to: target,
    subject: 'Your SmartHelp login code',
    text: `Your SmartHelp code is ${code}.\n\nIt expires in ${ttl} minutes. If you did not request it, ignore this email.`,
  });
  return { delivered: true, provider: 'email' };
}
