// The foreground program's resume point: a command line plus opaque state.
//
// Only the line is stored, never a live object, since a program holding
// listeners cannot be serialised. It records the command line that restarts it
// and a blob describing its internal position; the shell runs the line again
// and the program reads the blob back.

export class Resume {
  /** The command line that would restart the running program, or null. */
  line: string | null = null
  /** That program's own state. Read when the session is written. Must be JSON. */
  state: unknown = null

  private pendingLine: string | null = null
  private pendingState: unknown = null

  /** Install a saved session, to be claimed when the shell starts. */
  restore(line: string | null, state: unknown): void {
    this.pendingLine = line
    this.pendingState = state
  }

  /** Claimed once by the shell, before its first read. */
  takeLine(): string | null {
    const line = this.pendingLine
    this.pendingLine = null
    return line
  }

  /**
   * Claimed once by the resumed program. Cleared by reading, so a program
   * started by hand never inherits the previous run's state.
   */
  takeState(): unknown {
    const state = this.pendingState
    this.pendingState = null
    return state
  }

  /** Clear the slot. Called when the program exits. */
  clear(): void {
    this.line = null
    this.state = null
    this.pendingState = null
  }
}
