import net from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_FRAME_BYTES = 1024 * 1024;
const RECONNECT_MS = 3000;
const EVENT_CAP = 300;

function agentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured || join(homedir(), ".pi/agent");
}

export function brokerSocketPath() {
	return join(agentDir(), "intercom", "broker.sock");
}

function writeFrame(socket, msg) {
	const json = JSON.stringify(msg);
	const length = Buffer.byteLength(json, "utf8");
	const frame = Buffer.allocUnsafe(4 + length);
	frame.writeUInt32BE(length, 0);
	frame.write(json, 4, length, "utf8");
	socket.write(frame);
}

function createReader(onMessage, onError) {
	let buffer = Buffer.alloc(0);
	return (chunk) => {
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32BE(0);
			if (length > MAX_FRAME_BYTES) {
				onError(new Error(`intercom frame of ${length} bytes exceeds cap`));
				buffer = Buffer.alloc(0);
				return;
			}
			if (buffer.length < 4 + length) return;
			const payload = buffer.subarray(4, 4 + length);
			buffer = buffer.subarray(4 + length);
			try {
				onMessage(JSON.parse(payload.toString("utf8")));
			} catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	};
}

function sessionSummary(session) {
	if (!session || typeof session !== "object") return null;
	return { id: session.id, name: session.name, cwd: session.cwd, model: session.model };
}

export class BrokerClient {
	constructor(name) {
		this.name = name;
		this.socket = null;
		this.sessionId = null;
		this.stopped = false;
		this.lastError = null;
		this.pendingLists = new Map();
		this.pendingSends = new Map();
		this.events = [];
	}

	get connected() {
		return this.sessionId !== null && this.socket !== null && !this.socket.destroyed;
	}

	start() {
		this.#connect();
	}

	stop() {
		this.stopped = true;
		if (this.socket && !this.socket.destroyed) {
			try {
				writeFrame(this.socket, { type: "unregister" });
			} catch {
				// closing anyway
			}
			this.socket.destroy();
		}
	}

	listSessions(timeoutMs = 4000) {
		if (!this.connected) return Promise.reject(new Error("broker not connected"));
		const socket = this.socket;
		return new Promise((resolve, reject) => {
			const requestId = randomUUID();
			const timer = setTimeout(() => {
				this.pendingLists.delete(requestId);
				reject(new Error("list sessions timed out"));
			}, timeoutMs);
			this.pendingLists.set(requestId, {
				resolve: (sessions) => {
					clearTimeout(timer);
					resolve(sessions);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				writeFrame(socket, { type: "list", requestId });
			} catch (error) {
				clearTimeout(timer);
				this.pendingLists.delete(requestId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	send({ to, text, replyTo, expectsReply }) {
		if (!this.connected) return Promise.reject(new Error("broker not connected"));
		const socket = this.socket;
		const message = {
			id: randomUUID(),
			timestamp: Date.now(),
			...(replyTo ? { replyTo } : {}),
			...(expectsReply ? { expectsReply: true } : {}),
			content: { text },
		};
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingSends.delete(message.id);
				reject(new Error("send timed out"));
			}, 10000);
			this.pendingSends.set(message.id, {
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				writeFrame(socket, { type: "send", to, message });
				this.#event("sent", { to, messageId: message.id, text });
			} catch (error) {
				clearTimeout(timer);
				this.pendingSends.delete(message.id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	#event(kind, data) {
		this.events.push({ ts: Date.now(), kind, ...data });
		if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
	}

	#failAllPending(reason) {
		const error = new Error(reason);
		for (const pending of this.pendingLists.values()) pending.reject(error);
		for (const pending of this.pendingSends.values()) pending.reject(error);
		this.pendingLists.clear();
		this.pendingSends.clear();
	}

	#connect() {
		if (this.stopped) return;
		const socket = net.connect(brokerSocketPath());
		this.socket = socket;
		const reader = createReader(
			(msg) => this.#handle(msg),
			(error) => {
				this.lastError = error.message;
				socket.destroy();
			},
		);
		socket.on("data", reader);
		socket.on("error", (error) => {
			this.lastError = error.message;
		});
		socket.on("close", () => {
			const wasConnected = this.sessionId !== null;
			this.sessionId = null;
			if (this.socket === socket) this.socket = null;
			this.#failAllPending("broker connection closed");
			if (wasConnected) this.#event("broker_disconnected", {});
			if (!this.stopped) setTimeout(() => this.#connect(), RECONNECT_MS);
		});
		socket.on("connect", () => {
			const now = Date.now();
			writeFrame(socket, {
				type: "register",
				session: {
					name: this.name,
					cwd: process.cwd(),
					model: "dashboard",
					pid: process.pid,
					startedAt: now,
					lastActivity: now,
					status: "idle",
				},
			});
		});
	}

	#handle(msg) {
		if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
		switch (msg.type) {
			case "registered": {
				this.sessionId = msg.sessionId;
				this.lastError = null;
				this.#event("broker_connected", { sessionId: msg.sessionId });
				break;
			}
			case "sessions": {
				const pending = this.pendingLists.get(msg.requestId);
				if (pending) {
					this.pendingLists.delete(msg.requestId);
					pending.resolve(Array.isArray(msg.sessions) ? msg.sessions : []);
				}
				break;
			}
			case "delivered": {
				const pending = this.pendingSends.get(msg.messageId);
				if (pending) {
					this.pendingSends.delete(msg.messageId);
					pending.resolve({ ok: true, messageId: msg.messageId });
				}
				break;
			}
			case "delivery_failed": {
				const pending = this.pendingSends.get(msg.messageId);
				if (pending) {
					this.pendingSends.delete(msg.messageId);
					pending.resolve({ ok: false, messageId: msg.messageId, reason: msg.reason });
				} else {
					this.#event("delivery_failed", { messageId: msg.messageId, reason: msg.reason });
				}
				break;
			}
			case "message": {
				this.#event("message", {
					from: sessionSummary(msg.from),
					messageId: msg.message?.id,
					text: msg.message?.content?.text,
					replyTo: msg.message?.replyTo,
					expectsReply: msg.message?.expectsReply === true,
				});
				break;
			}
			case "message_receipt": {
				this.#event("receipt", {
					from: sessionSummary(msg.from),
					messageId: msg.receipt?.messageId,
					status: msg.receipt?.status,
					detail: msg.receipt?.detail,
				});
				break;
			}
			case "session_joined": {
				this.#event("session_joined", { session: sessionSummary(msg.session) });
				break;
			}
			case "session_left": {
				this.#event("session_left", { sessionId: msg.sessionId });
				break;
			}
			case "error": {
				this.lastError = typeof msg.error === "string" ? msg.error : "broker error";
				this.#event("broker_error", { error: this.lastError });
				break;
			}
			default:
				break;
		}
	}
}
