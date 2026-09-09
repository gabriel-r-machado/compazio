#!/usr/bin/env node

import {
  resolveCompassoDatabase,
  SqliteAgentLifecycleStore,
  SqliteAgentMessageStore,
  SqliteAgentSpawnStore,
  SqliteExecutionContextStore,
  SqliteWorkspaceArtifactStore,
  SqliteWorkspaceArtifactFeedbackStore,
  SqliteWorkspaceContractStore,
  SqliteWorkspaceContextStore,
  SqliteWorkspaceConnectionStore,
  SqliteWorkspaceGovernanceStore,
  SqliteWorkspaceHistoryStore,
  SqliteWorkspaceHandoffStore,
  SqliteWorkspaceImpactStore,
  SqliteWorkspaceNoteStore,
  SqliteOrchestrationProposalStore,
  SqliteRuntimeLifecycleStore,
  SqliteSupervisedAutonomyStore,
  SqliteWorkflowRunCommandStore,
  SqliteWorkflowRunStore,
  type CompassoRuntimeEndpointCredentials
} from "@forgedeck/local-db";

import { runCompassoCli } from "./cli";

const { database, args } = databaseOption(process.argv.slice(2));
if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
  process.exitCode = runCompassoCli(args, {
    cwd: process.cwd(),
    store: {
      listWorkspaces: () => [],
      listAgents: () => [],
      enqueue: () => {
        throw new Error("Help does not enqueue messages");
      },
      enqueueBatch: () => {
        throw new Error("Help does not enqueue message batches");
      },
      listMessages: () => [],
      getMessage: () => null,
      listInbox: () => [],
      cancelMessage: () => {
        throw new Error("Help does not cancel messages");
      },
      retryMessage: () => {
        throw new Error("Help does not retry messages");
      },
      recordResponse: () => {
        throw new Error("Help does not record responses");
      },
      listResponses: () => [],
      getAgentProfile: () => {
        throw new Error("Help does not load agent profiles");
      },
      getMission: () => null,
      setMission: () => {
        throw new Error("Help does not set missions");
      },
      getWorkspaceMemory: () => null,
      setWorkspaceMemory: () => {
        throw new Error("Help does not set workspace memory");
      },
      createSpawn: () => {
        throw new Error("Help does not create agent spawns");
      },
      getSpawn: () => {
        throw new Error("Help does not load agent spawns");
      },
      retrySpawn: () => {
        throw new Error("Help does not retry agent spawns");
      },
      createLifecycleCommand: () => {
        throw new Error("Help does not manage agent terminals");
      },
      listLifecycleCommands: () => [],
      publishArtifact: () => {
        throw new Error("Help does not publish artifacts");
      },
      resolveArtifact: () => {
        throw new Error("Help does not resolve artifacts");
      },
      listArtifacts: () => [],
      createArtifactFeedback: () => {
        throw new Error("Help does not create artifact feedback");
      },
      listArtifactFeedback: () => [],
      getArtifactMemory: () => {
        throw new Error("Help does not load artifact memory");
      },
      setArtifactMemory: () => {
        throw new Error("Help does not set artifact memory");
      },
      listArtifactMemories: () => [],
      compareArtifactMemories: () => {
        throw new Error("Help does not compare artifact memory");
      },
      restoreArtifactMemory: () => {
        throw new Error("Help does not restore artifact memory");
      },
      getArtifactImpact: () => {
        throw new Error("Help does not inspect artifact impact");
      },
      createDeliveryContract: () => {
        throw new Error("Help does not create delivery contracts");
      },
      getDeliveryContract: () => {
        throw new Error("Help does not load delivery contracts");
      },
      listDeliveryContracts: () => [],
      verifyDeliveryContract: () => {
        throw new Error("Help does not verify delivery contracts");
      },
      buildExecutionContext: () => {
        throw new Error("Help does not build execution context");
      },
      checkpointExecutionContext: () => {
        throw new Error("Help does not create checkpoints");
      },
      getExecutionCheckpoint: () => {
        throw new Error("Help does not load checkpoints");
      },
      listExecutionCheckpoints: () => [],
      createHandoff: () => {
        throw new Error("Help does not create handoffs");
      },
      getHandoff: () => {
        throw new Error("Help does not load handoffs");
      },
      listHandoffs: () => [],
      listHandoffEvents: () => [],
      approveHandoff: () => {
        throw new Error("Help does not approve handoffs");
      },
      rejectHandoff: () => {
        throw new Error("Help does not reject handoffs");
      },
      cancelHandoff: () => {
        throw new Error("Help does not cancel handoffs");
      },
      retryHandoff: () => {
        throw new Error("Help does not retry handoffs");
      },
      resolveContext: () => {
        throw new Error("Help does not resolve workspace context");
      },
      createConnection: () => {
        throw new Error("Help does not create canvas connections");
      },
      listConnections: () => [],
      showConnection: () => {
        throw new Error("Help does not load canvas connections");
      },
      removeConnection: () => {
        throw new Error("Help does not remove canvas connections");
      },
      resolveConnectionNode: () => {
        throw new Error("Help does not resolve canvas entities");
      },
      createNote: () => {
        throw new Error("Help does not create notes");
      },
      writeNote: () => {
        throw new Error("Help does not write notes");
      },
      readNoteContent: () => "",
      appendNote: () => {
        throw new Error("Help does not append notes");
      },
      resolveNote: () => {
        throw new Error("Help does not resolve notes");
      },
      listNotes: () => [],
      listHistory: () => [],
      getWorkflowRun: () => null,
      listWorkflowRuns: () => [],
      listWorkflowRunAlternatives: () => [],
      listWorkflowRunEvents: () => [],
      createOrchestrationProposal: () => {
        throw new Error("Help does not create orchestration proposals");
      },
      getOrchestrationProposal: () => {
        throw new Error("Help does not load orchestration proposals");
      },
      listOrchestrationProposals: () => [],
      listOrchestrationProposalEvents: () => [],
      updateOrchestrationProposal: () => {
        throw new Error("Help does not revise orchestration proposals");
      },
      approveOrchestrationProposal: () => {
        throw new Error("Help does not approve orchestration proposals");
      },
      rejectOrchestrationProposal: () => {
        throw new Error("Help does not reject orchestration proposals");
      },
      requestWorkflowRunStart: () => {
        throw new Error("Help does not start workflow runs");
      },
      requestWorkflowRunControl: () => {
        throw new Error("Help does not control workflow runs");
      },
      getRuntimeLifecycleStatus: () => ({
        state: "stopped",
        revision: 0,
        updatedBy: "system",
        updatedAt: new Date(0).toISOString()
      }),
      requestRuntimeLifecycle: () => {
        throw new Error("Help does not control the runtime");
      },
      isAutonomyKillSwitchEngaged: () => false,
      engageAutonomyKillSwitch: () => {
        throw new Error("Help does not control supervised autonomy");
      },
      releaseAutonomyKillSwitch: () => {
        throw new Error("Help does not control supervised autonomy");
      },
      listAutonomyDecisions: () => []
    },
    write: (line) => process.stdout.write(`${line}\n`)
  });
} else {
  const discovered = resolveCompassoDatabase({
    cwd: process.cwd(),
    databaseOverride: database
  });

  if (discovered === null) {
    process.stderr.write(
      "Compasso runtime was not found for this project. Open it in ForgeDeck or pass --database.\n"
    );
    process.exitCode = 1;
  } else {
    if (
      discovered.endpoint !== undefined &&
      !(await verifyLocalRuntimeEndpoint(discovered.endpoint))
    ) {
      process.stderr.write(
        "Compasso runtime authentication was rejected. Open the project in ForgeDeck again.\n"
      );
      process.exitCode = 1;
    } else {
      process.exitCode = runAgainstDatabase(discovered.databasePath, args);
    }
  }
}

