import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export const scopeSchema = z.object({
  workstream: id,
  run: id,
  node: id,
  ownerEpoch: z.number().int().positive(),
}).strict();
export type Scope = z.infer<typeof scopeSchema>;

// The service parses each operation's payload before admission. This public
// transport schema bounds the envelope and forbids caller-selected routing.
const payload = z.record(z.string(), z.unknown());
const readOperations = [
  "workstream.open", "progress", "wait", "history", "artifact.read", "log.read",
] as const;
const mutationOperations = [
  "workstream.create", "packet.admit", "graph.admit", "wave.launch", "node.launch",
  "root.create", "root.message", "root.reply", "root.cancel", "root.stop", "root.resume",
  "node.reply", "node.cancel", "node.resume", "delivery.ack",
] as const;
export const commandSchema = z.union([
  z.object({ v: z.literal(1), op: z.literal("capabilities") }).strict(),
  z.object({
    v: z.literal(1), op: z.enum(readOperations), scope: scopeSchema, payload,
  }).strict(),
  z.object({
    v: z.literal(1), op: z.enum(mutationOperations), scope: scopeSchema, payload,
    commandId: id, expectedRevision: z.number().int().nonnegative(),
  }).strict(),
]).refine(
  value => new TextEncoder().encode(JSON.stringify(value)).length <= 32768,
  "Command exceeds 32 KiB",
);
export type RuntimeCommand = z.infer<typeof commandSchema>;
export type Mutation = Extract<RuntimeCommand, { commandId: string }>;

export const responseSchema = z.union([
  z.object({
    ok: z.literal(false),
    error: z.string().regex(/^[A-Z][A-Z0-9_-]{0,79}$/u),
  }).strict(),
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({
    ok: z.literal(true),
    receipt: z.looseObject({
      commandId: z.string(), outcome: z.string(), revision: z.number().optional(),
    }),
    replayed: z.boolean(),
  }).strict(),
]);
export type RuntimeResponse = z.infer<typeof responseSchema>;

export const capabilitiesSchema = z.object({
  operations: z.array(z.string()),
  scopes: z.array(scopeSchema.omit({ ownerEpoch: true })),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

// Read models preserve additive runtime data; mutation envelopes above remain
// strict. These are view projections, not a second admission/state definition.
const requestSchema = z.looseObject({
  id: z.string(), kind: z.string().optional(), text: z.string().optional(),
  answered: z.boolean().optional(),
});
const rootSchema = z.looseObject({
  state: z.string(), adapter: z.string(), attempt: z.number(),
  request: requestSchema.nullable(), processExited: z.number().optional(),
});
export const nodeSchema = z.looseObject({
  revision: z.number(), status: z.string(), runtimeState: z.string(),
  processExited: z.number().optional(), requestDetail: requestSchema.optional(),
  snapshot: z.looseObject({
    state: z.string(), attempt: z.number(), request: requestSchema.nullable(),
  }),
  packet: z.looseObject({
    model: z.string(), thinking: z.string(), role: z.string(),
  }),
});
export const runSchema = z.looseObject({
  id: z.string(), workstream: z.string(), epoch: z.number(), revision: z.number(),
  cwd: z.string(), host: z.string(), root: rootSchema.nullable(),
  nodes: z.record(z.string(), nodeSchema),
  packets: z.record(z.string(), z.unknown()),
});
export type Run = z.infer<typeof runSchema>;
export type FleetNode = z.infer<typeof nodeSchema>;

export const deliverySchema = z.looseObject({
  id: z.number(), node: z.string(), kind: z.string(),
  text: z.string().optional(), note: z.string().optional(),
  reason: z.string().optional(), status: z.string().optional(),
  source: z.string().optional(), acked: z.boolean().optional(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const historySchema = z.object({
  entries: z.array(deliverySchema), nextCursor: z.number(), hasMore: z.boolean(),
});
export const artifactSchema = z.looseObject({ text: z.string(), eof: z.boolean() });
