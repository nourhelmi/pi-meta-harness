import { useCallback, useEffect, useRef, useState } from "react";
import { artifactSchema, capabilitiesSchema, commandSchema, deliverySchema, historySchema, runSchema, type Capabilities, type Delivery, type Mutation, type Run, type RuntimeCommand, type RuntimeResponse, type Scope } from "./runtime-contract.js";

export type CallRuntime = (command: RuntimeCommand) => Promise<RuntimeResponse>;
export const guidance = (code: string) => ({
  RUNTIME_CONFIGURATION: "Set the host and canonical private operator descriptor path in BB settings; start the existing service. Never paste a token.",
  SCOPE_FORBIDDEN: "Choose an explicitly authorized workstream/run/node or ask the operator to register it. No wildcard grants.",
  OPERATION_FORBIDDEN: "The operator must explicitly register this operation (including history for older registrations).",
  RUN_FORBIDDEN: "This authorized run is not open yet. Create it below, or check the workstream/run registration.",
  STALE_REVISION: "State changed. Refresh completed; inspect it and deliberately submit again. The rejected command was not applied.",
  OWNER_EPOCH_MISMATCH: "The service owner epoch changed. Inspect the runtime before updating the epoch; do not create a replacement root.",
  RESUME_UNSUPPORTED: "Stored-session resume is unsupported. Reconnect to the same live service; do not relaunch an ambiguous root.",
  ROOT_BUSY: "Wait for the current turn or resolve its request before sending another message.",
  TRANSPORT_UNCERTAIN: "The response was lost; the command may be committed. Retry the exact saved command, never create a replacement.",
  RECOVERY_REQUIRED: "The runtime needs operator reconciliation. Do not restart or relaunch this execution.",
  STORAGE_UNAVAILABLE: "Enable session storage before sending commands so an uncertain response can be retried after reload.",
}[code] ?? "The runtime rejected this operation. Inspect the current scope, request and state before trying again.");

function restored(key: string): Mutation | null {
  try {
    const value = sessionStorage.getItem(key);
    if (!value) return null;
    const parsed = commandSchema.safeParse(JSON.parse(value));
    return parsed.success && "commandId" in parsed.data ? parsed.data : null;
  } catch { return null; }
}

