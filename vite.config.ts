import { defineConfig } from "vite";

// GitHub Pages project sites are served from /repo-name/
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base =
  process.env.GITHUB_ACTIONS && repoName ? `/${repoName}/` : "./";

export default defineConfig({
  base,
  worker: {
    format: "es",
  },
});
