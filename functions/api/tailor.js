// Cloudflare Pages Function — POST /api/tailor
// Accepts a PDF (base64) or plain text resume, calls Anthropic Claude via document API.

const SYSTEM_INSTRUCTION = `You are an expert ATS-optimized resume tailoring assistant.

You will receive a candidate's resume PDF and a job description. Your job:
1. Read the PDF to extract ALL content exactly as it appears — every role, date, company, project, education, skill, and bullet.
2. Identify the original section order from the resume (e.g. Education before Experience, or Skills before Projects).
3. Rewrite the resume content to be ATS-optimized for the provided job description, WITHOUT changing any facts.

STRICT RULES:
- Do NOT fabricate, invent, or assume any experience, skill, certification, metric, title, employer, date, tool, or achievement.
- Do NOT change job titles, companies, dates, or degree names.
- Do NOT inflate seniority or impact beyond what the source material supports.
- Preserve every real role, project, and education entry — do not omit them.

REWRITING RULES:
- Rewrite bullets with strong action verbs that mirror the job description language.
- Be specific: each bullet must describe the action + context + result. No vague phrases like "helped with", "assisted team", "participated in", "worked on", or "demonstrated strong work ethic".
- If two bullets say the same thing, combine them into one stronger bullet.
- Front-load the most relevant keyword in each bullet.

SUMMARY RULES:
- If the resume already has a summary: rewrite it to target this specific role, 2-3 sentences.
- If the resume has NO summary: write one from scratch using the resume content, 2-3 sentences targeting this role.
- Never fabricate skills or experience not present in the resume.

ONE PAGE RULE — CRITICAL:
- The output must fill one full page but NEVER exceed it. Every line counts.
- Summary: exactly 2 sentences.
- Experience bullets: 2 per role. No more.
- Project bullets: 2 per project. No more.
- Include ALL experience and project entries from the original resume — do not skip any.
- Keep each bullet to one line where possible — no run-on sentences.

SKILLS RULES:
- Group skills into 3–5 categories. Each category: "CategoryName: skill1, skill2, skill3" (max 5 per group).
- Only include skills explicitly present in the resume.

OUTPUT RULES:
- Return valid JSON only — no markdown, no code fences, no explanation.
- originalSectionOrder must list sections in the order they appear in the uploaded PDF resume.`;

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

  // ── 1. Check API key ──────────────────────────────────────────
  const apiKey = env.ANTHROPHIC_KEY;
  if (!apiKey) {
    return jsonError('ANTHROPHIC_KEY environment variable is not configured.', 500);
  }

  // ── 2. Verify auth + check/enforce usage limit ────────────────
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  let userId = null;
  if (token) {
    try {
      const payload = await verifyClerkJwt(token);
      userId = payload.sub;
    } catch {}
  }

  if (userId && env.DB) {
    const month = new Date().toISOString().slice(0, 7);
    const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(userId).first();
    if (user && user.plan !== 'pro') {
      const usage = await env.DB.prepare(
        'SELECT tailor_count FROM usage WHERE user_id = ? AND month = ?'
      ).bind(userId, month).first();
      const count = usage?.tailor_count || 0;
      if (count >= 3) return jsonError('Free plan limit reached. Upgrade to Pro for unlimited tailoring.', 403);
    }
  }

  // ── 3. Parse + validate request body ─────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  const { resumePdfBase64, jobDescription, targetRole, profileInfo } = body;

  if (!resumePdfBase64 || typeof resumePdfBase64 !== 'string' || resumePdfBase64.length < 100) {
    return jsonError('resumePdfBase64 is required — please upload a PDF resume.', 400);
  }
  if (!jobDescription || typeof jobDescription !== 'string' || jobDescription.trim().length < 20) {
    return jsonError('jobDescription is required and must be at least 20 characters.', 400);
  }

  // ── 3. Build message content (PDF document + text prompt) ─────
  const textPrompt = buildPrompt({ jobDescription, targetRole, profileInfo });

  const messageContent = [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: resumePdfBase64,
      },
      title: 'Candidate Resume',
      context: 'This is the candidate\'s current resume PDF. Extract all content from it exactly as written.',
    },
    {
      type: 'text',
      text: textPrompt,
    },
  ];

  // ── 4. Call Anthropic ─────────────────────────────────────────
  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
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

  // ── 5. Extract response ───────────────────────────────────────
  let anthropicData;
  try {
    anthropicData = await anthropicRes.json();
  } catch {
    return jsonError('Failed to parse Anthropic response as JSON.', 502);
  }

  const rawText = anthropicData?.content?.[0]?.text;
  if (!rawText) {
    const stopReason = anthropicData?.stop_reason;
    return jsonError(`Anthropic returned an empty response. Stop reason: ${stopReason || 'unknown'}`, 502);
  }

  console.log('[tailor] raw Anthropic text (first 1000 chars):', rawText.slice(0, 1000));

  // ── 6. Parse JSON from response ───────────────────────────────
  let tailoredData;
  try {
    tailoredData = JSON.parse(rawText.trim());
  } catch {
    let cleanedText = rawText.trim()
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/\s*```/g, '')
      .trim();
    const jsonStart = cleanedText.indexOf('{');
    const jsonEnd = cleanedText.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }
    try {
      tailoredData = JSON.parse(cleanedText);
    } catch {
      return jsonError(`Failed to parse response as JSON. Raw: ${rawText.slice(0, 500)}`, 502);
    }
  }

  // ── 7. Normalize fields ───────────────────────────────────────
  const safeData = {
    tailoredSummary:      tailoredData.tailoredSummary      || '',
    tailoredExperience:   Array.isArray(tailoredData.tailoredExperience)   ? tailoredData.tailoredExperience   : [],
    tailoredProjects:     Array.isArray(tailoredData.tailoredProjects)     ? tailoredData.tailoredProjects     : [],
    education:            Array.isArray(tailoredData.education)            ? tailoredData.education            : [],
    tailoredSkills:       Array.isArray(tailoredData.tailoredSkills)       ? tailoredData.tailoredSkills       : [],
    originalSectionOrder: Array.isArray(tailoredData.originalSectionOrder) ? tailoredData.originalSectionOrder : [],
    matchedKeywords:      Array.isArray(tailoredData.matchedKeywords)      ? tailoredData.matchedKeywords      : [],
    missingKeywords:      Array.isArray(tailoredData.missingKeywords)      ? tailoredData.missingKeywords      : [],
    atsNotes:             tailoredData.atsNotes             || '',
    honestyWarnings:      Array.isArray(tailoredData.honestyWarnings)      ? tailoredData.honestyWarnings      : [],
  };

  // ── 8. Increment usage counter ───────────────────────────────
  if (userId && env.DB) {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare(`
      INSERT INTO usage (user_id, month, tailor_count, coverletter_count) VALUES (?, ?, 1, 0)
      ON CONFLICT (user_id, month) DO UPDATE SET tailor_count = tailor_count + 1
    `).bind(userId, month).run();
  }

  return new Response(
    JSON.stringify({ success: true, data: safeData }),
    { status: 200, headers: CORS_HEADERS }
  );
}

// ── Helpers ───────────────────────────────────────────────────────

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
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: CORS_HEADERS,
  });
}

function buildPrompt({ jobDescription, targetRole, profileInfo }) {
  const lines = [];

  if (targetRole) lines.push(`TARGET ROLE: ${targetRole}\n`);

  lines.push('=== JOB DESCRIPTION ===');
  lines.push(jobDescription.trim());
  lines.push('');

  if (profileInfo && typeof profileInfo === 'object') {
    const p = profileInfo;
    const pl = [];
    if (p.name)     pl.push(`Name: ${p.name}`);
    if (p.email)    pl.push(`Email: ${p.email}`);
    if (p.phone)    pl.push(`Phone: ${p.phone}`);
    if (p.city)     pl.push(`Location: ${p.city}`);
    if (p.linkedin) pl.push(`LinkedIn: ${p.linkedin}`);
    if (p.portfolio)pl.push(`Portfolio: ${p.portfolio}`);
    if (pl.length) {
      lines.push('=== CANDIDATE PROFILE (contact info only — do not invent content) ===');
      lines.push(pl.join('\n'));
      lines.push('');
    }
  }

  lines.push(`Return ONLY a raw JSON object — no markdown, no code fences, no explanation:
{
  "originalSectionOrder": ["summary","education","experience","projects","skills"],
  "tailoredSummary": "3-sentence summary targeting this specific role",
  "tailoredExperience": [{"role":"","company":"","start":"","end":"","bullets":["bullet 1","bullet 2"]}],
  "tailoredProjects": [{"name":"","description":"one-line: what it is + tech used","bullets":["bullet 1","bullet 2"]}],
  "education": [{"institution":"","location":"","degree":"","end":"Expected YYYY","gpa":""}],
  "tailoredSkills": ["Languages: Python, C++","Embedded Systems: Arduino, ESP32","Tools: Git, Multimeter"],
  "matchedKeywords": ["kw1","kw2"],
  "missingKeywords": ["kw1","kw2"],
  "atsNotes": "one sentence",
  "honestyWarnings": []
}

The originalSectionOrder array must exactly match the order sections appear in the uploaded PDF resume.`);

  return lines.join('\n');
}