export function useRuntime(call: CallRuntime, authority: string, connected: boolean) {
  const storageKey = `advisor-pending-v1:${authority}`;
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [entries, setEntries] = useState<Delivery[]>([]);
  const [unacked, setUnacked] = useState<Delivery[]>([]);
  const [pending, setPending] = useState<Mutation | null>(() => restored(storageKey));
  const pendingRef = useRef(pending);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [messageReceipt, setMessageReceipt] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<{ title: string; text: string; eof: boolean } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const cursor = useRef(0);
  const runRef = useRef(run);
  const refreshSerial = useRef(0);

  const invoke = useCallback(async (command: RuntimeCommand) => {
    try { return await call(command); }
    catch { return { ok: false as const, error: "TRANSPORT_UNCERTAIN" }; }
  }, [call]);

  const refresh = useCallback(async (target: Scope, reset = false) => {
    const gen = generation.current;
    const serial = ++refreshSerial.current;
    const from = reset ? 0 : cursor.current;
    const results = await Promise.all([
      invoke({ v: 1, op: "workstream.open", scope: target, payload: {} }),
      invoke({ v: 1, op: "history", scope: target, payload: { cursor: from, limit: 64, maxBytes: 262144 } }),
      invoke({ v: 1, op: "wait", scope: target, payload: { timeoutMs: 0, limit: 32 } }),
    ]);
    if (gen !== generation.current || serial !== refreshSerial.current) return;
    const [state, history, wait] = results;
    if (!state!.ok) {
      setError(state!.error); setRun(null); runRef.current = null; return;
    }
    try {
      if (!("value" in state!)) throw new Error("shape");
      const next = runSchema.parse(state.value); runRef.current = next; setRun(next);
      if (!history!.ok) { setError(history!.error); return; }
      if (!("value" in history!)) throw new Error("shape");
      const page = historySchema.parse(history.value);
      cursor.current = page.nextCursor; setHasMore(page.hasMore);
      setEntries(previous => [...new Map([...(reset ? [] : previous), ...page.entries].map(row => [row.id, row])).values()].slice(-256));
      if (wait!.ok && "value" in wait!) setUnacked(deliverySchema.array().parse(wait.value));
      else if (!wait!.ok) setError(wait!.error);
    } catch { setError("INVALID_RUNTIME_RESPONSE"); }
  }, [invoke]);

  const reconnect = useCallback(async () => {
    const gen = ++generation.current;
    const result = await invoke({ v: 1, op: "capabilities" });
    if (gen !== generation.current) return;
    if (!result.ok) { setError(result.error); return; }
    try {
      if (!("value" in result)) throw new Error("shape");
      const caps = capabilitiesSchema.parse(result.value); setCapabilities(caps);
      setError(null);
      if (scope) await refresh(scope, true);
    } catch { setError("INVALID_RUNTIME_RESPONSE"); }
  }, [invoke, refresh, scope]);

  useEffect(() => {
    if (connected) void reconnect();
    return () => { generation.current += 1; };
  }, [connected, reconnect]);
  useEffect(() => {
    if (!scope || !connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!busyRef.current) await refresh(scope);
      if (!stopped) timer = setTimeout(() => void tick(), 1500);
    };
    timer = setTimeout(() => void tick(), 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [connected, refresh, scope]);

  const choose = (next: Scope) => {
    if (pendingRef.current || busyRef.current) return;
    generation.current += 1; cursor.current = 0;
    setRun(null); runRef.current = null; setEntries([]); setUnacked([]); setArtifact(null); setError(null); setScope(next);
  };

  const send = async (command: Mutation) => {
    if (busyRef.current || !connected) return false;
    if (pendingRef.current && JSON.stringify(pendingRef.current) !== JSON.stringify(command)) return false;
    try { sessionStorage.setItem(storageKey, JSON.stringify(command)); }
    catch { setError("STORAGE_UNAVAILABLE"); return false; }
    pendingRef.current = command; setPending(command); busyRef.current = true; setBusy(true); setError(null);
    const result = await invoke(command);
    const ambiguous = !result.ok && ["TRANSPORT_UNCERTAIN", "TRANSPORT_ERROR", "TRANSPORT_TIMEOUT", "TRUNCATED_RESPONSE", "INTERNAL_ERROR"].includes(result.error);
    if (!ambiguous) {
      try { sessionStorage.removeItem(storageKey); pendingRef.current = null; setPending(null); }
      catch { setError("STORAGE_UNAVAILABLE"); }
    }
    if (!result.ok) setError(ambiguous ? "TRANSPORT_UNCERTAIN" : result.error);
    else if ("receipt" in result) {
      setNotice(`${result.replayed ? "Replayed" : "Accepted"} ${command.op} · ${command.commandId}. Acceptance is not finalization or process exit.`);
      if (command.op === "root.message") setMessageReceipt(command.commandId);
    }
    if (scope) await refresh(scope, true);
    busyRef.current = false; setBusy(false);
    return result.ok;
  };

  const mutate = (op: Mutation["op"], payload: Record<string, unknown>, node = "root") => {
    if (!scope || pendingRef.current || busyRef.current) return Promise.resolve(false);
    const current = runRef.current;
    const revision = node === "root" ? current?.revision ?? 0 : current?.nodes[node]?.revision;
    if (revision === undefined) return Promise.resolve(false);
    return send({ v: 1, op, commandId: crypto.randomUUID(), scope: { ...scope, node }, expectedRevision: revision, payload });
  };
  const openArtifact = async (node: string, path: string) => {
    if (!scope) return;
    const gen = generation.current;
    const result = await invoke({ v: 1, op: "artifact.read", scope: { ...scope, node }, payload: { path, offset: 0, maxBytes: 65536 } });
    if (gen !== generation.current) return;
    if (!result.ok) { setError(result.error); return; }
    try {
      if (!("value" in result)) throw new Error("shape");
      setArtifact({ title: `${node} / ${path}`, ...artifactSchema.parse(result.value) });
    } catch { setError("INVALID_RUNTIME_RESPONSE"); }
  };
  return { capabilities, scope, run, entries, unacked, pending, busy, error, notice, messageReceipt, artifact, hasMore, choose, reconnect, mutate, retry: () => pendingRef.current ? send(pendingRef.current) : Promise.resolve(false), openArtifact, closeArtifact: () => setArtifact(null), refresh: () => scope ? refresh(scope) : Promise.resolve() };
}
