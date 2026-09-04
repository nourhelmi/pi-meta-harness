import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import { metaHarnessRpcContract } from "./contracts.js";

type Snapshot = StandardSchemaV1InferOutput<(typeof metaHarnessRpcContract)["snapshot"]["output"]>;
const GRAPH_ID = "bb-adapter-live-canary";

const styles = `
.mh-shell{min-height:100%;background:#edf1f4;color:#17212b;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:22px}.mh-head{display:flex;align-items:end;justify-content:space-between;gap:20px;border-bottom:3px solid #17212b;padding-bottom:14px;margin-bottom:18px}.mh-kicker{color:#315ea8;font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:11px}.mh-head h1{font:800 30px/1 ui-rounded,system-ui,sans-serif;letter-spacing:-.04em;margin:3px 0 0}.mh-hash{max-width:38ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#536575}.mh-wave{display:grid;grid-template-columns:106px minmax(0,1fr);gap:16px;margin:16px 0}.mh-rail{border-right:2px solid #346beb;color:#244b9b;font-weight:850;padding:14px 16px 0 0;text-transform:uppercase;letter-spacing:.08em}.mh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:11px}.mh-node{background:#fff;border:1px solid #9aa8b5;border-left:6px solid #346beb;padding:15px;box-shadow:3px 3px 0 #c7d0d9;min-width:0}.mh-node[data-status="blocked"]{border-left-color:#d97706}.mh-node[data-status="done"],.mh-node[data-status="exited"]{border-left-color:#198754}.mh-node[data-status="error"],.mh-node[data-status="stalled"]{border-left-color:#b42318}.mh-node h2{font:750 17px/1.2 ui-rounded,system-ui,sans-serif;margin:0}.mh-row{display:flex;align-items:start;justify-content:space-between;gap:10px}.mh-status{border:1px solid currentColor;border-radius:999px;padding:2px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.mh-meta{color:#536575;font-size:12px;overflow-wrap:anywhere}.mh-meta strong{color:#17212b}.mh-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.mh-button{border:1px solid #17212b;background:#fff;color:#17212b;padding:6px 9px;font:inherit;font-weight:750;cursor:pointer}.mh-button:hover:not(:disabled){background:#17212b;color:#fff}.mh-button:disabled{opacity:.45;cursor:not-allowed}.mh-button:focus-visible,.mh-input:focus-visible,.mh-summary:focus-visible{outline:3px solid #ffb703;outline-offset:2px}.mh-primary{background:#17212b;color:#fff}.mh-log{background:#17212b;color:#dce8f2;max-height:150px;overflow:auto;padding:9px;white-space:pre-wrap;font-size:11px;overflow-wrap:anywhere}.mh-details{margin-top:10px}.mh-summary{cursor:pointer;font-weight:750}.mh-error{border:2px solid #b42318;background:#fff0ee;padding:12px;display:flex;justify-content:space-between;gap:12px}.mh-empty{border:1px dashed #738496;padding:22px}.mh-panel{margin-top:24px;border-top:1px solid #9aa8b5;padding-top:14px}.mh-panel h2{font:750 17px/1.2 ui-rounded,system-ui,sans-serif}.mh-edge,.mh-wake{background:#fff;border:1px solid #b9c3cb;padding:8px 10px;margin:6px 0;overflow-wrap:anywhere}.mh-compose{position:sticky;bottom:10px;background:#fff;border:2px solid #17212b;box-shadow:5px 5px 0 #b9c3cb;padding:12px;margin-top:18px}.mh-compose form{display:flex;gap:7px;margin-top:7px}.mh-input{min-width:0;flex:1;border:1px solid #667783;padding:7px;font:inherit}.mh-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:640px){.mh-shell{padding:14px}.mh-head{align-items:start;flex-direction:column}.mh-wave{grid-template-columns:1fr}.mh-rail{border-right:0;border-bottom:2px solid #346beb;padding:0 0 7px}.mh-compose form{flex-wrap:wrap}.mh-input{flex-basis:100%}}@media(prefers-reduced-motion:no-preference){.mh-node{transition:transform 120ms ease,box-shadow 120ms ease}.mh-node:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 #c7d0d9}}
`;

