import { readFile, writeFile } from "fs/promises";

export function parseMd(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  let end = 1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      end = i + 1;
      break;
    }
    const separator = lines[i]!.indexOf(":");
    if (separator === -1) continue;
    meta[lines[i]!.slice(0, separator).trim()] = lines[i]!.slice(separator + 1).trim();
  }

  return { meta, body: lines.slice(end).join("\n").trim() };
}

export async function readFrontmatterField(
  filePath: string,
  field: string,
): Promise<string | null> {
  const lines = (await readFile(filePath, "utf-8")).split("\n");
  if (lines[0]?.trim() !== "---") return null;

  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") break;
    const separator = lines[i]!.indexOf(":");
    if (separator === -1) continue;
    if (lines[i]!.slice(0, separator).trim() !== field) continue;
    let value = lines[i]!.slice(separator + 1).trim();
    if (value === "null" || value === "") return null;
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  return null;
}

export async function setFrontmatterField(
  filePath: string,
  field: string,
  value: string | null,
): Promise<boolean> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    console.warn(
      `[dispatcher] could not persist ${field}: ${filePath} is missing YAML frontmatter fence`,
    );
    return false;
  }

  let closingFence = -1;
  let existingLine = -1;

  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      closingFence = i;
      break;
    }
    const separator = lines[i]!.indexOf(":");
    if (separator !== -1 && lines[i]!.slice(0, separator).trim() === field) {
      existingLine = i;
    }
  }

  if (closingFence === -1) {
    console.warn(
      `[dispatcher] could not persist ${field}: ${filePath} has malformed YAML frontmatter fence`,
    );
    return false;
  }

  const serializedValue = value === null ? "null" : value;

  if (existingLine !== -1) {
    lines[existingLine] = `${field}: ${serializedValue}`;
  } else {
    lines.splice(closingFence, 0, `${field}: ${serializedValue}`);
  }

  await writeFile(filePath, lines.join("\n"), "utf-8");
  return true;
}
