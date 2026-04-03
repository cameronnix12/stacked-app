// Cloudflare Pages Function — POST /api/tailor
// Calls Anthropic Claude API server-side so the API key never touches the browser.

const SYSTEM_INSTRUCTION = `You are an expert ATS-optimized resume and CV tailoring assistant.

Your job is to transform a user's existing resume or CV into the strongest possible version for a specific job description, without adding false information.

STRICT RULES:
- Do NOT fabricate, invent, infer, or assume any experience, skill, certification, metric, title, employer, date, tool, responsibility, or achievement.
- Do NOT add keywords unless they are clearly supported by the provided resume, CV, or user profile.
- Do NOT change job titles, companies, dates, degree names, or timelines unless the source input explicitly shows a correction.
- Do NOT inflate impact or seniority.
- Do NOT copy the user's text mechanically if it can be improved.
- Rewrite aggressively for clarity, keyword alignment, ATS readability, and relevance, while preserving truth.

ATS GOALS:
- Prioritize exact alignment with the job description.
- Use strong action verbs.
- Make bullets concise, specific, and scannable.
- Front-load the most relevant words.
- Prefer standard ATS-friendly phrasing over creative wording.
- Do not keyword-stuff. Keep wording natural.

RESUME RULES:
- Optimize for brevity, scannability, and job relevance.
- Prefer 1 page for early-career candidates when possible.

OUTPUT RULES:
- Return valid JSON only — no markdown, no code fences, no explanation text.
- If a keyword is important but unsupported by the source material, place it in missingKeywords instead of inserting it.
- If something seems useful but unsupported, mention it in honestyWarnings.`;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Handle preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Handle POST /api/tailor
export async function onRequestPost(context) {
  const { request, env } = context;

  // ── 1. Check API key ──────────────────────────────────────────
  const apiKey = env.ANTHROPHIC_KEY;
  if (!apiKey) {
    return jsonError('ANTHROPHIC_KEY environment variable is not configured.', 500);
  }

  // ── 2. Parse + validate request body ─────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  const { resumeText, jobDescription, targetRole, profileInfo } = body;

  if (!resumeText || typeof resumeText !== 'string' || resumeText.trim().length < 50) {
    return jsonError('resumeText is required and must be at least 50 characters.', 400);
  }
  if (!jobDescription || typeof jobDescription !== 'string' || jobDescription.trim().length < 20) {
    return jsonError('jobDescription is required and must be at least 20 characters.', 400);
  }

  // ── 3. Build prompt ───────────────────────────────────────────
  const userPrompt = buildPrompt({ resumeText, jobDescription, targetRole, profileInfo });

  // ── 4. Call Anthropic ─────────────────────────────────────────
  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: SYSTEM_INSTRUCTION,
        messages: [{ role: 'user', content: userPrompt }],
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
  console.log('[tailor] rawText length:', rawText.length);

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
      return jsonError(`Failed to parse response as JSON. Raw response: ${rawText.slice(0, 500)}`, 502);
    }
  }

  // ── 7. Normalize fields ───────────────────────────────────────
  const safeData = {
    tailoredSummary:    tailoredData.tailoredSummary    || '',
    tailoredExperience: Array.isArray(tailoredData.tailoredExperience) ? tailoredData.tailoredExperience : [],
    tailoredProjects:   Array.isArray(tailoredData.tailoredProjects)   ? tailoredData.tailoredProjects   : [],
    tailoredSkills:     Array.isArray(tailoredData.tailoredSkills)     ? tailoredData.tailoredSkills     : [],
    matchedKeywords:    Array.isArray(tailoredData.matchedKeywords)    ? tailoredData.matchedKeywords    : [],
    missingKeywords:    Array.isArray(tailoredData.missingKeywords)    ? tailoredData.missingKeywords    : [],
    atsNotes:           tailoredData.atsNotes           || '',
    honestyWarnings:    Array.isArray(tailoredData.honestyWarnings)    ? tailoredData.honestyWarnings    : [],
  };

  return new Response(
    JSON.stringify({ success: true, data: safeData }),
    { status: 200, headers: CORS_HEADERS }
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: CORS_HEADERS,
  });
}

function buildPrompt({ resumeText, jobDescription, targetRole, profileInfo }) {
  const lines = ['Tailor the following resume or CV for the job description below.\n'];

  if (targetRole) lines.push(`TARGET ROLE: ${targetRole}\n`);

  lines.push('=== RESUME / CV TEXT ===');
  lines.push(resumeText.trim());
  lines.push('');

  lines.push('=== JOB DESCRIPTION ===');
  lines.push(jobDescription.trim());
  lines.push('');

  if (profileInfo && typeof profileInfo === 'object') {
    const p = profileInfo;
    const profileLines = [];
    if (p.name)     profileLines.push(`Name: ${p.name}`);
    if (p.email)    profileLines.push(`Email: ${p.email}`);
    if (p.phone)    profileLines.push(`Phone: ${p.phone}`);
    if (p.linkedin) profileLines.push(`LinkedIn: ${p.linkedin}`);
    if (p.portfolio)profileLines.push(`Portfolio: ${p.portfolio}`);
    if (p.uni)      profileLines.push(`University: ${p.uni}`);
    if (p.major)    profileLines.push(`Major: ${p.major}`);
    if (p.gradyear) profileLines.push(`Graduation Year: ${p.gradyear}`);
    if (p.gpa)      profileLines.push(`GPA: ${p.gpa}`);
    if (p.summary)  profileLines.push(`Profile Summary: ${p.summary}`);
    if (Array.isArray(p.skills) && p.skills.length > 0) {
      profileLines.push(`Skills: ${p.skills.join(', ')}`);
    }
    if (profileLines.length > 0) {
      lines.push('=== USER PROFILE (supplementary context only — do not invent details) ===');
      lines.push(profileLines.join('\n'));
      lines.push('');
    }
  }

  lines.push(`CONTENT RULES:
1. tailoredSummary: 2-3 sentences max. Name the target role and 2 concrete strengths. No fluff.
2. Bullets: Start with a strong action verb. Be specific — describe the action, its context, and result. Never write vague phrases like "demonstrated strong work ethic", "assisted team", "participated in meetings", "helped with", or "worked on". If two bullets say similar things, combine them into one stronger bullet.
3. MAX 3 bullets per experience role. Irrelevant roles get 1-2 bullets max.
4. MAX 3 bullets per project. Skip projects with zero relevance to the JD.
5. Each project must include a short one-line description (description field) — what it is and what tech it used.
6. Never fabricate titles, companies, dates, metrics, or tools.
7. tailoredSkills: Group skills into categories using this format — each array item is one category string: "Languages: Python, C++" or "Tools: Git, VS Code". Use 3–5 category groups, MAX 5 items per group. Only include skills from the source resume.
8. matchedKeywords: MAX 15 items. missingKeywords: MAX 8 items.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation text before or after:
{
  "tailoredSummary": "2-3 sentence summary targeting this specific role",
  "tailoredExperience": [{"role":"","company":"","start":"","end":"","bullets":["bullet 1","bullet 2"]}],
  "tailoredProjects": [{"name":"","description":"one-line description of what it is and what tech","bullets":["bullet 1","bullet 2"]}],
  "tailoredSkills": ["Languages: Python, C++","Embedded Systems: Arduino, ESP32","Tools: Git, Multimeter"],
  "matchedKeywords": ["kw1","kw2"],
  "missingKeywords": ["kw1","kw2"],
  "atsNotes": "one sentence",
  "honestyWarnings": []
}`);

  return lines.join('\n');
}
