export const GENERATED_OUTPUT_MARKERS = [
  "gentle-ai-overlay:gentlesmith",
  "<!-- fragment:",
  "agent.gentlesmith-",
] as const;

export function isGeneratedAgentOutput(raw: string): boolean {
  return GENERATED_OUTPUT_MARKERS.some((marker) => raw.includes(marker));
}
