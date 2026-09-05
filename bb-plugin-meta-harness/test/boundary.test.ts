import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(packageRoot, path), "utf8");
}

describe("external read-only boundary", () => {
  it("pins the public SDK and has no private or orchestration dependency", async () => {
    const manifest = JSON.parse(await source("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.4.47");
    expect(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      }).filter((name) => name.startsWith("@bb/")),
    ).toEqual([]);

    const production = (
      await Promise.all(
        [
          "src/app.tsx",
          "src/configuration.ts",
          "src/contracts.ts",
          "src/host.ts",
          "src/server.ts",
          "src/trace-policy.ts",
          "src/trace-projector.ts",
        ].map(source),
      )
    ).join("\n");
    expect(production).not.toMatch(
      /provider[-_.]?bridge|private[-_.]?init|threads?\.spawn|workers?\.spawn|orchestrat(?:e|ion)|bb\.sdk|bb\.background|experimental_watch|realtime\.publish/iu,
    );
    expect(production).not.toMatch(
      /node:(?:child_process|worker_threads)|@mariozechner\/pi|native[-_.]?transcript|messages\.jsonl|result\.md/iu,
    );
    expect(production).not.toMatch(
      /bb\.(?:agents|providers|threads|tools|services|schedules|background|realtime)\b/iu,
    );
  });

  it("keeps all production filesystem access descriptor-read-only", async () => {
    const policy = await source("src/trace-policy.ts");
    expect(policy).toMatch(/constants\.O_RDONLY \|/u);
    expect(policy).toMatch(/O_NOFOLLOW/u);
    expect(policy).toMatch(/handle\.read\(/u);
    expect(policy).not.toMatch(
      /\b(?:readFile|writeFile|appendFile|createWriteStream|mkdir|rename|rm|rmdir|unlink|truncate)\b/u,
    );
  });

  it("does not open trace-derived result paths", async () => {
    const policy = await source("src/trace-policy.ts");
    const projector = await source("src/trace-projector.ts");
    expect(policy).not.toMatch(/resultPath|result\.md/iu);
    expect(projector).toMatch(/resultPath/u);
  });
});
