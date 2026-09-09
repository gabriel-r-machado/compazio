/**
 * The official verification step of automatic mode. A node is NEVER considered done because its agent
 * printed "done": completion is decided by the structural node result (exit code + published artifact),
 * the presence of the expected artifacts, and the exit codes of the node's allowlisted verification
 * commands. Everything it surfaces is sanitized, so no secret ever reaches a remediation prompt or log.
 */

/** Outcome of one allowlisted verification command, decided by its exit code — never by its text. */
export interface CheckOutcome {
  readonly command: string;
  readonly exitCode: number;
  readonly ok: boolean;
  /** Compact, sanitized detail (e.g. the failing summary line). Never raw, unbounded output. */
  readonly summary: string;
}

/** Runs a single allowlisted verification command (lint/typecheck/test/build) and reports its exit. */
export interface CheckRunner {
  run(command: string): Promise<CheckOutcome>;
}

export interface NodeVerificationInput {
  readonly nodeId: string;
  /** Structural node result: the process exited 0 AND published its declared artifact. */
  readonly structuralSuccess: boolean;
  /** Whether every expected artifact for the node is present. */
  readonly hasExpectedArtifacts: boolean;
  readonly acceptanceCriteria: readonly string[];
  /** Allowlisted commands to run for this node (may be empty). */
  readonly verificationCommands: readonly string[];
}

export interface NodeVerificationResult {
  readonly nodeId: string;
  readonly passed: boolean;
  /** The acceptance criteria left unmet (all of them when the structural result is missing). */
  readonly unmetCriteria: readonly string[];
  readonly checkOutcomes: readonly CheckOutcome[];
  /** A sanitized, bounded description of why it failed, or null when it passed. */
  readonly sanitizedError: string | null;
}

const MAX_ERROR_CHARS = 4_000;

export class VerificationCoordinator {
  public constructor(
    private readonly checkRunner: CheckRunner,
    private readonly sanitize: (text: string) => string = (text) => text
  ) {}

  public async verifyNode(input: NodeVerificationInput): Promise<NodeVerificationResult> {
    // Text like "done"/"completed" is irrelevant: without a valid structural result there is nothing
    // to verify, and the node fails.
    if (!input.structuralSuccess) {
      return this.fail(
        input,
        [...input.acceptanceCriteria],
        [],
        "The node produced no valid structural result."
      );
    }
    if (!input.hasExpectedArtifacts) {
      return this.fail(
        input,
        [...input.acceptanceCriteria],
        [],
        "The node did not produce its expected artifacts."
      );
    }

    const checkOutcomes: CheckOutcome[] = [];
    for (const command of input.verificationCommands) {
      const outcome = await this.checkRunner.run(command);
      checkOutcomes.push({ ...outcome, summary: this.trim(this.sanitize(outcome.summary)) });
    }
    const failedChecks = checkOutcomes.filter((outcome) => !outcome.ok);
    if (failedChecks.length > 0) {
      const error = failedChecks
        .map((outcome) => `${outcome.command} (exit ${outcome.exitCode}): ${outcome.summary}`)
        .join("\n");
      return {
        nodeId: input.nodeId,
        passed: false,
        unmetCriteria: [...input.acceptanceCriteria],
        checkOutcomes,
        sanitizedError: this.trim(this.sanitize(error))
      };
    }

    return {
      nodeId: input.nodeId,
      passed: true,
      unmetCriteria: [],
      checkOutcomes,
      sanitizedError: null
    };
  }

  private fail(
    input: NodeVerificationInput,
    unmetCriteria: string[],
    checkOutcomes: CheckOutcome[],
    error: string
  ): NodeVerificationResult {
    return {
      nodeId: input.nodeId,
      passed: false,
      unmetCriteria,
      checkOutcomes,
      sanitizedError: this.trim(this.sanitize(error))
    };
  }

  private trim(text: string): string {
    return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
  }
}
