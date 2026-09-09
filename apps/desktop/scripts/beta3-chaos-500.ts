import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import {
  PipeProcessFactory,
  PlatformProcessTreeKiller,
  TransportProcessFactory
} from "@forgedeck/terminal";

import { createIsolatedTestRun } from "../src/v2/main/testing/isolated-entitlement";
import { V2WorkspaceService } from "../src/v2/main/workspace-service";

const seed = 0xc0a2_500;
const operationCount = 500;
const artifactDirectory = join(process.cwd(), "artifacts", "beta3-release-gate");

class Random {
  private state: number;
  public constructor(seedValue: number) {
    this.state = seedValue >>> 0;
  }
  public next(): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }
  public index(length: number): number {
    if (length < 1) throw new Error("chaos attempted to select from an empty collection");
    return this.next() % length;
  }
  public between(minimum: number, maximum: number): number {
    return minimum + (this.next() % (maximum - minimum + 1));
  }
}

const random = new Random(seed);
let idCounter = 0;
let timeCounter = 0;
const now = () => new Date(Date.UTC(2026, 7, 7, 0, 0, timeCounter++)).toISOString();

function serviceFor(root: string, repository = new V2WorkspaceRepository({ rootDirectory: root })) {
  const supervisor = new V2ProcessSupervisor(
    new TransportProcessFactory({ pty: new PipeProcessFactory(), pipe: new PipeProcessFactory() }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
  );
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "role-sessions"))
  });
  return {
    repository,
    supervisor,
    service: new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement: { assertCanCreateWorkspace: async () => undefined },
      createId: () => `chaos-${++idCounter}`,
      now
    })
  };
}

function assertInvariant(workspace: Awaited<ReturnType<V2WorkspaceService["snapshot"]>>): void {
  const ids = new Set(workspace.nodes.map((node) => node.id));
  if (ids.size !== workspace.nodes.length) throw new Error("invariant: duplicate node id");
  for (const node of workspace.nodes) {
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))
      throw new Error(`invariant: invalid position for ${node.id}`);
    if (node.size.width < 80 || node.size.height < 60)
      throw new Error(`invariant: invalid size for ${node.id}`);
  }
  const edgeIds = new Set<string>();
  for (const edge of workspace.edges) {
    if (edgeIds.has(edge.id)) throw new Error("invariant: duplicate edge id");
    edgeIds.add(edge.id);
    if (
      !ids.has(edge.sourceNodeId) ||
      !ids.has(edge.targetNodeId) ||
      edge.sourceNodeId === edge.targetNodeId
    )
      throw new Error(`invariant: invalid edge ${edge.id}`);
  }
}

