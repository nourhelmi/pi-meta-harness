import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRealtimeConnectionState, useRpc, useSettings, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { RuntimeRpcContract } from "./runtime-rpc.js";
import type { Mutation, RuntimeCommand } from "./runtime-contract.js";
import { guidance, useRuntime, type CallRuntime } from "./use-runtime.js";
import "./conversation.css";

type RuntimeView = ReturnType<typeof useRuntime>;
const value = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? "").trim();
const field = (label: string, name: string, initial = "", type = "text") => <label>{label}<input name={name} type={type} defaultValue={initial} required maxLength={type === "text" ? 4096 : undefined} /></label>;

function ArtifactDialog({ artifact, close }: { artifact: NonNullable<RuntimeView["artifact"]>; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="advisor-backdrop"><div ref={ref} className="advisor-artifact" role="dialog" aria-modal="true" aria-label={artifact.title} onKeyDown={event => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const targets = ref.current?.querySelectorAll<HTMLElement>("button, [tabindex='0']");
      const first = targets?.[0]; const last = targets?.[targets.length - 1];
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    }
  }}><header><h2>{artifact.title}</h2><button onClick={close}>Close artifact</button></header><p>{artifact.eof ? "Complete bounded artifact" : "First 64 KiB only; inspect remaining bytes with the scoped CLI."}</p><pre tabIndex={0}>{artifact.text}</pre></div></div>;
}

type Question = { id?: string; question: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };
function questionList(text: string): Question[] | null {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.questions) || parsed.questions.length < 1 || parsed.questions.length > 4) return null;
    if (!parsed.questions.every((q: Question) => typeof q.question === "string" && (q.id === undefined || typeof q.id === "string") && (q.options === undefined || q.options === null || (Array.isArray(q.options) && q.options.every(o => typeof o.label === "string" && (o.description === undefined || typeof o.description === "string")))))) return null;
    return parsed.questions;
  } catch { return null; }
}
function permissionChoices(text: string): string[] {
  try {
    const p = JSON.parse(text);
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(p.method)) return ["decline", "cancel"];
    if (p.method === "item/permissions/requestApproval") return ["deny"];
    if (["Write", "Edit"].includes(p.tool) && typeof p.path === "string" && /^[a-f0-9]{64}$/u.test(p.inputSha256) && p.decision === "allow or deny this exact file input only; no permission updates") return ["deny", "allow"];
    if (typeof p.decision === "string" && p.decision.startsWith("deny only")) return ["deny"];
    return [];
  } catch { return []; }
}
function RequestCard({ node, id, kind, text, attempt, runtime, disabled }: { node: string; id: string; kind: string; text: string; attempt?: number; runtime: RuntimeView; disabled: boolean }) {
  const questions = questionList(text);
  const choices = kind === "permission" ? permissionChoices(text) : [];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    let answer = value(form, "answer");
    if (questions) {
      for (let i = 0; i < questions.length; i++) {
        const custom = form.elements.namedItem(`custom-${i}`) as HTMLInputElement;
        custom.setCustomValidity("");
        if (!value(form, `custom-${i}`) && !new FormData(form).getAll(`question-${i}`).length) {
          custom.setCustomValidity("Choose an option or enter an answer."); custom.reportValidity(); return;
        }
      }
      answer = JSON.stringify(Object.fromEntries(questions.map((q, i) => {
        const values = new FormData(form).getAll(`question-${i}`).map(String).filter(Boolean);
        const custom = value(form, `custom-${i}`); if (custom) values.push(custom);
        return [q.id ?? q.question, q.id ? values : values.join(", ")];
      })));
    }
    void runtime.mutate(node === "root" ? "root.reply" : "node.reply", { requestId: id, text: answer, ...(attempt ? { attempt } : {}) }, node);
  };
  return <article className="advisor-request"><h3>{node} · {kind}</h3><code>{id}{attempt ? ` · attempt ${attempt}` : ""}</code>
    {questions ? null : <pre>{text}</pre>}
    <button onClick={() => void runtime.openArtifact(node, "request.json")}>Inspect request {node}</button>
    {kind === "credential" ? <p>Resolve credentials through the host login flow. Never enter a secret in this transcript.</p> : <form onSubmit={submit} onChange={event => event.currentTarget.querySelectorAll("input").forEach(input => input.setCustomValidity(""))}><fieldset disabled={disabled}><legend>Reply to {node}</legend>
      {questions ? questions.map((q, i) => <fieldset key={q.id ?? q.question}><legend>{q.question}</legend>
        {q.options?.map(option => <label key={option.label}><input type={q.multiSelect ? "checkbox" : "radio"} name={`question-${i}`} value={option.label} />{option.label}{option.description ? <small>{option.description}</small> : null}</label>)}
        <label>Custom answer<input name={`custom-${i}`} maxLength={2048} required={!q.options?.length} onInput={event => event.currentTarget.setCustomValidity("")} /></label>
      </fieldset>) : kind === "permission" ? <label>Exact permission decision<select name="answer" required defaultValue=""><option value="" disabled>Choose a decision</option>{choices.map(choice => <option key={choice} value={choice}>{choice === "allow" ? "Allow this exact file input once" : choice}</option>)}</select></label> : <label>Answer<textarea name="answer" required maxLength={16000} /></label>}
      {kind === "permission" && !choices.length ? <p>Unsupported permission shape. Inspect the artifact; no blanket grant is available.</p> : <button type="submit">Send reply to {node}</button>}
    </fieldset></form>}</article>;
}

