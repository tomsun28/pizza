import { macosBackend } from "./macos/backend.js";
import { ensureMacosReady } from "./macos/permissions.js";
import type { ComputerUsePlatformBackend, PlatformName } from "./types.js";
import { linuxBackend } from "./linux/backend.js";
import { windowsBackend } from "./windows/backend.js";

const macosPlatformBackend: ComputerUsePlatformBackend = {
	name: "macos",
	ensureReady: ensureMacosReady,
	listApps: macosBackend.listApps,
	listRoots: macosBackend.listRoots,
	getFrontmost: macosBackend.getFrontmost,
	focusWindow: macosBackend.focusWindow,
	observe: macosBackend.observe,
	act: macosBackend.act,
	actBatch: macosBackend.actBatch,
	readText: macosBackend.readText,
	waitFor: macosBackend.waitFor,
};

class UnsupportedPlatformBackend implements ComputerUsePlatformBackend {
	readonly name: PlatformName;
	private readonly platform: NodeJS.Platform;

	constructor(platform: NodeJS.Platform) {
		this.platform = platform;
		this.name = platform === "win32" ? "windows" : "linux";
	}

	private unsupported(): never {
		throw new Error(`pi-computer-use does not support platform '${this.platform}' yet.`);
	}

	async ensureReady(): Promise<never> { this.unsupported(); }
	async listApps(): Promise<never> { this.unsupported(); }
	async listRoots(): Promise<never> { this.unsupported(); }
	async getFrontmost(): Promise<never> { this.unsupported(); }
	async focusWindow(): Promise<never> { this.unsupported(); }
	async observe(): Promise<never> { this.unsupported(); }
	async act(): Promise<never> { this.unsupported(); }
	async readText(): Promise<never> { this.unsupported(); }
	async waitFor(): Promise<never> { this.unsupported(); }
}

export function platformBackendForRuntime(platform: NodeJS.Platform = process.platform): ComputerUsePlatformBackend {
	if (platform === "darwin") return macosPlatformBackend;
	if (platform === "win32") return windowsBackend;
	if (platform === "linux") return linuxBackend;
	return new UnsupportedPlatformBackend(platform);
}

export const currentPlatformBackend = platformBackendForRuntime();
