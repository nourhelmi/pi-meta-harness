import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resultStatusBody, validateResultArtifact } from "./result-artifact.mjs";

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

export async function withLock(path, task) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(path, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw new Error(`timed out acquiring lock ${path}`);
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await task();
  } finally {
    await handle.close();
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function readTrace(path) {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function nextWakeGeneration(events, parent) {
  return events.reduce((generation, event) => {
    if (event.type !== "parent.awakened" || event.node !== parent) return generation;
    const candidate = event.data?.wakeGeneration;
    return typeof candidate === "number" ? Math.max(generation, candidate) : generation;
  }, 0) + 1;
}

export async function appendTrace(root, runId, host, createDrafts) {
  const path = join(root, "traces", `${runId}.jsonl`);
  return withLock(`${path}.lock`, async () => {
    const events = await readTrace(path);
    const drafts = await createDrafts(events);
    if (drafts.length === 0) return events;
    const prior = Date.parse(events.at(-1)?.at ?? "");
    const at = new Date(Number.isFinite(prior) ? Math.max(Date.now(), prior) : Date.now()).toISOString();
    let seq = events.at(-1)?.seq ?? 0;
    const appended = drafts.map((draft) => ({
      v: 1,
      seq: ++seq,
      at,
      run: runId,
      host,
      ...draft,
    }));
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${appended.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    return [...events, ...appended];
  });
}

export async function reserveResult(path) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
}

export async function inspectArtifact(path) {
  let markdown;
  try {
    markdown = await readFile(path, "utf8");
  } catch (error) {
    const problem = error?.code === "ENOENT"
      ? "result artifact is missing"
      : `result artifact could not be read: ${error.message}`;
    return {
      present: false,
      validation: {
        valid: false,
        classification: "terminal",
        problems: [problem],
        notes: [],
      },
    };
  }
  if (!markdown.trim()) {
    return {
      present: false,
      validation: {
        valid: false,
        classification: "terminal",
        problems: ["result artifact is empty"],
        notes: [],
      },
    };
  }
  return {
    present: true,
    validation: validateResultArtifact(markdown),
    statusBody: resultStatusBody(markdown),
  };
}

export function parseRiskTier(prompt) {
  const match = prompt.match(/\brisk\s+tier\b[\s:*_`-]*(low|standard|high)\b/i)?.[1]?.toLowerCase();
  return match === "low" || match === "standard" || match === "high" ? match : "high";
}

export function parseAcceptance(prompt) {
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?ACCEPTANCE CRITERIA\s*:?\s*#*\s*$/i.test(line));
  if (start < 0) return ["result.md validates with the six required headings"];
  const criteria = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#{1,6}\s+|[A-Z][A-Z _-]+:\s*$)/.test(line) && criteria.length > 0) break;
    const match = /^\s*(?:-\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line);
    if (match?.[1]) criteria.push(match[1]);
  }
  return criteria.length > 0 ? criteria : ["result.md validates with the six required headings"];
}

const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Canonical run ids are capped at 128 characters; graph runs add `graph-`.
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/;

/** Parse the fixed indented GRAPH block shared by every host binding. */
export function parseGraphBlock(prompt) {
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*GRAPH:\s*$/.test(line));
  if (start < 0) return undefined;
  const values = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const match = /^\s+([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (!match) break;
    values[match[1]] = match[2];
  }
  const graph = stringValue(values.graph);
  const node = stringValue(values.node);
  const wave = integerValue(values.wave, 1);
  const repair = values.repair === undefined ? undefined : integerValue(values.repair, 0);
  if (!graph || !node || !GRAPH_ID.test(graph) || !TRACE_ID.test(node) || wave === undefined) return undefined;
  if (values.repair !== undefined && repair === undefined) return undefined;
  return {
    graph,
    node,
    wave,
    ...(repair !== undefined ? { repair } : {}),
    ...(values.upstream !== undefined ? { upstream: commaList(values.upstream) } : {}),
    ...(values.downstream !== undefined ? { downstream: commaList(values.downstream) } : {}),
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerValue(value, minimum) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

function commaList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export async function readGraphManifest(root, graph) {
  return readJson(join(root, "graphs", `${graph}.json`));
}

export async function resolveGraphLaunch(root, prompt) {
  const block = parseGraphBlock(prompt);
  if (!block) return undefined;
  const value = await readGraphManifest(root, block.graph);
  const waves = Array.isArray(value?.waves)
    ? value.waves.map((wave) => Array.isArray(wave) ? wave.filter((node) => typeof node === "string" && TRACE_ID.test(node)) : [])
    : [];
  const valid = value?.graphId === block.graph && waves.length > 0 && waves[block.wave - 1]?.includes(block.node) &&
    Number.isSafeInteger(value?.maxParallel) && value.maxParallel >= 1 &&
    Number.isSafeInteger(value?.maxRepairLoops) && value.maxRepairLoops >= 0;
  return {
    ...block,
    ...(valid ? {
      plan: {
        graph: block.graph,
        waves,
        maxParallel: value.maxParallel,
        maxRepairLoops: value.maxRepairLoops,
      },
    } : {}),
  };
}

export function blockedKind(text) {
  if (/\bcredential(?:s)?\b|\bapi[ -]?key\b|\bpassword\b|\bsecret\b|\bauth(?:entication)? token\b/i.test(text)) {
    return "credential";
  }
  if (/\bpermission\b|\bauthori[sz](?:e|ation)\b|\bapproval\b|\baccess grant\b/i.test(text)) {
    return "permission";
  }
  if (/\bexternal action\b|\bdeploy\b|\bpublish\b|\bpush\b|\bsend\b.+\b(message|email)\b/i.test(text)) {
    return "external-action";
  }
  return "decision";
}
