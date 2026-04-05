// Cloudflare Pages Function — POST /api/billing
// Creates a Stripe Checkout session for Pro subscription.

import { verifyClerkToken } from './_clerk.js';

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

  // ── 1. Verify Clerk session token ────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return jsonError('Unauthorized', 401);

  let clerkPayload;
  try {
    clerkPayload = await verifyClerkToken(token);
  } catch {
    return jsonError('Invalid session token', 401);
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
    if (!customerRes.ok) return jsonError('Failed to create Stripe customer', 502);
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
    return jsonError(`Stripe error: ${err.slice(0, 200)}`, 502);
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


function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: CORS_HEADERS });
}
