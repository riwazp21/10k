import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";

/** Use Node.js runtime so fs works on Vercel */
export const runtime = "nodejs";

/** ---------- Types ---------- */
type Row = { Path: string; Content: string };

type PathDoc = {
  path: string;
  contents: string[]; // all rows under the same Path
  preview: string; // short preview used in selector step
};

interface SelectorPayload {
  selected_indices?: unknown; // validated at runtime
  reasons?: Record<string, string>;
}

/** ---------- Config ---------- */
const OPENAI_MODEL_SELECTOR =
  process.env.OPENAI_MODEL_SELECTOR || "gpt-4o-mini";
const OPENAI_MODEL_ANSWER = process.env.OPENAI_MODEL_ANSWER || "gpt-4o-mini";

const MAX_QUESTION_LEN = 1000; // clamp input size
const PREFILTER_TOP_K = 50; // show more candidates to selector
const MAX_SELECTED = 4; // pick 3–4 paths

/** ---------- Load & index CSV (cold-start cache) ---------- */
let PATH_INDEX: PathDoc[] | null = null;

function loadPathIndex(): PathDoc[] {
  if (PATH_INDEX) return PATH_INDEX;

  // CSV must live at public/data/meta.csv with headers: Path,Content
  const filePath = join(process.cwd(), "public", "database", "Meta.csv");
  const csv = readFileSync(filePath, "utf8");
  const rows = parse(csv, { columns: true, bom: true, trim: true }) as Row[];

  // Group multiple content rows by Path
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const path = (r.Path || "").trim();
    const content = (r.Content || "").trim();
    if (!path || !content) continue;
    if (!map.has(path)) map.set(path, []);
    map.get(path)!.push(content);
  }

  const index: PathDoc[] = [];
  for (const [path, contents] of map.entries()) {
    const joinedPreview = contents.join(" ").slice(0, 500);
    index.push({ path, contents, preview: joinedPreview });
  }
  PATH_INDEX = index;
  return PATH_INDEX;
}

/** ---------- Lightweight keyword scoring for prefilter ---------- */
function score(hay: string, query: string): number {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const low = hay.toLowerCase();
  let s = 0;
  for (const t of terms) if (low.includes(t)) s += 1;
  return s;
}

function topPathCandidates(
  query: string,
  k: number
): { idx: number; doc: PathDoc; s: number }[] {
  const index = loadPathIndex();
  const ranked = index
    .map((doc, idx) => ({
      idx,
      doc,
      // weight path title higher than preview content
      s: score(doc.path, query) * 2 + score(doc.preview, query),
    }))
    .sort((a, b) => b.s - a.s);
  return ranked.slice(0, Math.min(k, ranked.length));
}

/** ---------- OpenAI ---------- */
const apiKey = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey });

const SYSTEM_SELECTOR = `You are a financial 10-K analyzer.
You will see a QUESTION and a numbered list of CANDIDATE PATHS (each with a brief preview).
Pick the 3–4 MOST RELEVANT unique paths by NUMBER ONLY and give a very short reason for each.

Return STRICT JSON (no prose, no backticks) with EXACT shape:
{
  "selected_indices": [1, 7, 9],
  "reasons": {
    "1": "why #1 helps (<= 15 words)",
    "7": "why #7 helps",
    "9": "why #9 helps"
  }
}

Rules:
- Select paths that directly contain facts to answer the question.
- Prefer specific subsections over broad sections when helpful.
- 3 to 4 items only.
- Respond with JSON ONLY.`;

/**
 * Natural, denser answerer:
 * - Normal ChatGPT-style prose (no rigid section headers).
 * - Use ONLY the provided Context; do not add external facts.
 * - Be detailed: weave in concrete figures, dates, segments, products, jurisdictions, and named regulations that appear in Context.
 * - 4–7 compact paragraphs. Bullets allowed only if clearly improves clarity.
 * - Optionally include very short quoted phrases from the Context (<= 10 words) to anchor key points.
 * - For “is it worth it” questions, present balanced considerations and scenario-style reasoning—not personalized advice.
 * - DO NOT include a Sources section or citations—the caller will append sources.
 * - If the Context is insufficient, say so briefly.
 */
const SYSTEM_ANSWER = `You are a rigorous financial 10-K assistant.
Use ONLY the provided Context; treat it as the sole source of truth.
Do not import outside knowledge. If the Context lacks details to answer, say so succinctly.

Write a natural, professional answer in 4–7 short paragraphs (no section headings). 
Make it dense with specifics drawn from the Context: figures, dates, segments, products, jurisdictions, and named regulations. 
When helpful, quote tiny phrases (≤10 words) from the Context to anchor assertions, then explain them.
If the user asks about "is it worth it", discuss tradeoffs and scenario-style considerations grounded in the Context; do not give personalized advice.
Avoid hype and speculation.
Do NOT include a Sources section or inline citations—the caller will append sources.`;

