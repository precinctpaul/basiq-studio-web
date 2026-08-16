import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The local agent's Python virtualenv. yt-dlp vendors JavaScript inside
    // its own package, which eslint happily crawled and reported findings on
    // — third-party code we neither wrote nor ship.
    "tools/.venv/**",
  ]),
]);

export default eslintConfig;
