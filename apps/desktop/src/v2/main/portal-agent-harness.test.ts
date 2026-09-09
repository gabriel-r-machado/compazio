import { describe, expect, it } from "vitest";

import {
  buildPortalAgentAuthCommand,
  buildPortalAgentCommand,
  isValidOpenCodeModel
} from "./portal-agent-commands";
import {
  buildPortalAgentPrompt,
  classifyPortalAgentFailure,
  extractPortalAgentReport,
  portalAgentExitCode,
  runPortalAgentProbe,
  sanitizePortalAgentProbe,
  type PortalAgentCleanup,
  type PortalAgentEnvironment,
  type PortalAgentObservation,
  type PortalAgentTurn,
  type RealPortalAgentProbe
} from "./portal-agent-harness";

const options = { fixtureUrl: "http://127.0.0.1:4100", portalId: "portal-1" };
const expectedName = "Compazio Agent Test";

const goodObservation: PortalAgentObservation = {
  counter: 1,
  nameValue: expectedName,
  visibleResult: `Olá, ${expectedName}`,
  navigatedUrl: "http://127.0.0.1:4100/",
  screenshotCount: 1,
  consoleEntries: 2,
  listedByAgent: true
};

const goodCleanup: PortalAgentCleanup = {
  views: 0,
  webContents: 0,
  listeners: 0,
  pendingOperations: 0,
  screenshots: 0,
  agentProcesses: 0,
  temporaryRemoved: true
};

const goodTurn: PortalAgentTurn = {
  stdout: `feito {"portalId":"portal-1","counter":1,"submittedName":"${expectedName}","visibleResult":"Olá, ${expectedName}","screenshotCreated":true,"consoleRead":true}`,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 4_000
};

/** A fake agent: the harness must be verifiable where no CLI is installed, which includes CI. */
function fakeEnvironment(overrides: Partial<PortalAgentEnvironment> = {}): PortalAgentEnvironment {
  return {
    detect: async () => ({ installed: true, authenticated: true, version: "1.0.0" }),
    runTurn: async () => goodTurn,
    observe: async () => goodObservation,
    revoke: async () => ({
      attempted: true,
      code: "PORTAL_NOT_CONNECTED",
      fixtureUnchanged: true
    }),
    cleanup: async () => goodCleanup,
    ...overrides
  };
}

