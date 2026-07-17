import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev port (1420) and no clearScreen so its logs stay visible.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: "127.0.0.1",
	},
	envPrefix: ["VITE_", "TAURI_"],
	build: {
		target: "es2022",
		outDir: "dist",
		emptyOutDir: true,
	},
});
