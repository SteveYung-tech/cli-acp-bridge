import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";

export interface ProcessCommand {
  command: string;
  argsPrefix: string[];
}

export function processCommandWithPrefix(
  command: string,
  environmentVariable: string,
  env: NodeJS.ProcessEnv = process.env,
): ProcessCommand {
  const encoded = env[environmentVariable];
  if (encoded === undefined) return { command, argsPrefix: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`${environmentVariable} must be a JSON array of strings`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`${environmentVariable} must be a JSON array of strings`);
  }
  return { command, argsPrefix: parsed };
}

export function spawnCommand(
  spec: ProcessCommand,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessWithoutNullStreams {
  return spawn(spec.command, [...spec.argsPrefix, ...args], options);
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);

    child.once("exit", onExit);
    if (hasExited(child)) finish(true);
  });
}

async function forceTerminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!child.pid || hasExited(child)) return hasExited(child);

  if (process.platform === "win32") {
    let taskkill;
    try {
      taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.unref();
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (succeeded: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        taskkill.removeAllListeners("error");
        taskkill.removeAllListeners("close");
        resolve(succeeded);
      };
      const timer = setTimeout(() => {
        taskkill.kill("SIGKILL");
        finish(false);
      }, Math.max(timeoutMs, 1_000));

      taskkill.once("error", () => finish(false));
      taskkill.once("close", (code) => finish(code === 0));
    });
  }

  try {
    return child.kill("SIGKILL");
  } catch {
    return false;
  }
}

export async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
  graceMs = 2_000,
): Promise<void> {
  if (hasExited(child)) return;
  child.stdin.end();
  if (await waitForExit(child, graceMs)) return;

  if (!await forceTerminateProcessTree(child, graceMs) && !await waitForExit(child, graceMs)) {
    throw new Error("Unable to forcefully terminate child process");
  }
  if (!await waitForExit(child, graceMs)) {
    throw new Error("Child process did not exit after forced termination");
  }
}
