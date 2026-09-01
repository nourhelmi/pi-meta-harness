import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerUnifiedEditFallback from "./unified-edit-fallback/upstream.ts";

/**
 * Keep the reviewed row-script editor available when no external edit
 * extension loaded. pi-better-edit is the configured primary; this coordinator
 * avoids overriding it regardless of extension discovery order.
 */
export default function unifiedEditCoordinator(pi: ExtensionAPI): void {
  const externalEdit = pi.getAllTools().find(
    (tool) => tool.name === "edit" && tool.sourceInfo.source !== "builtin",
  );
  if (externalEdit) return;
  registerUnifiedEditFallback(pi);
}
