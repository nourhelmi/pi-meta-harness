import type { Delivery, Mutation, Run, RuntimeCommand, RuntimeResponse } from "../src/runtime-contract.js";

// Synthetic public-RPC data. NOT a native adapter, provider or live certification.
export const fixtureOperations = ["workstream.create", "workstream.open", "progress", "history", "wait", "root.create", "root.message", "root.reply", "root.cancel", "root.stop", "root.resume", "packet.admit", "node.launch", "node.reply", "node.cancel", "delivery.ack", "artifact.read"];
export function createRuntimeFixture() {
  const fixture = {
    run: null as Run | null,
    entries: [] as Delivery[],
    calls: [] as RuntimeCommand[],
    outcomes: new Map<string, { body: string; response: RuntimeResponse }>(),
    failNext: null as string | null,
    loseNext: false,
    operations: [...fixtureOperations],
    artifact: "# Status\nPASS\nDeterministic artifact, not live proof.",
    append(node: string, kind: string, text: string) { fixture.entries.push({ id: fixture.entries.length + 1, node, kind, text, acked: false }); },
    block(node = "root", kind = "question", text = "Which fixture should we use?") {
      if (!fixture.run) throw new Error("Create fixture first");
      const request = { id: `${node}-request-17`, kind, text };
      if (node === "root") { fixture.run.root!.state = "blocked"; fixture.run.root!.request = request; }
      else { fixture.run.nodes[node]!.status = "blocked"; fixture.run.nodes[node]!.requestDetail = request; fixture.run.nodes[node]!.snapshot.state = "blocked"; fixture.run.nodes[node]!.snapshot.request = request; }
      fixture.run.revision++;
    },
    async call(command: RuntimeCommand): Promise<RuntimeResponse> {
      fixture.calls.push(structuredClone(command));
      if (fixture.failNext) { const error = fixture.failNext; fixture.failNext = null; return { ok: false, error }; }
      if (command.op === "capabilities") return { ok: true, value: { operations: fixture.operations, scopes: ["root", "maker"].map(node => ({ workstream: "work", run: "run", node })) } };
      if (command.op === "history") { const entries = fixture.entries.filter(e => e.id > Number(command.payload.cursor)).slice(0, Number(command.payload.limit)); return { ok: true, value: { entries: structuredClone(entries), nextCursor: entries.at(-1)?.id ?? command.payload.cursor, hasMore: (entries.at(-1)?.id ?? Number(command.payload.cursor)) < (fixture.entries.at(-1)?.id ?? 0) } }; }
      if (command.op === "wait") return { ok: true, value: structuredClone(fixture.entries.filter(e => !e.acked).slice(0, 32)) };
      if (command.op === "artifact.read") return { ok: true, value: { text: fixture.artifact, eof: true } };
      if (command.op === "root.resume") return { ok: false, error: "RESUME_UNSUPPORTED" };
      if (!("commandId" in command)) return fixture.run ? { ok: true, value: structuredClone(fixture.run) } : { ok: false, error: "RUN_FORBIDDEN" };
      const old = fixture.outcomes.get(command.commandId);
      if (old) return old.body === JSON.stringify(command) ? { ...old.response, replayed: true } as RuntimeResponse : { ok: false, error: "COMMAND_ID_REUSE" };
      const node = fixture.run?.nodes[command.scope.node];
      if (command.expectedRevision !== (command.scope.node === "root" ? fixture.run?.revision ?? 0 : node?.revision)) return { ok: false, error: "STALE_REVISION" };
      const p = command.payload;
      switch (command.op) {
        case "workstream.create": fixture.run = { id: "run", workstream: "work", epoch: 1, revision: 0, cwd: String(p.cwd), host: String(p.host), root: null, nodes: {}, packets: {} }; break;
        case "root.create": fixture.run!.root = { adapter: String(p.adapter), state: "idle", request: null, attempt: 1 }; fixture.append("root", "user.message", String(p.text)); fixture.append("root", "root.completed", "Synthetic root ready — no model was called."); break;
        case "root.message": fixture.append("root", "user.message", String(p.text)); fixture.append("root", "root.progress", "Streamed deterministic progress"); fixture.append("root", "root.completed", "Synthetic answer"); break;
        case "root.reply": fixture.run!.root!.request = null; fixture.run!.root!.state = "idle"; fixture.append("root", "user.message", String(p.text)); break;
        case "root.cancel": fixture.run!.root!.request = null; fixture.run!.root!.state = "idle"; fixture.append("root", "root.completed", "Turn finalized after accepted cancellation"); break;
        case "root.stop": fixture.run!.root!.processExited = 0; fixture.append("root", "root.process-exited", "Process exit observed"); break;
        case "packet.admit": fixture.run!.packets[String(p.node)] = p.packet; break;
        case "node.launch": fixture.run!.nodes[String(p.node)] = { revision: 0, status: "running", runtimeState: "running", snapshot: { state: "running", attempt: 1, request: null }, packet: fixture.run!.packets[String(p.node)] as Run["nodes"][string]["packet"] }; break;
        case "node.reply": node!.snapshot.attempt++; node!.snapshot.request = null; node!.snapshot.state = "running"; node!.status = "running"; node!.revision++; fixture.append(command.scope.node, "user.message", String(p.text)); break;
        case "node.cancel": node!.snapshot.state = "terminal"; node!.status = "cancelled"; node!.processExited = 0; node!.revision++; break;
        case "delivery.ack": fixture.entries.find(e => e.id === p.deliveryId)!.acked = true; break;
      }
      fixture.run!.revision++;
      const response: RuntimeResponse = { ok: true, receipt: { commandId: command.commandId, outcome: "accepted", revision: fixture.run!.revision }, replayed: false };
      fixture.outcomes.set(command.commandId, { body: JSON.stringify(command), response });
      if (fixture.loseNext) { fixture.loseNext = false; throw new Error("lost response; never display raw host detail"); }
      return response;
    },
  };
  return fixture;
}
export type RuntimeFixture = ReturnType<typeof createRuntimeFixture>;
export const mutations = (fixture: RuntimeFixture) => fixture.calls.filter((c): c is Mutation => "commandId" in c);