/** Build the selector prompt with enumerated candidates */
function buildSelectorPrompt(
  question: string,
  cands: { idx: number; doc: PathDoc }[]
) {
  const listing = cands
    .map(
      ({ doc }, i) =>
        `#${i + 1}
path: ${doc.path}
preview: ${doc.preview}`
    )
    .join("\n\n");

  return [
    { role: "system" as const, content: SYSTEM_SELECTOR },
    {
      role: "user" as const,
      content: `QUESTION: ${question}\n\nCANDIDATE PATHS:\n${listing}`,
    },
  ];
}

/** Build the answer prompt with the FULL content per selected path (no clipping) */
function buildAnswerPrompt(question: string, pickedDocs: PathDoc[]) {
  const ctxBlocks = pickedDocs.map((doc) => {
    const full = doc.contents.join("\n\n"); // ENTIRE content (no clipping)
    return `[${doc.path}]\n${full}`;
  });
  const ctx = ctxBlocks.join("\n\n");

  return [
    { role: "system" as const, content: SYSTEM_ANSWER },
    {
      role: "user" as const,
      content: `Question: ${question}\n\nContext:\n${ctx}`,
    },
  ];
}

/** ---------- Safe parsing helpers ---------- */
function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = Number(x);
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

/** ---------- Route ---------- */
export async function POST(req: Request) {
  try {
    if (!apiKey) {
      return NextResponse.json(
        {
          advice:
            "OPENAI_API_KEY is missing. Set it in Vercel → Project Settings → Environment Variables.",
        },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const userScenario = (body?.userScenario ?? "").toString();
    const question = userScenario.slice(0, MAX_QUESTION_LEN).trim();

    if (!question) {
      return NextResponse.json(
        { advice: "Please provide a question." },
        { status: 400 }
      );
    }

    // 1) Prefilter candidates
    const ranked = topPathCandidates(question, PREFILTER_TOP_K);
    if (ranked.length === 0) {
      return NextResponse.json({
        advice:
          "No content available yet. Ensure public/data/meta.csv exists with Path and Content rows.",
      });
    }

    // 2) Ask model to select 3–4 paths by index
    const selectorMsgs = buildSelectorPrompt(
      question,
      ranked.map(({ idx, doc }) => ({ idx, doc }))
    );

    const selector = await client.chat.completions.create({
      model: OPENAI_MODEL_SELECTOR,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: selectorMsgs,
    });

    // Parse & validate selection
    let payload: SelectorPayload = {};
    try {
      const raw = selector.choices[0]?.message?.content || "{}";
      payload = JSON.parse(raw) as SelectorPayload;
    } catch {
      payload = {};
    }

    const selected = toNumberArray(payload.selected_indices).filter(
      (n) => n >= 1 && n <= ranked.length
    );
    const unique = Array.from(new Set(selected)).slice(0, MAX_SELECTED);
    const chosenIdxes: number[] =
      unique.length > 0
        ? unique
        : [1, 2, 3].slice(0, Math.min(3, ranked.length));

    // 3) Pull full docs for selected paths
    const pickedDocs: PathDoc[] = [];
    const seen = new Set<string>();
    for (const oneBased of chosenIdxes) {
      const { doc } = ranked[oneBased - 1];
      if (!seen.has(doc.path)) {
        seen.add(doc.path);
        pickedDocs.push(doc);
      }
      if (pickedDocs.length >= MAX_SELECTED) break;
    }

    // 4) Ask model for a natural, detailed answer (no Sources/citations)
    const answerMsgs = buildAnswerPrompt(question, pickedDocs);
    const answerResp = await client.chat.completions.create({
      model: OPENAI_MODEL_ANSWER,
      temperature: 0.1, // slightly more extractive/deterministic
      messages: answerMsgs,
    });

    const answerText = answerResp.choices[0]?.message?.content?.trim() || "";

    // 5) Pretty Sources: numbered + bold, no duplicates
    const sources = pickedDocs
      .map((d, i) => `${i + 1}. **${d.path}**`)
      .join("\n");
    const advice = `${answerText}\n\nSources:\n${sources}`;

    return NextResponse.json({ advice });
  } catch (err) {
    console.error("synthesizer-agent error:", err);
    return NextResponse.json(
      {
        advice:
          "Server error while generating answer. Check logs & environment variables.",
      },
      { status: 500 }
    );
  }
}
