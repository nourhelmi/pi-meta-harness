// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RuntimeCommand } from "../src/runtime-contract.js";
import { createRuntimeFixture, mutations } from "./runtime-fixture.js";

const mounted: Array<{ lifecycle: { unmount(): void } }> = [];
beforeEach(() => sessionStorage.clear());
afterEach(() => { for (const view of mounted.splice(0)) view.lifecycle.unmount(); });
async function mount(fixture = createRuntimeFixture()) {
  const app = await loadPluginApp(() => import("../src/app.js"));
  const panel = app.navPanels.find(p => p.id === "advisor")!;
  const view = renderSlot(panel, { subPath: "" }, { settings: { hostId: "test-host", runtimeDescriptor: "/private/operator.json" }, realtimeConnectionState: "connected", rpc: { runtime: (command: unknown) => fixture.call(command as RuntimeCommand) } });
  mounted.push(view);
  await view.findByRole("option", { name: "work / run" });
  return { view, fixture };
}
type View = Awaited<ReturnType<typeof mount>>["view"];
const fill = (view: View, label: string, text: string) => fireEvent.change(view.getByLabelText(label), { target: { value: text } });
async function open(view: View) {
  fill(view, "Workstream / run", "0"); fireEvent.click(view.getByRole("button", { name: "Open workstream" }));
  await waitFor(() => expect(view.queryByText("Create authorized workstream / run") || view.queryByRole("heading", { name: "Conversation" })).not.toBeNull());
}
async function create(view: View) {
  await open(view);
  fill(view, "Workspace path", "/fixture/work"); fireEvent.click(view.getByRole("button", { name: "Create workstream" }));
  await view.findByText("Create one runtime-owned root");
  fill(view, "Model", "fixture-model"); fill(view, "First message", "Start the fixture advisor");
  fireEvent.click(view.getByRole("button", { name: "Create root" }));
  await view.findByText("Synthetic root ready — no model was called.");
  await waitFor(() => expect(view.queryByText("Keep this command identity")).toBeNull());
}
async function resync(view: View) {
  fireEvent.click(view.getByRole("button", { name: "Reconnect and resync" }));
  await waitFor(() => expect(view.queryByText("Sending; do not launch a replacement…")).toBeNull());
}
async function maker(view: View) {
  fireEvent.click(view.getByText("Admit a maker packet"));
  fill(view, "Node", "maker"); fill(view, "Task", "Inspect fixture"); fill(view, "Acceptance criteria (one per line)", "Show evidence\nReturn result"); fill(view, "Maker model", "fixture-model");
  fireEvent.click(view.getByRole("button", { name: "Admit packet" }));
  fireEvent.click(await view.findByRole("button", { name: "Launch maker" }));
  await view.findByRole("heading", { name: "maker · builder" });
}

