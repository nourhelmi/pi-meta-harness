import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAdvisorPrompt,
  findLatestSessionPath,
  loadProspectiveCase,
  prepareProspectiveRun,
  processChecks,
  startHerdrAgentWithRetry,
  waitForPiPromptRecord,
  verifyProspectiveWorkspace,
} from "../scripts/advisor-prospective.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function fixtureWorkspace(parent) {
  const loaded = await loadProspectiveCase("builder-self-verification");
  const workspace = join(parent, "workspace");
  await cp(loaded.workspaceSource, workspace, { recursive: true });
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "test@localhost");
  git(workspace, "config", "user.name", "Test");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "fixture");
  return { loaded, workspace };
}

test("prospective case fails before repair and passes after the bounded repair", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-case-"));
  try {
    const { loaded, workspace } = await fixtureWorkspace(temp);
    const initial = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(initial.reward, 0);
    assert.equal(initial.checks.find((check) => check.id === "public-check-passes").passed, false);

    await writeFile(join(workspace, "artifact.txt"), "BASELINE\nADVISOR_READY\n");
    const repaired = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(repaired.reward, 1);
    assert(repaired.checks.every((check) => check.passed));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prospective prompt freezes criteria and treats completion as a non-authoritative signal", async () => {
  const loaded = await loadProspectiveCase("builder-self-verification");
  const prompt = buildAdvisorPrompt(loaded.definition, "/private/run/completion.json", "run-123456789abc");
  for (const criterion of loaded.definition.acceptance) assert(prompt.includes(criterion.id));
  assert.match(prompt, /external verifier is authoritative/i);
  assert.match(prompt, /root advisor must not implement/i);
  assert.match(prompt, /staged Pi agent directory for required advisor-doctrine and intelligence-guide reads/i);
  assert.match(prompt, /workerHarness "native"/);
});

