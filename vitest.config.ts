import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

// Vitest prefixes environment globs with the project folder, so glob characters in the
// folder name (like the "(5)" in "pathfinder-smart-campus (5)") would be read as patterns.
// Wrapping each one in [] makes it match literally.
const literalRoot = templateRoot.replace(/\\/g, "/").replace(/[()*?{}]/g, (char) => `[${char}]`);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "shared/**/*.test.ts", "shared/**/*.spec.ts", "client/**/*.test.ts", "client/**/*.test.tsx"],
    environmentMatchGlobs: [[`${literalRoot}/client/**/*.browser.test.tsx`, "jsdom"]],
    setupFiles: ["client/src/test/setupDomStorage.ts"],
  },
});
