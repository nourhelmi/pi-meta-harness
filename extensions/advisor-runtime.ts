import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { callSocket, readCredential } from "../scripts/advisor-runtime/service.mjs";

export const ADVISOR_RUNTIME_DESCRIPTOR_ENV = "ADVISOR_RUNTIME_DESCRIPTOR";
const MAX_MODEL_RESPONSE_BYTES = 50 * 1024;
const LEGACY_TOOL_BLOCK_REASON =
	"Shared advisor runtime mode owns operational launches. Use advisor_runtime instead of bg_agent or bg_stop.";

const runtimeRequestSchema = Type.Object({
	v: Type.Integer({ minimum: 1, maximum: 1 }),
	op: Type.String({ minLength: 1, maxLength: 64 }),
	scope: Type.Object({
		workstream: Type.String({ minLength: 1, maxLength: 128 }),
		run: Type.String({ minLength: 1, maxLength: 128 }),
		node: Type.String({ minLength: 1, maxLength: 128 }),
		ownerEpoch: Type.Integer({ minimum: 1 }),
	}, { additionalProperties: false }),
	payload: Type.Object({}, { additionalProperties: true, maxProperties: 64 }),
	commandId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

function boundedResponse(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, error: "ADVISOR_RUNTIME_INVALID_RESPONSE" };
	}
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return { ok: false, error: "ADVISOR_RUNTIME_INVALID_RESPONSE" };
	}
	if (Buffer.byteLength(encoded) > MAX_MODEL_RESPONSE_BYTES) {
		return { ok: false, error: "ADVISOR_RUNTIME_RESPONSE_TOO_LARGE" };
	}
	return value as Record<string, unknown>;
}

/**
 * Optional Pi model transport for a separately hosted shared advisor runtime.
 * The environment descriptor is a trusted local operator boundary; Pi neither
 * creates a runtime nor receives provider/session ownership through this seam.
 */
export default function advisorRuntimeExtension(pi: ExtensionAPI): void {
	const descriptorPath = process.env[ADVISOR_RUNTIME_DESCRIPTOR_ENV]?.trim();
	if (!descriptorPath || process.env.PI_DETACH_RUNTIME_BRIDGE) return;

	pi.registerTool({
		name: "advisor_runtime",
		label: "Advisor Runtime",
		description:
			"Send one versioned, scoped operational request to the trusted shared advisor runtime. Responses are bounded; credentials are never returned.",
		promptSnippet: "Call the opt-in shared native advisor runtime with a versioned scoped request",
		promptGuidelines: [
			"Use advisor_runtime for advisor launches, replies, cancellation, waiting, and artifacts when this tool is active; bg_agent and bg_stop are fenced in shared runtime mode.",
		],
		parameters: runtimeRequestSchema,
		async execute(_toolCallId, request) {
			let response: Record<string, unknown>;
			try {
				const credential = readCredential(descriptorPath);
				response = boundedResponse(await callSocket(credential, request, "model"));
			} catch {
				response = { ok: false, error: "ADVISOR_RUNTIME_UNAVAILABLE" };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(response) }],
				details: response,
			};
		},
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bg_agent" && event.toolName !== "bg_stop") return;
		return { block: true, reason: LEGACY_TOOL_BLOCK_REASON };
	});
}
