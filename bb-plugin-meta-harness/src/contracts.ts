import { isAbsolute } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostIdProblem, stateRootContentProblem } from "./configuration.js";
import { runtimeHostMethod } from "./runtime-rpc.js";

export const TRACE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/u;
export const TRACE_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const TRACE_LINE_MAX_BYTES = 256 * 1024;
export const TRACE_RECORD_MAX = 4096;
export const TRACE_FILE_MAX = 256;

export const hostIdSettingSchema = z.string().superRefine((value, context) => {
  const problem = hostIdProblem(value);
  if (problem !== null) {
    context.addIssue({
      code: "custom",
      message: problem,
    });
  }
});

export const stateRootSettingSchema = z
  .string()
  .superRefine((value, context) => {
    const problem = !isAbsolute(value)
      ? "Advisor state root must be an absolute path"
      : stateRootContentProblem(value);
    if (problem !== null) {
      context.addIssue({
        code: "custom",
        message: problem,
      });
    }
  });

export const traceFileNameSchema = z
  .string()
  .regex(TRACE_FILE_NAME_PATTERN, "Invalid canonical trace filename");

export const traceErrorCodes = [
  "INVALID_CONFIGURATION",
  "NOFOLLOW_UNAVAILABLE",
  "ROOT_UNAVAILABLE",
  "ROOT_SYMLINK",
  "ROOT_NOT_DIRECTORY",
  "ROOT_IDENTITY_DRIFT",
  "TRACES_UNAVAILABLE",
  "TRACES_SYMLINK",
  "TRACES_NOT_DIRECTORY",
  "TRACES_IDENTITY_DRIFT",
  "TRACE_NAME_INVALID",
  "TRACE_FILE_LIMIT",
  "TRACE_DISAPPEARED",
  "TRACE_PERMISSION_DENIED",
  "TRACE_SYMLINK",
  "TRACE_NOT_REGULAR",
  "TRACE_OUTSIDE_DIRECTORY",
  "TRACE_TOO_LARGE",
  "TRACE_IDENTITY_DRIFT",
  "TRACE_SHRANK",
  "TRACE_READ_FAILED",
  "INVALID_UTF8",
  "LINE_TOO_LARGE",
  "RECORD_LIMIT",
  "NO_COMPLETE_EVENT",
  "MALFORMED_JSON",
  "INVALID_TRACE",
  "REQUEST_ABORTED",
] as const;

export type TraceErrorCode = (typeof traceErrorCodes)[number];

export const traceReadErrorSchema = z
  .object({
    code: z.enum(traceErrorCodes),
    message: z.string().min(1),
  })
  .strict();

export type TraceReadError = z.infer<typeof traceReadErrorSchema>;

const hostSchema = z.enum(["pi", "claude-code", "codex"]);
const settledStatusSchema = z.enum([
  "done",
  "blocked",
  "failed",
  "stalled",
  "cancelled",
]);
const nodeStateSchema = z.enum([
  "running",
  "blocked",
  "result-written",
  "result-validated",
  "result-invalid",
  "settled",
]);
const riskTierSchema = z.enum(["low", "standard", "high"]);

const launchSchema = z
  .object({
    role: z.string().min(1),
    label: z.string().min(1),
    harness: hostSchema,
    model: z.string().min(1),
    thinking: z.string().min(1),
    cwd: z.string().min(1),
    riskTier: riskTierSchema,
    acceptance: z.array(z.string().min(1)).min(1),
    resultPath: z.string().optional(),
    keepAlive: z.boolean().optional(),
    launchRef: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const blockedRequestSchema = z
  .object({
    kind: z.enum([
      "question",
      "decision",
      "permission",
      "credential",
      "external-action",
    ]),
    text: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    at: z.string(),
  })
  .strict();

export const traceProjectionSchema = z
  .object({
    run: z
      .object({
        id: z.string(),
        workstream: z.string(),
        goal: z.string().nullable(),
        graph: z.string().nullable(),
        stateRoot: z.string().nullable(),
        root: z.string(),
        session: z.string(),
        host: hostSchema,
        createdAt: z.string(),
        lastSeq: z.number().int().nonnegative(),
        lastAt: z.string().nullable(),
        waves: z.array(
          z
            .object({
              wave: z.number().int().positive(),
              nodes: z.array(z.string()),
              startedAt: z.string().nullable(),
              completedAt: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          parent: z.string(),
          host: hostSchema,
          state: nodeStateSchema,
          launchedAt: z.string(),
          settledAt: z.string().nullable(),
          attempts: z.number().int().nonnegative(),
          replies: z.array(
            z
              .object({
                at: z.string(),
                text: z.string(),
                source: z.enum(["advisor", "user"]),
              })
              .strict(),
          ),
          cancelRequested: z.boolean(),
          progress: z.array(
            z.object({ at: z.string(), note: z.string() }).strict(),
          ),
          blockedRequest: blockedRequestSchema.nullable(),
          resultPath: z.string().nullable(),
          resultValid: z.boolean().nullable(),
          resultStatus: z.string().nullable(),
          settledStatus: settledStatusSchema.nullable(),
          settledReason: z.string().nullable(),
          surfaceClosed: z.boolean().nullable(),
          launch: launchSchema,
        })
        .strict(),
    ),
    wakes: z.array(
      z
        .object({
          parent: z.string(),
          child: z.string(),
          childStatus: settledStatusSchema,
          generation: z.number().int().positive(),
          at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type TraceProjection = z.infer<typeof traceProjectionSchema>;
export type TraceNode = TraceProjection["nodes"][number];

const traceDetailSchema = z
  .object({
    fileName: traceFileNameSchema,
    partial: z.boolean(),
    projection: traceProjectionSchema,
    validationProblems: z.record(z.string(), z.array(z.string())),
  })
  .strict();

export type TraceDetail = z.infer<typeof traceDetailSchema>;

const traceSummarySchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      fileName: traceFileNameSchema,
      partial: z.boolean(),
      runId: z.string(),
      host: hostSchema,
      workstream: z.string(),
      lastState: z.string(),
      lastAt: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      fileName: traceFileNameSchema,
      partial: z.boolean().optional(),
      error: traceReadErrorSchema,
    })
    .strict(),
]);

export type TraceSummary = z.infer<typeof traceSummarySchema>;

export const traceListResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), traces: z.array(traceSummarySchema) })
    .strict(),
  z.object({ ok: z.literal(false), error: traceReadErrorSchema }).strict(),
]);

export const traceDetailResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), trace: traceDetailSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      fileName: traceFileNameSchema.optional(),
      partial: z.boolean().optional(),
      error: traceReadErrorSchema,
    })
    .strict(),
]);

export type TraceListResponse = z.infer<typeof traceListResponseSchema>;
export type TraceDetailResponse = z.infer<typeof traceDetailResponseSchema>;

const configuredStateRootSchema = z
  .object({ stateRoot: stateRootSettingSchema })
  .strict();

export const traceHostContract = defineRpcContract({
  runtime: runtimeHostMethod,
  listTraces: {
    input: configuredStateRootSchema,
    output: traceListResponseSchema,
  },
  readTrace: {
    input: configuredStateRootSchema.extend({ fileName: traceFileNameSchema }),
    output: traceDetailResponseSchema,
  },
});

export const traceRpcContract = defineRpcContract({
  listTraces: {
    input: z.null(),
    output: traceListResponseSchema,
  },
  readTrace: {
    input: z.object({ fileName: traceFileNameSchema }).strict(),
    output: traceDetailResponseSchema,
  },
});

export type TraceRpcContract = typeof traceRpcContract;
