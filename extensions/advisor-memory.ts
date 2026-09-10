import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advisorCheckpoint } from "./advisor-core/advisor-state.ts";

export const CHECKPOINT_MEMORY = `## Advisor memory integration
The workstream current section is the single operational checkpoint. Keep its outcome,
owner, remaining uncertainty, evidence locators and next action current at material
boundaries. Session metadata is a pointer, not a second diary. Engram remains available
for searching prior knowledge and optionally saving durable reusable lessons; there is
no mandatory per-step save, session-summary copy, or compaction archive in this mode.
After compaction, recover from the workstream checkpoint and linked captured evidence.
Missing, stale or corrupt checkpoint/proof means unknown, never completion. Do not
reconstruct authority from an old conversation summary or overwrite another owner.`;

/** Supported hook composition: upstream is unchanged; only its automatic diary hooks
 * are bypassed for this exact managed advisor identity. No prompt string surgery. */
export function registerAdvisorMemory(pi: ExtensionAPI, upstream: (api: ExtensionAPI) => void): void {
  let initializingSession: string | undefined;
  pi.on("input", (event, ctx) => {
    initializingSession = /^\/skill:advisor(?:-pi|-native)?(?:\s|$)/.test(event.text) ? ctx.sessionManager.getSessionId() : undefined;
  });
  upstream(new Proxy(pi, {
    get(target, key) {
      if (key !== "on") return Reflect.get(target, key);
      return (eventName: string, handler: (...args: any[]) => unknown) => {
        const on = target.on as (name: string, handler: (...args: any[]) => unknown) => void;
        on(eventName, async (event: any, ctx: ExtensionContext) => {
          if (["before_agent_start", "session_compact", "tool_execution_end", "session_start"].includes(eventName)) {
            const checkpoint = await advisorCheckpoint(ctx);
            const initializing = initializingSession === ctx.sessionManager.getSessionId() || (eventName === "before_agent_start" && /^(?:\/skill:advisor(?:-pi|-native)?(?:\s|$)|<skill name="advisor(?:-pi|-native)?")/.test(event.prompt ?? ""));
            if (checkpoint || initializing) {
              if (eventName === "before_agent_start") {
                initializingSession = undefined;
                return { systemPrompt: `${event.systemPrompt}\n\n${CHECKPOINT_MEMORY}\nCheckpoint: ${checkpoint?.path ?? "initialize with advisor_session_init first"}${checkpoint?.problem ? `\n${checkpoint.problem}` : ""}` };
              }
              return;
            }
          }
          if (eventName === "session_shutdown") initializingSession = undefined;
          return handler(event, ctx);
        });
      };
    },
  }));
}

export default async function advisorMemory(pi: ExtensionAPI): Promise<void> {
  const upstream = await import(new URL("../third-party/gentle-engram/index.ts", import.meta.url).href);
  registerAdvisorMemory(pi, upstream.default);
}
