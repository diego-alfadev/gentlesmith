export const ENGINE_IDS = ["codex", "claude", "gemini", "opencode"] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

export interface GenerationOptions {
  timeoutMs?: number;
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
}

export async function generateAgentProposal(
  prompt: string,
  engine: GenerationEngine,
  options: GenerationOptions = {},
): Promise<AgentProposal> {
  if (!engine.available()) {
    throw new Error(`${engine.label} is not available on PATH.`);
  }

  const content = (await engine.generate(prompt, options)).trim();
  if (!content) {
    throw new Error(`${engine.label} returned an empty proposal.`);
  }

  return {
    engine: engine.id,
    content,
  };
}
