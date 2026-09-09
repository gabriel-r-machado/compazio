import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ORCHESTRATOR_LABEL, PRODUCT_NAME } from "@forgedeck/compazio-v2-domain";

const v2Root = fileURLToPath(new URL(".", import.meta.url));

async function sourceFiles(): Promise<readonly { path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx|css|cjs|mjs)$/.test(entry.name)) continue;
      // This file quotes the forbidden vocabulary and the constructor shape in order to check them.
      if (entry.name === "v2-invariants.test.ts") continue;
      files.push({ path: relative(v2Root, full), text: await readFile(full, "utf8") });
    }
  };
  await walk(v2Root);
  return files;
}

describe("invariantes da superfície V2", () => {
  it("usa exclusivamente COMPAZIO para produto e coordenação pública", () => {
    expect(PRODUCT_NAME).toBe("COMPAZIO");
    expect(ORCHESTRATOR_LABEL).toBe("COMPAZIO");
  });

  it("toda construção do V2WorkspaceService passa pelo gate de entitlement", async () => {
    const missing: string[] = [];
    for (const file of await sourceFiles()) {
      let index = file.text.indexOf("new V2WorkspaceService({");
      while (index >= 0) {
        const block = file.text.slice(index, closingBrace(file.text, index));
        if (!block.includes("entitlement")) missing.push(`${file.path} @${index}`);
        index = file.text.indexOf("new V2WorkspaceService({", index + 1);
      }
    }
    expect(missing).toEqual([]);
  });

  it("nenhum harness aponta a raiz de estado para o userData instalado", async () => {
    const offenders = (await sourceFiles())
      .filter((file) => file.path.includes("e2e"))
      .filter((file) =>
        /AppData\\{1,2}Roaming\\{1,2}Compazio|Roaming[/\\]+Compazio/i.test(file.text)
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

/** Index just past the brace that closes the object literal opened at `start`. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  for (let index = text.indexOf("{", start); index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}
