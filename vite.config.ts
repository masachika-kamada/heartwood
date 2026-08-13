import { defineConfig } from "vite";

// GitHub Pages serves project sites from a subpath; everything else is root.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  build: {
    target: "es2022",
  },
});