function MetaHarnessPanel() {
  const rpc = useRpc<typeof metaHarnessRpcContract>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [messageTarget, setMessageTarget] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const mounted = useRef(true);
	const nodes = snapshot?.nodes;
	const nodesById = useMemo(
		() => new Map((nodes ?? []).map((node) => [node.id, node])),
		[nodes],
	);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("snapshot", { graphId: GRAPH_ID });
      if (mounted.current) {
        setSnapshot(next);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);
  const invalidate = useCallback(() => { void refresh(); }, [refresh]);
  useRealtime("projection-invalidated", invalidate);

  const runAction = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }, [refresh]);
  const stop = useCallback((threadId: string) => runAction(`stop:${threadId}`, () => rpc.call("stop", { threadId })), [rpc, runAction]);
  const answer = useCallback((runId: string, threadId: string) => runAction(`answer:${runId}`, () => rpc.call("answerBlocked", { runId, threadId, answer: "BB-POC-CONTINUE" })), [rpc, runAction]);
  const wakeDecision = useCallback((method: "retryWake" | "skipWake", parent: string, generation: string) => runAction(`${method}:${generation}`, () => rpc.call(method, { logicalParentThreadId: parent, settlementGeneration: generation })), [rpc, runAction]);
  const submitMessage = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const text = messageText.trim();
    if (!messageTarget || !text) return;
    await runAction(`message:${messageTarget}`, () => rpc.call("message", { threadId: messageTarget, text }));
    setMessageTarget(null);
    setMessageText("");
  }, [messageTarget, messageText, rpc, runAction]);

  return <main className="mh-shell">
    <style>{styles}</style>
    <header className="mh-head">
      <div><div className="mh-kicker">Canonical graph projection</div><h1>Meta Harness switchboard</h1></div>
      <div className="mh-hash" title={snapshot?.hash}>hash {snapshot?.hash ?? "loading"}</div>
    </header>
    <div className="mh-sr" aria-live="polite">{busy ? `Working: ${busy}` : "Ready"}</div>
    {error ? <div className="mh-error" role="alert"><span>Projection unavailable: {error}</span><button className="mh-button" type="button" onClick={() => void refresh()}>Retry</button></div> : null}
    {snapshot?.waves.length === 0 ? <div className="mh-empty">No graph nodes are projected yet.</div> : snapshot?.waves.map((wave) =>
      <section className="mh-wave" key={wave.index} aria-labelledby={`wave-${wave.index}`}>
        <div className="mh-rail" id={`wave-${wave.index}`}>Wave {wave.index}</div>
        <div className="mh-grid">{wave.nodeIds.map((nodeId) => {
          const node = nodesById.get(nodeId);
          if (!node) return null;
          const nodeBusy = busy !== null && [node.runId, node.threadId]
            .some((identity) => identity !== undefined && busy.endsWith(identity));
          return <article className="mh-node" data-status={node.status.toLowerCase()} key={node.id}>
            <div className="mh-row"><h2>{node.id}</h2><span className="mh-status">{node.status}</span></div>
            <div className="mh-meta"><strong>{node.role}</strong> · {node.worktree}</div>
            <div className="mh-meta">depends on {node.dependsOn.length ? node.dependsOn.join(", ") : "nothing"}</div>
            {node.runId ? <div className="mh-meta">run <strong>{node.runId}</strong></div> : null}
            {node.threadId ? <div className="mh-meta">thread <strong>{node.threadId}</strong> · {node.threadState} · host {node.hostId}</div> : null}
            {node.resultStatus ? <div className="mh-meta">result <strong>{node.resultStatus}</strong></div> : null}
            {node.logPath ? <details className="mh-details"><summary className="mh-summary">Log · {node.logPath}</summary><pre className="mh-log">{node.logTail || "No log output."}</pre></details> : null}
            {node.artifactPath ? <details className="mh-details"><summary className="mh-summary">Result · {node.artifactPath}</summary><pre className="mh-log">{node.artifact || "Artifact unavailable."}</pre></details> : null}
            <div className="mh-actions">
              {node.threadId ? <>
                <button className="mh-button mh-primary" type="button" onClick={() => navigate.toThread(node.threadId!)}>Open</button>
                <button className="mh-button" type="button" disabled={nodeBusy} onClick={() => void stop(node.threadId!)}>Stop</button>
                <button className="mh-button" type="button" onClick={() => { setMessageTarget(node.threadId!); setMessageText(""); }}>Message</button>
              </> : null}
              {node.status.toLowerCase() === "blocked" && node.runId && node.threadId ? <button className="mh-button" type="button" disabled={nodeBusy} onClick={() => void answer(node.runId!, node.threadId!)}>Answer BB-POC-CONTINUE</button> : null}
            </div>
          </article>;
        })}</div>
      </section>)}
    {snapshot ? <section className="mh-panel" aria-labelledby="edges-title"><h2 id="edges-title">Logical edges</h2>{snapshot.edges.length ? snapshot.edges.map((edge) => <div className="mh-edge" key={`${edge.from}:${edge.to}`}>{edge.from} → {edge.to}</div>) : <div className="mh-empty">No dependency edges.</div>}</section> : null}
	{snapshot ? <section className="mh-panel" aria-labelledby="wakes-title"><h2 id="wakes-title">Wake admission</h2>{snapshot.wakeAdmissions.length ? snapshot.wakeAdmissions.map((wake) => <div className="mh-wake" key={`${wake.logicalParentThreadId}:${wake.settlementGeneration}`}><strong>{wake.state}{wake.operatorSkippedAt ? " · operator skipped" : ""}</strong> · run {wake.runId} · parent {wake.logicalParentThreadId} · {wake.settlementGeneration.slice(0, 12)}{wake.state === "unknown" && !wake.operatorSkippedAt ? <span className="mh-actions"><button className="mh-button" type="button" disabled={Boolean(busy)} onClick={() => void wakeDecision("retryWake", wake.logicalParentThreadId, wake.settlementGeneration)}>Retry (may duplicate)</button><button className="mh-button" type="button" disabled={Boolean(busy)} onClick={() => void wakeDecision("skipWake", wake.logicalParentThreadId, wake.settlementGeneration)}>Skip</button></span> : null}</div>) : <div className="mh-empty">No terminal wake admissions.</div>}</section> : null}
    {messageTarget ? <aside className="mh-compose" aria-labelledby="message-title"><strong id="message-title">Message thread {messageTarget}</strong><form onSubmit={(event) => void submitMessage(event)}><label className="mh-sr" htmlFor="mh-message">Message</label><input className="mh-input" id="mh-message" autoFocus value={messageText} onChange={(event) => setMessageText(event.target.value)} /><button className="mh-button mh-primary" type="submit" disabled={!messageText.trim() || Boolean(busy)}>Send</button><button className="mh-button" type="button" onClick={() => setMessageTarget(null)}>Cancel</button></form></aside> : null}
  </main>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "meta-harness",
    title: "Meta Harness",
    icon: "Network",
    path: "meta-harness",
    component: MetaHarnessPanel,
  });
});
