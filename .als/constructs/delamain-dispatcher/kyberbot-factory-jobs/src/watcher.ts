import { readFile } from "fs/promises";
import { join, resolve } from "path";
import {
  gitListTrackedFilesAtHead,
  gitRepoPrefix,
  readGitFileAtHead,
  readGitFileFromIndex,
} from "./git.js";

interface PathSegment {
  kind: "literal" | "placeholder";
  text: string;
  entityName?: string;
}

interface ParsedPathTemplate {
  segments: PathSegment[];
}

interface PendingStatusChange {
  source: "working tree" | "index";
  status: string;
}

export interface WorkItem {
  id: string;
  status: string;
  type: string;
  filePath: string;
}

const warnedUncommittedTransitions = new Map<string, string>();

function parseFrontmatter(raw: string): Record<string, string> {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function parsePathTemplate(template: string): ParsedPathTemplate {
  return {
    segments: template.split("/").map((part) => {
      const match = part.match(/^(.*)\{([^}]+)\}(.*)$/);
      if (!match) {
        return {
          kind: "literal" as const,
          text: part,
        };
      }

      return {
        kind: "placeholder" as const,
        text: part,
        entityName: match[2] === "id" ? "id" : match[2],
      };
    }),
  };
}

function matchesPathTemplate(concretePath: string, template: ParsedPathTemplate): boolean {
  const concreteParts = concretePath.split("/");
  if (concreteParts.length !== template.segments.length) return false;

  const bindings = new Map<string, string>();

  for (let index = 0; index < template.segments.length; index += 1) {
    const templateSegment = template.segments[index]!;
    const concretePart = concreteParts[index]!;

    if (templateSegment.kind === "literal") {
      if (templateSegment.text !== concretePart) return false;
      continue;
    }

    const match = templateSegment.text.match(/^(.*)\{[^}]+\}(.*)$/);
    if (!match) return false;

    const prefix = match[1]!;
    const suffix = match[2]!;

    if (prefix && !concretePart.startsWith(prefix)) return false;
    if (suffix && !concretePart.endsWith(suffix)) return false;

    const captured = concretePart.slice(
      prefix.length,
      suffix ? concretePart.length - suffix.length : undefined,
    );
    if (captured.length === 0) return false;

    const bindingKey = templateSegment.entityName!;
    if (bindings.has(bindingKey) && bindings.get(bindingKey) !== captured) {
      return false;
    }
    bindings.set(bindingKey, captured);
  }

  return true;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readPendingStatusChange(
  moduleRoot: string,
  absolutePath: string,
  repoRelativePath: string,
  statusField: string,
  headStatus: string,
): Promise<PendingStatusChange | null> {
  try {
    const workingTreeFrontmatter = parseFrontmatter(await readFile(absolutePath, "utf-8"));
    const workingTreeStatus = workingTreeFrontmatter[statusField];
    if (workingTreeStatus && workingTreeStatus !== headStatus) {
      return {
        source: "working tree",
        status: workingTreeStatus,
      };
    }
  } catch {
    // Deleted or unreadable working-tree files stay invisible under HEAD polling.
  }

  const indexRaw = await readGitFileFromIndex(moduleRoot, repoRelativePath);
  if (!indexRaw) {
    return null;
  }

  const indexFrontmatter = parseFrontmatter(indexRaw);
  const indexStatus = indexFrontmatter[statusField];
  if (!indexStatus || indexStatus === headStatus) {
    return null;
  }

  return {
    source: "index",
    status: indexStatus,
  };
}

function warnOnUncommittedTransition(
  itemId: string,
  filePath: string,
  headStatus: string,
  pendingStatus: string,
  source: PendingStatusChange["source"],
): void {
  const signature = `${source}:${headStatus}->${pendingStatus}`;
  if (warnedUncommittedTransitions.get(filePath) === signature) {
    return;
  }

  console.log(
    `[dispatcher] status-drift: ${itemId} has an uncommitted status transition ${headStatus} -> ${pendingStatus} in the ${source}; continuing to read HEAD state`,
  );
  console.warn(
    `[dispatcher] status-drift: status transition is not committed; dispatcher only reads HEAD — commit the transition to proceed (${itemId}: ${headStatus} -> ${pendingStatus})`,
  );
  warnedUncommittedTransitions.set(filePath, signature);
}

function pruneResolvedWarnings(activeWarnings: Set<string>): void {
  for (const filePath of warnedUncommittedTransitions.keys()) {
    if (activeWarnings.has(filePath)) continue;
    warnedUncommittedTransitions.delete(filePath);
  }
}

export async function scan(
  moduleRoot: string,
  entityPath: string,
  statusField: string,
  discriminatorField?: string,
  discriminatorValue?: string,
): Promise<WorkItem[]> {
  const requestedModuleRoot = resolve(moduleRoot);
  const moduleRootFromRepo = trimTrailingSlash(
    normalizePath(await gitRepoPrefix(requestedModuleRoot)),
  );
  const template = parsePathTemplate(entityPath);
  const trackedFiles = await gitListTrackedFilesAtHead(requestedModuleRoot, ".");
  const items: WorkItem[] = [];
  const activeWarnings = new Set<string>();

  for (const moduleRelativePath of trackedFiles) {
    if (!moduleRelativePath.endsWith(".md")) continue;

    if (!matchesPathTemplate(moduleRelativePath, template)) continue;

    const repoRelativePath = moduleRootFromRepo === ""
      ? moduleRelativePath
      : `${moduleRootFromRepo}/${moduleRelativePath}`;
    const filePath = join(requestedModuleRoot, moduleRelativePath);

    try {
      const headRaw = await readGitFileAtHead(requestedModuleRoot, repoRelativePath);
      if (!headRaw) continue;

      const frontmatter = parseFrontmatter(headRaw);
      if (!frontmatter["id"] || !frontmatter[statusField]) continue;

      if (discriminatorField && discriminatorValue) {
        if (frontmatter[discriminatorField] !== discriminatorValue) continue;
      }

      const pending = await readPendingStatusChange(
        requestedModuleRoot,
        filePath,
        repoRelativePath,
        statusField,
        frontmatter[statusField]!,
      );
      if (pending) {
        warnOnUncommittedTransition(
          frontmatter["id"]!,
          filePath,
          frontmatter[statusField]!,
          pending.status,
          pending.source,
        );
        activeWarnings.add(filePath);
      }

      items.push({
        id: frontmatter["id"]!,
        status: frontmatter[statusField]!,
        type: frontmatter["type"] ?? "unknown",
        filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  pruneResolvedWarnings(activeWarnings);
  return items;
}
