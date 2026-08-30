import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorGraphExtension from "../extensions/advisor-graph.ts";

interface GraphWarning {
  code: string;
  nodeId: string;
  message: string;
}

interface GraphResult {
  content: Array<{ type: string; text: string }>;
  details: {
    manifestPath?: string;
    waves?: string[][];
    nodeCount?: number;
    warnings?: GraphWarning[];
  };
}

interface GraphTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<GraphResult>;
}

function installedGraphTool(): GraphTool {
  let tool: GraphTool | undefined;
  const pi = {
    registerTool: (candidate: GraphTool) => {
      if (candidate.name === "advisor_graph_plan") tool = candidate;
    },
  } as unknown as ExtensionAPI;
  advisorGraphExtension(pi);
  assert.ok(tool, "advisor_graph_plan is registered");
  return tool;
}

const node = (id: string, role = "scout", extra: Record<string, unknown> = {}) => ({
  id,
  role,
  task: `Resolve what ${id} unlocks`,
  anchor: `Produce the ${id} artifact`,
  ...extra,
});

const resultText = (result: GraphResult) => result.content.map((item) => item.text).join("\n");

test("advisor graph keeps structural safety hard and semantic ordering advisory", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-graph-"));
  const rolesPath = join(temp, "roles.json");
  await writeFile(rolesPath, `${JSON.stringify({
    profiles: {
      scout: {},
      planner: {},
      reducer: {},
      builder: {},
      foreman: {},
      checker: {},
      "browser-verifier": {},
    },
  })}\n`);

  const previousProfiles = process.env.PI_DETACH_AGENT_PROFILES;
  const previousState = process.env.ADVISOR_STATE_DIR;
  const previousWorkstream = process.env.ADVISOR_WORKSTREAM;
  process.env.PI_DETACH_AGENT_PROFILES = rolesPath;
  process.env.ADVISOR_STATE_DIR = join(temp, "state");
  process.env.ADVISOR_WORKSTREAM = "graph-tests";

  try {
    const tool = installedGraphTool();
    const context = {
      cwd: temp,
      sessionManager: { getSessionId: () => "graph-session" },
    } as unknown as ExtensionContext;
    const execute = (params: Record<string, unknown>) =>
      tool.execute("graph-call", params, undefined, undefined, context);

    await t.test("accepts baseline browser, checker audit, and one-input reducer with warnings", async () => {
      const result = await execute({
        graphId: "semantic-warnings",
        goal: "Resolve independent evidence before choosing a route",
        maxParallel: 6,
        nodes: [
          node("ticket-triage"),
          node("source-analysis"),
          node("baseline-browser", "browser-verifier"),
          node("audit-checker", "checker"),
          node("evidence-join", "planner", { dependsOn: ["ticket-triage", "source-analysis"] }),
          node("single-reducer", "reducer", { dependsOn: ["evidence-join"] }),
        ],
      });

      assert.deepEqual(result.details.waves, [
        ["audit-checker", "baseline-browser", "source-analysis", "ticket-triage"],
        ["evidence-join"],
        ["single-reducer"],
      ]);
      assert.deepEqual(result.details.warnings?.map((warning) => warning.code), [
        "browser-without-builder",
        "checker-without-builder",
        "reducer-low-fan-in",
      ]);
      assert.match(resultText(result), /Advisory warnings \(3; non-blocking\)/);
      assert.match(resultText(result), /Confirm these graph shapes are intentional/);

      assert.ok(result.details.manifestPath);
      const manifest = JSON.parse(await readFile(result.details.manifestPath, "utf8"));
      assert.deepEqual(manifest.waves, result.details.waves);
      assert.deepEqual(manifest.warnings, result.details.warnings);
    });

    await t.test("accepts conventional review ancestry without warnings", async () => {
      const result = await execute({
        graphId: "review-ancestry",
        goal: "Build and independently verify a frozen diff",
        nodes: [
          node("build", "builder", { worktree: join(temp, "build") }),
          node("check", "checker", { dependsOn: ["build"] }),
          node("browser", "browser-verifier", { dependsOn: ["build"] }),
          node("reduce", "reducer", { dependsOn: ["check", "browser"] }),
        ],
      });

      assert.deepEqual(result.details.warnings, []);
      assert.deepEqual(result.details.waves, [["build"], ["browser", "check"], ["reduce"]]);
      assert.match(resultText(result), /Advisory warnings: none/);
    });

    await t.test("accepts a foreman as an implementation ancestor", async () => {
      const result = await execute({
        graphId: "foreman-review",
        goal: "Complete and independently verify one delegated work item",
        nodes: [
          node("item", "foreman", { worktree: join(temp, "item") }),
          node("check", "checker", { dependsOn: ["item"] }),
        ],
      });

      assert.deepEqual(result.details.warnings, []);
      assert.deepEqual(result.details.waves, [["item"], ["check"]]);
    });

    const rejected = async (params: Record<string, unknown>, expected: RegExp) => {
      const result = await execute(params);
      assert.match(resultText(result), expected);
      assert.equal(result.details.manifestPath, undefined);
    };

    await t.test("rejects malformed identifiers and roles", async () => {
      await rejected(
        { graphId: "Bad_Graph", goal: "invalid", nodes: [node("valid")] },
        /Malformed graph id/,
      );
      await rejected(
        { graphId: "malformed-role", goal: "invalid", nodes: [node("valid", "Bad_Role")] },
        /Malformed graph role/,
      );
      await rejected(
        { graphId: "unknown-role", goal: "invalid", nodes: [node("valid", "unknown")] },
        /unknown role unknown/,
      );
    });

    await t.test("accepts a freeform node without a configured profile", async () => {
      const result = await execute({
        graphId: "freeform-node",
        goal: "Blend scouting and synthesis in one role-less worker",
        nodes: [node("blended-aide", "freeform")],
      });
      assert.deepEqual(result.details.waves, [["blended-aide"]]);
    });

    await t.test("accepts acceptance criteria in place of an anchor and rejects criterion-less nodes", async () => {
      const accepted = await execute({
        graphId: "acceptance-node",
        goal: "Criteria-first node",
        nodes: [
          {
            id: "criteria-only",
            role: "scout",
            task: "Survey the auth module",
            acceptance: ["Findings cite exact files", "Open questions are enumerated"],
          },
        ],
      });
      assert.deepEqual(accepted.details.waves, [["criteria-only"]]);
      await rejected(
        {
          graphId: "criterion-less",
          goal: "invalid",
          nodes: [{ id: "bare", role: "scout", task: "Survey" }],
        },
        /needs at least one acceptance criterion/,
      );
    });

    await t.test("rejects missing dependencies and invalid concurrency", async () => {
      await rejected(
        {
          graphId: "missing-dependency",
          goal: "invalid",
          nodes: [node("dependent", "scout", { dependsOn: ["absent"] })],
        },
        /missing dependency absent/,
      );
      await rejected(
        { graphId: "invalid-concurrency", goal: "invalid", maxParallel: 0, nodes: [node("valid")] },
        /maxParallel must be an integer between 1 and 6/,
      );
    });

    await t.test("rejects dependency cycles", async () => {
      await rejected(
        {
          graphId: "dependency-cycle",
          goal: "invalid",
          nodes: [
            node("left", "scout", { dependsOn: ["right"] }),
            node("right", "scout", { dependsOn: ["left"] }),
          ],
        },
        /dependency cycle/,
      );
    });

    await t.test("rejects parallel builders sharing a checkout", async () => {
      const checkout = join(temp, "shared-checkout");
      await rejected(
        {
          graphId: "shared-builders",
          goal: "invalid",
          allowParallelBuilders: true,
          nodes: [
            node("builder-left", "builder", { worktree: checkout }),
            node("builder-right", "builder", { worktree: checkout }),
          ],
        },
        /Parallel builders or foremen require distinct explicit worktrees/,
      );
    });

    await t.test("applies builder worktree isolation to parallel foremen", async () => {
      const checkout = join(temp, "shared-foreman-checkout");
      await rejected(
        {
          graphId: "shared-foremen",
          goal: "invalid",
          allowParallelBuilders: true,
          nodes: [
            node("foreman-left", "foreman", { worktree: checkout }),
            node("foreman-right", "foreman", { worktree: checkout }),
          ],
        },
        /Parallel builders or foremen require distinct explicit worktrees/,
      );
    });
  } finally {
    if (previousProfiles === undefined) delete process.env.PI_DETACH_AGENT_PROFILES;
    else process.env.PI_DETACH_AGENT_PROFILES = previousProfiles;
    if (previousState === undefined) delete process.env.ADVISOR_STATE_DIR;
    else process.env.ADVISOR_STATE_DIR = previousState;
    if (previousWorkstream === undefined) delete process.env.ADVISOR_WORKSTREAM;
    else process.env.ADVISOR_WORKSTREAM = previousWorkstream;
    await rm(temp, { recursive: true, force: true });
  }
});