describe("portal real agent harness", () => {
  it("passes when the agent completes the flow and everything is cleaned up", async () => {
    const probe = await runPortalAgentProbe("claude-code", fakeEnvironment(), options);
    expect(probe.status).toBe("passed");
    expect(probe.version).toBe("1.0.0");
    expect(probe.steps).toEqual({
      listPortal: true,
      navigate: true,
      click: true,
      type: true,
      submit: true,
      readResult: true,
      screenshot: true,
      console: true,
      revokedAfterDisconnect: true,
      cleanup: true
    });
    expect(probe.durationMs).toBeGreaterThanOrEqual(0);
    expect(probe.failure).toBeUndefined();
  });

  it("reports a missing executable without blaming the Portal", async () => {
    const probe = await runPortalAgentProbe(
      "codex",
      fakeEnvironment({
        detect: async () => ({ installed: false, authenticated: false, issue: "codex ausente" })
      }),
      options
    );
    expect(probe.status).toBe("not-installed");
    expect(probe.failure).toMatchObject({ category: "agent", code: "AGENT_NOT_INSTALLED" });
    expect(probe.steps.navigate).toBe(false);
  });

  it("reports a missing login separately from a failure", async () => {
    const probe = await runPortalAgentProbe(
      "codex",
      fakeEnvironment({
        detect: async () => ({ installed: true, authenticated: false, version: "0.144.6" })
      }),
      options
    );
    expect(probe.status).toBe("not-authenticated");
    expect(probe.failure?.category).toBe("authentication");
  });

  it("classifies an unavailable provider as an external block, not a Compazio defect", async () => {
    const probe = await runPortalAgentProbe(
      "opencode",
      fakeEnvironment({
        runTurn: async () => ({
          stdout: "",
          stderr: "Error from provider (Console): Upstream request failed",
          exitCode: 1,
          timedOut: false,
          durationMs: 900
        }),
        observe: async () => ({
          counter: 0,
          nameValue: "",
          visibleResult: "",
          navigatedUrl: "",
          screenshotCount: 0,
          consoleEntries: 0,
          listedByAgent: false
        })
      }),
      options
    );
    expect(probe.status).toBe("blocked-external");
    expect(probe.failure).toMatchObject({
      category: "provider",
      code: "EXTERNAL_PROVIDER_UNAVAILABLE"
    });
    expect(probe.steps.cleanup).toBe(true);
  });

  it("classifies a timeout as a timeout", async () => {
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({
        runTurn: async () => ({
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: true,
          durationMs: 120_000
        }),
        observe: async () => ({ ...goodObservation, counter: 0, listedByAgent: false })
      }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.failure).toMatchObject({ category: "timeout", code: "AGENT_TIMEOUT" });
  });

  it("fails when the agent process dies", async () => {
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({
        runTurn: async () => {
          throw new Error("spawn ENOENT");
        }
      }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.failure).toMatchObject({ category: "agent", code: "AGENT_PROCESS_FAILED" });
    expect(probe.steps.cleanup).toBe(true);
  });

  it("accepts a turn whose JSON is unusable when the effects are real", async () => {
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({
        runTurn: async () => ({ ...goodTurn, stdout: "pronto! {não é json}" })
      }),
      options
    );
    expect(probe.status).toBe("passed");
  });

  it("fails when the bridge is unreachable", async () => {
    const probe = await runPortalAgentProbe(
      "codex",
      fakeEnvironment({
        runTurn: async () => ({
          stdout: "connect ECONNREFUSED 127.0.0.1:1 BRIDGE_UNAVAILABLE",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          durationMs: 500
        }),
        observe: async () => ({ ...goodObservation, counter: 0, listedByAgent: false })
      }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.failure).toMatchObject({ category: "bridge" });
  });

  it("fails with the Portal code when the Portal is gone", async () => {
    const probe = await runPortalAgentProbe(
      "codex",
      fakeEnvironment({
        runTurn: async () => ({
          stdout: "erro PORTAL_NOT_FOUND",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          durationMs: 500
        }),
        observe: async () => ({ ...goodObservation, counter: 0, listedByAgent: false })
      }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.failure).toMatchObject({ category: "portal", code: "PORTAL_NOT_FOUND" });
  });

  it("fails when removing the connection does not revoke control", async () => {
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({
        revoke: async () => ({ attempted: true, code: "sem-erro", fixtureUnchanged: false })
      }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.failure?.category).toBe("portal");
    expect(probe.steps.revokedAfterDisconnect).toBe(false);
  });

  it("fails when resources leak, even with a perfect turn", async () => {
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({ cleanup: async () => ({ ...goodCleanup, views: 1 }) }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.failure).toMatchObject({ category: "cleanup", code: "RESOURCES_LEAKED" });
  });

  it("cleans up after a failed flow", async () => {
    let cleaned = false;
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({
        observe: async () => ({ ...goodObservation, counter: 0, listedByAgent: false }),
        cleanup: async () => {
          cleaned = true;
          return goodCleanup;
        }
      }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(cleaned).toBe(true);
    expect(probe.steps.cleanup).toBe(true);
  });

  it("does not accept a turn that skipped the form", async () => {
    const probe = await runPortalAgentProbe(
      "claude-code",
      fakeEnvironment({ observe: async () => ({ ...goodObservation, visibleResult: "Olá, " }) }),
      options
    );
    expect(probe.status).toBe("failed");
    expect(probe.steps.submit).toBe(false);
  });
});

describe("portal agent report parsing", () => {
  it("finds the last JSON object that carries the expected keys", () => {
    const output = [
      '{"unrelated":true}',
      "texto",
      '```json\n{"portalId":"p1","counter":1,"screenshotCreated":true}\n```',
      "fim"
    ].join("\n");
    expect(extractPortalAgentReport(output)).toEqual({
      portalId: "p1",
      counter: 1,
      screenshotCreated: true
    });
  });

  it("survives nested objects, strings with braces and escapes", () => {
    const output = '{"portalId":"p1","visibleResult":"Olá, {teste} \\" fim","counter":2}';
    expect(extractPortalAgentReport(output)).toMatchObject({
      portalId: "p1",
      counter: 2,
      visibleResult: 'Olá, {teste} " fim'
    });
  });

  it("returns null when there is no usable report", () => {
    expect(extractPortalAgentReport("nenhum json aqui")).toBeNull();
    expect(extractPortalAgentReport("{quebrado")).toBeNull();
    expect(extractPortalAgentReport('{"outra":"coisa"}')).toBeNull();
  });
});

describe("portal agent failure classification", () => {
  it("separates provider, authentication, portal, bridge, timeout and agent", () => {
    const base = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    expect(classifyPortalAgentFailure({ ...base, timedOut: true })?.category).toBe("timeout");
    expect(
      classifyPortalAgentFailure({ ...base, stderr: "Upstream request failed", exitCode: 1 })
        ?.category
    ).toBe("provider");
    expect(
      classifyPortalAgentFailure({ ...base, stderr: "Not logged in", exitCode: 1 })?.category
    ).toBe("authentication");
    expect(
      classifyPortalAgentFailure({ ...base, stdout: "PORTAL_TIMEOUT", exitCode: 1 })
    ).toMatchObject({ category: "portal", code: "PORTAL_TIMEOUT" });
    expect(
      classifyPortalAgentFailure({ ...base, stdout: "BRIDGE_NOT_ENABLED", exitCode: 1 })?.category
    ).toBe("bridge");
    expect(classifyPortalAgentFailure({ ...base, exitCode: 7 })).toMatchObject({
      category: "agent",
      code: "EXIT_7"
    });
    expect(classifyPortalAgentFailure(base)).toBeNull();
  });

  it("does not call a refused Portal a Portal defect", () => {
    expect(
      classifyPortalAgentFailure({
        stdout: "PORTAL_NOT_CONNECTED",
        stderr: "",
        exitCode: 0,
        timedOut: false
      })
    ).toBeNull();
  });
});

describe("portal agent harness plumbing", () => {
  it("builds a deterministic prompt that names the Portal and the fixture", () => {
    const prompt = buildPortalAgentPrompt(options);
    expect(prompt).toContain("compazio portal");
    expect(prompt).toContain(options.portalId);
    expect(prompt).toContain(options.fixtureUrl);
    expect(prompt).toContain(expectedName);
    expect(prompt).toContain("Incrementar");
    expect(prompt).not.toContain("navegador externo\n\n");
  });

  it("issues the same commands the production adapters issue", () => {
    const claude = buildPortalAgentCommand("claude-code", {
      executable: "claude",
      workingDirectory: "C:/tmp/w"
    });
    expect(claude.args).toContain("--print");
    expect(claude.args).toContain("Bash(compazio portal *)");
    expect(claude.promptOnStdin).toBe(false);
    const codex = buildPortalAgentCommand("codex", {
      executable: "codex",
      workingDirectory: "C:/tmp/w"
    });
    expect(codex.args.slice(0, 4)).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox"
    ]);
    expect(codex.args).toContain("C:/tmp/w");
    const opencode = buildPortalAgentCommand("opencode", {
      executable: "opencode",
      workingDirectory: "C:/tmp/w",
      model: "anthropic/claude-sonnet-4"
    });
    expect(opencode.args).toEqual(["run", "--model", "anthropic/claude-sonnet-4"]);
    expect(opencode.promptOnStdin).toBe(false);
  });

  it("asks Codex for its login status and validates an OpenCode model", () => {
    expect(buildPortalAgentAuthCommand("codex")?.args).toEqual(["login", "status"]);
    expect(buildPortalAgentAuthCommand("claude-code")).toBeNull();
    expect(isValidOpenCodeModel("anthropic/claude-sonnet-4")).toBe(true);
    expect(isValidOpenCodeModel("modelo-sem-provedor")).toBe(false);
  });

  it("answers with an exit code that separates a defect from an external block", () => {
    const probe = (status: RealPortalAgentProbe["status"]): RealPortalAgentProbe => ({
      agentId: "claude-code",
      status,
      startedAt: new Date().toISOString(),
      steps: {
        listPortal: false,
        navigate: false,
        click: false,
        type: false,
        submit: false,
        readResult: false,
        screenshot: false,
        console: false,
        revokedAfterDisconnect: false,
        cleanup: false
      }
    });
    expect(portalAgentExitCode([])).toBe(4);
    expect(portalAgentExitCode([probe("passed")])).toBe(0);
    expect(portalAgentExitCode([probe("passed"), probe("failed")])).toBe(1);
    expect(portalAgentExitCode([probe("passed"), probe("blocked-external")])).toBe(2);
    expect(portalAgentExitCode([probe("not-installed"), probe("not-authenticated")])).toBe(3);
  });

  it("keeps the saved report free of agent output", () => {
    const sanitized = sanitizePortalAgentProbe({
      agentId: "codex",
      status: "failed",
      startedAt: new Date().toISOString(),
      steps: {
        listPortal: true,
        navigate: true,
        click: true,
        type: true,
        submit: true,
        readResult: true,
        screenshot: true,
        console: true,
        revokedAfterDisconnect: false,
        cleanup: true
      },
      failure: { category: "portal", code: "X", message: `${"a".repeat(500)}\n\nsegredo` }
    });
    expect(sanitized.failure?.message.length).toBe(240);
    expect(sanitized.failure?.message).not.toContain("\n");
  });
});
