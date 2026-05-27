import { spawn } from "node:child_process";

type CommandRunInput = {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  timeoutMs?: number;
  persistentMode?: "foreground" | "until-ready";
};

type CommandRunResult = {
  exitCode: number;
  output: string;
  completedBy: "exit" | "ready";
};

export async function runPowershellCommand(input: CommandRunInput): Promise<CommandRunResult> {
  const { command, cwd, signal, onOutput, timeoutMs = 60_000, persistentMode = "foreground" } = input;
  const child = spawn("powershell", ["-NoProfile", "-Command", command], {
    cwd,
    windowsHide: true,
  });

  let done = false;
  let readyDetected = false;
  let output = "";
  const readyPatterns = [
    /vite v\d+\.\d+\.\d+\s+ready/i,
    /\blocal:\s+http/i,
    /ready in \d+ ?ms/i,
    /started server on/i,
    /watching for file changes/i,
  ];
  const checkReady = (chunk: string) => {
    if (persistentMode !== "until-ready" || done) return;
    if (readyPatterns.some((pattern) => pattern.test(chunk))) {
      readyDetected = true;
      done = true;
      child.kill();
    }
  };

  const timer = setTimeout(() => {
    if (!done) child.kill();
  }, timeoutMs);

  const abortListener = () => {
    if (!done) child.kill();
  };
  signal?.addEventListener("abort", abortListener);

  child.stdout.on("data", (buffer: Buffer) => {
    const chunk = buffer.toString("utf8");
    output += chunk;
    onOutput?.(chunk, "stdout");
    checkReady(chunk);
  });
  child.stderr.on("data", (buffer: Buffer) => {
    const chunk = buffer.toString("utf8");
    output += chunk;
    onOutput?.(chunk, "stderr");
    checkReady(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortListener);
  });

  if (readyDetected) {
    return { exitCode: 0, output, completedBy: "ready" };
  }
  return { exitCode, output, completedBy: "exit" };
}
