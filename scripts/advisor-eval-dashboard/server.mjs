#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROSPECTIVE_CASES_ROOT,
  compareProspectiveArtifacts,
  scanProspectiveArtifacts,
} from "../advisor-prospective-results.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function scanCases() {
  const cases = [];
  try {
    for (const entry of await readdir(PROSPECTIVE_CASES_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const definition = JSON.parse(await readFile(join(PROSPECTIVE_CASES_ROOT, entry.name, "case.json"), "utf8"));
        cases.push({
          id: definition.id,
          title: definition.title,
          instruction: definition.instruction,
          acceptance: definition.acceptance,
          process: definition.process,
        });
      } catch {
        cases.push({ id: entry.name, title: entry.name, error: "Case definition is unreadable" });
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

function publicArtifact(artifact) {
  return {
    key: `${artifact.kind}:${artifact.id}`,
    id: artifact.id,
    kind: artifact.kind,
    baseline: artifact.baseline,
    manifest: artifact.manifest,
    result: artifact.result,
    diagnostics: artifact.diagnostics,
    error: artifact.error,
  };
}

async function state() {
  const [{ runs, baselines }, cases] = await Promise.all([scanProspectiveArtifacts(), scanCases()]);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cases,
    runs: runs.map(publicArtifact),
    baselines: baselines.map(publicArtifact),
  };
}

function findArtifact(snapshot, key) {
  return [...snapshot.runs, ...snapshot.baselines].find((artifact) => artifact.key === key);
}

export function createDashboardServer() {
  return createServer(async (request, response) => {
    try {
      const [pathname = "/", query = ""] = (request.url ?? "/").split("?", 2);
      const searchParams = new URLSearchParams(query);
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Only GET is supported" });
        return;
      }
      if (pathname === "/api/state") {
        sendJson(response, 200, await state());
        return;
      }
      if (pathname === "/api/compare") {
        const snapshot = await state();
        const before = findArtifact(snapshot, searchParams.get("before"));
        const after = findArtifact(snapshot, searchParams.get("after"));
        if (!before || !after) {
          sendJson(response, 404, { error: "Select two available artifacts" });
          return;
        }
        if (!before.result || !after.result) {
          const incomplete = [before, after].filter((artifact) => !artifact.result).map((artifact) => artifact.id).join(", ");
          sendJson(response, 409, { error: `Wait for these runs to finish before comparing: ${incomplete}` });
          return;
        }
        try {
          sendJson(response, 200, compareProspectiveArtifacts(before, after));
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const filename = STATIC_FILES.get(pathname);
      if (!filename) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const body = await readFile(join(ROOT, filename));
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(filename)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startDashboard({ port = 4318, host = "127.0.0.1" } = {}) {
  const server = createDashboardServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${actualPort}` };
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return 4318;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 through 65535");
  return port;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDashboard({ port: parsePort(process.argv.slice(2)) })
    .then(({ url }) => process.stdout.write(`Prospective eval dashboard: ${url}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