export function Conversation({ call, authority, connected = true }: { call: CallRuntime; authority: string; connected?: boolean }) {
  const runtime = useRuntime(call, authority, connected);
  const { capabilities, scope, run, pending, busy } = runtime;
  const [selection, setSelection] = useState("");
  const locked = busy || pending !== null || !connected;
  const can = (op: Mutation["op"]) => !locked && Boolean(capabilities?.operations.includes(op));
  const roots = capabilities?.scopes.filter(s => s.node === "root") ?? [];
  const workers = capabilities?.scopes.filter(s => s.node !== "root" && s.run === scope?.run && s.workstream === scope?.workstream) ?? [];
  const submitWorkstream = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget;
    const selected = roots[Number(selection)];
    if (selected && selection !== "") runtime.choose({ ...selected, ownerEpoch: Number(value(form, "epoch")) });
  };
  const createRun = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget;
    void runtime.mutate("workstream.create", { cwd: value(form, "cwd"), host: value(form, "host") });
  };
  const createRoot = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget;
    void runtime.mutate("root.create", { adapter: value(form, "adapter"), model: value(form, "model"), thinking: value(form, "thinking"), text: value(form, "text") });
  };
  const admitMaker = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget;
    void runtime.mutate("packet.admit", { node: value(form, "node"), packet: { role: value(form, "role"), task: value(form, "task"), acceptance: value(form, "acceptance").split("\n").map(s => s.trim()).filter(Boolean), riskTier: value(form, "risk"), cwd: value(form, "cwd"), adapter: value(form, "adapter"), model: value(form, "model"), thinking: value(form, "thinking") } });
  };
  return <section className="advisor-console" aria-label="Advisor conversation">
    <header className="advisor-header"><div><p>Durable advisor · one runtime</p><h1>{scope?.workstream ?? "Open a workstream"}</h1></div><div><span role="status">{connected ? "Connected · bounded polling" : "Disconnected · fleet continues"}</span><button disabled={busy || !connected} onClick={() => void runtime.reconnect()}>Reconnect and resync</button></div></header>
    <form className="advisor-scope" onSubmit={submitWorkstream}><fieldset disabled={locked}><legend>Authorized workstreams</legend>
      <label>Workstream / run<select value={selection} onChange={event => setSelection(event.target.value)} required><option value="">Choose an authorized scope</option>{roots.map((s, i) => <option key={`${s.workstream}/${s.run}`} value={i}>{s.workstream} / {s.run}</option>)}</select></label>
      {field("Owner epoch", "epoch", "1", "number")}<button type="submit">Open workstream</button>
    </fieldset><p>Creation is limited to the exact scopes registered by your operator. New scope? Register it on the host first.</p></form>
    {runtime.error ? <div role="alert" className="advisor-error"><strong>{runtime.error}</strong><p>{guidance(runtime.error)}</p></div> : null}
    {pending ? <section className="advisor-pending" aria-label="Unconfirmed command"><h2>Keep this command identity</h2><p>{pending.op} · <code>{pending.commandId}</code> · {pending.scope.workstream}/{pending.scope.run}/{pending.scope.node}</p><p>{guidance("TRANSPORT_UNCERTAIN")}</p><button disabled={busy || !connected} onClick={() => void runtime.retry()}>Retry exact command</button></section> : null}
    <p role="status" className="advisor-receipt">{busy ? "Sending; do not launch a replacement…" : runtime.notice}</p>
    {scope && !run ? <form onSubmit={createRun}><fieldset disabled={!can("workstream.create")}><legend>Create authorized workstream / run</legend>{field("Workspace path", "cwd")}<label>Native host<select name="host"><option value="codex">Codex CLI</option><option value="claude-code">Claude Code</option></select></label><button>Create workstream</button></fieldset></form> : null}
    {run ? <div className="advisor-layout"><section className="advisor-transcript" aria-label="Conversation and controls"><header><h2>Conversation</h2><code>{run.id} · revision {run.revision} · root {run.root?.state ?? "not created"}</code></header>
      {!run.root ? <form onSubmit={createRoot}><fieldset disabled={!can("root.create")}><legend>Create one runtime-owned root</legend><NativeFields host={run.host} />{field("Model", "model")}{field("Thinking effort", "thinking", "high")}<label>First message<textarea name="text" required maxLength={16000} /></label><button>Create root</button></fieldset><p>Use an available model explicitly. Unsupported adapter/model or resume returns a typed rejection; BB does not spawn its own thread.</p></form> : null}
      <ol aria-label="Durable transcript" className="advisor-messages">{runtime.entries.map(entry => <li key={entry.id} data-kind={entry.kind}><header><strong>{entry.kind === "user.message" ? entry.source === "advisor" ? "Advisor" : "You" : entry.node}</strong><small>{entry.kind} · delivery {entry.id}{entry.acked ? " · acknowledged" : ""}</small></header><p>{entry.text ?? entry.note ?? entry.reason ?? entry.status ?? "Durable lifecycle event"}</p></li>)}</ol>
      {!runtime.entries.length ? <p>No conversation entries yet. Start the root or reconnect to read durable history.</p> : null}
      <p className="advisor-note">Showing at most 256 persisted entries. Acknowledgment never deletes history. Updates poll the same service every 1.5 seconds; this is not model wake.</p>
      {runtime.hasMore ? <button onClick={() => void runtime.refresh()}>Load next history page</button> : null}
      {run.root ? <><form key={runtime.messageReceipt} onSubmit={event => { event.preventDefault(); const form = event.currentTarget; void runtime.mutate("root.message", { text: value(form, "text") }).then(ok => { if (ok) form.reset(); }); }}><fieldset disabled={!can("root.message") || run.root.state !== "idle" || run.root.processExited !== undefined}><legend>Message the advisor</legend><label>Message<textarea name="text" required maxLength={16000} /></label><button>Send message</button></fieldset></form>
        <div className="advisor-controls"><button disabled={!can("root.cancel") || !["running", "blocked"].includes(run.root.state)} onClick={() => void runtime.mutate("root.cancel", { reason: "User cancelled from BB" })}>Cancel root turn</button><button disabled={!can("root.stop") || run.root.state !== "idle" || run.root.processExited !== undefined} onClick={() => void runtime.mutate("root.stop", {})}>Stop idle root</button><button disabled={!can("root.resume")} onClick={() => void runtime.mutate("root.resume", {})}>Request stored resume</button><button onClick={() => void runtime.openArtifact("root", "native.json")}>Inspect root identity</button></div><p>Process exit: {run.root.processExited === undefined ? "not observed" : `observed (${run.root.processExited})`}. Cancel acceptance is not process exit.</p></> : null}
    </section><aside className="advisor-rail" aria-label="Fleet and outstanding requests"><section className="advisor-attention"><h2>Needs your reply</h2>
      {run.root?.request ? <RequestCard key={`root/${run.root.request.id}`} node="root" id={run.root.request.id} kind={run.root.request.kind ?? "question"} text={run.root.request.text ?? "Inspect request"} runtime={runtime} disabled={!can("root.reply")} /> : null}
      {Object.entries(run.nodes).filter(([, n]) => n.snapshot.state === "blocked" && n.snapshot.request && !n.snapshot.request.answered).map(([node, n]) => <RequestCard key={`${node}/${n.snapshot.request!.id}`} node={node} id={n.snapshot.request!.id} attempt={n.snapshot.attempt} kind={n.requestDetail?.kind ?? "question"} text={n.requestDetail?.text ?? "Inspect request.json before answering."} runtime={runtime} disabled={!can("node.reply")} />)}
      {!run.root?.request && !Object.values(run.nodes).some(n => n.snapshot.state === "blocked") ? <p>No outstanding questions or permissions.</p> : null}</section>
      <section><h2>Fleet</h2>{Object.entries(run.nodes).map(([node, n]) => <article className="advisor-node" key={node}><h3>{node} · {n.packet.role}</h3><p>{n.status} · {n.runtimeState} · attempt {n.snapshot.attempt} · revision {n.revision}</p><p>{n.packet.model} / {n.packet.thinking} (requested)</p><p>Process exit: {n.processExited === undefined ? "not observed" : `observed (${n.processExited})`}</p><div className="advisor-controls"><button onClick={() => void runtime.openArtifact(node, "result.md")}>Open result {node}</button><button onClick={() => void runtime.openArtifact(node, "native.json")}>Inspect identity {node}</button><button disabled={!can("node.cancel") || n.snapshot.state === "terminal"} onClick={() => void runtime.mutate("node.cancel", { attempt: n.snapshot.attempt, reason: "User cancelled from BB" }, node)}>Cancel {node}</button></div></article>)}
      {Object.keys(run.packets).filter(node => !run.nodes[node]).map(node => <button key={node} disabled={!can("node.launch")} onClick={() => void runtime.mutate("node.launch", { node })}>Launch {node}</button>)}
      <details><summary>Admit a maker packet</summary><form onSubmit={admitMaker}><fieldset disabled={!can("packet.admit")}><legend>One scoped maker</legend><label>Node<select name="node" required><option value="">Choose an authorized node</option>{workers.filter(s => !run.packets[s.node]).map(s => <option key={s.node}>{s.node}</option>)}</select></label><label>Role<select name="role"><option>builder</option><option>reviewer</option></select></label><label>Task<textarea name="task" required maxLength={16000} /></label><label>Acceptance criteria (one per line)<textarea name="acceptance" required maxLength={12000} /></label><label>Risk<select name="risk"><option>high</option><option>standard</option><option>low</option></select></label>{field("Maker workspace", "cwd", run.cwd)}<NativeFields host={run.host} />{field("Maker model", "model")}{field("Maker thinking", "thinking", "high")}<button>Admit packet</button></fieldset></form></details></section>
      <section><h2>Awaiting acknowledgment</h2><p>Acknowledge only after inspecting the outcome. Delivery is not a model turn.</p>{runtime.unacked.map(entry => <div className="advisor-delivery" key={entry.id}><span>{entry.node} · {entry.kind} · {entry.id}</span><button disabled={!can("delivery.ack")} onClick={() => void runtime.mutate("delivery.ack", { deliveryId: entry.id })}>Acknowledge {entry.id}</button></div>)}</section>
    </aside></div> : null}
    {runtime.artifact ? <ArtifactDialog artifact={runtime.artifact} close={runtime.closeArtifact} /> : null}
  </section>;
}
function NativeFields({ host }: { host: string }) { return <label>Adapter<select name="adapter" defaultValue={host}><option value="codex">Codex CLI</option><option value="claude-code">Claude Code</option></select></label>; }

export function ConversationPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<RuntimeRpcContract>();
  const settings = useSettings();
  const connection = useRealtimeConnectionState();
  const call = useCallback((command: RuntimeCommand) => rpc.call("runtime", command), [rpc]);
  const authority = JSON.stringify([settings.values?.hostId, settings.values?.runtimeDescriptor]);
  if (settings.isLoading) return <p role="status">Loading runtime settings…</p>;
  return <Conversation key={authority} call={call} authority={authority} connected={connection === "connected"} />;
}
