// Cloudflare Pages Function — POST /api/billing
// Creates a Stripe Checkout session for Pro subscription.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    return await handlePost(request, env);
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: 'Unhandled: ' + e.message + ' | ' + e.stack?.slice(0, 200) }), { status: 500, headers: CORS_HEADERS });
  }
}

async function handlePost(request, env) {
  // ── 1. Verify Clerk session token ────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return jsonError('Unauthorized', 401);

  let clerkPayload;
  try {
    clerkPayload = await verifyClerkJwt(token);
  } catch (e) {
    return jsonError('Invalid session token: ' + e.message, 401);
  }
  const userId = clerkPayload.sub;

  // ── 2. Parse body ─────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

  const { priceId, email } = body;
  if (!priceId) return jsonError('priceId is required', 400);

  // Validate priceId is one of ours
  const allowedPrices = [env.STRIPE_PRICE_MONTHLY, env.STRIPE_PRICE_YEARLY].filter(Boolean);
  if (allowedPrices.length > 0 && !allowedPrices.includes(priceId)) {
    return jsonError('Invalid price ID', 400);
  }

  // ── 3. Look up or create Stripe customer ──────────────────────
  const user = await env.DB.prepare('SELECT stripe_customer_id, plan FROM users WHERE id = ?')
    .bind(userId).first();

  let customerId = user?.stripe_customer_id;

  if (!customerId) {
    const customerRes = await stripePost('https://api.stripe.com/v1/customers', {
      email: email || '',
      metadata: { clerk_user_id: userId },
    }, env.STRIPE_SECRET_KEY);
    if (!customerRes.ok) return jsonError('Failed to create Stripe customer', 500);
    const customer = await customerRes.json();
    customerId = customer.id;
    await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
      .bind(customerId, userId).run();
  }

  // ── 4. Create Checkout session ────────────────────────────────
  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    'mode': 'subscription',
    'customer': customerId,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': 'https://stackedapp.co/app?upgraded=true',
    'cancel_url': 'https://stackedapp.co/app',
    'metadata[user_id]': userId,
    'subscription_data[metadata][user_id]': userId,
    'allow_promotion_codes': 'true',
  });

  const sessionRes = await stripePost('https://api.stripe.com/v1/checkout/sessions', params, env.STRIPE_SECRET_KEY);
  if (!sessionRes.ok) {
    const err = await sessionRes.text();
    return jsonError(`Stripe error: ${err.slice(0, 200)}`, 500);
  }
  const session = await sessionRes.json();

  return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: CORS_HEADERS });
}

// ── Helpers ───────────────────────────────────────────────────────

function stripePost(url, params, secretKey) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params instanceof URLSearchParams ? params : new URLSearchParams(params),
  });
}

async function verifyClerkJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const decode = (b64) => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
  const header  = decode(parts[0]);
  const payload = decode(parts[1]);

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('Token expired');
  }

  // Fetch Clerk JWKS
  const jwksRes = await fetch('https://clerk.stackedapp.co/.well-known/jwks.json');
  if (!jwksRes.ok) throw new Error('Failed to fetch JWKS');
  const jwks = await jwksRes.json();

  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No matching JWK for kid: ' + header.kid);

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const sigInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const valid    = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, sigInput);
  if (!valid) throw new Error('Invalid signature');

  return payload;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: CORS_HEADERS });
}
