import type { ResourceGraph } from "../domain/resource-graph";

export interface RenderedTargetOutput {
  content: string;
  warnings: string[];
}

export interface TargetAdapter<TTarget = unknown> {
  name: string;
  render(input: { graph: ResourceGraph; target: TTarget }): Promise<RenderedTargetOutput> | RenderedTargetOutput;
}
