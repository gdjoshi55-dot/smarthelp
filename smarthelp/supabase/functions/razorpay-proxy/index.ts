// Supabase Edge Function: razorpay-proxy
//
// The same transport pos-subscription uses to reach Razorpay when the host's
// egress rules block api.razorpay.com. It accepts the envelope pos's
// `/api/subscription/create` sends — `{ method, url, authHeader, body }` —
// forwards it to Razorpay, and returns the upstream body and status verbatim.
//
// Deploy with:  supabase functions deploy razorpay-proxy --no-verify-jwt
// Then set RAZORPAY_PROXY_URL on the Next.js host to the function URL. Until it
// is deployed and configured, lib/razorpayProxy.ts falls back to calling
// Razorpay directly, which is what SmartHelp did before this function existed.
//
// This file is Deno, not Node, and is excluded from tsconfig.json on purpose.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface Envelope {
  method?: string;
  url?: string;
  authHeader?: string;
  body?: unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let envelope: Envelope;
  try {
    envelope = (await req.json()) as Envelope;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { method = 'POST', url, authHeader, body } = envelope ?? {};
  if (!url || !authHeader) {
    return json({ error: 'url and authHeader are required' }, 400);
  }

  try {
    const upstream = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      ...(method.toUpperCase() === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return json({ error: (err as Error).message || 'Proxy request failed' }, 502);
  }
});
