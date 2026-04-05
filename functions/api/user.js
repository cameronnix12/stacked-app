// Cloudflare Pages Function — GET/POST /api/user

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/user — return current user plan + usage
export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = await getUserId(request);
  if (!userId) return jsonError('Unauthorized', 401);

  const user = await env.DB.prepare('SELECT plan, subscription_status, current_period_end FROM users WHERE id = ?')
    .bind(userId).first();

  if (!user) return jsonError('User not found', 404);

  const month = new Date().toISOString().slice(0, 7);
  const usage = await env.DB.prepare('SELECT tailor_count, coverletter_count FROM usage WHERE user_id = ? AND month = ?')
    .bind(userId, month).first();

  return new Response(JSON.stringify({
    success: true,
    plan: user.plan,
    subscriptionStatus: user.subscription_status,
    currentPeriodEnd: user.current_period_end,
    usage: {
      tailor: usage?.tailor_count || 0,
      coverLetter: usage?.coverletter_count || 0,
      tailorLimit: user.plan === 'pro' ? null : 3,
      coverLetterLimit: user.plan === 'pro' ? null : 2,
    },
  }), { status: 200, headers: CORS_HEADERS });
}

// POST /api/user — upsert user on signup/signin
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = await getUserId(request);
  if (!userId) return jsonError('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON', 400); }

  const { email, name } = body;
  if (!email) return jsonError('email is required', 400);

  await env.DB.prepare(`
    INSERT INTO users (id, email, name) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name
  `).bind(userId, email, name || '').run();

  const user = await env.DB.prepare('SELECT plan, subscription_status FROM users WHERE id = ?')
    .bind(userId).first();

  return new Response(JSON.stringify({ success: true, plan: user.plan }), {
    status: 200, headers: CORS_HEADERS,
  });
}

// ── Helpers ───────────────────────────────────────────────────────

async function getUserId(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const payload = await verifyClerkJwt(token);
    return payload.sub || null;
  } catch { return null; }
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

  const jwksRes = await fetch('https://clerk.stackedapp.co/.well-known/jwks.json');
  if (!jwksRes.ok) throw new Error('Failed to fetch JWKS');
  const jwks = await jwksRes.json();

  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No matching JWK');

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
