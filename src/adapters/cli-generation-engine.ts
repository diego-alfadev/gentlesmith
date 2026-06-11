import {
  ENGINE_IDS,
  type EngineId,
  type GenerationEngine,
  type GenerationOptions,
} from "../application/generation-engine";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface EngineDefinition {
  label: string;
  command: string;
  args(prompt: string): string[];
}

const ENGINE_DEFINITIONS: Record<EngineId, EngineDefinition> = {
  codex: {
    label: "Codex",
    command: "codex",
    args: (prompt) => ["exec", "--sandbox", "read-only", "--ephemeral", prompt],
  },
  claude: {
    label: "Claude Code",
    command: "claude",
    args: (prompt) => ["--permission-mode", "plan", "--no-session-persistence", "--print", "-p", prompt],
  },
  gemini: {
    label: "Gemini CLI",
    command: "gemini",
    args: (prompt) => ["--approval-mode", "plan", "-p", prompt],
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    args: (prompt) => ["run", prompt],
  },
};

export interface EngineCommand {
  command: string;
  args: string[];
}

export function isEngineId(value: string): value is EngineId {
  return ENGINE_IDS.includes(value as EngineId);
}

export function buildEngineCommand(id: EngineId, prompt: string): EngineCommand {
  const definition = ENGINE_DEFINITIONS[id];
  return {
    command: definition.command,
    args: definition.args(prompt),
  };
}

export function createCliGenerationEngine(id: EngineId): GenerationEngine {
  const definition = ENGINE_DEFINITIONS[id];

  return {
    id,
    label: definition.label,
    available: () => Bun.which(definition.command) !== null,
    generate: (prompt, options) => runEngineCommand(buildEngineCommand(id, prompt), options),
  };
}

export function listCliGenerationEngines(): Array<{
  id: EngineId;
  label: string;
  available: boolean;
}> {
  return ENGINE_IDS.map((id) => {
    const engine = createCliGenerationEngine(id);
    return {
      id,
      label: engine.label,
      available: engine.available(),
    };
  });
}

async function runEngineCommand(command: EngineCommand, options: GenerationOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const process = Bun.spawn({
    cmd: [command.command, ...command.args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      process.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          process.kill();
          reject(new Error(`${command.command} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
      throw new Error(`${command.command} failed: ${detail}`);
    }

    return stdout;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
