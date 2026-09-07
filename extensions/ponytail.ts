import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Ponytail supplies the modes, commands, persistence, and instruction loader.
// This adapter only bridges Pi's explicit command expansion and our obligations.
export const PONYTAIL_COMPATIBILITY = `## Ponytail in the meta harness
When Ponytail is active, use it throughout diagnosis, planning, implementation,
review, and verification: understand the flow, question unnecessary work, reuse
existing code, then prefer the standard library, native platform, installed
dependencies, and the smallest clear implementation. Apply this in the current
owner's work, not by adding a Ponytail agent, review stage, or whole-repo audit.

These compatibility rules take precedence over conflicting Ponytail advice:
accepted behavior, safety, security, accessibility, role write boundaries,
required checks, and evidence obligations remain binding. A lazy alternative is
not permission to ship incomplete requirements. ONE check is not a test ceiling;
use repository tooling and run every required check. Code-first/three-line advice
does not truncate required reports or requested explanations. Complexity-only
review supplements, never replaces, correctness/security review or independent
verification. Fewer lines is a preference, not a success metric. Do not invent
savings for this repository from upstream benchmarks. Honor explicit mode/off
choices; do not re-enable Ponytail by loading a skill behind the user's choice.
The active core instructions are already injected: do not read them again just
to work, delegate, or recover after compaction. Load specialized skills only for
a relevant decision or explicit command.`;

export async function registerPonytail(
  pi: ExtensionAPI,
  upstream: (api: ExtensionAPI) => void | Promise<void>,
): Promise<void> {
  await upstream({
    ...pi,
    // Upstream's five aliases send /skill:...; Pi otherwise treats that as prose.
    sendUserMessage: (content, options) => pi.sendUserMessage(content, {
      ...options,
      expandPromptTemplates: true,
    }),
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${PONYTAIL_COMPATIBILITY}`,
  }));
}

export default async function ponytail(pi: ExtensionAPI): Promise<void> {
  // Pi's documented global Git package layout; honors isolated agent directories.
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const entry = join(agentDir, "git", "github.com", "DietrichGebert", "ponytail", "pi-extension", "index.js");
  const upstream = await import(pathToFileURL(entry).href);
  await registerPonytail(pi, upstream.default);
}
