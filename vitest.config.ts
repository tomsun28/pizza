import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    server: {
      deps: {
        external: [/@silvia-odwyer\/photon-node/],
      },
    },
  },
  resolve: {
    // Preserve symlinks to avoid issues with monorepo package resolution
    preserveSymlinks: true,
  },
});
