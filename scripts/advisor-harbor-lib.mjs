import { analyzeTrace, validateFixture } from "./advisor-eval-lib.mjs";

export const HARBOR_VERSION = "0.16.1";
export const REWARDKIT_VERSION = "0.1";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function eventSource(kind) {
  if (kind === "session_started") return "system";
  if (kind === "user_message" || kind === "user_intervention") return "user";
  return "agent";
}

function eventMessage(event) {
  if (event.kind === "session_started") return "Advisor session started.";
  if (event.kind === "user_message") return "User message observed.";
  if (event.kind === "user_intervention") {
    const signals = event.signals?.length ? event.signals.join(", ") : "none";
    return `User intervention observed; categorical signals: ${signals}.`;
  }
  if (event.kind === "graph_plan") {
    return `Advisor graph plan observed: ${event.nodeCount} nodes across ${event.waves.length} dependency waves.`;
  }
  if (event.kind === "worker_launch") {
    return `Worker ${event.action} requested for role ${event.role}; status ${event.status}.`;
  }
  if (event.kind === "worker_launch_result") {
    return `Worker launch result observed for role ${event.role}; status ${event.status}.`;
  }
  if (event.kind === "worker_status") return `Worker status observed: ${event.status}.`;
  if (event.kind === "tool_call") return `Advisor tool call observed: ${event.toolName}.`;
  if (event.kind === "tool_error") return `Advisor tool error observed: ${event.toolName}.`;
  return "Advisor decision observed.";
}

export function createAtifTrajectory(normalized) {
  analyzeTrace(normalized);
  const steps = normalized.events.map((event, index) => ({
    step_id: index + 1,
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    source: eventSource(event.kind),
    message: eventMessage(event),
    extra: { advisor_event: structuredClone(event) },
  }));
  return {
    schema_version: "ATIF-v1.7",
    session_id: normalized.source.artifactAlias,
    agent: {
      name: "pi-advisor",
      version: "recorded",
      extra: {
        source_kind: normalized.source.kind,
        text_policy: normalized.source.textPolicy,
        alias_scope: normalized.source.aliasScope,
      },
    },
    steps,
    final_metrics: { total_steps: steps.length },
    extra: {
      privacy: structuredClone(normalized.redaction),
      relationships: structuredClone(normalized.relationships),
    },
  };
}

function createContext(fixture, normalized, metrics) {
  const sourceScale = structuredClone(fixture.rubric.scale ?? {});
  const labels = Array.isArray(sourceScale.labels)
    ? sourceScale.labels
    : ["harmful or absent", "weak", "adequate", "strong", "excellent"];
  return {
    schemaVersion: 1,
    framework: { name: "harbor", version: HARBOR_VERSION, verifier: "rewardkit", verifierVersion: REWARDKIT_VERSION },
    case: { id: fixture.id, title: fixture.title, description: fixture.description ?? "" },
    privacy: structuredClone(normalized.redaction),
    diagnostics: metrics,
    rubric: {
      dimensions: structuredClone(fixture.rubric.dimensions),
      scale: {
        minimum: 1,
        maximum: 5,
        labels,
        normalizedMapping: "RewardKit maps 1..5 linearly to 0..1.",
        sourceScale,
      },
    },
    checkpoints: structuredClone(fixture.checkpoints),
    ...(fixture.calibration ? { calibration: structuredClone(fixture.calibration) } : {}),
    judgeGuidance: {
      noGoldenWorkflow: true,
      acceptableActionsAreExamples: true,
      instruction: fixture.calibration
        ? "Judge the observable decisions and adaptation against the evidence. Do not require one exact topology or action sequence. Enforce the calibration risk threshold and expected decision without inventing unsupported defects. Acceptance criteria stay frozen within one loop, but a new packet revision may deliberately change them when its rationale is explicit."
        : "Judge the observable decisions and adaptation against the evidence. Do not require one exact topology or action sequence.",
    },
  };
}

function createJudgeToml(fixture) {
  const lines = [
    "[judge]",
    'judge = "anthropic/claude-sonnet-4-6"',
    'atif-trajectory = "/app/advisor-trajectory.json"',
    'files = ["/app/advisor-eval-context.json"]',
    'prompt_template = "/tests/advisor-prompt.md"',
    'mode = "batched"',
    'reasoning_effort = "high"',
    "timeout = 300",
    "",
  ];
  for (const dimension of fixture.rubric.dimensions) {
    const criteria = dimension.criteria.join(" ");
    lines.push(
      "[[criterion]]",
      `id = ${tomlString(dimension.id)}`,
      `name = ${tomlString(dimension.id)}`,
      `description = ${tomlString(`Score ${dimension.id} from 1 to 5 using this rubric: ${criteria} Use the checkpoint evidence, but accept equally well-supported alternatives not listed there.`)}`,
      'type = "likert"',
      "points = 5",
      `weight = ${dimension.weight}`,
      "",
    );
  }
  lines.push("[scoring]", 'aggregation = "weighted_mean"', "");
  return lines.join("\n");
}

