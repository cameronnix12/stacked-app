// Cloudflare Pages Function — POST /api/webhook
// Handles Stripe webhook events to sync subscription state to D1.

export async function onRequestPost(context) {
  const { request, env } = context;

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  // ── 1. Verify Stripe webhook signature ────────────────────────
  let event;
  try {
    event = await verifyStripeWebhook(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return new Response('Webhook signature invalid', { status: 400 });
  }

  console.log('[webhook] event type:', event.type);

  // ── 2. Handle events ──────────────────────────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const subscriptionId = session.subscription;
        const customerId = session.customer;
        if (!userId) break;

        // Fetch subscription to get period end
        const sub = await fetchStripe(
          `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
          env.STRIPE_SECRET_KEY
        );

        await env.DB.prepare(`
          UPDATE users SET
            plan = 'pro',
            stripe_customer_id = ?,
            stripe_subscription_id = ?,
            subscription_status = 'active',
            current_period_end = ?
          WHERE id = ?
        `).bind(customerId, subscriptionId, sub.current_period_end, userId).run();

        console.log('[webhook] upgraded user to pro:', userId);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;

        const sub = await fetchStripe(
          `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
          env.STRIPE_SECRET_KEY
        );
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        await env.DB.prepare(`
          UPDATE users SET
            subscription_status = 'active',
            current_period_end = ?
          WHERE id = ?
        `).bind(sub.current_period_end, userId).run();
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;

        const sub = await fetchStripe(
          `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
          env.STRIPE_SECRET_KEY
        );
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        await env.DB.prepare(`
          UPDATE users SET subscription_status = 'past_due' WHERE id = ?
        `).bind(userId).run();

        console.log('[webhook] payment failed for user:', userId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        await env.DB.prepare(`
          UPDATE users SET
            plan = 'free',
            subscription_status = 'canceled',
            stripe_subscription_id = NULL
          WHERE id = ?
        `).bind(userId).run();

        console.log('[webhook] downgraded user to free:', userId);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        const isActive = sub.status === 'active' || sub.status === 'trialing';
        await env.DB.prepare(`
          UPDATE users SET
            plan = ?,
            subscription_status = ?,
            current_period_end = ?
          WHERE id = ?
        `).bind(isActive ? 'pro' : 'free', sub.status, sub.current_period_end, userId).run();
        break;
      }

      default:
        console.log('[webhook] unhandled event:', event.type);
    }
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Helpers ───────────────────────────────────────────────────────

async function verifyStripeWebhook(payload, sigHeader, webhookSecret) {
  // Stripe uses HMAC-SHA256 to sign webhooks.
  // Cloudflare Workers support the WebCrypto API natively.
  const parts = (sigHeader || '').split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) throw new Error('Missing signature parts');

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);
  const signedPayload = `${timestamp}.${payload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  if (computedSig !== expectedSig) throw new Error('Signature mismatch');

  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    throw new Error('Webhook timestamp too old');
  }

  return JSON.parse(payload);
}

async function fetchStripe(url, secretKey) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${secretKey}` },
  });
  if (!res.ok) throw new Error(`Stripe fetch failed: ${url}`);
  return res.json();
}
