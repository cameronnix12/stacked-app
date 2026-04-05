// Cloudflare Pages Function — POST /api/portal
// Creates a Stripe Customer Portal session for managing/cancelling subscription.

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
    return new Response(JSON.stringify({ success: false, error: 'Unhandled: ' + e.message }), { status: 500, headers: CORS_HEADERS });
  }
}

async function handlePost(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return jsonError('Unauthorized', 401);

  let userId;
  try {
    const payload = await verifyClerkJwt(token);
    userId = payload.sub;
  } catch (e) {
    return jsonError('Invalid session token: ' + e.message, 401);
  }

  const user = await env.DB.prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
    .bind(userId).first();

  if (!user?.stripe_customer_id) return jsonError('No subscription found', 400);

  const params = new URLSearchParams({
    customer: user.stripe_customer_id,
    return_url: 'https://stackedapp.co/app',
  });

  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!res.ok) {
    const err = await res.text();
    return jsonError('Stripe error: ' + err.slice(0, 200), 500);
  }

  const session = await res.json();
  return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: CORS_HEADERS });
}

async function verifyClerkJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const decode = (b64) => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
  const header  = decode(parts[0]);
  const payload = decode(parts[1]);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error('Token expired');
  const jwksRes = await fetch('https://clerk.stackedapp.co/.well-known/jwks.json');
  if (!jwksRes.ok) throw new Error('Failed to fetch JWKS');
  const jwks = await jwksRes.json();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No matching JWK');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sigInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, sigInput);
  if (!valid) throw new Error('Invalid signature');
  return payload;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: CORS_HEADERS });
}
