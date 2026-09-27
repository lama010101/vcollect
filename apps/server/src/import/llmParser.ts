// =============================================================================
// LLM script parser — uses a free LLM (Ollama local or Groq online) to parse
// freeform music-video scripts into structured shot data.
//
// Supported providers (both free, both OpenAI-compatible API):
//   - Ollama (local):  No API key. Install from ollama.com, run `ollama pull llama3.2`.
//                      Default URL: http://localhost:11434/v1
//   - Groq (online):   Free API key from console.groq.com.
//                      Default URL: https://api.groq.com/openai/v1
//                      Default model: llama-3.3-70b-versatile
//
// The LLM can parse scripts in ANY format — treatments, screenplays, prose,
// bullet lists — not just the strict conventional format. It extracts shots
// with section, lyrics, visual description, search query, duration, and
// computes time ranges by sequential packing.
// =============================================================================

import { config } from "../config.js";
import type { ParsedScript, ParsedShot, ParsedSection, ParseError } from "./scriptParser.js";

// --- Provider resolution -----------------------------------------------------

export type LlmProvider = "ollama" | "groq" | "openrouter" | "custom";

interface ResolvedLlm {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.2" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free" },
  custom: { baseUrl: "", model: "" },
};

/** Resolve the LLM config from env vars. Returns null if LLM is not configured. */
export function resolveLlm(): ResolvedLlm | null {
  const provider = (config.llmProvider || "").toLowerCase();
  if (!provider || provider === "none" || provider === "off") return null;

  const p = (DEFAULTS[provider as LlmProvider] ? provider : "custom") as LlmProvider;
  const def = DEFAULTS[p]!;
  return {
    provider: p,
    baseUrl: config.llmBaseUrl || def.baseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel || def.model,
  };
}

