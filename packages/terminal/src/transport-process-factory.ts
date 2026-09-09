import type { ManagedProcess, ManagedProcessFactory, ManagedProcessSpawnInput } from "./types";

/**
 * Selects the process transport per launch, from the controlled `transport` field on the spec. It is
 * a thin dispatcher, not a supervisor: it owns no lifecycle, sessions, output, timeout, cancellation
 * or cleanup — those stay with the single ProcessSupervisor, which drives whatever process is spawned.
 * The default is `pty`, preserving existing interactive-terminal behavior.
 */
export class TransportProcessFactory implements ManagedProcessFactory {
  public constructor(
    private readonly transports: {
      readonly pty: ManagedProcessFactory;
      readonly pipe: ManagedProcessFactory;
    }
  ) {}

  public spawn(input: ManagedProcessSpawnInput): Promise<ManagedProcess> {
    const transport = input.transport ?? "pty";
    const factory = transport === "pipe" ? this.transports.pipe : this.transports.pty;
    return factory.spawn(input);
  }
}
