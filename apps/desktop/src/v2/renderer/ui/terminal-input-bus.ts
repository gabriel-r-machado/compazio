type TerminalSubmission = (text: string) => Promise<void>;

class TerminalInputBus {
  private readonly submissions = new Map<string, TerminalSubmission>();

  public register(terminalId: string, submit: TerminalSubmission): () => void {
    this.submissions.set(terminalId, submit);
    return () => {
      if (this.submissions.get(terminalId) === submit) this.submissions.delete(terminalId);
    };
  }

  public async submit(terminalId: string, text: string): Promise<boolean> {
    const submit = this.submissions.get(terminalId);
    if (submit === undefined) return false;
    await submit(text);
    return true;
  }
}

/** Keeps Prompt Composer submissions on the same xterm-owned input path as physical keyboard input. */
export const terminalInputBus = new TerminalInputBus();
