import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

export async function verify(workspace) {
  const test = spawnSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8" });
  const contractPath = join(workspace, "contract.json");
  const runtimePath = join(workspace, "runtime-observation.json");
  const planPath = join(workspace, "deployment-plan.json");
  const [contract, runtime, plan, contractText, runtimeText] = await Promise.all([
    json(contractPath),
    json(runtimePath),
    json(planPath),
    readFile(contractPath, "utf8"),
    readFile(runtimePath, "utf8"),
  ]);
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const changed = diff.status === 0 ? diff.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const sourcesExact = contractText === '{\n  "owner": "platform",\n  "apiVersion": "v3"\n}\n'
    && runtimeText === '{\n  "region": "eu-west-1",\n  "failover": "warm"\n}\n';
  return { checks: [
    { id: "public-check-passes", passed: test.status === 0, evidence: `npm test exited ${test.status ?? "without status"}` },
    { id: "contract-evidence-merged", passed: plan?.owner === contract?.owner && plan?.apiVersion === contract?.apiVersion, evidence: plan ? `${plan.owner}; ${plan.apiVersion}` : "deployment plan missing" },
    { id: "runtime-evidence-merged", passed: plan?.region === runtime?.region && plan?.failover === runtime?.failover, evidence: plan ? `${plan.region}; ${plan.failover}` : "deployment plan missing" },
    { id: "bounded-surface", passed: sourcesExact && diff.status === 0 && changed.length === 1 && changed[0] === "deployment-plan.json", evidence: `changed paths: ${changed.join(", ") || "none"}` },
  ] };
}
