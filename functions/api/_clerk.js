// Shared Clerk JWT verification using JWKS — works in Cloudflare Workers

const JWKS_URL = 'https://clerk.stackedapp.co/.well-known/jwks.json';
let _jwksCache = null;

async function getJwks() {
  if (_jwksCache) return _jwksCache;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Failed to fetch JWKS');
  _jwksCache = await res.json();
  return _jwksCache;
}

export async function verifyClerkToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const decode = (b64) => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
  const header  = decode(parts[0]);
  const payload = decode(parts[1]);

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('Token expired');
  }

  const jwks = await getJwks();
  const jwk  = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No matching JWK');

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const sigInput  = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sigBytes  = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const valid     = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, sigInput);
  if (!valid) throw new Error('Invalid signature');

  return payload;
}

export async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const payload = await verifyClerkToken(token);
    return payload.sub || null;
  } catch { return null; }
}
