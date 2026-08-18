import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { once } from "node:events";

export interface ProcessCommand {
  command: string;
  argsPrefix: string[];
}

export function spawnCommand(
  spec: ProcessCommand,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessWithoutNullStreams {
  return spawn(spec.command, [...spec.argsPrefix, ...args], options);
}

function forceTerminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

export async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
  graceMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.stdin.end();
  const timer = setTimeout(() => forceTerminateProcessTree(child), graceMs);
  await exited;
  clearTimeout(timer);
}
