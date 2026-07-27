#!/usr/bin/env node
/**
 * Regenerate src/builtin-extensions/agent-browser/skill-content.ts from skill.md.
 *
 * The skill content is embedded as a string so it is available in every Pizza
 * distribution (Node dist, compiled Bun binary) without runtime file lookups.
 *
 * Run after editing skill.md:
 *   node scripts/generate-browser-skill.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const skillPath = join(root, "src/builtin-extensions/agent-browser/skill.md");
const outPath = join(root, "src/builtin-extensions/agent-browser/skill-content.ts");

const content = readFileSync(skillPath, "utf-8");
const ts =
	"/* AUTO-GENERATED from skill.md by scripts/generate-browser-skill.mjs. Do not edit by hand. */\n" +
	"/* eslint-disable */\n" +
	`export const AGENT_BROWSER_SKILL_CONTENT: string = ${JSON.stringify(content)};\n`;

writeFileSync(outPath, ts);
console.log(`Wrote ${outPath} (${ts.length} bytes)`);
