// Cloudflare Pages Function — POST /api/tailor
// Calls Gemini API server-side so the API key never touches the browser.

const SYSTEM_INSTRUCTION = `[You are an expert ATS-optimized resume and CV tailoring assistant.

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
- Avoid graphics, columns, tables, icons, or decorative formatting.
- Do not keyword-stuff. Keep wording natural.

RESUME RULES:
- Optimize for brevity, scannability, and job relevance.
- Prefer 1 page for early-career candidates when possible.

CV RULES:
- Use the job description plus the user's profile information to strengthen and organize the CV.
- CVs may be more detailed than resumes, but must still remain truthful and relevant.

OUTPUT RULES:
- Return valid JSON only.
- If a keyword is important but unsupported by the source material, place it in missingKeywords instead of inserting it.
- If something seems useful but unsupported, mention it in honestyWarnings.]`;

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError('GEMINI_API_KEY environment variable is not configured.', 500);
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

  // ── 4. Call Gemini ────────────────────────────────────────────
  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseSchema: {
            type: 'OBJECT',
            properties: {
              tailoredSummary:    { type: 'STRING' },
              tailoredExperience: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    role:    { type: 'STRING' },
                    company: { type: 'STRING' },
                    start:   { type: 'STRING' },
                    end:     { type: 'STRING' },
                    bullets: { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                },
              },
              tailoredProjects: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name:        { type: 'STRING' },
                    description: { type: 'STRING' },
                    bullets:     { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                },
              },
              tailoredSkills:   { type: 'ARRAY', items: { type: 'STRING' } },
              matchedKeywords:  { type: 'ARRAY', items: { type: 'STRING' } },
              missingKeywords:  { type: 'ARRAY', items: { type: 'STRING' } },
              atsNotes:                    { type: 'STRING' },
              honestyWarnings:             { type: 'ARRAY', items: { type: 'STRING' } },
              contentRanking:              { type: 'ARRAY', items: { type: 'STRING' } },
              removedOrDeemphasizedContent:{ type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: [
              'tailoredSummary', 'tailoredExperience', 'tailoredProjects',
              'tailoredSkills', 'matchedKeywords', 'missingKeywords',
              'atsNotes', 'honestyWarnings', 'contentRanking',
              'removedOrDeemphasizedContent',
            ],
          },
        },
      }),
    });
  } catch (err) {
    return jsonError(`Failed to reach Gemini API: ${err.message}`, 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    return jsonError(`Gemini API returned status ${geminiRes.status}: ${errText.slice(0, 300)}`, 502);
  }

  // ── 5. Extract Gemini response ────────────────────────────────
  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch {
    return jsonError('Failed to parse Gemini response as JSON.', 502);
  }

  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    // Check for safety blocks
    const finishReason = geminiData?.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') {
      return jsonError('Gemini blocked the response for safety reasons. Try rephrasing your input.', 422);
    }
    return jsonError('Gemini returned an empty response.', 502);
  }

  // Temporary logging for debugging — remove once JSON parsing is stable
  console.log('[tailor] raw Gemini text (first 1000 chars):', rawText.slice(0, 1000));
  console.log('[tailor] rawText length:', rawText.length);

  // ── 6. Parse structured JSON from Gemini ─────────────────────
  let tailoredData;
  try {
    // First, try to parse directly
    tailoredData = JSON.parse(rawText.trim());
  } catch {
    // If direct parse fails, try to clean up the text
    let cleanedText = rawText.trim();

    // Strip markdown code fences — works even when extra text precedes/follows
    // e.g. "Here you go:\n```json\n{...}\n```\nDone."
    cleanedText = cleanedText
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/\s*```/g, '')
      .trim();

    // Try to extract JSON object from text (find first { to last })
    const jsonStart = cleanedText.indexOf('{');
    const jsonEnd = cleanedText.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }

    try {
      tailoredData = JSON.parse(cleanedText);
    } catch (parseError) {
      // If all parsing attempts fail, return error with raw text for debugging
      return jsonError(`Gemini returned malformed JSON. Raw response: ${rawText.slice(0, 500)}`, 502);
    }
  }

  // ── 7. Ensure all expected fields exist (never crash frontend) ─
  const safeData = {
    tailoredSummary:    tailoredData.tailoredSummary    || '',
    tailoredExperience: Array.isArray(tailoredData.tailoredExperience) ? tailoredData.tailoredExperience : [],
    tailoredProjects:   Array.isArray(tailoredData.tailoredProjects)   ? tailoredData.tailoredProjects   : [],
    tailoredSkills:     Array.isArray(tailoredData.tailoredSkills)     ? tailoredData.tailoredSkills     : [],
    matchedKeywords:    Array.isArray(tailoredData.matchedKeywords)    ? tailoredData.matchedKeywords    : [],
    missingKeywords:    Array.isArray(tailoredData.missingKeywords)    ? tailoredData.missingKeywords    : [],
    atsNotes:           tailoredData.atsNotes           || '',
    honestyWarnings:              Array.isArray(tailoredData.honestyWarnings)              ? tailoredData.honestyWarnings              : [],
    contentRanking:               Array.isArray(tailoredData.contentRanking)               ? tailoredData.contentRanking               : [],
    removedOrDeemphasizedContent: Array.isArray(tailoredData.removedOrDeemphasizedContent) ? tailoredData.removedOrDeemphasizedContent : [],
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

  lines.push(`CONTENT STRATEGY (do this mentally before writing):
1. Rank all experience entries and projects by relevance to THIS specific job description. Most relevant first.
2. Within each role, reorder bullets so the most job-aligned achievement comes first.
3. If a role or project is largely irrelevant, reduce its bullets to 1-2 and keep them brief.
4. Cut or minimize generic filler bullets (e.g. "assisted team", "participated in meetings").
5. Strengthen every kept bullet: add specificity, quantify if numbers exist in the source, use strong action verbs that echo the JD.
6. The summary must name the specific role/domain from the JD and reference 2-3 of the candidate's most relevant strengths.
7. Skills list: include only skills clearly supported by the resume that are also relevant to the JD.

Return a single JSON object with EXACTLY these fields — no markdown, no code fences, no extra text, ONLY the raw JSON object:
{
  "tailoredSummary": "2-4 sentence professional summary specifically targeting this role, referencing key JD requirements",
  "tailoredExperience": [
    {
      "role": "exact job title from resume",
      "company": "exact company name from resume",
      "start": "start date from resume",
      "end": "end date or Present",
      "bullets": ["strongest most-relevant bullet first", "second bullet", "..."]
    }
  ],
  "tailoredProjects": [
    {
      "name": "project name from resume",
      "description": "one-line description",
      "bullets": ["most relevant bullet first", "..."]
    }
  ],
  "tailoredSkills": ["only skills present in resume that are relevant to this JD", "..."],
  "matchedKeywords": ["exact keyword from JD that clearly appears in the tailored resume", "..."],
  "missingKeywords": ["important JD keyword that is NOT supported by the resume", "..."],
  "atsNotes": "1-2 sentence ATS feedback: what is strong and what gaps remain",
  "honestyWarnings": ["specific content that was flagged as unverifiable or potentially embellished", "..."],
  "contentRanking": ["most relevant role/project first", "second most relevant", "..."],
  "removedOrDeemphasizedContent": ["brief description of what was cut or reduced and why", "..."]
}`);

  return lines.join('\n');
}
