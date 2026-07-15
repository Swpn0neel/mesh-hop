import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "desktop-dist/**",
      "desktop-engine-build/**",
      "src-tauri/**",
      "release/**",
      "node_modules/**",
      "website/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "scripts/**/*.mjs", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["desktop-ui/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, __APP_VERSION__: "readonly" },
    },
  },
];
