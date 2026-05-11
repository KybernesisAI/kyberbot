import { readFile } from "fs/promises";
import { join } from "path";

export interface DispatcherVersionInfo {
  localVersion: number;
  latestVersion: number;
}

export function parseDispatcherVersion(raw: string, label: string): number {
  const value = raw.trim();
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} dispatcher VERSION must be a positive integer`);
  }
  return Number(value);
}

export function resolveCanonicalDispatcherVersionPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const pluginRoot = env["CLAUDE_PLUGIN_ROOT"];
  if (!pluginRoot) {
    throw new Error("CLAUDE_PLUGIN_ROOT is not set; cannot read canonical dispatcher VERSION");
  }
  return join(pluginRoot, "delamain-dispatcher", "VERSION");
}

export async function loadDispatcherVersionInfo(
  bundleRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DispatcherVersionInfo> {
  const localPath = join(bundleRoot, "dispatcher", "VERSION");
  const canonicalPath = resolveCanonicalDispatcherVersionPath(env);

  return {
    localVersion: await readVersionFile(localPath, "local"),
    latestVersion: await readVersionFile(canonicalPath, "canonical"),
  };
}

export function formatDispatcherVersionLine(info: DispatcherVersionInfo): string {
  if (info.localVersion < info.latestVersion) {
    return `[dispatcher] version: ${info.localVersion} (latest: ${info.latestVersion} — run /update to update)`;
  }
  return `[dispatcher] version: ${info.localVersion} (latest: ${info.latestVersion})`;
}

async function readVersionFile(path: string, label: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(
      `${label} dispatcher VERSION missing or unreadable at ${path}: ${formatError(error)}`,
    );
  }
  return parseDispatcherVersion(raw, label);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