it("public panel creates one scoped workstream/root, messages/streams, admits and launches a maker, replies, inspects artifacts, cancels/stops, acks and reconnects", async () => {
  const { view, fixture } = await mount(); await create(view);
  expect(mutations(fixture).map(c => c.op)).toEqual(["workstream.create", "root.create"]);
  expect(mutations(fixture)[1]).toMatchObject({ expectedRevision: 1, scope: { workstream: "work", run: "run", node: "root", ownerEpoch: 1 }, payload: { model: "fixture-model", text: "Start the fixture advisor" } });
  fill(view, "Message", "hello advisor"); fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText("Streamed deterministic progress"); await view.findByText("hello advisor");
  await maker(view);
  fixture.block("maker"); await resync(view);
  await view.findByText("Which fixture should we use?");
  fill(view, "Answer", "Use fixture A"); fireEvent.click(view.getByRole("button", { name: "Send reply to maker" }));
  await waitFor(() => expect(mutations(fixture).find(c => c.op === "node.reply")).toMatchObject({ scope: { node: "maker" }, expectedRevision: 0, payload: { attempt: 1, requestId: "maker-request-17", text: "Use fixture A" } }));
  const artifact = view.getByRole("button", { name: "Open result maker" }); artifact.focus(); fireEvent.click(artifact);
  const dialog = await view.findByRole("dialog", { name: "maker / result.md" });
  expect(within(dialog).getByRole("button", { name: "Close artifact" })).toBe(document.activeElement);
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(document.activeElement).toBe(artifact);
  fireEvent.click(view.getByRole("button", { name: "Inspect identity maker" })); await view.findByRole("dialog", { name: "maker / native.json" }); fireEvent.click(view.getByRole("button", { name: "Close artifact" }));
  fireEvent.click(view.getByRole("button", { name: "Cancel maker" }));
  await waitFor(() => expect(fixture.run!.nodes.maker!.status).toBe("cancelled"));
  expect(mutations(fixture).find(c => c.op === "node.cancel")!.payload.attempt).toBe(2);
  fixture.run!.root!.state = "running"; await resync(view);
  await waitFor(() => expect((view.getByRole("button", { name: "Cancel root turn" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByRole("button", { name: "Cancel root turn" })); await view.findByText("Turn finalized after accepted cancellation");
  fireEvent.click(view.getByRole("button", { name: "Stop idle root" })); await view.findByText("Process exit observed");
  fireEvent.click(view.getByRole("button", { name: "Acknowledge 1" }));
  await waitFor(() => expect(fixture.entries[0]!.acked).toBe(true));
  await view.behavior.setRealtimeConnectionState("reconnecting"); fixture.append("root", "root.progress", "Persisted during disconnect");
  await view.behavior.setRealtimeConnectionState("connected"); await view.findByText("Persisted during disconnect");
  expect(view.getAllByText("Start the fixture advisor")).toHaveLength(1);
  expect(view.queryByRole("button", { name: "Acknowledge 1" })).toBeNull();
  expect(mutations(fixture).filter(c => c.op === "root.create")).toHaveLength(1);
});

it("preserves the exact ambiguous command across remount; disables fresh side effects and retries without changing ID/body", async () => {
  const fixture = createRuntimeFixture(); const { view } = await mount(fixture);
  await open(view); fill(view, "Workspace path", "/fixture/work");
  fixture.loseNext = true; fireEvent.click(view.getByRole("button", { name: "Create workstream" }));
  await view.findByText("TRANSPORT_UNCERTAIN"); const original = structuredClone(mutations(fixture)[0]!);
  expect(view.queryByText("lost response; never display raw host detail")).toBeNull();
  expect((view.getByRole("button", { name: "Open workstream" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(JSON.stringify(original));
  view.lifecycle.unmount(); mounted.splice(0);
  const remount = (await mount(fixture)).view;
  fireEvent.click(remount.getByRole("button", { name: "Retry exact command" }));
  await waitFor(() => expect(remount.queryByText("Keep this command identity")).toBeNull());
  expect(mutations(fixture)).toEqual([original, original]); expect(fixture.outcomes.size).toBe(1);
  expect(sessionStorage.length).toBe(0);
  await open(remount); await remount.findByText("Create one runtime-owned root");
});

it("shows typed denial, stale CAS with deliberate new submission, unsupported resume and safe artifact errors", async () => {
  const { view, fixture } = await mount(); await create(view);
  fixture.run!.revision++; fill(view, "Message", "stale message"); fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText("STALE_REVISION");
  expect(fixture.entries.some(e => e.text === "stale message")).toBe(false);
  const stale = mutations(fixture).at(-1)!;
  fireEvent.click(view.getByRole("button", { name: "Send message" })); await view.findByText("stale message");
  expect(mutations(fixture).at(-1)!.commandId).not.toBe(stale.commandId);
  fixture.failNext = "SCOPE_FORBIDDEN"; fill(view, "Message", "denied"); fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText("SCOPE_FORBIDDEN"); expect(fixture.entries.some(e => e.text === "denied")).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Request stored resume" })); await view.findByText("RESUME_UNSUPPORTED");
  fixture.failNext = "PATH_FORBIDDEN"; fireEvent.click(view.getByRole("button", { name: "Inspect root identity" })); await view.findByText("PATH_FORBIDDEN");
  expect(view.queryByRole("dialog")).toBeNull();
});

it("renders native question choices into exact answer JSON and exposes only supported one-shot permission choices", async () => {
  const { view, fixture } = await mount(); await create(view);
  fixture.block("root", "question", JSON.stringify({ questions: [{ id: "q1", question: "Which color?", options: [{ label: "Blue" }, { label: "Red" }] }] })); await resync(view);
  fireEvent.click(await view.findByLabelText("Blue")); fireEvent.click(view.getByRole("button", { name: "Send reply to root" }));
  await waitFor(() => expect(mutations(fixture).find(c => c.op === "root.reply")!.payload).toEqual({ requestId: "root-request-17", text: '{"q1":["Blue"]}' }));
  await maker(view);
  fixture.block("maker", "permission", JSON.stringify({ method: "item/commandExecution/requestApproval", itemId: "command", decision: "decline or cancel" })); await resync(view);
  await view.findByLabelText("Exact permission decision");
  expect(view.queryByRole("option", { name: "Allow this exact file input once" })).toBeNull();
  fill(view, "Exact permission decision", "decline"); fireEvent.click(view.getByRole("button", { name: "Send reply to maker" }));
  await waitFor(() => expect(mutations(fixture).filter(c => c.op === "node.reply").at(-1)!.payload.text).toBe("decline"));
  fixture.block("maker", "permission", JSON.stringify({ tool: "Write", path: "/fixture/work/a.txt", inputSha256: "a".repeat(64), decision: "allow or deny this exact file input only; no permission updates" })); await resync(view);
  await view.findByRole("option", { name: "Allow this exact file input once" });
  fill(view, "Exact permission decision", "allow"); fireEvent.click(view.getByRole("button", { name: "Send reply to maker" }));
  await waitFor(() => expect(mutations(fixture).filter(c => c.op === "node.reply").at(-1)!.payload.text).toBe("allow"));
  fixture.block("maker", "permission", "unknown permission"); await resync(view);
  await view.findByText(/Unsupported permission shape/); expect(view.queryByRole("button", { name: "Send reply to maker" })).toBeNull();
});

it("keeps configuration/denied capabilities actionable, bounds transcript, and provides mobile, focus and reduced-motion CSS", async () => {
  const fixture = createRuntimeFixture(); fixture.failNext = "RUNTIME_CONFIGURATION";
  const app = await loadPluginApp(() => import("../src/app.js"));
  const view = renderSlot(app.navPanels.find(p => p.id === "advisor")!, { subPath: "" }, { realtimeConnectionState: "connected", rpc: { runtime: (c: unknown) => fixture.call(c as RuntimeCommand) } }); mounted.push(view);
  await view.findByText("RUNTIME_CONFIGURATION");
  expect(mutations(fixture)).toHaveLength(0);
  const css = readFileSync(resolve("src/conversation.css"), "utf8");
  expect(css).toContain("@media (max-width: 760px)"); expect(css).toContain("grid-template-columns: minmax(0, 1fr)"); expect(css).toContain(":focus-visible"); expect(css).toContain("prefers-reduced-motion"); expect(css).toContain("min-height: 44px");
  view.lifecycle.unmount(); mounted.splice(0);
  const next = await mount(); await create(next.view);
  for (let i = 0; i < 330; i++) next.fixture.append("root", "root.progress", `fixture entry ${i}`);
  await resync(next.view);
  for (const last of [125, 189, 253, 317, 329]) {
    fireEvent.click(await next.view.findByRole("button", { name: "Load next history page" }));
    await next.view.findByText(`fixture entry ${last}`);
  }
  expect(within(next.view.getByRole("list", { name: "Durable transcript" })).getAllByRole("listitem")).toHaveLength(256);
  expect(next.view.queryByText("fixture entry 0")).toBeNull();
});

it("clears a successfully replayed message draft and never repeats its admitted message", async () => {
  const { view, fixture } = await mount(); await create(view);
  fixture.loseNext = true; fill(view, "Message", "one uncertain message");
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText("TRANSPORT_UNCERTAIN");
  const first = mutations(fixture).find(c => c.op === "root.message")!;
  fireEvent.click(view.getByRole("button", { name: "Retry exact command" }));
  await waitFor(() => expect(view.queryByText("Keep this command identity")).toBeNull());
  expect(mutations(fixture).filter(c => c.op === "root.message")).toEqual([first, first]);
  expect(fixture.entries.filter(e => e.text === "one uncertain message")).toHaveLength(1);
  expect((view.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
});
