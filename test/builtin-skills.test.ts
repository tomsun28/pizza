import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getBuiltinSkillIds,
	getBuiltinSkillInfos,
	getBuiltinSkillPath,
	getEnabledBuiltinSkillPaths,
	isBuiltinSkillId,
} from "../src/builtin-skills/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

describe("built-in skills registry", () => {
	it("has a non-empty, unique set of ids", () => {
		const ids = getBuiltinSkillIds();
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("isBuiltinSkillId matches registry ids only", () => {
		expect(isBuiltinSkillId(getBuiltinSkillIds()[0])).toBe(true);
		expect(isBuiltinSkillId("not-a-builtin-skill")).toBe(false);
	});

	it("ships a valid SKILL.md for every registered id", () => {
		for (const id of getBuiltinSkillIds()) {
			const path = getBuiltinSkillPath(id);
			expect(existsSync(path), `${path} should exist`).toBe(true);

			const { frontmatter } = parseFrontmatter<{ name?: string; description?: string }>(
				readFileSync(path, "utf-8"),
			);
			// Per Agent Skills spec: name matches the directory, description required.
			expect(frontmatter.name, `${id}: name frontmatter must match directory`).toBe(id);
			expect(frontmatter.description?.trim(), `${id}: description is required`).toBeTruthy();
			expect((frontmatter.description ?? "").length).toBeLessThanOrEqual(1024);
		}
	});

	it("getBuiltinSkillInfos reads name/description from the SKILL.md files", () => {
		const infos = getBuiltinSkillInfos();
		expect(infos.map((info) => info.id)).toEqual(getBuiltinSkillIds());
		for (const info of infos) {
			expect(info.name).toBe(info.id);
			expect(info.description.length).toBeGreaterThan(0);
			expect(info.path).toBe(getBuiltinSkillPath(info.id));
		}
	});

	it("getEnabledBuiltinSkillPaths returns only enabled ids, in registry order", () => {
		const ids = getBuiltinSkillIds();
		expect(getEnabledBuiltinSkillPaths(new Set())).toEqual([]);
		const enabled = new Set([ids[0], ids[ids.length - 1]]);
		expect(getEnabledBuiltinSkillPaths(enabled)).toEqual([
			getBuiltinSkillPath(ids[0]),
			getBuiltinSkillPath(ids[ids.length - 1]),
		]);
	});
});

describe("built-in skills loading (resource loader)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `builtin-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(join(agentDir), { recursive: true });
		mkdirSync(join(cwd), { recursive: true });
		originalAgentDir = process.env.PIZZA_CODING_AGENT_DIR;
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PIZZA_CODING_AGENT_DIR;
		} else {
			process.env.PIZZA_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSettings(settings: Record<string, unknown>): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, "\t"));
	}

	it("are disabled by default (no settings)", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		for (const id of getBuiltinSkillIds()) {
			expect(skills.some((s) => s.name === id)).toBe(false);
		}
	});

	it("load when enabled via settings.enabledBuiltinSkills, attributed to the builtin source", async () => {
		writeSettings({ enabledBuiltinSkills: ["git-workflow"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const skill = skills.find((s) => s.name === "git-workflow");
		expect(skill).toBeDefined();
		expect(skill?.filePath).toBe(getBuiltinSkillPath("git-workflow"));
		expect(skill?.sourceInfo.source).toBe("builtin");
		// Not enabled → not loaded
		expect(skills.some((s) => s.name === "code-review")).toBe(false);
	});

	it("lose name collisions to user skills (user overrides builtin)", async () => {
		writeSettings({ enabledBuiltinSkills: ["git-workflow"] });
		const userSkillDir = join(agentDir, "skills");
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(
			join(userSkillDir, "git-workflow.md"),
			"---\nname: git-workflow\ndescription: user override\n---\nuser content",
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills, diagnostics } = loader.getSkills();
		const skill = skills.find((s) => s.name === "git-workflow");
		expect(skill?.filePath).toBe(join(userSkillDir, "git-workflow.md"));
		expect(diagnostics.some((d) => d.type === "collision")).toBe(true);
	});

	it("are skipped entirely with noBuiltinSkills, even when enabled", async () => {
		writeSettings({ enabledBuiltinSkills: ["git-workflow"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir, noBuiltinSkills: true });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "git-workflow")).toBe(false);
	});

	it("are skipped with noSkills, even when enabled", async () => {
		writeSettings({ enabledBuiltinSkills: ["git-workflow"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "git-workflow")).toBe(false);
	});

	it("reloadSkills picks up enable/disable changes without a full reload", async () => {
		writeSettings({ enabledBuiltinSkills: [] });
		// Share one settings manager between the test and the loader (as the TUI does).
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.name === "debugging")).toBe(false);

		settingsManager.setBuiltinSkillEnabled("debugging", true);
		loader.reloadSkills();
		expect(loader.getSkills().skills.some((s) => s.name === "debugging")).toBe(true);

		settingsManager.setBuiltinSkillEnabled("debugging", false);
		loader.reloadSkills();
		expect(loader.getSkills().skills.some((s) => s.name === "debugging")).toBe(false);
	});
});
