import { readFile } from "node:fs/promises";

export async function readTextFixture(path: string): Promise<string> {
  return readFile(path, "utf8");
}
