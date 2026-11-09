import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// React Aria repeats React DOM properties in multiple base interfaces. With
// exactOptionalPropertyTypes, React's explicit `| undefined` is incompatible
// with the equivalent Spectrum property. Omit the duplicates in the DOM base
// so the Spectrum definitions remain authoritative. Runtime code is untouched.
const patches = [
  [
    "Group",
    "'role' | 'slot'",
    "'role' | 'slot' | keyof AriaLabelingProps | keyof DOMProps",
  ],
  [
    "OverlayArrow",
    "'render' | 'children'",
    "'render' | 'children' | keyof DOMProps",
  ],
];
for (const [name, before, after] of patches) {
  const path = fileURLToPath(
    new URL(
      `../node_modules/react-aria-components/dist/types/src/${name}.d.ts`,
      import.meta.url,
    ),
  );
  const source = readFileSync(path, "utf8");
  if (source.includes(after)) continue;
  if (!source.includes(before))
    throw new Error(
      `Review the React Aria ${name} declaration patch after upgrading.`,
    );
  writeFileSync(path, source.replace(before, after));
}

// unplugin's declaration eagerly imports all bundlers, including optional peers
// that a Vite application does not use. Type only the API used by this project.
const macroTypes = fileURLToPath(
  new URL(
    "../node_modules/unplugin-parcel-macros/unplugin-macros.d.ts",
    import.meta.url,
  ),
);
writeFileSync(
  macroTypes,
  "import type { PluginOption } from 'vite';\ndeclare const plugin: { vite(): PluginOption };\nexport = plugin;\n",
);

// The locale optimizer uses the same unplugin abstraction. Its optional bundler
// peers must not become requirements of this Vite-only application either.
const localeTypes = fileURLToPath(
  new URL(
    "../node_modules/@react-aria/optimize-locales-plugin/LocalesPlugin.d.ts",
    import.meta.url,
  ),
);
writeFileSync(
  localeTypes,
  "import type { Plugin } from 'vite';\ndeclare const plugin: { vite(options: {locales: readonly string[]}): Plugin };\nexport = plugin;\n",
);
