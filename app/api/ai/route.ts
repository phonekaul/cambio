import { DECISION_MODEL, SUMMARY_MODEL, callTool } from "../../../lib/anthropic";
import { DECIDE_TOOL, SUMMARY_SYSTEM, SUMMARY_TOOL, SYSTEM, decideUser, summaryUser } from "../../../lib/prompts";
import type { AiRequest, DecideRequest, DecideResponse, SummaryRequest, SummaryResponse } from "../../../lib/protocol";
import { checkRate } from "../../../lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

async function decide(r: DecideRequest): Promise<DecideResponse> {
  const ids = r.candidates.map((c) => c.id);
  if (ids.length === 0) throw new Error("No options to choose from.");
  if (process.env.AI_MOCK === "1") {
    return { choice: ids[0], thought: r.candidates[0].reasons[0] ?? "Playing the top-scored move." };
  }
  const out = await callTool<{ choice: string; thought: string }>({
    model: DECISION_MODEL,
    system: SYSTEM,
    user: decideUser(r),
    tool: DECIDE_TOOL(ids),
    maxTokens: 400,
  });
  // The engine listed the legal options; anything else is rejected and the client falls back.
  if (!ids.includes(out.choice)) throw new Error("The model picked an option that wasn't offered.");
  return { choice: out.choice, thought: clip(out.thought, 400) };
}

async function summary(r: SummaryRequest): Promise<SummaryResponse> {
  if (process.env.AI_MOCK === "1") throw new Error("mock mode: use the local summary");
  const out = await callTool<SummaryResponse>({
    model: SUMMARY_MODEL,
    system: SUMMARY_SYSTEM,
    user: summaryUser(r),
    tool: SUMMARY_TOOL,
    maxTokens: 900,
  });
  return {
    headline: clip(out.headline, 120),
    reads: (out.reads ?? []).slice(0, 5).map((x) => clip(x, 240)),
    adapted: (out.adapted ?? []).slice(0, 3).map((x) => clip(x, 240)),
    tip: clip(out.tip, 300),
  };
}

export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const limited = checkRate(ip);
  if (limited) return Response.json({ error: limited }, { status: 429 });

  let body: AiRequest;
  try {
    body = (await req.json()) as AiRequest;
  } catch {
    return Response.json({ error: "Bad request body." }, { status: 400 });
  }

  try {
    if (body.action === "decide") return Response.json(await decide(body));
    if (body.action === "summary") return Response.json(await summary(body));
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : "The AI had a problem." }, { status: 500 });
  }
}
