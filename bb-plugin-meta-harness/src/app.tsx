import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type {
  TraceDetail,
  TraceNode,
  TraceReadError,
  TraceRpcContract,
  TraceSummary,
} from "./contracts.js";
import { hasValidConfiguration } from "./configuration.js";
import "./app.css";

type ListState =
  | { status: "loading" }
  | { status: "needs-configuration" }
  | { status: "ready"; traces: TraceSummary[] }
  | { status: "error"; error: TraceReadError | Error };

type DetailState =
  | { status: "idle" }
  | { status: "loading"; fileName: string }
  | { status: "ready"; trace: TraceDetail }
  | {
      status: "error";
      fileName: string;
      partial: boolean;
      error: TraceReadError | Error;
    };

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

function formatTime(value: string | null): string {
  if (value === null) return "—";
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? value : DATE_TIME.format(time);
}

function errorMessage(error: TraceReadError | Error): string {
  return "code" in error ? `${error.code}: ${error.message}` : error.message;
}

function MetaField({
  label,
  value,
  path = false,
}: {
  label: string;
  value: string | number | boolean | null;
  path?: boolean;
}) {
  return (
    <div className="trace-field">
      <dt>{label}</dt>
      <dd className={path ? "trace-wrap-path" : undefined}>
        {value === null ? "—" : String(value)}
      </dd>
    </div>
  );
}

function StatePill({ state }: { state: string }) {
  return (
    <span className="trace-state" data-state={state}>
      <span aria-hidden="true" className="trace-state-dot" />
      {state}
    </span>
  );
}

