import { describe, expect, it } from "vitest";

import { translationCatalogs } from "./i18n";

describe("i18n catalogs", () => {
  it("keeps PT-BR and English catalogs complete and defaults at the schema boundary", () => {
    expect(Object.keys(translationCatalogs.en).sort()).toEqual(
      Object.keys(translationCatalogs["pt-BR"]).sort()
    );
    expect(translationCatalogs["pt-BR"]["topbar.openFolder"]).toBe("Abrir pasta");
    expect(translationCatalogs.en["topbar.openFolder"]).toBe("Open folder");
  });
});
