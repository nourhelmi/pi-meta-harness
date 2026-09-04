import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bbRoot = resolve(
  process.env.BB_PINNED_SOURCE_ROOT ?? "/private/tmp/get-bb-bootstrap-api",
);
const expectedCommit = "5c6f1520bd5c1870a5d22e3268bc57f9f10b3fdd";
const cli = resolve(bbRoot, "packages/scripts/dist/commands/run-cli.js");

const git = spawnSync("git", ["-C", bbRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
if (git.status !== 0 || git.stdout.trim() !== expectedCommit) {
  throw new Error(
    `pinned BB checkout must be ${expectedCommit}; got ${git.stdout.trim() || git.stderr.trim()}`,
  );
}

const bbApp = JSON.parse(
  readFileSync(resolve(bbRoot, "packages/bb-app/package.json"), "utf8"),
);
const sdkVersion = /PLUGIN_SDK_VERSION = "([^"]+)"/u.exec(
  readFileSync(resolve(bbRoot, "packages/domain/src/plugin-sdk-version.ts"), "utf8"),
)?.[1];
if (bbApp.version !== "0.41.0" || sdkVersion !== "0.4.40") {
  throw new Error(
    `pinned BB build identity mismatch: bb-app=${bbApp.version}, sdk=${sdkVersion}`,
  );
}

const build = spawnSync(
  process.execPath,
  [cli, "plugin", "build", process.cwd()],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

for (const entry of ["server", "app", "host"]) {
  const metadata = JSON.parse(
    readFileSync(resolve(process.cwd(), "dist", `${entry}.meta.json`), "utf8"),
  );
  if (
    metadata.sdkVersion !== "0.4.40" ||
    metadata.builtWith?.bbVersion !== "0.41.0" ||
    metadata.builtWith?.pluginSdkVersion !== "0.4.40"
  ) {
    throw new Error(`${entry} artifact was not built by BB 0.41.0 / SDK 0.4.40`);
  }
}
