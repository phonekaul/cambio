import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export const DECISION_MODEL = process.env.AI_DECISION_MODEL || "claude-haiku-4-5-20251001";
export const SUMMARY_MODEL = process.env.AI_SUMMARY_MODEL || "claude-sonnet-5-5";

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("The server has no ANTHROPIC_API_KEY set. See .env.example.");
  }
  // Keys that aren't scoped to a workspace must name one on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  client ??= new Anthropic({
    timeout: 50_000,
    maxRetries: 1,
    defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined,
  });
  return client;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/**
 * Structured outputs require every object to list its keys and forbid extras, and don't take
 * array-length limits (we clip lengths ourselves after parsing).
 */
function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "minItems" || k === "maxItems") continue;
    out[k] = strictSchema(v);
  }
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

/**
 * Ask for an answer shaped by `tool.input_schema`, using structured outputs so the reply is
 * guaranteed to be valid JSON for that schema. (Forcing a tool call isn't supported on newer
 * models such as claude-sonnet-5-5, so we don't use tool_choice for this.)
 */
export async function callTool<T>(opts: {
  model: string;
  system: string;
  user: string;
  tool: ToolDef;
  maxTokens?: number;
}): Promise<T> {
  const res = await getClient().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4000,
    system: `${opts.system}\n\nRespond with JSON only. Task: ${opts.tool.description}`,
    messages: [{ role: "user", content: opts.user }],
    output_config: { format: { type: "json_schema", schema: strictSchema(opts.tool.input_schema) as Record<string, unknown> } },
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined to answer.");
  if (res.stop_reason === "max_tokens") throw new Error("The model ran out of room before finishing its answer.");
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("The model returned no structured answer.");
  return JSON.parse(block.text) as T;
}
