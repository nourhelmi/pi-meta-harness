import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const Strict = { additionalProperties: false } as const;
const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" });
const Version = Type.Literal("1");
const Model = Type.String({
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*/[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const Reasoning = Type.Union([
	Type.Literal("none"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export interface BbSurfaceContext {
	threadId: string;
	projectId: string;
	environmentId: string;
	serverUrl: string;
}

export const BbStartResponseSchema = Type.Object(
	{
		version: Version,
		runId: Id,
		threadId: Id,
		logicalParentThreadId: Id,
		hostId: Id,
		projectId: Id,
		environmentId: Id,
		providerId: Type.Literal("pi"),
		model: Model,
		reasoning: Reasoning,
		cwd: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
	},
	Strict,
);
export type BbStartResponse = Static<typeof BbStartResponseSchema>;

export function detectBbSurfaceContext(env: NodeJS.ProcessEnv = process.env): BbSurfaceContext | undefined {
	const threadId = env.BB_THREAD_ID?.trim();
	const projectId = env.BB_PROJECT_ID?.trim();
	const environmentId = env.BB_ENVIRONMENT_ID?.trim();
	const server = env.BB_SERVER_URL?.trim();
	const present = [threadId, projectId, environmentId, server].filter(Boolean).length;
	if (present === 0) return undefined;
	if (present !== 4) throw new Error("partial BB context is forbidden");
	if (env.HERDR_ENV === "1" || env.HERDR_PANE_ID || env.HERDR_SOCKET_PATH)
		throw new Error("BB and Herdr contexts are mutually exclusive");
	if (!threadId || !projectId || !environmentId || !server) throw new Error("partial BB context is forbidden");
	for (const [key, value] of [
		["BB_THREAD_ID", threadId],
		["BB_PROJECT_ID", projectId],
		["BB_ENVIRONMENT_ID", environmentId],
	] as const) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error(`${key} has invalid syntax`);
	}
	const url = new URL(server);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "::1", "localhost"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("BB_SERVER_URL must be a credential-free loopback http origin");
	}
	return { threadId, projectId, environmentId, serverUrl: url.origin };
}

export interface BbSurfaceClient {
	start(input: Record<string, unknown>): Promise<BbStartResponse>;
}

async function boundedText(response: Response): Promise<string> {
	const maximum = 1_000_000;
	const declared = response.headers.get("content-length");
	if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum))
		throw new Error("BB plugin response too large or malformed");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximum) {
				await reader.cancel();
				throw new Error("BB plugin response too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		bytes,
	).toString("utf8");
}

export function createBbSurfaceClient(context: BbSurfaceContext, fetcher: typeof fetch = fetch): BbSurfaceClient {
	const prefix = `${context.serverUrl}/api/v1/plugins/meta-harness/http`;
	async function post<T>(path: string, body: unknown, schema: TSchema): Promise<T> {
		const response = await fetcher(`${prefix}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			redirect: "manual",
			signal: AbortSignal.timeout(60_000),
		});
		if (response.status >= 300 && response.status < 400) throw new Error("BB plugin redirect rejected");
		if (!response.ok) throw new Error(`BB plugin returned HTTP ${response.status}`);
		const text = await boundedText(response);
		let decoded: unknown;
		try {
			decoded = JSON.parse(text);
		} catch {
			throw new Error("BB plugin returned invalid JSON");
		}
		try {
			return Value.Parse(schema, decoded) as T;
		} catch {
			throw new Error("BB plugin response violated protocol");
		}
	}
	return {
		start: (input) => post("/v1/agents/start", input, BbStartResponseSchema),
	};
}
