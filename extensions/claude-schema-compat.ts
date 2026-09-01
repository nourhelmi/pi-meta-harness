import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRAPPED = Symbol.for("pi-meta-harness.claude-schema-compat");

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: JsonValue;
}

interface ToolContext {
  tools?: ProviderToolDefinition[];
}

interface ProviderModel {
  readonly provider?: string;
  readonly id?: string;
}

interface ProviderStreamOptions {
  readonly signal?: AbortSignal;
  readonly reasoning?: string;
  readonly cwd?: string;
}

type StreamMethod = (model: ProviderModel, context: ToolContext, options?: ProviderStreamOptions) => object;

interface MutableBridgeProvider {
  stream?: StreamMethod;
  streamSimple?: StreamMethod;
}

/**
 * Translate the draft-07 tuple form still emitted by some TypeBox tools into
 * JSON Schema 2020-12. Claude rejects `items: [...]`/`additionalItems`, while
 * 2020-12 represents the same fixed tuple as `prefixItems`/`items: false`.
 */
export function normalizeClaudeToolSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeClaudeToolSchema);
  if (!value || typeof value !== "object") return value;

  const source = value as { [key: string]: JsonValue };
  const normalized: { [key: string]: JsonValue } = {};

  for (const [key, child] of Object.entries(source)) {
    if (key === "additionalItems" && Array.isArray(source.items)) continue;

    if (key === "items" && Array.isArray(child)) {
      normalized.prefixItems = child.map(normalizeClaudeToolSchema);
      const additionalItems = source.additionalItems;
      if (additionalItems === false) normalized.items = false;
      else if (additionalItems && typeof additionalItems === "object") {
        normalized.items = normalizeClaudeToolSchema(additionalItems);
      }
      continue;
    }

    normalized[key] = normalizeClaudeToolSchema(child);
  }

  return normalized;
}

function normalizeToolContext(context: ToolContext): ToolContext {
  if (!Array.isArray(context.tools)) return context;

  return {
    ...context,
    tools: context.tools.map((tool) => ({
      ...tool,
      parameters: normalizeClaudeToolSchema(tool.parameters),
    })),
  };
}

/**
 * pi-claude-bridge forwards Pi tools through an MCP server. Patch only the
 * bridge provider's request boundary so every tool keeps its implementation
 * while Claude receives a valid 2020-12 schema.
 */
export default function claudeSchemaCompat(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const candidate = ctx.modelRegistry.getProvider("claude-bridge");
    // SAFETY: Pi's provider contract guarantees stream/streamSimple use the
    // model-context-options signature; this mutable view only wraps those methods.
    const provider = candidate as
      | (MutableBridgeProvider & { [WRAPPED]?: boolean })
      | undefined;
    if (!provider || provider[WRAPPED]) return;

    for (const method of ["stream", "streamSimple"] as const) {
      const original = provider[method];
      if (!original) continue;

      provider[method] = function (
        model: ProviderModel,
        context: ToolContext,
        options?: ProviderStreamOptions,
      ): object {
        return original.call(this, model, normalizeToolContext(context), options);
      };
    }

    provider[WRAPPED] = true;
  });
}
