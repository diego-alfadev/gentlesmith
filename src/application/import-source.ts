import { readFile } from "node:fs/promises";
import { isGeneratedAgentOutput } from "../domain/generated-output";
import type { ScanSetupResult } from "./scan-setup";

export interface AssertImportableSourceInput {
  scan: ScanSetupResult;
  sourcePath: string;
  force?: boolean;
}

export async function assertImportableSource(input: AssertImportableSourceInput): Promise<void> {
  if (input.force) return;

  const source = input.scan.candidates.find((candidate) => candidate.path === input.sourcePath);
  const raw = await readFile(input.sourcePath, "utf8");
  const generated = source?.kind === "generated" || isGeneratedAgentOutput(raw);
  if (!generated) return;

  throw new Error([
    `Refusing to import generated agent output: ${input.sourcePath}`,
    "Generated files are rendered results, not the source of truth.",
    "Choose a personal/system source from `gentlesmith scan`, or re-run with `--force` if you really want to catalog this file.",
  ].join("\n"));
}
