import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteCanvasHandoffRepository } from "./canvas-handoff-repository";
import { runLocalMigrations } from "./migrate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteCanvasHandoffRepository", () => {
  it("persists reviewed lifecycle and rejects a duplicate delivery transition", async () => {
    const fixture = await createFixture();
    const repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
    try {
      const draft = repository.createDraft(handoffInput(), at(0));
      expect(draft.status).toBe("draft");
      expect(draft.revision).toBe(1);

      const updated = repository.updateDraft(
        draft.id,
        draft.revision,
        { summary: "Implementation complete", evidence: [{ label: "Tests", detail: "passed" }] },
        at(1)
      );
      const ready = repository.markReady(updated.id, updated.revision, updated.content, at(2));
      expect(ready.status).toBe("ready");
      expect(ready.readyAt).toBe(at(2).toISOString());

      const submitting = repository.beginDelivery(
        ready.id,
        ready.revision,
        {
          targetSessionId: "session-1",
          adapterId: "codex"
        },
        at(3)
      );
      const deliveryAttemptId = submitting.deliveryAttempts[0]?.id;
      if (deliveryAttemptId === undefined) throw new Error("Delivery attempt was not persisted");
      expect(() =>
        repository.beginDelivery(
          submitting.id,
          ready.revision,
          {
            targetSessionId: "session-1",
            adapterId: "codex"
          },
          at(3)
        )
      ).toThrow("revision conflict");
      const written = repository.markWrittenToTerminal(
        submitting.id,
        submitting.revision,
        deliveryAttemptId,
        at(4)
      );
      const submitted = repository.markSubmittedToAgent(
        written.id,
        written.revision,
        deliveryAttemptId,
        at(5)
      );
      const delivered = repository.markDelivered(
        submitted.id,
        submitted.revision,
        deliveryAttemptId,
        at(6)
      );

      expect(delivered.status).toBe("delivered");
      expect(delivered.deliveredAt).toBe(at(6).toISOString());
      expect(delivered.deliveryAttempts).toEqual([
        expect.objectContaining({
          id: deliveryAttemptId,
          status: "response_detected",
          confirmation: "response_detected"
        })
      ]);
      expect(repository.listByCanvas("canvas-1")).toEqual([delivered]);
      expect(repository.listEvents(delivered.id).map((event) => event.type)).toEqual([
        "draft_created",
        "draft_updated",
        "handoff_ready",
        "delivery_attempt_started",
        "written_to_terminal",
        "submitted_to_agent",
        "response_detected"
      ]);
    } finally {
      repository.close();
      await fixture.close();
    }
  });

  it("recovers an interrupted delivery as unknown and requires an explicit retry", async () => {
    const fixture = await createFixture();
    const repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
    try {
      const draft = repository.createDraft(handoffInput(), at(0));
      const ready = repository.markReady(
        draft.id,
        draft.revision,
        { summary: "Ready for review" },
        at(1)
      );
      repository.beginDelivery(
        ready.id,
        ready.revision,
        {
          targetSessionId: "session-1",
          adapterId: "codex"
        },
        at(2)
      );

      expect(repository.recoverDeliveries(at(3))).toBe(1);
      const unknown = repository.get(draft.id);
      expect(unknown?.status).toBe("delivery_unknown");
      if (unknown === null) throw new Error("Recovered handoff is missing");

      const retry = repository.requestRetry(unknown.id, unknown.revision, at(4));
      expect(retry.status).toBe("ready");
      expect(repository.recoverDeliveries(at(5))).toBe(0);
      expect(repository.listEvents(retry.id).map((event) => event.type)).toEqual([
        "draft_created",
        "handoff_ready",
        "delivery_attempt_started",
        "delivery_unknown",
        "retry_requested"
      ]);
    } finally {
      repository.close();
      await fixture.close();
    }
  });

  it("records an explicit review rejection and returns only to draft on retry", async () => {
    const fixture = await createFixture();
    const repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
    try {
      const draft = repository.createDraft(handoffInput(), at(0));
      const rejected = repository.reject(draft.id, draft.revision, "Evidence is incomplete", at(1));
      expect(rejected).toMatchObject({ status: "rejected", error: "Evidence is incomplete" });

      const retried = repository.requestRetry(rejected.id, rejected.revision, at(2));
      expect(retried).toMatchObject({ status: "draft", error: null });
      expect(repository.listEvents(retried.id).map((event) => event.type)).toEqual([
        "draft_created",
        "handoff_rejected",
        "retry_requested"
      ]);
    } finally {
      repository.close();
      await fixture.close();
    }
  });

  it("preserves an approved package while waiting for an explicitly selected destination", async () => {
    const fixture = await createFixture();
    const repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
    try {
      const draft = repository.createDraft(handoffInput(), at(0));
      const ready = repository.markReady(
        draft.id,
        draft.revision,
        { summary: "Approved package" },
        at(1)
      );

      const awaiting = repository.markAwaitingDestination(
        ready.id,
        ready.revision,
        "Target terminal session is not active",
        at(2)
      );

      expect(awaiting).toMatchObject({
        status: "awaiting_destination",
        content: { summary: "Approved package" },
        deliveryAttempts: []
      });
      const retried = repository.requestRetry(awaiting.id, awaiting.revision, at(3));
      expect(retried.status).toBe("ready");
      expect(repository.listEvents(retried.id).map((event) => event.type)).toEqual([
        "draft_created",
        "handoff_ready",
        "destination_unavailable",
        "retry_requested"
      ]);
    } finally {
      repository.close();
      await fixture.close();
    }
  });

  it("keeps independent recovery attempts and persists a manual sent decision after reload", async () => {
    const fixture = await createFixture();
    let repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
    try {
      const draft = repository.createDraft(handoffInput(), at(0));
      const ready = repository.markReady(
        draft.id,
        draft.revision,
        { summary: "Ready for recovery" },
        at(1)
      );
      const firstSubmission = repository.beginDelivery(
        ready.id,
        ready.revision,
        { targetSessionId: "session-1", adapterId: "codex" },
        at(2)
      );
      const firstAttempt = firstSubmission.deliveryAttempts[0];
      if (firstAttempt === undefined) throw new Error("First attempt was not persisted");

      expect(repository.recoverDeliveries(at(3))).toBe(1);
      const unknown = repository.get(draft.id);
      if (unknown === null) throw new Error("Recovered handoff is missing");
      expect(unknown.status).toBe("delivery_unknown");
      expect(repository.get(draft.id)?.revision).toBe(unknown.revision);

      const retried = repository.requestRetry(unknown.id, unknown.revision, at(4));
      const secondSubmission = repository.beginDelivery(
        retried.id,
        retried.revision,
        { targetSessionId: "session-2", adapterId: "codex" },
        at(5)
      );
      const secondAttempt = secondSubmission.deliveryAttempts.at(-1);
      if (secondAttempt === undefined) throw new Error("Second attempt was not persisted");
      expect(secondAttempt.id).not.toBe(firstAttempt.id);
      expect(secondAttempt.sequence).toBe(2);

      expect(repository.recoverDeliveries(at(6))).toBe(1);
      const secondUnknown = repository.get(draft.id);
      if (secondUnknown === null) throw new Error("Second recovered handoff is missing");
      const manuallySent = repository.markSentManually(
        secondUnknown.id,
        secondUnknown.revision,
        secondAttempt.id,
        at(7)
      );
      expect(manuallySent).toMatchObject({
        status: "delivered",
        deliveryAttempts: [
          { id: firstAttempt.id, status: "delivery_unknown" },
          {
            id: secondAttempt.id,
            status: "manually_marked_sent",
            confirmation: "manual_marked_sent",
            responsible: "local_user"
          }
        ]
      });

      repository.close();
      repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
      expect(repository.get(draft.id)).toEqual(manuallySent);
      expect(repository.listEvents(draft.id).at(-1)).toMatchObject({
        type: "delivery_marked_sent",
        responsible: "local_user",
        deliveryAttemptId: secondAttempt.id
      });
    } finally {
      repository.close();
      await fixture.close();
    }
  });

  it("cancels an unknown delivery without deleting its reviewed package or event history", async () => {
    const fixture = await createFixture();
    const repository = new SqliteCanvasHandoffRepository(fixture.filename, sequentialIds());
    try {
      const draft = repository.createDraft(handoffInput(), at(0));
      const ready = repository.markReady(
        draft.id,
        draft.revision,
        { summary: "Keep this package" },
        at(1)
      );
      repository.beginDelivery(
        ready.id,
        ready.revision,
        { targetSessionId: "session-1", adapterId: "claude-code" },
        at(2)
      );
      repository.recoverDeliveries(at(3));
      const unknown = repository.get(draft.id);
      if (unknown === null) throw new Error("Recovered handoff is missing");

      const cancelled = repository.cancelDelivery(unknown.id, unknown.revision, at(4));

      expect(cancelled).toMatchObject({
        status: "cancelled",
        content: { summary: "Keep this package" },
        deliveryAttempts: [expect.objectContaining({ status: "cancelled" })]
      });
      expect(repository.listEvents(cancelled.id).at(-1)).toMatchObject({
        type: "delivery_cancelled",
        responsible: "local_user"
      });
    } finally {
      repository.close();
      await fixture.close();
    }
  });
});

