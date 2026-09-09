import { afterEach, describe, expect, it } from "vitest";

import { startPortalFixture, type PortalFixture } from "./portal-fixture";

describe("portal fixture", () => {
  let fixture: PortalFixture | undefined;
  afterEach(async () => fixture?.close());
  it("serves deterministic local browser controls", async () => {
    fixture = await startPortalFixture();
    const body = await fetch(fixture.baseUrl).then((result) => result.text());
    expect(body).toContain('aria-label="Incrementar"');
    expect(body).toContain('id="name"');
    await expect(fetch(`${fixture.baseUrl}/download`)).resolves.toMatchObject({ ok: true });
  });
});
