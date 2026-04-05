// Cloudflare Pages Function — POST /api/coverletter
// Accepts optional resume PDF + job description, generates a tailored cover letter.

const SYSTEM_INSTRUCTION = `You are an expert cover letter writer for college students and recent graduates. You write short, honest, personalized cover letters that sound like a real person wrote them.

STRUCTURE RULES:
- Address a real person if a hiring manager name is provided; otherwise use "Hiring Manager"
- First sentence must name the company's specific challenge or goal pulled directly from the job description
- Show you researched the company — reference their mission, product, or a specific detail from the JD
- 3 short paragraphs ONLY — no more, no less
- Focus entirely on what the candidate will contribute, not what they want from the company
- No generic phrases: "team player", "fast learner", "passionate", "detail-oriented", "hard worker", "I believe", "I feel", "I think"

TONE RULES:
- Sound like a real person in their early 20s who is confident but not arrogant
- No corporate speak. Never use: "leverage," "synergy," "utilize," "facilitate," "spearhead," "impactful"
- Short sentences. Active voice only.
- Never use em dashes (—)
- Write the way a smart student actually talks, not like a LinkedIn post

CRITICAL ACCURACY RULES:
- Only mention skills, tools, projects, and experiences the candidate explicitly provided. Do not invent or assume anything.
- If they only listed basic coursework, only reference basic coursework. Do not call it "extensive experience" or "advanced proficiency."
- Do not add technologies, frameworks, languages, or tools that were not mentioned by the candidate.
- Do not exaggerate titles or responsibilities. If they said "class project" do not call it "professional experience."
- If the candidate has limited experience, lead with enthusiasm, learning ability, and relevant coursework — not fabricated skills.
- A shorter honest letter beats a longer dishonest one every time.

OUTPUT: Return ONLY a raw JSON object — no markdown, no code fences, no explanation:
{
  "salutation": "Ms. Johnson" or "Hiring Manager",
  "hiringManagerName": "Sarah Johnson" or "",
  "hiringManagerTitle": "Head of Engineering" or "",
  "companyName": "Anthropic",
  "paragraphs": [
    "Opening paragraph — first sentence names specific challenge/goal, explains why you are excited about THIS company specifically",
    "Middle paragraph — your most relevant real experience or coursework, one specific thing that maps to their need",
    "Closing paragraph — what you will contribute, confident direct call to action"
  ]
}`;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.ANTHROPHIC_KEY;
  if (!apiKey) return jsonError('ANTHROPHIC_KEY environment variable is not configured.', 500);

  // ── Auth + usage limit check ──────────────────────────────────
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  let userId = null;
  if (token) {
    try { const p = await verifyClerkJwt(token); userId = p.sub; } catch {}
  }
  if (userId && env.DB) {
    const month = new Date().toISOString().slice(0, 7);
    const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(userId).first();
    if (user && user.plan !== 'pro') {
      const usage = await env.DB.prepare('SELECT coverletter_count FROM usage WHERE user_id = ? AND month = ?').bind(userId, month).first();
      if ((usage?.coverletter_count || 0) >= 3) return jsonError('Free plan limit reached. Upgrade to Pro for unlimited cover letters.', 403);
    }
  }

  let body;
  try { body = await request.json(); } catch { return jsonError('Request body must be valid JSON.', 400); }

  const { jobDescription, companyName, hiringManagerName, profileInfo, resumePdfBase64 } = body;

  if (!jobDescription || typeof jobDescription !== 'string' || jobDescription.trim().length < 20) {
    return jsonError('jobDescription is required and must be at least 20 characters.', 400);
  }

  // Build prompt
  const lines = [];
  if (companyName) lines.push(`COMPANY: ${companyName}`);
  if (hiringManagerName) lines.push(`HIRING MANAGER: ${hiringManagerName}`);
  lines.push('\n=== JOB DESCRIPTION ===');
  lines.push(jobDescription.trim());

  if (profileInfo && typeof profileInfo === 'object') {
    const p = profileInfo;
    const pl = [];
    if (p.name)     pl.push(`Name: ${p.name}`);
    if (p.email)    pl.push(`Email: ${p.email}`);
    if (p.uni)      pl.push(`University: ${p.uni}`);
    if (p.major)    pl.push(`Major: ${p.major}`);
    if (p.gradyear) pl.push(`Graduation: ${p.gradyear}`);
    if (p.summary)  pl.push(`Summary: ${p.summary}`);
    if (pl.length) {
      lines.push('\n=== CANDIDATE PROFILE ===');
      lines.push(pl.join('\n'));
    }
  }

  lines.push('\nReturn ONLY the JSON object described in the system prompt.');
  const textPrompt = lines.join('\n');

  // Build message content
  const messageContent = [];
  if (resumePdfBase64 && resumePdfBase64.length > 100) {
    messageContent.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: resumePdfBase64 },
      title: 'Candidate Resume',
      context: 'Use this resume to understand the candidate\'s real background, skills, and experience.',
    });
  }
  messageContent.push({ type: 'text', text: textPrompt });

  let anthropicRes;
  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (resumePdfBase64 && resumePdfBase64.length > 100) {
      reqHeaders['anthropic-beta'] = 'pdfs-2024-09-25';
    }
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_INSTRUCTION,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });
  } catch (err) {
    return jsonError(`Failed to reach Anthropic API: ${err.message}`, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return jsonError(`Anthropic API returned status ${anthropicRes.status}: ${errText.slice(0, 300)}`, 502);
  }

  let anthropicData;
  try { anthropicData = await anthropicRes.json(); } catch { return jsonError('Failed to parse Anthropic response.', 502); }

  const rawText = anthropicData?.content?.[0]?.text;
  if (!rawText) return jsonError(`Anthropic returned empty response. Stop: ${anthropicData?.stop_reason}`, 502);

  let data;
  try {
    data = JSON.parse(rawText.trim());
  } catch {
    let cleaned = rawText.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
    const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
    if (s !== -1 && e > s) cleaned = cleaned.substring(s, e + 1);
    try { data = JSON.parse(cleaned); } catch { return jsonError(`Failed to parse JSON: ${rawText.slice(0, 400)}`, 502); }
  }

  const safeData = {
    salutation:         data.salutation         || 'Hiring Manager',
    hiringManagerName:  data.hiringManagerName  || '',
    hiringManagerTitle: data.hiringManagerTitle || '',
    companyName:        data.companyName        || companyName || '',
    paragraphs:         Array.isArray(data.paragraphs) ? data.paragraphs : [data.body || ''],
  };

  // ── Increment usage ───────────────────────────────────────────
  if (userId && env.DB) {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare(`
      INSERT INTO usage (user_id, month, tailor_count, coverletter_count) VALUES (?, ?, 0, 1)
      ON CONFLICT (user_id, month) DO UPDATE SET coverletter_count = coverletter_count + 1
    `).bind(userId, month).run();
  }

  return new Response(JSON.stringify({ success: true, data: safeData }), { status: 200, headers: CORS_HEADERS });
}

async function verifyClerkJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const decode = (b64) => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
  const header = decode(parts[0]);
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