function TraceList({
  selectedFile,
  state,
  onSelect,
}: {
  selectedFile: string | null;
  state: ListState;
  onSelect: (fileName: string) => void;
}) {
  if (state.status === "loading") {
    return (
      <p className="trace-empty" role="status">
        Reading canonical traces…
      </p>
    );
  }
  if (state.status === "needs-configuration") {
    return (
      <div className="trace-empty" role="status">
        <strong>Configuration required</strong>
        <span>Set an explicit host id and absolute advisor state root.</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="trace-empty trace-error" role="alert">
        <strong>Trace index unavailable</strong>
        <span>{errorMessage(state.error)}</span>
      </div>
    );
  }
  if (state.traces.length === 0) {
    return (
      <div className="trace-empty" role="status">
        <strong>No canonical traces</strong>
        <span>The configured traces directory has no direct JSONL files.</span>
      </div>
    );
  }
  return (
    <ul className="trace-index-list">
      {state.traces.map((trace) => (
        <li key={trace.fileName}>
          <button
            type="button"
            aria-pressed={selectedFile === trace.fileName}
            className="trace-index-row"
            onClick={() => onSelect(trace.fileName)}
          >
            <span className="trace-index-title">
              <span className="trace-run-id">
                {trace.ok ? trace.runId : trace.fileName}
              </span>
              {trace.ok && trace.partial ? (
                <span className="trace-chip">partial</span>
              ) : null}
              {!trace.ok ? (
                <span className="trace-chip danger">error</span>
              ) : null}
            </span>
            {trace.ok ? (
              <>
                <span className="trace-index-meta">
                  {trace.host} · {trace.workstream}
                </span>
                <span className="trace-index-foot">
                  <StatePill state={trace.lastState} />
                  <time dateTime={trace.lastAt ?? undefined}>
                    {formatTime(trace.lastAt)}
                  </time>
                </span>
              </>
            ) : (
              <span className="trace-index-meta">{trace.error.message}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ValidationNotes({
  nodeId,
  notes,
}: {
  nodeId: string;
  notes: string[] | undefined;
}) {
  if (notes === undefined) return null;
  if (notes.length === 0) {
    return <p className="trace-note-ok">Validation reported no notes.</p>;
  }
  return (
    <div
      className="trace-validation"
      aria-label={`Validation notes for ${nodeId}`}
    >
      <strong>Advisory validation notes</strong>
      <ul>
        {notes.map((note, index) => (
          <li key={`${index}-${note}`}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

function NodeCard({
  node,
  validationProblems,
}: {
  node: TraceNode;
  validationProblems: string[] | undefined;
}) {
  const titleId = useId();
  return (
    <article className="trace-node" aria-labelledby={titleId}>
      <div className="trace-node-marker" aria-hidden="true" />
      <header className="trace-node-header">
        <div>
          <p className="trace-eyebrow">
            {node.parent} <span aria-hidden="true">→</span> {node.id}
          </p>
          <h3 id={titleId}>{node.launch.label}</h3>
        </div>
        <StatePill state={node.state} />
      </header>

      <dl className="trace-field-grid">
        <MetaField label="Role" value={node.launch.role} />
        <MetaField label="Host" value={node.host} />
        <MetaField label="Model" value={node.launch.model} />
        <MetaField label="Thinking" value={node.launch.thinking} />
        <MetaField label="Risk" value={node.launch.riskTier} />
        <MetaField label="Keep alive" value={node.launch.keepAlive ?? null} />
        <MetaField label="Launched" value={formatTime(node.launchedAt)} />
        <MetaField label="Last settled" value={formatTime(node.settledAt)} />
        <MetaField label="Settlement attempts" value={node.attempts} />
        <MetaField
          label="Cancellation requested"
          value={node.cancelRequested}
        />
        <MetaField label="Working directory" value={node.launch.cwd} path />
      </dl>

      <section
        className="trace-node-section"
        aria-labelledby={`${titleId}-acceptance`}
      >
        <h4 id={`${titleId}-acceptance`}>Acceptance</h4>
        <ol className="trace-copy-list">
          {node.launch.acceptance.map((criterion, index) => (
            <li key={`${index}-${criterion}`}>{criterion}</li>
          ))}
        </ol>
      </section>

      {node.progress.length > 0 ? (
        <section
          className="trace-node-section"
          aria-labelledby={`${titleId}-progress`}
        >
          <h4 id={`${titleId}-progress`}>Progress</h4>
          <ol className="trace-event-list">
            {node.progress.map((progress, index) => (
              <li key={`${index}-${progress.at}`}>
                <time dateTime={progress.at}>{formatTime(progress.at)}</time>
                <span>{progress.note}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {node.replies.length > 0 ? (
        <section
          className="trace-node-section"
          aria-labelledby={`${titleId}-replies`}
        >
          <h4 id={`${titleId}-replies`}>Replies</h4>
          <ol className="trace-event-list">
            {node.replies.map((reply, index) => (
              <li key={`${index}-${reply.at}`}>
                <time dateTime={reply.at}>{formatTime(reply.at)}</time>
                <span>
                  {reply.source}: {reply.text}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {node.blockedRequest !== null ? (
        <section className="trace-blocked" role="status">
          <p className="trace-eyebrow">
            {node.state === "blocked" ||
            (node.state === "settled" && node.settledStatus === "blocked")
              ? "BLOCKED"
              : "Last blocked request"}{" "}
            · {node.blockedRequest.kind}
          </p>
          <p>{node.blockedRequest.text}</p>
          {node.blockedRequest.options !== undefined ? (
            <ul>
              {node.blockedRequest.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          ) : null}
          <time dateTime={node.blockedRequest.at}>
            {formatTime(node.blockedRequest.at)}
          </time>
        </section>
      ) : null}

      <section
        className="trace-node-section"
        aria-labelledby={`${titleId}-result`}
      >
        <h4 id={`${titleId}-result`}>Trace-derived result</h4>
        {node.state !== "settled" && node.attempts > 0 ? (
          <p className="trace-note-ok">
            Result and settlement fields retain the last recorded values until
            newer events replace them.
          </p>
        ) : null}
        <dl className="trace-field-grid">
          <MetaField label="Path" value={node.resultPath} path />
          <MetaField label="Validated" value={node.resultValid} />
          <MetaField label="Result status" value={node.resultStatus} />
          <MetaField label="Settlement" value={node.settledStatus} />
          <MetaField label="Surface closed" value={node.surfaceClosed} />
          <MetaField label="Reason" value={node.settledReason} />
        </dl>
        <ValidationNotes nodeId={node.id} notes={validationProblems} />
      </section>
    </article>
  );
}

function TraceDetailView({ state }: { state: DetailState }) {
  if (state.status === "idle") {
    return (
      <div className="trace-detail-empty" role="status">
        Select a trace to inspect its canonical projection.
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="trace-detail-empty" role="status">
        Reading {state.fileName} from a fresh descriptor…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="trace-detail-empty trace-error" role="alert">
        <strong>
          {state.error instanceof Error ||
          state.error.code !== "TRACE_DISAPPEARED"
            ? "Trace unavailable"
            : "Selected trace vanished"}
        </strong>
        <span className="trace-wrap-path">{state.fileName}</span>
        <span>{errorMessage(state.error)}</span>
        {state.partial ? (
          <span>The unread tail was incomplete; no projection was served.</span>
        ) : null}
      </div>
    );
  }

  const { projection, validationProblems } = state.trace;
  const run = projection.run!;
  return (
    <div className="trace-detail-content">
      {state.trace.partial ? (
        <div className="trace-partial" role="status">
          Partial append detected. The unterminated tail was omitted; Refresh
          rereads the file from scratch.
        </div>
      ) : null}

      <header className="trace-run-header">
        <div>
          <p className="trace-eyebrow">Canonical run · {run.host}</p>
          <h2>{run.id}</h2>
          <p className="trace-run-goal">{run.goal ?? "No goal recorded."}</p>
        </div>
        <StatePill state={projection.nodes.at(-1)?.state ?? "created"} />
      </header>
      <dl className="trace-run-fields">
        <MetaField label="Host" value={run.host} />
        <MetaField label="Workstream" value={run.workstream} />
        <MetaField label="Session" value={run.session} />
        <MetaField label="Graph" value={run.graph} />
        <MetaField label="Root node" value={run.root} />
        <MetaField label="State root" value={run.stateRoot} path />
        <MetaField label="Created" value={formatTime(run.createdAt)} />
        <MetaField label="Last event" value={formatTime(run.lastAt)} />
        <MetaField label="Last sequence" value={run.lastSeq} />
      </dl>

      {run.waves.length > 0 ? (
        <section className="trace-section" aria-label="Waves">
          <div className="trace-section-heading">
            <h2>Waves</h2>
            <span>{run.waves.length}</span>
          </div>
          <ol className="trace-copy-list">
            {run.waves.map((wave) => (
              <li key={wave.wave}>
                <strong>Wave {wave.wave}</strong> · {wave.nodes.join(", ")}
                <dl className="trace-field-grid">
                  <MetaField
                    label="Started"
                    value={formatTime(wave.startedAt)}
                  />
                  <MetaField
                    label="Completed"
                    value={formatTime(wave.completedAt)}
                  />
                </dl>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="trace-section" aria-labelledby="trace-nodes-title">
        <div className="trace-section-heading">
          <div>
            <p className="trace-eyebrow">Logical execution edges</p>
            <h2 id="trace-nodes-title">Nodes</h2>
          </div>
          <span>{projection.nodes.length}</span>
        </div>
        {projection.nodes.length > 0 ? (
          <div className="trace-node-list">
            {projection.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                validationProblems={validationProblems[node.id]}
              />
            ))}
          </div>
        ) : (
          <p className="trace-section-empty">No worker nodes launched.</p>
        )}
      </section>

      <section className="trace-section" aria-labelledby="trace-wakes-title">
        <div className="trace-section-heading">
          <div>
            <p className="trace-eyebrow">Delivered after settlement</p>
            <h2 id="trace-wakes-title">Parent wakes</h2>
          </div>
          <span>{projection.wakes.length}</span>
        </div>
        {projection.wakes.length > 0 ? (
          <ul className="trace-wake-list">
            {projection.wakes.map((wake) => (
              <li key={`${wake.parent}-${wake.child}-${wake.generation}`}>
                <span className="trace-wake-edge">
                  {wake.parent} <span aria-hidden="true">←</span> {wake.child}
                </span>
                <StatePill state={wake.childStatus} />
                <span>generation {wake.generation}</span>
                <time dateTime={wake.at}>{formatTime(wake.at)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="trace-section-empty">No parent wake recorded.</p>
        )}
      </section>
    </div>
  );
}

export function TracePanel(_props: PluginNavPanelProps) {
  const surfaceTitleId = useId();
  const rpc = useRpc<TraceRpcContract>();
  const settings = useSettings();
  const connection = useRealtimeConnectionState();
  const hostId =
    typeof settings.values?.hostId === "string"
      ? settings.values.hostId
      : undefined;
  const stateRoot =
    typeof settings.values?.stateRoot === "string"
      ? settings.values.stateRoot
      : undefined;
  const configured =
    !settings.isLoading && hasValidConfiguration(hostId, stateRoot);

  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({
    status: "idle",
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selectedFileRef = useRef<string | null>(null);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);

  const loadDetail = useCallback(
    async (fileName: string): Promise<void> => {
      const generation = ++detailGenerationRef.current;
      setDetailState({ status: "loading", fileName });
      try {
        const response = await rpc.call("readTrace", { fileName });
        if (generation !== detailGenerationRef.current) return;
        if (response.ok) {
          setDetailState({ status: "ready", trace: response.trace });
        } else {
          setDetailState({
            status: "error",
            fileName,
            partial: response.partial ?? false,
            error: response.error,
          });
        }
      } catch (error) {
        if (generation !== detailGenerationRef.current) return;
        setDetailState({
          status: "error",
          fileName,
          partial: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    [rpc],
  );

  const loadAll = useCallback(
    async (resetSelection: boolean): Promise<void> => {
      const generation = ++listGenerationRef.current;
      ++detailGenerationRef.current;
      setListState(
        settings.isLoading
          ? { status: "loading" }
          : configured
            ? { status: "loading" }
            : { status: "needs-configuration" },
      );
      setDetailState({ status: "idle" });
      if (!configured) {
        selectedFileRef.current = null;
        setSelectedFile(null);
        return;
      }
      if (resetSelection) {
        selectedFileRef.current = null;
        setSelectedFile(null);
      }
      try {
        const response = await rpc.call("listTraces", null);
        if (generation !== listGenerationRef.current) return;
        if (!response.ok) {
          setListState({ status: "error", error: response.error });
          selectedFileRef.current = null;
          setSelectedFile(null);
          return;
        }
        setListState({ status: "ready", traces: response.traces });
        const previous = selectedFileRef.current;
        const next = previous ?? response.traces[0]?.fileName ?? null;
        selectedFileRef.current = next;
        setSelectedFile(next);
        if (next !== null) await loadDetail(next);
      } catch (error) {
        if (generation !== listGenerationRef.current) return;
        setListState({
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
        selectedFileRef.current = null;
        setSelectedFile(null);
      }
    },
    [configured, loadDetail, rpc, settings.isLoading],
  );

  useEffect(() => {
    void loadAll(true);
  }, [hostId, loadAll, stateRoot]);

  const previousConnectionRef = useRef(connection);
  const connectedOnceRef = useRef(connection === "connected");
  useEffect(() => {
    const previous = previousConnectionRef.current;
    if (connection === "connected") {
      if (connectedOnceRef.current && previous === "reconnecting") {
        void loadAll(false);
      }
      connectedOnceRef.current = true;
    }
    previousConnectionRef.current = connection;
  }, [connection, loadAll]);

  const selectTrace = useCallback(
    (fileName: string): void => {
      selectedFileRef.current = fileName;
      setSelectedFile(fileName);
      void loadDetail(fileName);
    },
    [loadDetail],
  );

  return (
    <section
      className="trace-surface"
      aria-labelledby={surfaceTitleId}
      aria-busy={
        listState.status === "loading" || detailState.status === "loading"
      }
    >
      <header className="trace-toolbar">
        <div>
          <p className="trace-eyebrow">Advisor Core · read-only projection</p>
          <h1 id={surfaceTitleId}>Execution traces</h1>
        </div>
        <div className="trace-toolbar-actions">
          <span
            className="trace-connection"
            data-connection={connection}
            role="status"
          >
            <span aria-hidden="true" />
            {connection}
          </span>
          <button
            type="button"
            className="trace-refresh"
            disabled={settings.isLoading}
            onClick={() => void loadAll(false)}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="trace-layout">
        <nav className="trace-index" aria-label="Canonical traces">
          <div className="trace-index-heading">
            <span>Runs</span>
            {listState.status === "ready" ? (
              <span>{listState.traces.length}</span>
            ) : null}
          </div>
          <TraceList
            selectedFile={selectedFile}
            state={listState}
            onSelect={selectTrace}
          />
        </nav>
        <section className="trace-detail" aria-label="Selected trace">
          <TraceDetailView state={detailState} />
        </section>
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "trace",
    title: "Advisor traces",
    icon: "Waypoints",
    path: "trace",
    component: TracePanel,
  });
});
