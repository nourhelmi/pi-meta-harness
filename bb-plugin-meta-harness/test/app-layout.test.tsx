// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

const css = await readFile(resolve(process.cwd(), "src/app.css"), "utf8");

// jsdom has no layout/hit testing or viewport media evaluation. Activate the
// stylesheet's width rules explicitly, then use its cascade on the real panel.
// These are source/layout contracts; actual geometry belongs to browser proof.
function viewportStyles(source: string, width: number): HTMLStyleElement {
  const parsed = document.createElement("style");
  parsed.textContent = source;
  document.head.append(parsed);
  try {
    const active = Array.from(parsed.sheet!.cssRules).flatMap((rule) => {
      if (!("conditionText" in rule)) return [rule.cssText];
      const media = rule as CSSMediaRule;
      if (media.conditionText === "(prefers-reduced-motion: reduce)") return [];
      const maximum = /^\(max-width: (\d+)px\)$/u.exec(media.conditionText);
      if (maximum === null) throw new Error(`Unmodeled media: ${media.conditionText}`);
      return width <= Number(maximum[1])
        ? Array.from(media.cssRules, (child) => child.cssText)
        : [];
    });
    const style = document.createElement("style");
    style.textContent = active.join("\n");
    document.head.append(style);
    return style;
  } finally {
    parsed.remove();
  }
}

async function withPanel(source: string, width: number, check: (container: HTMLElement) => void) {
  const style = viewportStyles(source, width);
  const app = await loadPluginApp(() => import("../src/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" });
  try {
    await slot.findByText("Configuration required");
    check(slot.container);
  } finally {
    slot.lifecycle.unmount();
    style.remove();
  }
}

function styles(container: HTMLElement, selector: string): CSSStyleDeclaration {
  const element = container.querySelector(selector);
  expect(element, selector).not.toBeNull();
  return getComputedStyle(element!);
}

function desktopContract(container: HTMLElement) {
  const surface = styles(container, ".trace-surface");
  expect(surface.height).toBe("100%");
  expect(surface.minHeight).toBe("0");
  expect(surface.overflowY).toBe("auto");
  const layout = styles(container, ".trace-layout");
  expect(layout.minHeight).toBe("0");
  expect(layout.gridTemplateRows).toBe("minmax(0, 1fr)");
  expect(layout.gridTemplateColumns).toBe("minmax(17rem, 22rem) minmax(0, 1fr)");
  for (const selector of [".trace-index", ".trace-detail"]) {
    const pane = styles(container, selector);
    expect(pane.minHeight, selector).toBe("0");
    expect(pane.minWidth, selector).toBe("0");
    expect(pane.overflowY, selector).toBe("auto");
  }
}

function mobileContract(container: HTMLElement) {
  const toolbar = styles(container, ".trace-toolbar");
  expect(toolbar.flexShrink).toBe("0");
  expect(toolbar.flexBasis).toBe("auto");
  expect(toolbar.flexDirection).toBe("column");
  // A fixed height would reserve the old 72px even with shrinking disabled.
  expect(["", "auto"]).toContain(toolbar.height);
  const layout = styles(container, ".trace-layout");
  expect(layout.flexShrink).toBe("0");
  expect(layout.gridTemplateRows).toBe("clamp(12rem, 36vh, 19rem) auto");
  const index = styles(container, ".trace-index");
  expect(index.overflowY).toBe("auto");
  expect(index.minHeight).toBe("12rem");
  expect(index.maxHeight).toBe("19rem");
  expect(styles(container, ".trace-surface").overflowY).toBe("auto");

  const header = container.querySelector(".trace-toolbar")!;
  expect(header.nextElementSibling).toBe(container.querySelector(".trace-layout"));
  expect(header.querySelector(".trace-toolbar-actions .trace-connection")).not.toBeNull();
  const refresh = header.querySelector<HTMLButtonElement>(".trace-refresh")!;
  expect(refresh.disabled).toBe(false);
  expect(styles(container, ".trace-refresh").pointerEvents).not.toBe("none");
}

describe("trace layout failure regressions", () => {
  it("requires bounded independent desktop pane constraints at 1280px", async () => {
    await withPanel(css, 1280, desktopContract);
  });

  it("requires intrinsic toolbar flow above the mobile index at 390px", async () => {
    await withPanel(css, 390, mobileContract);
  });

  it.each([
    ["unbounded surface", ".trace-surface { height: auto; min-height: 100% }"],
    ["content-sized desktop track", ".trace-layout { grid-template-rows: auto }"],
    ["visible desktop index overflow", ".trace-index { overflow-y: visible }"],
    [
      "detail minimum expanding the track",
      ".trace-detail { min-height: auto; overflow-y: visible }",
    ],
  ])("rejects %s even as a later no-semicolon override", async (_name, override) => {
    await expect(withPanel(`${css}\n${override}`, 1280, desktopContract)).rejects.toThrow();
  });

  it.each([
    ["shrinking toolbar", ".trace-toolbar { flex: 0 1 auto }"],
    ["fixed 72px toolbar", ".trace-toolbar { height: 72px }"],
    ["clipped mobile surface", ".trace-surface { overflow-y: hidden }"],
  ])("rejects %s even as a later mobile override", async (_name, override) => {
    await expect(
      withPanel(`${css}\n@media (max-width: 520px) { ${override} }`, 390, mobileContract),
    ).rejects.toThrow();
  });
});