function runAgainstDatabase(databasePath: string, args: readonly string[]): number {
  const messageStore = new SqliteAgentMessageStore(databasePath);
  const spawnStore = new SqliteAgentSpawnStore(databasePath);
  const lifecycleStore = new SqliteAgentLifecycleStore(databasePath);
  const artifactStore = new SqliteWorkspaceArtifactStore(databasePath);
  const artifactFeedbackStore = new SqliteWorkspaceArtifactFeedbackStore(databasePath);
  const contractStore = new SqliteWorkspaceContractStore(databasePath);
  const impactStore = new SqliteWorkspaceImpactStore(databasePath);
  const executionContextStore = new SqliteExecutionContextStore(databasePath);
  const contextStore = new SqliteWorkspaceContextStore(databasePath);
  const connectionStore = new SqliteWorkspaceConnectionStore(databasePath);
  const handoffStore = new SqliteWorkspaceHandoffStore(databasePath);
  const noteStore = new SqliteWorkspaceNoteStore(databasePath, { notesOnDisk: true });
  const historyStore = new SqliteWorkspaceHistoryStore(databasePath);
  const governanceStore = new SqliteWorkspaceGovernanceStore(databasePath);
  const runtimeLifecycleStore = new SqliteRuntimeLifecycleStore(databasePath);
  const workflowRunStore = new SqliteWorkflowRunStore(databasePath);
  const workflowRunCommandStore = new SqliteWorkflowRunCommandStore(databasePath);
  const orchestrationProposalStore = new SqliteOrchestrationProposalStore(databasePath);
  const supervisedAutonomyStore = new SqliteSupervisedAutonomyStore(databasePath);
  try {
    return runCompassoCli(args, {
      cwd: process.cwd(),
      env: process.env,
      store: {
        listWorkspaces: () => messageStore.listWorkspaces(),
        listAgents: (workspaceId) => messageStore.listAgents(workspaceId),
        enqueue: (input) => messageStore.enqueue(input),
        enqueueBatch: (inputs) => messageStore.enqueueBatch(inputs),
        listMessages: (workspaceId, limit) => messageStore.listMessages(workspaceId, limit),
        getMessage: (messageId) => messageStore.get(messageId),
        listInbox: (workspaceId, agentNodeId, limit) =>
          messageStore.listInbox(workspaceId, agentNodeId, limit),
        cancelMessage: (messageId) => messageStore.cancel(messageId),
        retryMessage: (messageId) => messageStore.retry(messageId),
        recordResponse: (input) => messageStore.recordResponse(input),
        listResponses: (workspaceId, requestMessageId, limit) =>
          messageStore.listResponses(workspaceId, requestMessageId, limit),
        getAgentProfile: (workspaceId, nodeId) =>
          governanceStore.getAgentProfile(workspaceId, nodeId),
        getMission: (workspaceId) => governanceStore.getMission(workspaceId),
        setMission: (input) => governanceStore.setMission(input),
        getWorkspaceMemory: (workspaceId) => governanceStore.getWorkspaceMemory(workspaceId),
        setWorkspaceMemory: (input) => governanceStore.setWorkspaceMemory(input),
        createSpawn: (input) => spawnStore.create(input),
        getSpawn: (spawnId) => spawnStore.get(spawnId),
        retrySpawn: (spawnId, requestedByNodeId) => spawnStore.retry(spawnId, requestedByNodeId),
        createLifecycleCommand: (input) => lifecycleStore.create(input),
        listLifecycleCommands: (workspaceId, limit) => lifecycleStore.list(workspaceId, limit),
        publishArtifact: (input) => artifactStore.publish(input),
        resolveArtifact: (workspaceId, reference) => artifactStore.resolve(workspaceId, reference),
        listArtifacts: (workspaceId, limit) => artifactStore.list(workspaceId, limit),
        createArtifactFeedback: (input) => artifactFeedbackStore.create(input),
        listArtifactFeedback: (workspaceId, artifactId, artifactVersion, limit) =>
          artifactFeedbackStore.list(workspaceId, artifactId, artifactVersion, limit),
        getArtifactMemory: (workspaceId, artifactId) =>
          contractStore.getArtifactMemory(workspaceId, artifactId),
        setArtifactMemory: (input) => contractStore.setArtifactMemory(input),
        listArtifactMemories: (workspaceId, artifactId, limit) =>
          contractStore.listArtifactMemories(workspaceId, artifactId, limit),
        compareArtifactMemories: (input) => contractStore.compareArtifactMemories(input),
        restoreArtifactMemory: (input) => contractStore.restoreArtifactMemory(input),
        getArtifactImpact: (workspaceId, artifactId) =>
          impactStore.getArtifactImpact(workspaceId, artifactId),
        createDeliveryContract: (input) => contractStore.createDeliveryContract(input),
        getDeliveryContract: (workspaceId, contractId) =>
          contractStore.getDeliveryContract(workspaceId, contractId),
        listDeliveryContracts: (workspaceId, limit) =>
          contractStore.listDeliveryContracts(workspaceId, limit),
        verifyDeliveryContract: (input) => contractStore.verifyDeliveryContract(input),
        buildExecutionContext: (input) => executionContextStore.build(input),
        checkpointExecutionContext: (input) => executionContextStore.checkpoint(input),
        getExecutionCheckpoint: (workspaceId, checkpointId) =>
          executionContextStore.getCheckpoint(workspaceId, checkpointId),
        listExecutionCheckpoints: (workspaceId, agentNodeId, limit) =>
          executionContextStore.listCheckpoints(workspaceId, agentNodeId, limit),
        createHandoff: (input) => handoffStore.create(input),
        getHandoff: (workspaceId, handoffId) => handoffStore.get(workspaceId, handoffId),
        listHandoffs: (workspaceId, limit) => handoffStore.list(workspaceId, limit),
        listHandoffEvents: (workspaceId, handoffId) =>
          handoffStore.listEvents(workspaceId, handoffId),
        approveHandoff: (input) => handoffStore.approve(input),
        rejectHandoff: (input) => handoffStore.reject(input),
        cancelHandoff: (input) => handoffStore.cancel(input),
        retryHandoff: (input) => handoffStore.retry(input),
        resolveContext: (input) => contextStore.resolve(input),
        createConnection: (input) => connectionStore.create(input),
        listConnections: (workspaceId, limit) => connectionStore.list(workspaceId, limit),
        showConnection: (workspaceId, connectionId) =>
          connectionStore.show(workspaceId, connectionId),
        removeConnection: (input) => connectionStore.remove(input),
        resolveConnectionNode: (workspaceId, reference) =>
          connectionStore.resolveNode(workspaceId, reference),
        createNote: (input) => noteStore.create(input),
        writeNote: (input) => noteStore.write(input),
        readNoteContent: (note) => noteStore.readContent(note),
        appendNote: (input) => noteStore.append(input),
        resolveNote: (workspaceId, reference) => noteStore.resolve(workspaceId, reference),
        listNotes: (workspaceId, limit) => noteStore.list(workspaceId, limit),
        listHistory: (input) => historyStore.list(input),
        getWorkflowRun: (runId) => workflowRunStore.get(runId),
        listWorkflowRuns: (input) => workflowRunStore.list(input),
        listWorkflowRunAlternatives: (sourceRunId, nodeId) =>
          workflowRunStore.listAlternatives(sourceRunId, nodeId),
        listWorkflowRunEvents: (runId, limit) => workflowRunStore.listEvents(runId, limit),
        createOrchestrationProposal: (input) => orchestrationProposalStore.create(input),
        getOrchestrationProposal: (workspaceId, proposalId) =>
          orchestrationProposalStore.get(workspaceId, proposalId),
        listOrchestrationProposals: (workspaceId, limit) =>
          orchestrationProposalStore.list(workspaceId, limit),
        listOrchestrationProposalEvents: (workspaceId, proposalId) =>
          orchestrationProposalStore.listEvents(workspaceId, proposalId),
        updateOrchestrationProposal: (input) => orchestrationProposalStore.updateDraft(input),
        approveOrchestrationProposal: (input) => orchestrationProposalStore.approve(input),
        rejectOrchestrationProposal: (input) => orchestrationProposalStore.reject(input),
        requestWorkflowRunStart: (input) => workflowRunCommandStore.requestStart(input),
        requestWorkflowRunControl: (input) => workflowRunCommandStore.requestControl(input),
        getRuntimeLifecycleStatus: () => runtimeLifecycleStore.getStatus(),
        requestRuntimeLifecycle: (action) => runtimeLifecycleStore.request(action),
        isAutonomyKillSwitchEngaged: (workspaceId) =>
          supervisedAutonomyStore.isKillSwitchEngaged(workspaceId),
        engageAutonomyKillSwitch: (workspaceId, engagedBy) =>
          supervisedAutonomyStore.engageKillSwitch(workspaceId, engagedBy),
        releaseAutonomyKillSwitch: (workspaceId) =>
          supervisedAutonomyStore.releaseKillSwitch(workspaceId),
        listAutonomyDecisions: (workspaceId, limit) =>
          supervisedAutonomyStore.listDecisions(workspaceId, limit)
      },
      write: (line) => process.stdout.write(`${line}\n`)
    });
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : "Compasso CLI failed"}\n`);
    return 1;
  } finally {
    messageStore.close();
    spawnStore.close();
    lifecycleStore.close();
    artifactStore.close();
    artifactFeedbackStore.close();
    contractStore.close();
    impactStore.close();
    executionContextStore.close();
    contextStore.close();
    connectionStore.close();
    handoffStore.close();
    noteStore.close();
    historyStore.close();
    governanceStore.close();
    runtimeLifecycleStore.close();
    supervisedAutonomyStore.close();
    workflowRunStore.close();
    workflowRunCommandStore.close();
    orchestrationProposalStore.close();
  }
}

async function verifyLocalRuntimeEndpoint(
  endpoint: CompassoRuntimeEndpointCredentials
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${endpoint.url}/v1/health`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "x-compasso-identity": endpoint.identityId,
        "x-compasso-nonce": endpoint.nonce
      },
      signal: controller.signal
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function databaseOption(args: readonly string[]): {
  readonly database: string | null;
  readonly args: readonly string[];
} {
  const remaining: string[] = [];
  let database: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) break;
    if (value !== "--database") {
      remaining.push(value);
      continue;
    }
    const path = args[index + 1];
    if (path === undefined || path.startsWith("--")) {
      process.stderr.write("--database requires a path\n");
      process.exit(1);
    }
    database = path;
    index += 1;
  }
  return { database, args: remaining };
}
