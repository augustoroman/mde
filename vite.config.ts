import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "mde",
      cssFileName: "mde",
    },
    sourcemap: true,
    rollupOptions: {
      external: [/^prosemirror-/, "markdown-it"],
    },
  },
  test: {
    environment: "node",
  },
});