/** Check if the LLM is reachable (for the status endpoint). */
export async function checkLlmStatus(): Promise<{
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  reachable: boolean;
  error: string | null;
}> {
  const llm = resolveLlm();
  if (!llm) {
    return { configured: false, provider: "", model: "", baseUrl: "", reachable: false, error: "LLM not configured (set LLM_PROVIDER in .env.local)" };
  }
  // For Ollama, check /api/tags. For others, try a minimal models list.
  try {
    if (llm.provider === "ollama") {
      const res = await fetch(`${llm.baseUrl.replace(/\/v1$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { configured: true, provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl, reachable: true, error: null };
    }
    // Groq / OpenRouter / custom: try GET /models with auth header.
    const res = await fetch(`${llm.baseUrl}/models`, {
      headers: llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { configured: true, provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl, reachable: true, error: null };
  } catch (e) {
    return { configured: true, provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl, reachable: false, error: (e as Error).message };
  }
}

// --- LLM prompt ---------------------------------------------------------------

const SYSTEM_PROMPT = `You are a music video script parser. You receive a music video script in any format (treatment, screenplay, prose, bullet list, etc.) and must extract structured shot data.

Return ONLY a JSON object (no markdown, no explanation) with this exact shape:
{
  "sections": [
    {
      "name": "SECTION_NAME (UPPER_SNAKE_CASE)",
      "startSeconds": <number or null>,
      "endSeconds": <number or null>,
      "lyrics": ["lyric line 1", "lyric line 2"],
      "shots": [
        {
          "visualDescription": "What the shot shows",
          "searchQuery": "English search terms for stock footage (concise, 3-6 words)",
          "targetDurationSeconds": <number>,
          "priority": <1-10, default 5>,
          "referenceImageUrl": <string URL or null>
        }
      ]
    }
  ]
}

Rules:
- Extract every visual shot described in the script.
- If the script has timecodes or timestamps, use them for startSeconds/endSeconds. If not, set them to null.
- If the script has lyrics, attach them to the section they belong to.
- If no explicit duration is given, estimate 2-3 seconds per shot.
- searchQuery should be concise English terms suitable for searching Pexels/Pixabay stock video (e.g. "children playing outdoors sunny").
- If the script mentions a reference image URL, include it. Otherwise null.
- Section names must be UPPER_SNAKE_CASE (e.g. INTRO, VERSE_1, CHORUS, BRIDGE).
- If the script has no explicit sections, create one section called "MAIN".
- Do NOT include timeStartSeconds or timeEndSeconds in shots — those are computed by sequential packing.`;

// --- LLM API call -------------------------------------------------------------

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

async function callLlm(llm: ResolvedLlm, userPrompt: string): Promise<string> {
  const url = `${llm.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;

  const body = {
    model: llm.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1, // low temperature for deterministic parsing
    max_tokens: 8000,
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000), // 2 min timeout for long scripts
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty response");
  return content;
}

// --- Response parsing ---------------------------------------------------------

/** Extract JSON from an LLM response that may be wrapped in markdown fences. */
function extractJson(raw: string): string {
  // Strip markdown code fences if present.
  let s = raw.trim();
  // Remove leading ```json or ``` and trailing ```
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Find the first { and last } to extract the JSON object.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM response contains no JSON object");
  return s.slice(start, end + 1);
}

interface LlmShot {
  visualDescription: string;
  searchQuery: string;
  targetDurationSeconds: number;
  priority: number;
  referenceImageUrl: string | null;
}

interface LlmSection {
  name: string;
  startSeconds: number | null;
  endSeconds: number | null;
  lyrics: string[];
  shots: LlmShot[];
}

interface LlmResponse {
  sections: LlmSection[];
}

/** Validate and sanitize a single shot from the LLM response. */
function sanitizeShot(shot: LlmShot, shotNumber: number, section: string, lyrics: string | null, timeStart: number): ParsedShot {
  const duration = Math.max(0.5, Math.min(600, Number(shot.targetDurationSeconds) || 2));
  const priority = Math.max(1, Math.min(10, Math.round(Number(shot.priority) || 5)));
  const desc = String(shot.visualDescription || "").trim() || "Untitled shot";
  const query = String(shot.searchQuery || "").trim() || desc;
  const ref = shot.referenceImageUrl ? String(shot.referenceImageUrl).trim() : null;
  return {
    shotNumber,
    section,
    lyrics,
    visualDescription: desc,
    searchQuery: query,
    targetDurationSeconds: duration,
    priority,
    referenceImageUrl: ref && ref !== "null" ? ref : null,
    timeStartSeconds: timeStart,
    timeEndSeconds: timeStart + duration,
  };
}

// --- Main LLM parser ----------------------------------------------------------

/** Parse a freeform script using an LLM. Returns the same ParsedScript shape
 *  as the conventional parser so the downstream code is identical. */
export async function parseScriptWithLlm(text: string): Promise<ParsedScript> {
  const llm = resolveLlm();
  if (!llm) {
    throw new Error(
      "LLM is not configured. Set LLM_PROVIDER in .env.local to 'ollama' (local, free) or 'groq' (online, free API key from console.groq.com).",
    );
  }

  const userPrompt = `Parse this music video script into structured shot data:\n\n${text}`;
  const rawResponse = await callLlm(llm, userPrompt);
  const jsonStr = extractJson(rawResponse);
  let parsed: LlmResponse;
  try {
    parsed = JSON.parse(jsonStr) as LlmResponse;
  } catch (e) {
    throw new Error(`LLM returned invalid JSON: ${(e as Error).message}. Raw response (first 500 chars): ${rawResponse.slice(0, 500)}`);
  }

  if (!parsed.sections || !Array.isArray(parsed.sections)) {
    throw new Error("LLM response missing 'sections' array");
  }

  const errors: ParseError[] = [];
  const sections: ParsedSection[] = [];
  const allShots: ParsedShot[] = [];
  let globalShotNumber = 0;

  for (let si = 0; si < parsed.sections.length; si++) {
    const ls = parsed.sections[si]!;
    const sectionName = String(ls.name || "UNNAMED").toUpperCase().replace(/\s+/g, "_");
    const sectionStart = ls.startSeconds != null ? Number(ls.startSeconds) : (si === 0 ? 0 : null);
    const sectionEnd = ls.endSeconds != null ? Number(ls.endSeconds) : null;
    const lyrics = Array.isArray(ls.lyrics) ? ls.lyrics.map((l) => String(l)) : [];
    const lyricsStr = lyrics.length > 0 ? lyrics.join("\n") : null;

    let timeCursor = sectionStart ?? 0;
    const sectionShots: ParsedShot[] = [];

    if (Array.isArray(ls.shots)) {
      for (const ls_shot of ls.shots) {
        globalShotNumber++;
        const shot = sanitizeShot(ls_shot, globalShotNumber, sectionName, lyricsStr, timeCursor);
        timeCursor = shot.timeEndSeconds;
        sectionShots.push(shot);
        allShots.push(shot);
      }
    }

    sections.push({
      name: sectionName,
      startSeconds: sectionStart,
      endSeconds: sectionEnd,
      lyrics,
      shots: sectionShots,
    });
  }

  if (allShots.length === 0) {
    errors.push({
      line: 0,
      text: "",
      message: "LLM parsed the script but found no shots. Try rephrasing the script or using the conventional parser.",
    });
  }

  const totalDuration = allShots.reduce((max, s) => Math.max(max, s.timeEndSeconds), 0);

  return { sections, shots: allShots, totalDurationSeconds: totalDuration, errors };
}