function handoffInput() {
  return {
    canvasId: "canvas-1",
    projectId: "project-1",
    mission: "Deliver a premium landing page",
    source: {
      nodeId: "source",
      title: "Implementer",
      role: role("Implementer")
    },
    target: {
      nodeId: "target",
      title: "Reviewer",
      role: role("Reviewer")
    },
    edge: {
      edgeId: "edge-1",
      contract: {
        schemaVersion: "1.0" as const,
        kind: "handoff" as const,
        handoffMode: "manual" as const,
        sourceDeliverable: "Working implementation",
        targetInstruction: "Review against acceptance criteria"
      }
    }
  };
}

function role(name: string) {
  return {
    name,
    responsibilities: "Complete the assigned role",
    constraints: "Do not expand permissions",
    expectedDeliverable: "A structured delivery",
    completionCriteria: "Evidence is included"
  };
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `generated-${++value}`;
}

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 6, 19, 12, minutes));
}

async function createFixture(): Promise<{
  readonly filename: string;
  readonly close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-handoffs-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "handoffs.db");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  const timestamp = at(0).getTime();
  sqlite
    .prepare(
      `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "project-1",
      "Project",
      "C:/project",
      "C:/project",
      "main",
      "0123456789abcdef0123456789abcdef01234567",
      timestamp,
      timestamp
    );
  sqlite
    .prepare(
      `INSERT INTO canvases
         (id, title, mission, revision, viewport_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run("canvas-1", "Main", "Deliver a premium landing page", 1, "{}", timestamp, timestamp);
  sqlite.close();

  return {
    filename,
    close: async () => undefined
  };
}
