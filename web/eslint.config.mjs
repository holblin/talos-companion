import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
  files: [
    "src/**/*.{ts,tsx}",
    "tests/**/*.{ts,tsx}",
    "vite.config.ts",
    "vitest.config.ts",
  ],
  extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
  linterOptions: {
    noInlineConfig: true,
    reportUnusedDisableDirectives: "error",
  },
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@react-spectrum/s2",
            allowImportNames: [
              "mergeStyles",
              "useListData",
              "useTreeData",
              "useAsyncList",
              "useDragAndDrop",
            ],
            allowTypeImports: true,
            message:
              "Import S2 components from their documented component subpath.",
          },
        ],
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "ImportDeclaration[importKind!='type'][source.value='@react-spectrum/s2/style']:not(:has(ImportAttribute[key.name='type'][value.value='macro']))",
        message: 'The S2 style import requires with { type: "macro" }.',
      },
      {
        selector: "JSXAttribute[name.name='style']",
        message:
          "Use the S2 style macro with className on HTML or styles on Spectrum components.",
      },
      {
        selector: "JSXAttribute[name.name=/^UNSAFE_(style|className)$/]",
        message:
          "Use S2 component props and style macro layout tokens; unsafe overrides are prohibited.",
      },
      {
        selector:
          "JSXAttribute[name.name='styles'] > JSXExpressionContainer > ObjectExpression",
        message:
          "Use styles={style({...})} with the S2 macro, not a raw object.",
      },
      {
        selector: "JSXElement[openingElement.name.name='style']",
        message: "Use the S2 style macro instead of style elements.",
      },
      {
        selector:
          "ImportDeclaration[source.value=/\\.css$/]:not([source.value='@react-spectrum/s2/page.css'])",
        message:
          "Application CSS must use the S2 style macro. Only Spectrum page.css is allowed.",
      },
    ],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/ban-ts-comment": [
      "error",
      {
        "ts-check": false,
        "ts-expect-error": true,
        "ts-ignore": true,
        "ts-nocheck": true,
      },
    ],
  },
});
