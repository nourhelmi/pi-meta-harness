import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRAPPED_METHOD = Symbol.for("pi-meta-harness.claude-schema-compat.method");

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
type WrappedStreamMethod = StreamMethod & { [key: symbol]: boolean | undefined };

interface MutableBridgeProvider {
  stream?: StreamMethod;
  streamSimple?: StreamMethod;
}

interface ProviderRegistry {
  getProvider(id: string): unknown;
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

function wrapClaudeBridgeProvider(registry: ProviderRegistry): void {
  const candidate = registry.getProvider("claude-bridge");
  // SAFETY: Pi's provider contract guarantees stream/streamSimple use the
  // model-context-options signature; this mutable view only wraps those methods.
  const provider = candidate as MutableBridgeProvider | undefined;
  if (!provider) return;

  for (const method of ["stream", "streamSimple"] as const) {
    const original = provider[method] as WrappedStreamMethod | undefined;
    if (!original || original[WRAPPED_METHOD]) continue;

    const wrapped = function (
      this: unknown,
      model: ProviderModel,
      context: ToolContext,
      options?: ProviderStreamOptions,
    ): object {
      return original.call(this, model, normalizeToolContext(context), options);
    } as WrappedStreamMethod;
    wrapped[WRAPPED_METHOD] = true;
    provider[method] = wrapped;
  }
}

/**
 * pi-claude-bridge forwards Pi tools through an MCP server. Patch only the
 * bridge provider's request boundary so every tool keeps its implementation
 * while Claude receives a valid 2020-12 schema.
 */
export default function claudeSchemaCompat(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    wrapClaudeBridgeProvider(ctx.modelRegistry);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    // The effective provider can be composed or replaced after session_start,
    // especially when a long-lived Pi session switches models. Re-check at the
    // last lifecycle boundary before every provider request.
    wrapClaudeBridgeProvider(ctx.modelRegistry);
  });
}