function createTaskToml(fixture) {
  return [
    'schema_version = "1.4"',
    "",
    "[task]",
    `name = ${tomlString(`pi-meta-harness/${fixture.id}`)}`,
    'version = "1.0.0"',
    `description = ${tomlString(fixture.description ?? fixture.title)}`,
    "authors = []",
    'keywords = ["advisor", "orchestration", "trajectory", "privacy-safe"]',
    "",
    "[metadata]",
    'category = "advisor-orchestration"',
    `case_id = ${tomlString(fixture.id)}`,
    'trace_policy = "categorical-only"',
    "",
    "[verifier]",
    "timeout_sec = 600.0",
    "",
    "[verifier.env]",
    `ANTHROPIC_API_KEY = ${tomlString("${ANTHROPIC_API_KEY:-}")}`,
    `CLAUDE_CODE_OAUTH_TOKEN = ${tomlString("${CLAUDE_CODE_OAUTH_TOKEN:-}")}`,
    `OPENAI_API_KEY = ${tomlString("${OPENAI_API_KEY:-}")}`,
    `REWARDKIT_JUDGE = ${tomlString("${REWARDKIT_JUDGE:-anthropic/claude-sonnet-4-6}")}`,
    "",
    "[agent]",
    "timeout_sec = 30.0",
    "",
    "[environment]",
    'network_mode = "public"',
    "build_timeout_sec = 600.0",
    "cpus = 1",
    "memory_mb = 2048",
    "storage_mb = 4096",
    "",
  ].join("\n");
}

const ADVISOR_PROMPT = `You are grading the observable judgment of a Pi advisor, not inventing a preferred workflow.

The ATIF trajectory contains only privacy-safe categorical events and opaque aliases. The accompanying context contains descriptive diagnostics, a weighted rubric, and decision checkpoints. Raw messages and tool payloads are intentionally unavailable. Do not infer missing facts or reward verbosity.

Treat each checkpoint's acceptable actions as non-exhaustive examples. An alternative route can score equally well when it has comparable information value, safety, adaptation, and outcome support. Graph width, elapsed time, worker count, and parallelism are diagnostic evidence, never quality rules by themselves.

Evaluate only what the trajectory supports. Reflect uncertainty in the explanation rather than fabricating evidence.

{criteria}
`;

const DOCKERFILE = `FROM ubuntu:24.04

COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /uvx /bin/

WORKDIR /app
COPY advisor-trajectory.json /app/advisor-trajectory.json
COPY advisor-eval-context.json /app/advisor-eval-context.json
`;

const TEST_SH = `#!/bin/bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
uv run --no-project --with harbor-rewardkit==${REWARDKIT_VERSION} python /tests/run_rewardkit.py
`;

const REWARDKIT_RUNNER = `import json
import os
import shutil
import tempfile
from pathlib import Path

import rewardkit  # type: ignore[import-not-found]


DEFAULT_JUDGE = "anthropic/claude-sonnet-4-6"


def prepare_tests(source: Path, destination: Path, judge: str | None = None) -> None:
    shutil.copytree(source, destination, dirs_exist_ok=True)
    config_path = destination / "reward.toml"
    contents = config_path.read_text()
    selected = (judge or DEFAULT_JUDGE).strip() or DEFAULT_JUDGE
    expected = f"judge = {json.dumps(DEFAULT_JUDGE)}"
    replacement = f"judge = {json.dumps(selected)}"
    if contents.count(expected) != 1:
        raise ValueError("RewardKit judge configuration is not in the expected generated form")
    config_path.write_text(contents.replace(expected, replacement, 1))


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="advisor-rewardkit-") as temporary:
        tests_dir = Path(temporary) / "tests"
        prepare_tests(Path("/tests"), tests_dir, os.environ.get("REWARDKIT_JUDGE"))
        rewardkit.run(tests_dir, workspace="/app", output="/logs/verifier/reward.json")


if __name__ == "__main__":
    main()
`;

export function createHarborTask(fixture, normalized) {
  const validation = validateFixture(fixture, normalized);
  if (!validation.valid) throw new Error(`Invalid fixture:\n- ${validation.errors.join("\n- ")}`);
  const metrics = analyzeTrace(normalized);
  const trajectory = createAtifTrajectory(normalized);
  const context = createContext(fixture, normalized, metrics);
  return {
    taskId: fixture.id,
    files: {
      "instruction.md": "Evaluate the supplied privacy-safe recorded advisor trajectory. The configured no-op agent intentionally performs no work; Harbor and RewardKit grade the recorded process.\n",
      "task.toml": createTaskToml(fixture),
      "environment/Dockerfile": DOCKERFILE,
      "environment/advisor-trajectory.json": `${JSON.stringify(trajectory, null, 2)}\n`,
      "environment/advisor-eval-context.json": `${JSON.stringify(context, null, 2)}\n`,
      "tests/test.sh": TEST_SH,
      "tests/reward.toml": createJudgeToml(fixture),
      "tests/advisor-prompt.md": ADVISOR_PROMPT,
      "tests/run_rewardkit.py": REWARDKIT_RUNNER,
    },
  };
}
