import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "../src/conversation.js";
import { createRuntimeFixture } from "./runtime-fixture.js";
import type { Mutation } from "../src/runtime-contract.js";

const fixture = createRuntimeFixture();
const scope = { workstream: "work", run: "run", node: "root", ownerEpoch: 1 };
async function seed(op: Mutation["op"], payload: Record<string, unknown>) {
  await fixture.call({ v: 1, commandId: crypto.randomUUID(), op, payload, scope, expectedRevision: fixture.run?.revision ?? 0 });
}
await seed("workstream.create", { cwd: "/isolated/fixture-workspace", host: "codex" });
await seed("root.create", { adapter: "codex", model: "fixture-only", thinking: "high", text: "Inspect the fixture with one maker. Ask before choosing a format." });
await seed("packet.admit", { node: "maker", packet: { role: "builder", task: "Inspect the fixture", acceptance: ["Report evidence"], riskTier: "high", cwd: "/isolated/fixture-workspace", adapter: "codex", model: "fixture-only", thinking: "high" } });
await seed("node.launch", { node: "maker" });
fixture.block("maker", "question", JSON.stringify({ questions: [{ id: "format", question: "Which result format should I use?", options: [{ label: "Concise report", description: "Evidence and remaining risk" }, { label: "Detailed report", description: "Include the full inspection" }] }] }));
function FixtureApp() {
  const [connected, setConnected] = useState(true);
  return <><header id="fixture-banner">DETERMINISTIC FIXTURE ONLY · no BB host, socket or model calls.
    <button onClick={() => setConnected(c => !c)}>{connected ? "Fixture disconnect" : "Fixture reconnect"}</button>
    <button onClick={() => { fixture.loseNext = true; }}>Fixture lose next response</button>
    <button onClick={() => { fixture.append("root", "root.progress", "Synthetic update while disconnected"); }}>Fixture append progress</button>
  </header><main><Conversation call={fixture.call} authority="browser-fixture" connected={connected} /></main></>;
}
createRoot(document.getElementById("root")!).render(<FixtureApp />);
