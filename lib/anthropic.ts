import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export const DECISION_MODEL = process.env.AI_DECISION_MODEL || "claude-haiku-4-5-20251001";
export const SUMMARY_MODEL = process.env.AI_SUMMARY_MODEL || "claude-sonnet-5-5";

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("The server has no ANTHROPIC_API_KEY set. See .env.example.");
  }
  client ??= new Anthropic({ timeout: 50_000, maxRetries: 1 });
  return client;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/** Forces the model to answer through a single tool, so we always get structured JSON back. */
export async function callTool<T>(opts: {
  model: string;
  system: string;
  user: string;
  tool: ToolDef;
  maxTokens?: number;
}): Promise<T> {
  const res = await getClient().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1500,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    tools: [opts.tool as Anthropic.Tool],
    tool_choice: { type: "tool", name: opts.tool.name },
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("The model returned no structured answer.");
  return block.input as T;
}
