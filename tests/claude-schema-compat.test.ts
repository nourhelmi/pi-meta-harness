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

test("Claude schema compatibility wraps the bridge provider request boundary", () => {
  let startHandler: ((event: unknown, context: unknown) => void) | undefined;
  let receivedContext: unknown;
  const provider: Record<PropertyKey, unknown> = {
    stream(_model: unknown, context: unknown) {
      receivedContext = context;
      return "stream";
    },
    streamSimple(_model: unknown, context: unknown) {
      receivedContext = context;
      return "simple";
    },
  };
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => void) {
      assert.equal(event, "session_start");
      startHandler = handler;
    },
  } as unknown as ExtensionAPI;

  claudeSchemaCompat(pi);
  assert.ok(startHandler);
  startHandler({}, {
    modelRegistry: {
      getProvider(id: string) {
        assert.equal(id, "claude-bridge");
        return provider;
      },
    },
  });

  const context = {
    tools: [{ name: "edit", parameters: { type: "array", items: [{ type: "string" }], additionalItems: false } }],
  };
  const result = (provider.streamSimple as (model: unknown, context: unknown) => unknown)({}, context);

  assert.equal(result, "simple");
  assert.deepEqual(receivedContext, {
    tools: [{ name: "edit", parameters: { type: "array", prefixItems: [{ type: "string" }], items: false } }],
  });
  assert.equal("additionalItems" in context.tools[0]!.parameters, true, "caller context must remain unchanged");
});