test("prospective preparation stages setup resources without leaking credentials to artifacts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-prepare-"));
  const sourceAgentDir = join(temp, "source-agent");
  const sourceCodexHome = join(temp, "source-codex");
  const localPiDetach = join(temp, "pi-detach");
  const output = join(temp, "run");
  const secret = "subscription-refresh-token-must-not-leak";
  try {
    await mkdir(sourceAgentDir, { recursive: true });
    await writeFile(join(sourceAgentDir, "auth.json"), `${JSON.stringify({ "openai-codex": { type: "oauth", refresh: secret } })}\n`);
    await chmod(join(sourceAgentDir, "auth.json"), 0o600);
    await mkdir(sourceCodexHome, { recursive: true });
    await writeFile(join(sourceCodexHome, "auth.json"), `${JSON.stringify({ tokens: { access_token: secret } })}\n`);
    await chmod(join(sourceCodexHome, "auth.json"), 0o600);
    await mkdir(localPiDetach, { recursive: true });
    await writeFile(join(localPiDetach, "package.json"), '{"name":"pi-detach"}\n');
    git(localPiDetach, "init", "-q");
    git(localPiDetach, "config", "user.email", "test@localhost");
    git(localPiDetach, "config", "user.name", "Test");
    git(localPiDetach, "add", ".");
    git(localPiDetach, "commit", "-qm", "fixture");

    const prepared = await prepareProspectiveRun({
      subject: "builder-self-verification",
      output,
      sourceAgentDir,
      sourceCodexHome,
      piDetachSource: localPiDetach,
      profile: "codex-lean",
      candidateLabel: "test-setup",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      timeoutMinutes: 1,
    });
    const manifest = await readFile(join(output, "manifest.json"), "utf8");
    const prompt = await readFile(join(output, "prompt.md"), "utf8");
    assert(!manifest.includes(secret));
    assert(!prompt.includes(secret));
    assert.equal((await readFile(join(prepared.agentDir, "auth.json"), "utf8")).includes(secret), true);
    assert.equal((await readFile(join(prepared.codexHome, "auth.json"), "utf8")).includes(secret), true);
    const stagedCodexConfig = await readFile(join(prepared.codexHome, "config.toml"), "utf8");
    assert.match(stagedCodexConfig, /hooks = false/);
    assert.match(stagedCodexConfig, /plugins = false/);
    assert(stagedCodexConfig.includes(`[projects.${JSON.stringify(prepared.workspace)}]`));
    assert.match(stagedCodexConfig, /trust_level = "trusted"/);
    assert.equal(prepared.manifest.execution.credentialPolicy, "temporary-isolated-copies-removed-after-run");
    assert.equal(prepared.manifest.execution.nativeWorkerEnvironment, "isolated-codex-home-with-doctor-preflight");
    assert.equal(prepared.manifest.candidate.label, "test-setup");
    assert.equal(prepared.manifest.execution.piDetach.source, "local-committed");
    assert.match(prepared.manifest.execution.piDetach.revision, /^[0-9a-f]{40}$/);
    assert.equal(prepared.manifest.candidate.fingerprint.algorithm, "sha256-candidate-tree-plus-pi-detach-v1");
    assert.equal(prepared.manifest.case.parallelism.maxUsefulWidth, 1);
    assert.deepEqual(prepared.manifest.case.parallelism.roles, ["builder", "foreman"]);
    assert.match(prepared.manifest.candidate.fingerprint.value, /^[0-9a-f]{64}$/);
    assert.equal(prepared.manifest.evaluation.fingerprint.algorithm, "sha256-prospective-suite-tree-v1");
    assert.match(prepared.manifest.evaluation.fingerprint.value, /^[0-9a-f]{64}$/);
    const stagedSettings = JSON.parse(await readFile(join(prepared.agentDir, "settings.json"), "utf8"));
    assert(stagedSettings.packages.includes(localPiDetach));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prospective preparation removes staged credentials when Codex auth is unavailable", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-auth-failure-"));
  const sourceAgentDir = join(temp, "source-agent");
  const sourceCodexHome = join(temp, "source-codex");
  const output = join(temp, "run");
  try {
    await mkdir(sourceAgentDir, { recursive: true });
    await mkdir(sourceCodexHome, { recursive: true });
    await writeFile(join(sourceAgentDir, "auth.json"), '{"openai-codex":{"type":"oauth"}}\n');
    await assert.rejects(
      prepareProspectiveRun({
        subject: "builder-self-verification",
        output,
        sourceAgentDir,
        sourceCodexHome,
        timeoutMinutes: 1,
      }),
      /Codex subscription credentials are missing/,
    );
    await assert.rejects(readFile(join(output, ".agent", "auth.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prospective case validation rejects malformed process delegation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-schema-"));
  try {
    const loaded = await loadProspectiveCase("builder-self-verification");
    const caseDir = join(temp, loaded.definition.id);
    await cp(loaded.caseDir, caseDir, { recursive: true });
    const malformed = {
      ...loaded.definition,
      process: { ...loaded.definition.process, requiredDelegation: { id: "builder", roles: ["builder"], minimum: 1 } },
    };
    await writeFile(join(caseDir, "case.json"), `${JSON.stringify(malformed, null, 2)}\n`);
    await assert.rejects(() => loadProspectiveCase(caseDir), /required delegation must be an array/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prospective case validation rejects malformed topology roles", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-topology-schema-"));
  try {
    const loaded = await loadProspectiveCase("single-maker-fast-path");
    const caseDir = join(temp, loaded.definition.id);
    await cp(loaded.caseDir, caseDir, { recursive: true });
    const malformed = {
      ...loaded.definition,
      process: {
        ...loaded.definition.process,
        topology: { ...loaded.definition.process.topology, allowedRoles: ["builder", "invented-role"] },
      },
    };
    await writeFile(join(caseDir, "case.json"), `${JSON.stringify(malformed, null, 2)}\n`);
    await assert.rejects(() => loadProspectiveCase(caseDir), /known worker roles/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prospective root start retries only transient fresh-pane busy errors", async () => {
  let attempts = 0;
  const delays = [];
  await startHerdrAgentWithRetry(
    ["agent", "start"],
    Date.now() + 1_000,
    () => {
      attempts += 1;
      if (attempts < 3) throw new Error("herdr failed: agent_pane_busy");
    },
    async (milliseconds) => delays.push(milliseconds),
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 250]);

  await assert.rejects(
    startHerdrAgentWithRetry(
      ["agent", "start"],
      Date.now() + 1_000,
      () => { throw new Error("invalid_argument"); },
      async () => {},
    ),
    /invalid_argument/,
  );
});

test("prospective delegation requires a successful worker settlement, not an attempt", () => {
  const definition = {
    process: {
      expectedCompletionStatus: "completed",
      requiredDelegation: [{ id: "checker-delegation", roles: ["checker"], minimum: 1 }],
    },
  };
  const attempted = {
    events: [
      { kind: "worker_launch", role: "checker" },
      { kind: "worker_launch_result", role: "checker", status: "failed", failureKind: "startup-blocked" },
    ],
  };
  const completion = { schemaVersion: 1, status: "completed" };
  const failed = processChecks(attempted, completion, definition);
  assert.equal(failed.find((check) => check.id === "checker-delegation")?.passed, false);
  assert.match(failed.find((check) => check.id === "checker-delegation")?.evidence ?? "", /0 successful.*1 launch.*startup-blocked=1/);

  attempted.events[1].status = "successful";
  attempted.events[1].attemptAlias = "attempt-1";
  attempted.events.push({
    kind: "worker_status",
    role: "checker",
    status: "successful",
    attemptAlias: "attempt-1",
  });
  const passed = processChecks(attempted, completion, definition);
  assert.equal(passed.find((check) => check.id === "checker-delegation")?.passed, true);
  assert.match(passed.find((check) => check.id === "checker-delegation")?.evidence ?? "", /^1 successful/);
});

test("prospective topology checks reject extra roles, successful workers, and graphs without punishing retries", () => {
  const definition = {
    process: {
      expectedCompletionStatus: "completed",
      requiredDelegation: [{ id: "builder-delegation", roles: ["builder"], minimum: 1 }],
      topology: {
        allowedRoles: ["builder"],
        maximumSuccessfulWorkers: 1,
        maximumGraphPlans: 0,
      },
    },
  };
  const completion = { schemaVersion: 1, status: "completed" };
  const trace = {
    events: [
      { kind: "worker_launch", role: "builder", workerAlias: "worker-1", attemptAlias: "attempt-1" },
      { kind: "worker_launch_result", role: "builder", workerAlias: "worker-1", attemptAlias: "attempt-1", status: "failed" },
      { kind: "worker_launch", role: "builder", workerAlias: "worker-1", attemptAlias: "attempt-2" },
      { kind: "worker_status", role: "builder", workerAlias: "worker-1", attemptAlias: "attempt-2", status: "successful" },
    ],
  };
  const retryPass = processChecks(trace, completion, definition);
  assert.equal(retryPass.find((check) => check.id === "orchestration-allowed-roles")?.passed, true);
  assert.equal(retryPass.find((check) => check.id === "orchestration-successful-worker-budget")?.passed, true);
  assert.equal(retryPass.find((check) => check.id === "orchestration-graph-budget")?.passed, true);

  trace.events.push(
    { kind: "worker_launch", role: "checker", workerAlias: "worker-2", attemptAlias: "attempt-3" },
    { kind: "worker_status", role: "checker", workerAlias: "worker-2", attemptAlias: "attempt-3", status: "successful" },
    { kind: "graph_plan", nodeCount: 1, waves: [] },
  );
  const topologyFailed = processChecks(trace, completion, definition);
  assert.equal(topologyFailed.find((check) => check.id === "orchestration-allowed-roles")?.passed, false);
  assert.equal(topologyFailed.find((check) => check.id === "orchestration-successful-worker-budget")?.passed, false);
  assert.equal(topologyFailed.find((check) => check.id === "orchestration-graph-budget")?.passed, false);
});

test("prospective topology checks require maker settlement before checker launch", () => {
  const definition = {
    process: {
      requiredDelegation: [
        { id: "builder-delegation", roles: ["builder"], minimum: 1 },
        { id: "checker-delegation", roles: ["checker"], minimum: 1 },
      ],
      topology: {
        requiredOrder: [{ id: "maker-before-checker", beforeRoles: ["builder"], afterRoles: ["checker"] }],
      },
    },
  };
  const completion = { schemaVersion: 1, status: "completed" };
  const events = [
    { kind: "worker_launch", role: "builder", workerAlias: "worker-1", attemptAlias: "attempt-1" },
    { kind: "worker_status", role: "builder", workerAlias: "worker-1", attemptAlias: "attempt-1", status: "successful" },
    { kind: "worker_launch", role: "checker", workerAlias: "worker-2", attemptAlias: "attempt-2" },
    { kind: "worker_status", role: "checker", workerAlias: "worker-2", attemptAlias: "attempt-2", status: "successful" },
  ];
  const ordered = processChecks({ events }, completion, definition);
  assert.equal(ordered.find((check) => check.id === "orchestration-maker-before-checker")?.passed, true);

  const earlyChecker = processChecks({ events: [events[0], events[2], events[1], events[3]] }, completion, definition);
  assert.equal(earlyChecker.find((check) => check.id === "orchestration-maker-before-checker")?.passed, false);
});

test("prospective prompt delivery waits for Pi to record the user task", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-prompt-"));
  try {
    const sessions = join(temp, "sessions", "workspace");
    await mkdir(sessions, { recursive: true });
    const session = join(sessions, "prompt.jsonl");
    await writeFile(session, '{"type":"session"}\n');
    const append = Promise.resolve().then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await appendFile(session, '{"type":"message","message":{"role":"user"}}\n');
    });
    assert.equal(await waitForPiPromptRecord(temp, 1000), session);
    await append;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prospective session capture falls back to the newest temporary Pi session", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-prospective-session-"));
  try {
    const sessions = join(temp, "sessions", "workspace");
    await mkdir(sessions, { recursive: true });
    const older = join(sessions, "older.jsonl");
    const latest = join(sessions, "latest.jsonl");
    await writeFile(older, "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(latest, "{}\n");
    assert.equal(await findLatestSessionPath(temp), latest);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
