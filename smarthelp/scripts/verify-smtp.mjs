/**
 * Checks that the configured SMTP host accepts the credentials, without sending
 * anything. transporter.verify() does a TLS handshake plus an AUTH round trip,
 * which is the part that actually fails on a wrong host, port or app password.
 *
 *   node scripts/verify-smtp.mjs
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const host = env.SMTP_HOST;
const user = env.SMTP_USER;
const pass = env.SMTP_PASS;
const port = Number(env.SMTP_PORT || 465);

if (!host || !user || !pass) {
  console.error('SMTP_HOST / SMTP_USER / SMTP_PASS not all set');
  process.exit(1);
}

// Values are not printed; only whether they work.
console.log(`host=${host} port=${port} user configured=${Boolean(user)} pass configured=${Boolean(pass)}`);

const { default: nodemailer } = await import('nodemailer');
const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });

try {
  await transporter.verify();
  console.log('SMTP verify OK - credentials accepted, nothing was sent');
} catch (e) {
  console.error(`SMTP verify FAILED: ${e.message}`);
  process.exitCode = 1;
}