async function operation(
  service: V2WorkspaceService,
  workspaceId: string,
  index: number
): Promise<string> {
  const workspace = await service.snapshot(workspaceId);
  const nodes = workspace.nodes;
  const terminals = nodes.filter((node) => node.type === "terminal");
  const notes = nodes.filter((node) => node.type === "note");
  const portals = nodes.filter((node) => node.type === "portal");
  const kind = index % 10;
  switch (kind) {
    case 0:
      if (index % 2 === 0)
        await service.addNote(workspaceId, {
          title: `Note ${index}`,
          content: `- [ ] step ${index}`
        });
      else
        await service.addPortal(workspaceId, {
          title: `Portal ${index}`,
          url: `http://127.0.0.1:${4100 + (index % 50)}/`
        });
      return "create";
    case 1: {
      const node = nodes[random.index(nodes.length)];
      if (node === undefined) throw new Error("move node missing");
      await service.moveNode(workspaceId, node.id, {
        x: random.between(-3000, 3000),
        y: random.between(-3000, 3000)
      });
      return "move";
    }
    case 2: {
      const node = nodes[random.index(nodes.length)];
      if (node === undefined) throw new Error("resize node missing");
      await service.resizeNode(workspaceId, node.id, {
        width: random.between(220, 720),
        height: random.between(140, 520)
      });
      return "resize";
    }
    case 3: {
      const pairs = nodes.flatMap((source) =>
        nodes
          .filter(
            (target) =>
              target.id !== source.id &&
              !workspace.edges.some(
                (edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id
              )
          )
          .map((target) => ({ source, target }))
      );
      const pair = pairs[random.index(pairs.length)];
      if (pair === undefined) throw new Error("connection pair missing");
      await service.addEdge(workspaceId, pair.source.id, pair.target.id, ["share-context"]);
      return "connect";
    }
    case 4: {
      if (workspace.edges.length === 0) return operation(service, workspaceId, 3);
      const edge = workspace.edges[random.index(workspace.edges.length)];
      if (edge === undefined) throw new Error("edge missing");
      await service.removeEdge(workspaceId, edge.id);
      return "disconnect";
    }
    case 5: {
      if (notes.length === 0) {
        await service.addNote(workspaceId, { title: `Note ${index}`, content: "- [ ] created" });
        return "note-edit";
      }
      const note = notes[random.index(notes.length)];
      if (note === undefined) throw new Error("note missing");
      await service.updateNode(workspaceId, note.id, {
        content: `${note.content}\n- [ ] edit ${index}`.slice(-12_000)
      });
      return "note-edit";
    }
    case 6: {
      const terminal = terminals[random.index(terminals.length)];
      if (terminal === undefined) throw new Error("terminal missing");
      const active = service.sessionForNode(workspaceId, terminal.id);
      if (active === null || ["stopped", "completed", "failed"].includes(active.state)) {
        await service.startTerminal(workspaceId, terminal.id);
        return "terminal-start";
      }
      await service.stopTerminal(workspaceId, terminal.id, active.id);
      return "terminal-stop";
    }
    case 7: {
      if (portals.length === 0 || index % 2 === 0) {
        await service.addPortal(workspaceId, {
          title: `Portal ${index}`,
          url: `http://127.0.0.1:${4200 + (index % 50)}/`
        });
      } else {
        const portal = portals[random.index(portals.length)];
        if (portal === undefined) throw new Error("portal missing");
        await service.updatePortal(workspaceId, portal.id, {
          url: `http://127.0.0.1:${4300 + (index % 50)}/`
        });
      }
      return "portal";
    }
    case 8:
      await service.undo(workspaceId);
      return "undo";
    case 9:
      await service.redo(workspaceId);
      return "redo";
    default:
      throw new Error("unreachable chaos operation");
  }
}

const run = await createIsolatedTestRun({ label: "beta3-chaos-500" });
const counts = new Map<string, number>();
try {
  const first = serviceFor(run.stateDirectory);
  const service = first.service;
  const workspace = await service.create({ name: "Beta 3 Chaos", workingDirectory: run.root });
  const workspaceId = workspace.id;
  for (const title of ["Terminal A", "Terminal B"]) {
    await service.addTerminal(workspaceId, {
      title,
      agentConfig: { agentId: "custom" },
      launchConfig: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: {},
        processMode: "pipe"
      }
    });
  }
  await service.addNote(workspaceId, { title: "Shared plan", content: "- [ ] initial" });
  await service.addPortal(workspaceId, { title: "Initial Portal", url: "http://127.0.0.1:4100/" });
  const initial = await service.snapshot(workspaceId);
  for (const source of initial.nodes.slice(0, 3)) {
    const target = initial.nodes.find((node) => node.id !== source.id);
    if (target !== undefined)
      await service.addEdge(workspaceId, source.id, target.id, ["share-context"]);
  }

  for (let index = 0; index < operationCount; index += 1) {
    const name = await operation(service, workspaceId, index);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    assertInvariant(await service.snapshot(workspaceId));
  }
  const beforeClose = await service.snapshot(workspaceId);
  await service.close(workspaceId);
  await service.shutdown();

  const reopened = serviceFor(run.stateDirectory);
  try {
    const restored = await reopened.service.open(workspaceId);
    assertInvariant(restored);
    if (
      restored.nodes.length !== beforeClose.nodes.length ||
      restored.edges.length !== beforeClose.edges.length
    )
      throw new Error("persistence invariant: reopen changed the saved canvas graph");
    if (reopened.supervisor.list().length !== 0)
      throw new Error("cleanup invariant: reopened supervisor has sessions");
  } finally {
    await reopened.service.shutdown();
  }
} finally {
  await run.cleanup();
}

await mkdir(artifactDirectory, { recursive: true });
const report = {
  gate: "Beta.3 Chaos 500",
  seed: `0x${seed.toString(16)}`,
  operations: operationCount,
  operationCounts: Object.fromEntries([...counts.entries()].sort()),
  persistence: "save -> close -> reopen -> invariants passed",
  temporaryUserData: true,
  realUserDataTouched: false,
  temporaryRootRemoved: true
};
await writeFile(join(artifactDirectory, "chaos-500-latest.json"), JSON.stringify(report, null, 2));
console.info(`Beta.3 Chaos 500 PASS seed=${report.seed}`);
console.info(`Operations: ${operationCount}`);
console.info(`Operation counts: ${JSON.stringify(report.operationCounts)}`);
console.info("Persistence: save -> close -> reopen -> invariants passed");
console.info("Real userData touched: NO");
