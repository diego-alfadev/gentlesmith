export const ENGINE_IDS = ["codex", "claude", "gemini", "opencode"] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

export type GenerationStage = "starting" | "completed";

export interface GenerationProgress {
  stage: GenerationStage;
  engine: EngineId;
  elapsedMs: number;
}

export interface GenerationOptions {
  timeoutMs?: number;
  model?: string;
  onProgress?(progress: GenerationProgress): void;
}

export interface GenerationEngine {
  readonly id: EngineId;
  readonly label: string;
  available(): boolean;
  generate(prompt: string, options?: GenerationOptions): Promise<string>;
}

export interface AgentProposal {
  engine: EngineId;
  content: string;
  metrics: {
    durationMs: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export async function generateAgentProposal(
  prompt: string,
  engine: GenerationEngine,
  options: GenerationOptions = {},
): Promise<AgentProposal> {
  if (!engine.available()) {
    throw new Error(`${engine.label} is not available on PATH.`);
  }

  const startedAt = performance.now();
  options.onProgress?.({ stage: "starting", engine: engine.id, elapsedMs: 0 });
  const content = (await engine.generate(prompt, options)).trim();
  const durationMs = Math.round(performance.now() - startedAt);
  if (!content) {
    throw new Error(`${engine.label} returned an empty proposal.`);
  }
  options.onProgress?.({ stage: "completed", engine: engine.id, elapsedMs: durationMs });

  return {
    engine: engine.id,
    content,
    metrics: {
      durationMs,
      model: options.model,
    },
  };
}
