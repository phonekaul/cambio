import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export const DECISION_MODEL = process.env.AI_DECISION_MODEL || "claude-haiku-4-5-20251001";
export const SUMMARY_MODEL = process.env.AI_SUMMARY_MODEL || "claude-sonnet-5-5";

function workspaceId(): string | undefined {
  const raw = process.env.ANTHROPIC_WORKSPACE_ID?.trim().replace(/^["']|["']$/g, "");
  return raw || undefined;
}

/** What the server can see about the workspace setting, without revealing the value. */
function workspaceStatus(): string {
  const id = workspaceId();
  if (!id) return "ANTHROPIC_WORKSPACE_ID is not visible to the server";
  return id.startsWith("wrkspc_")
    ? "ANTHROPIC_WORKSPACE_ID is set on the server, but the API didn't accept it for this key"
    : "ANTHROPIC_WORKSPACE_ID is set but doesn't look like a workspace ID (those start with wrkspc_)";
}

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("The server has no ANTHROPIC_API_KEY set. See .env.example.");
  }
  // Keys that aren't scoped to a workspace must name one on every request.
  // Trim and unquote: values pasted into a hosting dashboard often pick up spaces or quotes.
  const workspace = workspaceId();
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
  let res: Anthropic.Message;
  try {
    res = await getClient().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4000,
      system: `${opts.system}\n\nRespond with JSON only. Task: ${opts.tool.description}`,
      messages: [{ role: "user", content: opts.user }],
      output_config: { format: { type: "json_schema", schema: strictSchema(opts.tool.input_schema) as Record<string, unknown> } },
    });
  } catch (e) {
    // Workspace errors are confusing on a host: say what this server can actually see.
    if (e instanceof Anthropic.BadRequestError && /workspace/i.test(e.message)) {
      throw new Error(`${e.message} [${workspaceStatus()}]`);
    }
    throw e;
  }
  if (res.stop_reason === "refusal") throw new Error("The model declined to answer.");
  if (res.stop_reason === "max_tokens") throw new Error("The model ran out of room before finishing its answer.");
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("The model returned no structured answer.");
  return JSON.parse(block.text) as T;
}
