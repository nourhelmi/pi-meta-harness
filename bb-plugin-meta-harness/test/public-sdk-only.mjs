import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scan = experimental_scanPublicSdkOnly(packageRoot, {
  allow: [
    /^@get-bb\/plugin-sdk\/testing$/u,
    /^react$/u,
    /^@testing-library\/react$/u,
    /^vitest\/config$/u,
  ],
});

assert.deepEqual(scan.violations, []);
assert.deepEqual(scan.privateDependencies, []);
assert.ok(scan.files.includes("src/server.ts"));
assert.ok(scan.files.includes("src/host.ts"));
assert.ok(scan.files.includes("src/app.tsx"));

process.stdout.write(
  `public-sdk-only: ${scan.files.length} files, 0 violations, 0 private dependencies\n`,
);
