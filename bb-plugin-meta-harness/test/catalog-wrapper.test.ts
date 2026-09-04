import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const detachRoot = "/Users/nour/Dev/pi-detach-worktrees/bb-adapter-poc";
const wrapper = join(packageRoot, "src", "catalog-wrapper.mjs");

describe("catalog wrapper", () => {
  it("pins the exact classifier, runtime, curated profile, and five-descriptor contract", () => {
    const source = readFileSync(new URL("../src/catalog-wrapper.mjs", import.meta.url), "utf8");
    expect(source).toContain('STATIC_PREFIX = ["--bb-wrapper-static", "v1", "--config"]');
    expect(source).toContain('EXPECTED_NODE = "v24.18.0"');
    expect(source).toContain('EXPECTED_PI = "0.84.4"');
    expect(source).toContain('args.length === 1 && args[0] === "--version"');
    expect(source).toContain("stdio: [0, 1, 2, 3, 4]");
    expect(source).toContain('[...args, "--no-extensions"]');
    expect(source).toContain("validateToolOwners(detachRoot)");
		expect(source).toContain("validateThreadTail(args, extensionDir, config.skillRoots)");
    expect(source).toContain("validateDynamicTools(extensionDir)");
    expect(source).toContain('name: "update_environment_directory"');
    expect(source).toContain("single pinned relocation tool");
		expect(source).toContain("reservedSessionFile(config.sessionRoot, args[3])");
		expect(source).toContain("resolvePi(config.piExecutable)");
		expect(source).not.toContain('execFileSync("which"');
    expect(source).toContain("project Pi extension discovery is forbidden");
    expect(source).not.toContain('stdio: "inherit"');
    expect(source).not.toContain("node/v25");
    expect(source).not.toContain("/tmp/pi-bb-catalog-wrapper");
  });

	it("rejects missing, duplicate, colliding, and unexpected BB dynamic tools before Pi", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bb-wrapper-tool-reject-")));
		const profileRoot = join(root, "profile");
		const sessionRoot = join(root, "sessions");
		const advisorStateRoot = join(root, "advisor");
		const detachStateRoot = join(root, "detach");
		const providerTempRoot = realpathSync(mkdtempSync(join(tmpdir(), "bb-provider-bridge-provider-pi-")));
		const scratch = join(providerTempRoot, "pi");
		mkdirSync(scratch);
		const extension = join(scratch, "bb-pi-extension.mjs");
		const piPackage = join(root, "pi-package");
		const piExecutable = join(piPackage, "bin", "pi-fixture.mjs");
		for (const path of [profileRoot, sessionRoot, advisorStateRoot, detachStateRoot]) mkdirSync(path, { recursive: true });
		writeFileSync(extension, "export default function fixture() {}\n");
		mkdirSync(dirname(piExecutable), { recursive: true });
		writeFileSync(
			join(piPackage, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.4" }),
		);
		writeFileSync(
			piExecutable,
			'#!/usr/bin/env node\nif (process.argv.includes("--version")) process.stdout.write("0.84.4\\n");\n',
		);
		chmodSync(piExecutable, 0o755);
		const config = Buffer.from(JSON.stringify({
			advisorStateRoot,
			allowedRoots: [root],
			detachRoot,
			detachStateRoot,
			hostId: "host-test",
			piExecutable,
			profileRoot,
			sessionRoot,
			skillRoots: [],
		})).toString("base64url");
		const args = [
			wrapper,
			"--bb-wrapper-static", "v1", "--config", config,
			"--mode", "rpc",
			"--session", join(sessionRoot, "thread.jsonl"),
			"--session-dir", sessionRoot,
			"--extension", extension,
			"--model", "openai-codex/gpt-5.6-sol",
			"--thinking", "high",
		];
		const baseEnv = {
			...process.env,
			BB_THREAD_ID: "thread-test",
			BB_PROJECT_ID: "project-test",
			BB_ENVIRONMENT_ID: "environment-test",
			BB_SERVER_URL: "http://127.0.0.1:38886",
		};
		const cases: Array<{ name: string; tools?: unknown[]; reason: RegExp }> = [
			{ name: "missing", reason: /PI_BB_TOOLS_FILE is required/u },
			{ name: "duplicate", tools: [{ name: "same" }, { name: "same" }], reason: /duplicate tools/u },
			{ name: "collision", tools: [{ name: "bg_agent" }], reason: /collides with a curated public tool/u },
			{ name: "unexpected", tools: [{ name: "rogue_tool" }], reason: /single pinned relocation tool/u },
		];
		for (const fixture of cases) {
			const toolsFile = join(scratch, `${fixture.name}.json`);
			if (fixture.tools) writeFileSync(toolsFile, JSON.stringify(fixture.tools));
			const env = { ...baseEnv, ...(fixture.tools ? { PI_BB_TOOLS_FILE: toolsFile } : {}) };
			delete env.PI_BB_TOOLS_FILE;
			if (fixture.tools) env.PI_BB_TOOLS_FILE = toolsFile;
			const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
			expect(result.status, fixture.name).toBe(64);
			expect(result.stderr, fixture.name).toMatch(fixture.reason);
		}
	});
});
