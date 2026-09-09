import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexLocalSkillIsolationArgs,
  createPortalMcpLaunch,
  inspectPortalMcpTranscript
} from "./portal-mcp-agent-config";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

describe("temporary Portal MCP client configuration", () => {
  it("creates a Claude-only temporary Streamable HTTP configuration without embedding the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-mcp-client-"));
    roots.push(root);
    const launch = await createPortalMcpLaunch({
      agentId: "claude-code",
      directory: root,
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      tools: ["portal_list"],
      prompt: "list"
    });
    const path = launch.args[launch.args.indexOf("--mcp-config") + 1];
    expect(path).toBeDefined();
    const config = await readFile(path ?? "", "utf8");
    expect(config).toContain("${COMPAZIO_MCP_TOKEN}");
    expect(config).not.toContain("secret");
    expect(config).toContain('"streamable-http"');
    expect(launch.args).not.toContain("--tools");
    expect(launch.args).toContain("--no-session-persistence");
    expect(launch.args).toContain("--allowedTools");
    expect(launch.args).toContain("mcp__compazio__portal_list");
    expect(launch.args).not.toContain("--disallowedTools");
    expect(launch.args).not.toContain("--permission-mode");
    expect(launch.args.at(-2)).toBe("--");
    expect(launch.args.at(-1)).toBe("list");
    await launch.cleanup();
    await expect(readFile(path ?? "", "utf8")).rejects.toThrow();
  });

  it("uses a process-only Codex MCP override with no shell grants", async () => {
    const launch = await createPortalMcpLaunch({
      agentId: "codex",
      directory: tmpdir(),
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      tools: ["portal_list"],
      prompt: "list"
    });
    expect(launch.args.join(" ")).toContain("mcp_servers.compazio.url=");
    expect(launch.args.join(" ")).toContain('enabled_tools=["portal_list"]');
    expect(launch.args.join(" ")).toContain(
      'mcp_servers.compazio.default_tools_approval_mode="approve"'
    );
    expect(launch.args).not.toContain("--ignore-user-config");
    expect(launch.args).not.toContain("--sandbox");
    expect(launch.args).not.toContain("--ask-for-approval");
  });

  it("disables user and workspace local skills only for the launched Codex process", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-codex-skills-"));
    roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "repo", "nested");
    const userSkill = join(home, ".agents", "skills", "user-control", "SKILL.md");
    const repoSkill = join(root, "repo", ".agents", "skills", "repo-control", "SKILL.md");
    await mkdir(join(userSkill, ".."), { recursive: true });
    await mkdir(join(repoSkill, ".."), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(userSkill, "---\nname: user-control\n---\n", "utf8");
    await writeFile(repoSkill, "---\nname: repo-control\n---\n", "utf8");

    const args = await buildCodexLocalSkillIsolationArgs({
      workingDirectory: workspace,
      aliasDirectory: join(root, "aliases"),
      homeDirectory: home
    });

    expect(args[0]).toBe("-c");
    expect(args[1]).not.toContain(userSkill.replaceAll("\\", "/"));
    expect(args[1]).not.toContain(repoSkill.replaceAll("\\", "/"));
    expect(args[1]).toContain("skill-001/SKILL.md");
    expect(args[1]).toContain("skill-002/SKILL.md");
    expect(args[1]).toContain("enabled=false");
  });

  it("creates an OpenCode-only temporary remote MCP configuration without embedding the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-mcp-client-"));
    roots.push(root);
    const launch = await createPortalMcpLaunch({
      agentId: "opencode",
      directory: root,
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      tools: ["portal_list"],
      prompt: "list"
    });
    const configPath = launch.environment.OPENCODE_CONFIG;
    expect(configPath).toBeDefined();
    const config = await readFile(configPath ?? "", "utf8");
    expect(config).toContain("{env:COMPAZIO_MCP_TOKEN}");
    expect(JSON.parse(config)).toMatchObject({ mcp: { compazio: { codemode: false } } });
    expect(config).not.toContain("secret");
    expect(launch.args).toEqual(["run", "--format", "json", "list"]);
    await launch.cleanup();
    await expect(readFile(configPath ?? "", "utf8")).rejects.toThrow();
  });

  it("creates an interactive Claude launch with only the connection-granted Portal tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-mcp-client-"));
    roots.push(root);
    const launch = await createPortalMcpLaunch({
      agentId: "claude-code",
      directory: root,
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      interactive: true,
      tools: ["portal_list", "portal_dom"]
    });
    expect(launch.args).not.toContain("--print");
    expect(launch.args).not.toContain("--no-session-persistence");
    expect(launch.args).toContain("--disable-slash-commands");
    expect(launch.args.join(" ")).not.toContain("secret");
    expect(launch.args).toContain("--allowedTools");
    expect(launch.args).toContain("mcp__compazio__portal_list,mcp__compazio__portal_dom");
    expect(launch.args).not.toContain("--disallowedTools");
    expect(launch.environment).toEqual({ COMPAZIO_MCP_TOKEN: "secret" });
    await launch.cleanup();
  });

  it("loads the Compazio protocol as additive Claude system context", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-orchestrator-client-"));
    roots.push(root);
    const instructionsPath = join(root, "ORCHESTRATOR_PROTOCOL.md");
    const launch = await createPortalMcpLaunch({
      agentId: "claude-code",
      directory: root,
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      interactive: true,
      tools: ["portal_list"],
      orchestratorInstructionsPath: instructionsPath
    });

    expect(launch.args).toContain("--append-system-prompt-file");
    expect(launch.args).toContain("--disable-slash-commands");
    expect(launch.args).toContain(instructionsPath);
    expect(launch.args).toContain("--allowedTools");
    expect(launch.args).toContain("mcp__compazio__portal_list");
    expect(launch.args).not.toContain("--disallowedTools");
    expect(launch.args).not.toContain("--permission-mode");
    await launch.cleanup();
  });

  it("injects the Compazio protocol into Codex developer instructions", async () => {
    const launch = await createPortalMcpLaunch({
      agentId: "codex",
      directory: tmpdir(),
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      interactive: true,
      tools: ["portal_list"],
      orchestratorInstructions: "COMPAZIO_CONTROL_PLANE_ONLY"
    });

    expect(launch.args.join(" ")).toContain("developer_instructions=");
    expect(launch.args.join(" ")).toContain("COMPAZIO_CONTROL_PLANE_ONLY");
  });

  it("loads the Compazio protocol without replacing OpenCode permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-opencode-orchestrator-"));
    roots.push(root);
    const instructionsPath = join(root, "ORCHESTRATOR_PROTOCOL.md");
    const launch = await createPortalMcpLaunch({
      agentId: "opencode",
      directory: root,
      endpoint: "http://127.0.0.1:3210/mcp",
      token: "secret",
      interactive: true,
      tools: ["portal_list"],
      orchestratorInstructionsPath: instructionsPath
    });

    const config = JSON.parse(await readFile(launch.environment.OPENCODE_CONFIG ?? "", "utf8"));
    expect(config.instructions).toEqual([instructionsPath]);
    expect(config).not.toHaveProperty("permission");
    await launch.cleanup();
  });

  it("requires a tool event and flags forbidden tool events", () => {
    expect(
      inspectPortalMcpTranscript(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__compazio__portal_list"}]},"protocolVersion":"2025-11-25"}'
      )
    ).toMatchObject({
      discovered: true,
      calledPortalList: true,
      usedForbiddenTool: false,
      protocolVersion: "2025-11-25"
    });
    expect(inspectPortalMcpTranscript('{"type":"tool_use","name":"Bash"}')).toMatchObject({
      usedForbiddenTool: true
    });
    expect(inspectPortalMcpTranscript("I listed the portal.")).toMatchObject({
      calledPortalList: false
    });
    expect(
      inspectPortalMcpTranscript(
        '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"compazio","tool":"portal_list","status":"completed"}}'
      )
    ).toMatchObject({ discovered: true, calledPortalList: true, usedForbiddenTool: false });
    expect(
      inspectPortalMcpTranscript('{"type":"command_execution","command":"dir"}')
    ).toMatchObject({ usedForbiddenTool: true });
    expect(inspectPortalMcpTranscript('{"type":"tool","name":"shell"}')).toMatchObject({
      usedForbiddenTool: true
    });
    expect(inspectPortalMcpTranscript('{"type":"tool_use","name":"ToolSearch"}')).toMatchObject({
      usedForbiddenTool: false
    });
  });

  it("recognizes the structured denial from either client without trusting malformed output", () => {
    expect(
      inspectPortalMcpTranscript(
        '{"type":"tool_result","content":{"structuredContent":{"error":{"code":"PORTAL_NOT_CONNECTED"}}}}'
      )
    ).toMatchObject({ receivedPortalNotConnected: true, calledPortalList: false });
    expect(
      inspectPortalMcpTranscript(
        '{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"portal_list","status":"failed","error":{"code":"PORTAL_NOT_CONNECTED"}}}'
      )
    ).toMatchObject({ receivedPortalNotConnected: true, calledPortalList: true });
    expect(inspectPortalMcpTranscript("{invalid json")).toMatchObject({
      discovered: false,
      calledPortalList: false,
      receivedPortalNotConnected: false
    });
  });
});
