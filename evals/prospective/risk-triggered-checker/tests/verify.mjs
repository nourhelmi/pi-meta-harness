import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function command(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

export async function verify(workspace) {
  const publicCheck = command("npm", ["test", "--silent"], workspace);
  const contract = JSON.parse(await readFile(join(workspace, "contract.json"), "utf8"));
  const status = command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace);
  const changedPaths = status.status === 0
    ? status.stdout.split("\0").filter(Boolean).map((record) => record.slice(3)).sort()
    : [];

  let crossTenantDenied = false;
  let wrongOwnerDenied = false;
  let missingIdentityDenied = false;
  try {
    const { canRead } = await import(`${pathToFileURL(join(workspace, "authorize.mjs")).href}?${Date.now()}-${Math.random()}`);
    const request = { tenantId: "tenant-a", userId: "user-a" };
    crossTenantDenied = canRead(request, { tenantId: "tenant-b", ownerId: "user-a" }) === false;
    wrongOwnerDenied = canRead(request, { tenantId: "tenant-a", ownerId: "user-b" }) === false;
    const resource = { tenantId: "tenant-a", ownerId: "user-a" };
    const requestFieldsDenied = contract.requiredRequestFields.every((field) => {
      const missing = { ...request };
      delete missing[field];
      return canRead(missing, resource) === false && canRead({ ...request, [field]: "" }, resource) === false;
    });
    const resourceFieldsDenied = contract.requiredResourceFields.every((field) => {
      const missing = { ...resource };
      delete missing[field];
      return canRead(request, missing) === false && canRead(request, { ...resource, [field]: "" }) === false;
    });
    missingIdentityDenied = requestFieldsDenied && resourceFieldsDenied && canRead(null, resource) === false;
  } catch {
    crossTenantDenied = false;
    wrongOwnerDenied = false;
    missingIdentityDenied = false;
  }

  const expectedContract = {
    readRule: "same-tenant-and-owner",
    requiredRequestFields: ["tenantId", "userId"],
    requiredResourceFields: ["tenantId", "ownerId"]
  };
  return {
    checks: [
      { id: "public-check-passes", passed: publicCheck.status === 0, evidence: `npm test exited ${publicCheck.status ?? "without status"}` },
      { id: "cross-tenant-denied", passed: crossTenantDenied, evidence: crossTenantDenied ? "same-owner cross-tenant request denied" : "cross-tenant request was not denied" },
      { id: "wrong-owner-denied", passed: wrongOwnerDenied, evidence: wrongOwnerDenied ? "same-tenant wrong-owner request denied" : "wrong-owner request was not denied" },
      { id: "missing-identity-denied", passed: missingIdentityDenied, evidence: missingIdentityDenied ? "missing request/resource identity failed closed" : "missing identity did not fail closed" },
      { id: "bounded-surface", passed: status.status === 0 && changedPaths.length === 1 && changedPaths[0] === "authorize.mjs" && JSON.stringify(contract) === JSON.stringify(expectedContract), evidence: status.status === 0 ? `changed paths: ${changedPaths.join(", ") || "none"}` : "git status failed" }
    ]
  };
}
