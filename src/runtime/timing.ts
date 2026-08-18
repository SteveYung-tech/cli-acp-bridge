import { performance } from "node:perf_hooks";

type TimingWriter = (line: string) => void;

export class TimingTrace {
  private readonly enabled: boolean;
  private readonly startedAt: number;

  public constructor(
    private readonly adapterId: string,
    private readonly sessionId: string,
    env: NodeJS.ProcessEnv = process.env,
    private readonly write: TimingWriter = (line) => process.stderr.write(line),
    private readonly scope = "root",
    startedAt = performance.now(),
  ) {
    this.enabled = env.ACP_TIMING === "1";
    this.startedAt = startedAt;
  }

  public mark(name: string): void {
    if (!this.enabled) return;

    const elapsedMs = performance.now() - this.startedAt;
    this.write(
      `acp_timing adapter=${this.adapterId} session=${this.sessionId} trace=${this.scope} mark=${name} elapsed_ms=${elapsedMs.toFixed(3)}\n`,
    );
  }

  public child(name: string): TimingTrace {
    return new TimingTrace(
      this.adapterId,
      this.sessionId,
      { ACP_TIMING: this.enabled ? "1" : undefined },
      this.write,
      `${this.scope}.${name}`,
      this.startedAt,
    );
  }
}
