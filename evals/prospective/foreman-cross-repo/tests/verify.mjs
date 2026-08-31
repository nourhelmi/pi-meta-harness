import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function verify(workspace) {
  const test = spawnSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8" });
  const schema = (await readFile(join(workspace, "repos", "schema", "version.txt"), "utf8")).trim();
  const service = (await readFile(join(workspace, "repos", "service", "schema-version.txt"), "utf8")).trim();
  let plan;
  try { plan = JSON.parse(await readFile(join(workspace, "delivery-plan.json"), "utf8")); } catch { plan = undefined; }
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const changed = diff.status === 0 ? diff.stdout.trim().split(/\r?\n/).filter(Boolean).sort() : [];
  const expected = ["delivery-plan.json", "repos/schema/version.txt", "repos/service/schema-version.txt"];
  return { checks: [
    { id: "public-check-passes", passed: test.status === 0, evidence: `npm test exited ${test.status ?? "without status"}` },
    { id: "versions-aligned", passed: schema === "v2" && service === "v2", evidence: `schema ${schema}; service ${service}` },
    { id: "delivery-order-recorded", passed: JSON.stringify(plan?.order) === JSON.stringify(["schema", "service"]) && plan?.externalEffects === false, evidence: plan ? `${plan.order?.join(" → ")}; externalEffects ${plan.externalEffects}` : "delivery plan missing" },
    { id: "bounded-surface", passed: diff.status === 0 && JSON.stringify(changed) === JSON.stringify(expected), evidence: `changed paths: ${changed.join(", ") || "none"}` }
  ] };
}
