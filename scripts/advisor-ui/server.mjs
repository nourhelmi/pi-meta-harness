import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { BrokerClient, brokerSocketPath } from "./broker-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.ADVISOR_UI_PORT ?? 4664);
const SCAN_TTL_MS = 1500;
const RUNS_PER_PROJECT = 60;

const broker = new BrokerClient("advisor-dashboard");
broker.start();

async function safeReaddir(path) {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

function parseWorkstream(name, text) {
	const status = /^- Status:\s*(.+)$/m.exec(text)?.[1]?.replaceAll("`", "").trim() ?? null;
	const owner = /Owner session:\s*`?([0-9a-f-]+)/i.exec(text)?.[1] ?? null;
	const goalMatch = /## Goal\s*\n([\s\S]*?)(?:\n## |$)/.exec(text);
	const goal = goalMatch ? goalMatch[1].trim().slice(0, 600) : null;
	return { name, status, owner, goal };
}

function inferResultRole(text) {
	if (!text) return null;
	if (/\b(pass-with-findings|findings|reviewed|fresh-context review|whole-diff review)\b/i.test(text)) return "checker";
	if (/^#\s*Packet\b|##\s*What changed\b/im.test(text)) return "builder";
	if (/\b(browser-verifier|playwright|screenshots?\b|browser evidence)\b/i.test(text)) return "browser-verifier";
	return null;
}

function parseResultState(text) {
	const status = /^##?\s*Status\s*\n+\s*([^\n]+)/im.exec(text)?.[1]?.trim().toLowerCase() ?? "";
	if (/\b(in progress|running|partial)\b/.test(status)) return "running";
	if (/\b(blocked|failed|failure|error)\b/.test(status)) return "incomplete";
	if (/\b(success|complete|completed|pass|passed|pass-with-findings)\b/.test(status)) return "complete";
	return "unknown";
}

async function scanProjects() {
	const rootsDir = process.env.ADVISOR_STATE_HOME ?? join(homedir(), ".advisor");
	const projects = [];
	for (const entry of await safeReaddir(rootsDir)) {
		const root = join(rootsDir, entry);
		try {
			if (!(await stat(root)).isDirectory()) continue;
		} catch {
			continue;
		}
		const project = { key: entry, root, graphs: [], workstreams: [], runs: [] };

		for (const file of await safeReaddir(join(root, "graphs"))) {
			if (!file.endsWith(".json")) continue;
			const path = join(root, "graphs", file);
			try {
				const manifest = JSON.parse(await readFile(path, "utf8"));
				if (!manifest || !Array.isArray(manifest.nodes)) continue;
				manifest.mtime = (await stat(path)).mtimeMs;
				project.graphs.push(manifest);
			} catch {
				// unreadable manifest — skip
			}
		}

		for (const file of await safeReaddir(join(root, "workstreams"))) {
			if (!file.endsWith(".md")) continue;
			try {
				const text = await readFile(join(root, "workstreams", file), "utf8");
				project.workstreams.push(parseWorkstream(file.slice(0, -3), text));
			} catch {
				// skip
			}
		}

		const runsDir = join(root, "runs");
		for (const slug of await safeReaddir(runsDir)) {
			for (const runId of await safeReaddir(join(runsDir, slug))) {
				const dir = join(runsDir, slug, runId);
				let manifest = {};
				try {
					manifest = JSON.parse(await readFile(join(dir, "worker-manifest.json"), "utf8"));
				} catch {
					// run without a manifest still counts
				}
				let mtime = 0;
				try {
					mtime = (await stat(dir)).mtimeMs;
				} catch {
					continue;
				}
				const resultPath = join(dir, "result.md");
				let resultText = "";
				if (existsSync(resultPath)) {
					try {
						resultText = await readFile(resultPath, "utf8");
					} catch {
						// The existence signal still matters when a result cannot be read.
					}
				}
				project.runs.push({
					slug,
					runId,
					role: manifest.role ?? inferResultRole(resultText),
					sessionId: manifest.sessionId ?? runId,
					model: manifest.model ?? null,
					thinking: manifest.thinking ?? null,
					completedPromptCycles: manifest.completedPromptCycles ?? null,
					maxPromptCycles: manifest.maxPromptCycles ?? null,
					hasResult: existsSync(resultPath),
					resultState: parseResultState(resultText),
					resultExcerpt: resultText.slice(0, 6000),
					mtime,
				});
			}
		}

		project.graphs.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
		project.runs.sort((a, b) => b.mtime - a.mtime);
		project.runs = project.runs.slice(0, RUNS_PER_PROJECT);
		if (project.graphs.length || project.workstreams.length || project.runs.length) {
			projects.push(project);
		}
	}
	projects.sort((a, b) => (b.graphs[0]?.mtime ?? 0) - (a.graphs[0]?.mtime ?? 0));
	return projects;
}

/** @type {{ at: number, promise: ReturnType<typeof scanProjects> | null }} */
let scanCache = { at: 0, promise: null };
/**
 * @param {boolean} [force]
 * @returns {ReturnType<typeof scanProjects>}
 */
function cachedProjects(force = false) {
	const now = Date.now();
	if (force || !scanCache.promise || now - scanCache.at > SCAN_TTL_MS) {
		scanCache = { at: now, promise: scanProjects() };
	}
	return scanCache.promise;
}

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(payload);
}

function readBody(req, limit = 256 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	try {
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const html = await readFile(join(here, "index.html"), "utf8");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}

		const staticFiles = {
			"/app.js": [join(here, "app.js"), "text/javascript; charset=utf-8"],
			"/styles.css": [join(here, "styles.css"), "text/css; charset=utf-8"],
			"/vendor/cytoscape.min.js": [join(repoRoot, "node_modules/cytoscape/dist/cytoscape.min.js"), "text/javascript; charset=utf-8"],
		};
		if (req.method === "GET" && staticFiles[url.pathname]) {
			const [path, contentType] = staticFiles[url.pathname];
			res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
			res.end(await readFile(path));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/state") {
			const projects = await cachedProjects(url.searchParams.get("refresh") === "1");
			let sessions = [];
			let listError = null;
			if (broker.connected) {
				try {
					sessions = await broker.listSessions();
				} catch (error) {
					listError = error instanceof Error ? error.message : String(error);
				}
			}
			json(res, 200, {
				now: Date.now(),
				broker: {
					connected: broker.connected,
					sessionId: broker.sessionId,
					socketPath: brokerSocketPath(),
					error: listError ?? broker.lastError,
				},
				sessions,
				projects,
				events: broker.events.slice(-120),
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/send") {
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch {
				json(res, 400, { ok: false, reason: "invalid JSON body" });
				return;
			}
			const to = typeof body.to === "string" ? body.to.trim() : "";
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (!to || !text) {
				json(res, 400, { ok: false, reason: "'to' and 'text' are required" });
				return;
			}
			if (!broker.connected) {
				json(res, 503, { ok: false, reason: "intercom broker not connected" });
				return;
			}
			try {
				const result = await broker.send({
					to,
					text,
					replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
					expectsReply: body.expectsReply === true,
				});
				json(res, result.ok ? 200 : 502, result);
			} catch (error) {
				json(res, 502, { ok: false, reason: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	} catch (error) {
		json(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`advisor-ui: http://${HOST}:${PORT} (broker socket: ${brokerSocketPath()})`);
});

function shutdown() {
	broker.stop();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
