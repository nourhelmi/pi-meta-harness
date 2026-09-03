import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeSchemaCompat, { normalizeClaudeToolSchema } from "../extensions/claude-schema-compat.ts";

test("Claude schema compatibility converts draft-07 tuples without mutating the source", () => {
  const source = {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "array",
          items: [{ type: "string" }, { type: "string" }, { type: "string" }],
          additionalItems: false,
          minItems: 3,
        },
      },
    },
  };

  const normalized = normalizeClaudeToolSchema(source) as {
    properties: { edits: { items: Record<string, unknown> } };
  };
  const tuple = normalized.properties.edits.items;

  assert.deepEqual(tuple.prefixItems, [{ type: "string" }, { type: "string" }, { type: "string" }]);
  assert.equal(tuple.items, false);
  assert.equal("additionalItems" in tuple, false);
  assert.equal(Array.isArray(source.properties.edits.items.items), true, "source schema must remain unchanged");
});

test("Claude schema compatibility wraps late and replaced bridge provider methods", () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  let receivedContext: unknown;
  let provider: Record<PropertyKey, unknown> | undefined;
  const makeProvider = (): Record<PropertyKey, unknown> => ({
    stream(_model: unknown, context: unknown) {
      receivedContext = context;
      return "stream";
    },
    streamSimple(_model: unknown, context: unknown) {
      receivedContext = context;
      return "simple";
    },
  });
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  claudeSchemaCompat(pi);
  const context = {
    modelRegistry: {
      getProvider(id: string) {
        assert.equal(id, "claude-bridge");
        return provider;
      },
    },
  };
  const startHandler = handlers.get("session_start");
  const beforeHandler = handlers.get("before_agent_start");
  assert.ok(startHandler);
  assert.ok(beforeHandler);

  startHandler({}, context);
  provider = makeProvider();
  beforeHandler({}, context);

  const toolContext = {
    tools: [{ name: "edit", parameters: { type: "array", items: [{ type: "string" }], additionalItems: false } }],
  };
  const result = (provider.streamSimple as (model: unknown, context: unknown) => unknown)({}, toolContext);

  assert.equal(result, "simple");
  assert.deepEqual(receivedContext, {
    tools: [{ name: "edit", parameters: { type: "array", prefixItems: [{ type: "string" }], items: false } }],
  });
  assert.equal("additionalItems" in toolContext.tools[0]!.parameters, true, "caller context must remain unchanged");

  provider.streamSimple = makeProvider().streamSimple;
  beforeHandler({}, context);
  (provider.streamSimple as (model: unknown, context: unknown) => unknown)({}, toolContext);
  assert.deepEqual(receivedContext, {
    tools: [{ name: "edit", parameters: { type: "array", prefixItems: [{ type: "string" }], items: false } }],
  });
});
