import { readFile } from "fs/promises";
import { join } from "path";
import type { AgentProvider } from "./provider.js";

export interface RuntimeManifest {
  schema: string;
  delamain_name: string;
  module_id: string;
  module_version: number;
  module_mount_path: string;
  entity_name: string;
  entity_path: string;
  status_field: string;
  discriminator_field: string | null;
  discriminator_value: string | null;
  submodules: string[];
  state_providers: Record<string, AgentProvider>;
  limits?: RuntimeManifestLimits;
}

export interface RuntimeManifestLimits {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxBudgetUsdByProvider?: {
    anthropic?: number;
    openai?: number;
  };
}

const DELAMAIN_RUNTIME_MANIFEST_SCHEMA = "als-delamain-runtime-manifest@1";

function requireStringField(
  manifest: Partial<RuntimeManifest>,
  field: keyof Pick<
    RuntimeManifest,
    "schema"
      | "delamain_name"
      | "module_id"
      | "module_mount_path"
      | "entity_name"
      | "entity_path"
      | "status_field"
  >,
): string {
  return manifest[field] as string;
}

export async function loadRuntimeManifest(bundleRoot: string): Promise<RuntimeManifest> {
  const manifestPath = join(bundleRoot, "runtime-manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    throw new Error(
      `Missing runtime-manifest.json in '${bundleRoot}'. Redeploy this Delamain bundle with 'alsc deploy claude'.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid runtime-manifest.json in '${bundleRoot}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid runtime-manifest.json in '${bundleRoot}': expected an object`);
  }

  const manifest = parsed as Partial<RuntimeManifest>;
  const requiredStringFields: Array<keyof Pick<
    RuntimeManifest,
    "schema"
      | "delamain_name"
      | "module_id"
      | "module_mount_path"
      | "entity_name"
      | "entity_path"
      | "status_field"
  >> = [
    "schema",
    "delamain_name",
    "module_id",
    "module_mount_path",
    "entity_name",
    "entity_path",
    "status_field",
  ];

  for (const field of requiredStringFields) {
    if (typeof manifest[field] !== "string" || manifest[field]!.length === 0) {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': '${field}' must be a non-empty string`,
      );
    }
  }

  if (manifest.schema !== DELAMAIN_RUNTIME_MANIFEST_SCHEMA) {
    throw new Error(
      `Invalid runtime-manifest.json in '${bundleRoot}': unsupported schema '${manifest.schema}'`,
    );
  }

  if (typeof manifest.module_version !== "number" || !Number.isInteger(manifest.module_version)) {
    throw new Error(
      `Invalid runtime-manifest.json in '${bundleRoot}': 'module_version' must be an integer`,
    );
  }

  for (const field of ["discriminator_field", "discriminator_value"] as const) {
    if (manifest[field] !== null && manifest[field] !== undefined && typeof manifest[field] !== "string") {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': '${field}' must be string or null`,
      );
    }
  }

  const submodules = normalizeSubmodules(bundleRoot, manifest.submodules);
  const stateProviders = normalizeStateProviders(bundleRoot, manifest.state_providers);
  const limits = normalizeLimits(bundleRoot, manifest.limits);

  return {
    schema: requireStringField(manifest, "schema"),
    delamain_name: requireStringField(manifest, "delamain_name"),
    module_id: requireStringField(manifest, "module_id"),
    module_version: manifest.module_version,
    module_mount_path: requireStringField(manifest, "module_mount_path"),
    entity_name: requireStringField(manifest, "entity_name"),
    entity_path: requireStringField(manifest, "entity_path"),
    status_field: requireStringField(manifest, "status_field"),
    discriminator_field: manifest.discriminator_field ?? null,
    discriminator_value: manifest.discriminator_value ?? null,
    submodules,
    state_providers: stateProviders,
    limits,
  };
}

function normalizeSubmodules(bundleRoot: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid runtime-manifest.json in '${bundleRoot}': 'submodules' must be an array of repo-relative paths`,
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': 'submodules' entries must be non-empty strings`,
      );
    }

    const candidate = entry.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
    if (
      candidate.length === 0
      || candidate === "."
      || candidate.startsWith("/")
      || candidate.startsWith("../")
      || candidate.includes("/../")
      || candidate.endsWith("/..")
    ) {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': submodule path '${entry}' must be repo-relative`,
      );
    }

    if (seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }

  return normalized;
}

function normalizeLimits(bundleRoot: string, value: unknown): RuntimeManifestLimits | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid runtime-manifest.json in '${bundleRoot}': 'limits' must be an object`);
  }

  const limits = value as Record<string, unknown>;
  const normalized: RuntimeManifestLimits = {};

  if (limits.maxTurns !== undefined) {
    if (
      typeof limits.maxTurns !== "number"
      || !Number.isInteger(limits.maxTurns)
      || limits.maxTurns <= 0
    ) {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': 'limits.maxTurns' must be a positive integer`,
      );
    }
    normalized.maxTurns = limits.maxTurns;
  }

  if (limits.maxBudgetUsd !== undefined) {
    if (
      typeof limits.maxBudgetUsd !== "number"
      || !Number.isFinite(limits.maxBudgetUsd)
      || limits.maxBudgetUsd <= 0
    ) {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': 'limits.maxBudgetUsd' must be a positive number`,
      );
    }
    normalized.maxBudgetUsd = limits.maxBudgetUsd;
  }

  if (limits.maxBudgetUsdByProvider !== undefined) {
    if (
      !limits.maxBudgetUsdByProvider
      || typeof limits.maxBudgetUsdByProvider !== "object"
      || Array.isArray(limits.maxBudgetUsdByProvider)
    ) {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': 'limits.maxBudgetUsdByProvider' must be an object`,
      );
    }

    const providerLimits = limits.maxBudgetUsdByProvider as Record<string, unknown>;
    const normalizedProviderLimits: NonNullable<RuntimeManifestLimits["maxBudgetUsdByProvider"]> = {};

    for (const [provider, providerLimit] of Object.entries(providerLimits)) {
      if (provider !== "anthropic" && provider !== "openai") {
        throw new Error(
          `Invalid runtime-manifest.json in '${bundleRoot}': 'limits.maxBudgetUsdByProvider.${provider}' is not a supported field`,
        );
      }
      if (
        typeof providerLimit !== "number"
        || !Number.isFinite(providerLimit)
        || providerLimit <= 0
      ) {
        throw new Error(
          `Invalid runtime-manifest.json in '${bundleRoot}': 'limits.maxBudgetUsdByProvider.${provider}' must be a positive number`,
        );
      }

      normalizedProviderLimits[provider] = providerLimit;
    }

    normalized.maxBudgetUsdByProvider = normalizedProviderLimits;
  }

  return normalized;
}

function normalizeStateProviders(
  bundleRoot: string,
  value: unknown,
): Record<string, AgentProvider> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Invalid runtime-manifest.json in '${bundleRoot}': 'state_providers' must be an object`,
    );
  }

  const normalized: Record<string, AgentProvider> = {};
  for (const [stateName, provider] of Object.entries(value as Record<string, unknown>)) {
    if (provider !== "anthropic" && provider !== "openai") {
      throw new Error(
        `Invalid runtime-manifest.json in '${bundleRoot}': state provider '${stateName}' must be 'anthropic' or 'openai'`,
      );
    }
    normalized[stateName] = provider;
  }

  return normalized;
}
