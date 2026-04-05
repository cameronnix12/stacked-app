// Cloudflare Pages Function — POST /api/user
// Called from the app on first load after Clerk sign-in.
// Creates the user row in D1 if it doesn't exist, returns plan info.

import { getUserIdFromRequest } from './_clerk.js';

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
  const userId = await getUserId(request, env);
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
  const userId = await getUserId(request, env);
  if (!userId) return jsonError('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON', 400); }

  const { email, name } = body;
  if (!email) return jsonError('email is required', 400);

  // Upsert — create if not exists, ignore if exists
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

async function getUserId(request, env) {
  return getUserIdFromRequest(request);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: CORS_HEADERS });
}
