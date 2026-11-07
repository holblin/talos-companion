import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));

it("allows Spectrum fonts only from the bundled stylesheet's font host", () => {
  const css = readFileSync(
    resolve(
      directory,
      "../node_modules/@react-spectrum/s2/dist/private/font-faces.css",
    ),
    "utf8",
  );
  const origins = [
    ...new Set(
      [...css.matchAll(/url\("(https:[^"]+)"\)/g)].map(
        (match) => new URL(match[1] ?? "").origin,
      ),
    ),
  ];
  expect(origins).toEqual(["https://use.typekit.net"]);
  const server = readFileSync(resolve(directory, "../../src/main.rs"), "utf8");
  expect(server).toContain(`font-src 'self' ${origins.join(" ")};`);
});

it.each(["interactions/usePress", "overlays/usePreventScroll"])(
  "allows the fixed React Aria %s style under the server CSP",
  (module) => {
    const source = readFileSync(
      resolve(
        directory,
        "../node_modules/react-aria/dist/private",
        `${module}.mjs`,
      ),
      "utf8",
    );
    const template = /style\.textContent = `([\s\S]*?)`\.trim\(\)/.exec(
      source,
    )?.[1];
    if (!template)
      throw new Error("Review React Aria's runtime styles after upgrading.");
    const css = template
      .replace(/\$\{[^}]+PRESSABLE_ATTRIBUTE\}/g, "data-react-aria-pressable")
      .trim();
    expect(css.includes("${")).toBe(false);
    const hash = createHash("sha256").update(css).digest("base64");
    const server = readFileSync(
      resolve(directory, "../../src/main.rs"),
      "utf8",
    );
    expect(server).toContain(`'sha256-${hash}'`);
    expect(server).not.toContain("'unsafe-inline'");
  },
);
