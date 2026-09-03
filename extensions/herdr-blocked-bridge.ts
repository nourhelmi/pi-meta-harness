/**
 * Bridge Pi's blocking UI prompt lifecycle onto Herdr's reference-counted
 * `herdr:blocked` event contract.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function herdrBlockedBridge(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;

	let activePrompts = 0;
	pi.on("ui_prompt_start", (event) => {
		activePrompts += 1;
		const label = typeof event.title === "string" && event.title.trim()
			? event.title
			: `${event.kind} prompt`;
		pi.events.emit("herdr:blocked", { active: true, label });
	});
	pi.on("ui_prompt_end", () => {
		if (activePrompts === 0) return;
		activePrompts -= 1;
		pi.events.emit("herdr:blocked", { active: false });
	});
}
