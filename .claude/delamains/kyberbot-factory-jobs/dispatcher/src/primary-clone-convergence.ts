#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  gitAbortRebase,
  gitChangedFilesBetween,
  gitCurrentBranch,
  gitFetchRef,
  gitHeadCommit,
  gitIsAncestor,
  gitMergeFastForward,
  gitRebase,
  gitRepoRoot,
  gitResolveCanonicalRefTarget,
  gitRevParse,
  runCommand,
  runGit,
} from "./git.js";

export const PRIMARY_CLONE_PENDING_SCHEMA = "als-primary-clone-convergence@1";

const HOOK_MARKER = "ALS_PRIMARY_CLONE_GUARD";
const DEFAULT_PUBLISHER = "unknown";

export type PrimaryClonePendingReason =
  | "dirty_worktree"
  | "overlap_blocked"
  | "rebase_failed";

export type PrimaryCloneBlockedReason =
  | "missing_canonical_upstream"
  | "fetch_failed"
  | "fast_forward_failed"
  | "repo_inspection_failed";

export interface PrimaryClonePendingState {
  schema: typeof PRIMARY_CLONE_PENDING_SCHEMA;
  repo_root: string;
  current_branch: string;
  remote_name: string;
  branch_name: string;
  full_ref: string;
  tracking_ref: string;
  local_head: string;
  remote_head: string;
  merge_base: string | null;
  publisher: string;
  reason: PrimaryClonePendingReason;
  message: string;
  detected_at: string;
  worktree_paths: string[];
  local_only_paths: string[];
  remote_only_paths: string[];
  conflict_paths: string[];
}

interface PrimaryCloneConvergenceBase {
  repo_root: string;
  current_branch: string;
  remote_name: string;
  branch_name: string;
  full_ref: string;
  tracking_ref: string;
  local_head: string;
  remote_head: string;
  state_file: string;
  message: string;
}

export interface PrimaryCloneConvergedResult extends PrimaryCloneConvergenceBase {
  status: "converged";
  mode:
    | "already_current"
    | "fast_forwarded"
    | "local_commits_ahead"
    | "replayed_local_commits";
  pending_state_cleared: boolean;
}

export interface PrimaryClonePendingResult extends PrimaryCloneConvergenceBase {
  status: "pending";
  reason: PrimaryClonePendingReason;
  pending_state: PrimaryClonePendingState;
}

export interface PrimaryCloneBlockedResult extends PrimaryCloneConvergenceBase {
  status: "blocked";
  reason: PrimaryCloneBlockedReason;
}

export type PrimaryCloneConvergenceResult =
  | PrimaryCloneConvergedResult
  | PrimaryClonePendingResult
  | PrimaryCloneBlockedResult;

export interface EnsurePrimaryCloneGuardResult {
  repo_root: string;
  hook_path: string;
  chained_hook_path: string | null;
  changed: boolean;
}

interface ParsedStatusEntry {
  path: string;
}

interface PendingStatePaths {
  stateFile: string;
  hookFile: string;
  chainedHookFile: string;
}

export async function convergePrimaryClone(input: {
  repoRoot: string;
  publisher?: string | null;
}): Promise<PrimaryCloneConvergenceResult> {
  const repoRoot = await gitRepoRoot(resolve(input.repoRoot));
  const publisher = input.publisher?.trim() || DEFAULT_PUBLISHER;
  const { stateFile } = await resolvePendingStatePaths(repoRoot);

  let target;
  try {
    target = await gitResolveCanonicalRefTarget(repoRoot);
  } catch (error) {
    return {
      status: "blocked",
      reason: "repo_inspection_failed",
      ...(await readRepoContext(repoRoot, stateFile)),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!target) {
    return {
      status: "blocked",
      reason: "missing_canonical_upstream",
      ...(await readRepoContext(repoRoot, stateFile)),
      message: "Primary clone does not expose a canonical upstream branch.",
    };
  }

  const trackingRef = `refs/remotes/${target.remoteName}/${target.branchName}`;
  const fetch = await gitFetchRef(repoRoot, target.remoteName, target.fullRef, trackingRef);
  if (fetch.exitCode !== 0) {
    return {
      status: "blocked",
      reason: "fetch_failed",
      ...(await readRepoContext(repoRoot, stateFile, target, trackingRef)),
      message: fetch.stderr.trim() || fetch.stdout.trim() || `git fetch ${target.remoteName} ${target.fullRef} failed`,
    };
  }

  const [currentBranch, localHead, remoteHead, worktreeEntries] = await Promise.all([
    gitCurrentBranch(repoRoot),
    gitHeadCommit(repoRoot),
    gitRevParse(repoRoot, trackingRef),
    readStatusEntries(repoRoot),
  ]);

  const baseResult = {
    repo_root: repoRoot,
    current_branch: currentBranch,
    remote_name: target.remoteName,
    branch_name: target.branchName,
    full_ref: target.fullRef,
    tracking_ref: trackingRef,
    local_head: localHead,
    remote_head: remoteHead,
    state_file: stateFile,
  };

  const worktreePaths = worktreeEntries.map((entry) => entry.path);

  if (localHead === remoteHead) {
    const pendingStateCleared = await clearPendingState(stateFile);
    return {
      status: "converged",
      mode: "already_current",
      pending_state_cleared: pendingStateCleared,
      ...baseResult,
      message: "Primary clone already matches canonical upstream.",
    };
  }

  const [remoteIsAncestor, localIsAncestor] = await Promise.all([
    gitIsAncestor(repoRoot, remoteHead, localHead),
    gitIsAncestor(repoRoot, localHead, remoteHead),
  ]);

  if (remoteIsAncestor) {
    const pendingStateCleared = await clearPendingState(stateFile);
    return {
      status: "converged",
      mode: "local_commits_ahead",
      pending_state_cleared: pendingStateCleared,
      ...baseResult,
      message: "Primary clone already contains canonical upstream with local commits on top.",
    };
  }

  if (worktreePaths.length > 0) {
    const pendingState = buildPendingState({
      repoRoot,
      currentBranch,
      target,
      trackingRef,
      localHead,
      remoteHead,
      mergeBase: await tryReadMergeBase(repoRoot, localHead, remoteHead),
      publisher,
      reason: "dirty_worktree",
      message: `Primary clone is behind canonical upstream while worktree changes are present: ${worktreePaths.join(", ")}`,
      worktreePaths,
      localOnlyPaths: [],
      remoteOnlyPaths: [],
      conflictPaths: [],
    });
    await writePendingState(stateFile, pendingState);
    return {
      status: "pending",
      reason: "dirty_worktree",
      pending_state: pendingState,
      ...baseResult,
      message: pendingState.message,
    };
  }

  if (localIsAncestor) {
    const merge = await gitMergeFastForward(repoRoot, remoteHead);
    if (merge.exitCode !== 0) {
      return {
        status: "blocked",
        reason: "fast_forward_failed",
        ...baseResult,
        message: merge.stderr.trim() || merge.stdout.trim() || `git merge --ff-only ${remoteHead} failed`,
      };
    }

    const nextHead = await gitHeadCommit(repoRoot);
    const pendingStateCleared = await clearPendingState(stateFile);
    return {
      status: "converged",
      mode: "fast_forwarded",
      pending_state_cleared: pendingStateCleared,
      ...baseResult,
      local_head: nextHead,
      message: "Primary clone fast-forwarded to canonical upstream.",
    };
  }

  const mergeBase = await tryReadMergeBase(repoRoot, localHead, remoteHead);
  const localOnlyPaths = mergeBase
    ? await gitChangedFilesBetween(repoRoot, mergeBase, localHead)
    : [];
  const remoteOnlyPaths = mergeBase
    ? await gitChangedFilesBetween(repoRoot, mergeBase, remoteHead)
    : [];
  const conflictPaths = overlappingPaths(localOnlyPaths, remoteOnlyPaths);

  if (conflictPaths.length > 0) {
    const pendingState = buildPendingState({
      repoRoot,
      currentBranch,
      target,
      trackingRef,
      localHead,
      remoteHead,
      mergeBase,
      publisher,
      reason: "overlap_blocked",
      message: `Primary clone diverged from canonical upstream on overlapping paths: ${conflictPaths.join(", ")}`,
      worktreePaths: [],
      localOnlyPaths,
      remoteOnlyPaths,
      conflictPaths,
    });
    await writePendingState(stateFile, pendingState);
    return {
      status: "pending",
      reason: "overlap_blocked",
      pending_state: pendingState,
      ...baseResult,
      message: pendingState.message,
    };
  }

  const rebase = await gitRebase(repoRoot, trackingRef);
  if (rebase.exitCode !== 0) {
    const rebaseConflictPaths = await readUnmergedPaths(repoRoot);
    await gitAbortRebase(repoRoot).catch(() => undefined);
    const pendingState = buildPendingState({
      repoRoot,
      currentBranch,
      target,
      trackingRef,
      localHead,
      remoteHead,
      mergeBase,
      publisher,
      reason: "rebase_failed",
      message: rebase.stderr.trim() || rebase.stdout.trim() || `git rebase ${trackingRef} failed`,
      worktreePaths: [],
      localOnlyPaths,
      remoteOnlyPaths,
      conflictPaths: rebaseConflictPaths,
    });
    await writePendingState(stateFile, pendingState);
    return {
      status: "pending",
      reason: "rebase_failed",
      pending_state: pendingState,
      ...baseResult,
      message: pendingState.message,
    };
  }

  const nextHead = await gitHeadCommit(repoRoot);
  const pendingStateCleared = await clearPendingState(stateFile);
  return {
    status: "converged",
    mode: "replayed_local_commits",
    pending_state_cleared: pendingStateCleared,
    ...baseResult,
    local_head: nextHead,
    message: "Primary clone replayed local commits onto canonical upstream.",
  };
}

export async function ensurePrimaryClonePreCommitGuard(input: {
  repoRoot: string;
  helperScriptPath: string;
}): Promise<EnsurePrimaryCloneGuardResult> {
  const repoRoot = await gitRepoRoot(resolve(input.repoRoot));
  const helperScriptPath = resolve(input.helperScriptPath);
  const { hookFile, chainedHookFile } = await resolvePendingStatePaths(repoRoot);

  await mkdir(dirname(hookFile), { recursive: true });

  if (existsSync(hookFile)) {
    const existingHook = await readFile(hookFile, "utf-8");
    if (!existingHook.includes(HOOK_MARKER)) {
      if (!existsSync(chainedHookFile)) {
        await rename(hookFile, chainedHookFile);
      } else {
        await rm(hookFile, { force: true });
      }
    }
  }

  const nextContents = buildHookContents({
    repoRoot,
    helperScriptPath,
    chainedHookFile: existsSync(chainedHookFile) ? chainedHookFile : null,
  });
  const currentContents = existsSync(hookFile)
    ? await readFile(hookFile, "utf-8")
    : null;

  const changed = currentContents !== nextContents;
  if (changed) {
    await writeFile(hookFile, nextContents, "utf-8");
    await chmod(hookFile, 0o755);
  }

  return {
    repo_root: repoRoot,
    hook_path: hookFile,
    chained_hook_path: existsSync(chainedHookFile) ? chainedHookFile : null,
    changed,
  };
}

export async function ensurePrimaryClonePreCommitGuards(input: {
  repoRoots: ReadonlyArray<string>;
  helperScriptPath: string;
}): Promise<EnsurePrimaryCloneGuardResult[]> {
  const results: EnsurePrimaryCloneGuardResult[] = [];
  for (const repoRoot of input.repoRoots) {
    results.push(await ensurePrimaryClonePreCommitGuard({
      repoRoot,
      helperScriptPath: input.helperScriptPath,
    }));
  }
  return results;
}

function buildPendingState(input: {
  repoRoot: string;
  currentBranch: string;
  target: NonNullable<Awaited<ReturnType<typeof gitResolveCanonicalRefTarget>>>;
  trackingRef: string;
  localHead: string;
  remoteHead: string;
  mergeBase: string | null;
  publisher: string;
  reason: PrimaryClonePendingReason;
  message: string;
  worktreePaths: string[];
  localOnlyPaths: string[];
  remoteOnlyPaths: string[];
  conflictPaths: string[];
}): PrimaryClonePendingState {
  return {
    schema: PRIMARY_CLONE_PENDING_SCHEMA,
    repo_root: input.repoRoot,
    current_branch: input.currentBranch,
    remote_name: input.target.remoteName,
    branch_name: input.target.branchName,
    full_ref: input.target.fullRef,
    tracking_ref: input.trackingRef,
    local_head: input.localHead,
    remote_head: input.remoteHead,
    merge_base: input.mergeBase,
    publisher: input.publisher,
    reason: input.reason,
    message: input.message,
    detected_at: new Date().toISOString(),
    worktree_paths: [...input.worktreePaths],
    local_only_paths: [...input.localOnlyPaths],
    remote_only_paths: [...input.remoteOnlyPaths],
    conflict_paths: [...input.conflictPaths],
  };
}

async function tryReadMergeBase(
  repoRoot: string,
  left: string,
  right: string,
): Promise<string | null> {
  const result = await runCommand(["git", "merge-base", left, right], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function readStatusEntries(repoRoot: string): Promise<ParsedStatusEntry[]> {
  const result = await runCommand(["git", "status", "--porcelain"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "git status --porcelain failed",
    );
  }
  if (result.stdout.length === 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const body = line.slice(3).trim();
      const path = body.includes(" -> ")
        ? body.split(" -> ").at(-1)?.trim() ?? body
        : body;
      return {
        path,
      } satisfies ParsedStatusEntry;
    });
}

async function readUnmergedPaths(repoRoot: string): Promise<string[]> {
  const output = await runGit(repoRoot, ["ls-files", "-u"]);
  if (output.length === 0) {
    return [];
  }

  const conflicts = new Set<string>();
  for (const line of output.split("\n")) {
    const path = line.split("\t")[1]?.trim();
    if (!path) continue;
    conflicts.add(path);
  }
  return [...conflicts].sort();
}

function overlappingPaths(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((entry) => rightSet.has(entry)))].sort();
}

async function readRepoContext(
  repoRoot: string,
  stateFile: string,
  target?: NonNullable<Awaited<ReturnType<typeof gitResolveCanonicalRefTarget>>> | null,
  trackingRef?: string,
): Promise<Omit<PrimaryCloneConvergenceBase, "message" | "local_head" | "remote_head"> & {
  local_head: string;
  remote_head: string;
}> {
  const [currentBranch, localHead] = await Promise.all([
    gitCurrentBranch(repoRoot).catch(() => "HEAD"),
    gitHeadCommit(repoRoot).catch(() => "unknown"),
  ]);
  const remoteHead = target && trackingRef
    ? await gitRevParse(repoRoot, trackingRef).catch(() => "unknown")
    : "unknown";

  return {
    repo_root: repoRoot,
    current_branch: currentBranch,
    remote_name: target?.remoteName ?? "unknown",
    branch_name: target?.branchName ?? "unknown",
    full_ref: target?.fullRef ?? "unknown",
    tracking_ref: trackingRef ?? "unknown",
    local_head: localHead,
    remote_head: remoteHead,
    state_file: stateFile,
  };
}

async function resolvePendingStatePaths(repoRoot: string): Promise<PendingStatePaths> {
  const [statePathRaw, hookPathRaw] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--git-path", "als/primary-clone-convergence.json"]),
    runGit(repoRoot, ["rev-parse", "--git-path", "hooks/pre-commit"]),
  ]);

  const stateFile = resolveGitPath(repoRoot, statePathRaw);
  const hookFile = resolveGitPath(repoRoot, hookPathRaw);
  return {
    stateFile,
    hookFile,
    chainedHookFile: `${hookFile}.als-user`,
  };
}

function resolveGitPath(repoRoot: string, filePath: string): string {
  return filePath.startsWith("/") ? filePath : resolve(repoRoot, filePath);
}

async function writePendingState(
  stateFile: string,
  state: PrimaryClonePendingState,
): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function clearPendingState(stateFile: string): Promise<boolean> {
  if (!existsSync(stateFile)) {
    return false;
  }
  await rm(stateFile, { force: true });
  return true;
}

function buildHookContents(input: {
  repoRoot: string;
  helperScriptPath: string;
  chainedHookFile: string | null;
}): string {
  const chainSnippet = input.chainedHookFile
    ? [
      `if [ -x "${shellEscape(input.chainedHookFile)}" ]; then`,
      `  exec "${shellEscape(input.chainedHookFile)}" "$@"`,
      "fi",
      "",
    ].join("\n")
    : "";

  return [
    "#!/bin/sh",
    `# ${HOOK_MARKER}`,
    `bun "${shellEscape(input.helperScriptPath)}" guard --repo-root "${shellEscape(input.repoRoot)}"`,
    "status=$?",
    "if [ \"$status\" -ne 0 ]; then",
    "  exit \"$status\"",
    "fi",
    chainSnippet,
    "exit 0",
    "",
  ].join("\n");
}

function shellEscape(value: string): string {
  return value.replaceAll("\"", "\\\"");
}

function formatGuardFailure(result: PrimaryClonePendingResult | PrimaryCloneBlockedResult): string {
  const header = result.status === "pending"
    ? "Primary clone convergence is still pending."
    : "Primary clone convergence check failed.";
  return [
    `[als] ${header}`,
    `[als] repo: ${result.repo_root}`,
    `[als] branch: ${result.current_branch} -> ${result.remote_name}/${result.branch_name}`,
    `[als] local: ${result.local_head}`,
    `[als] remote: ${result.remote_head}`,
    `[als] reason: ${result.message}`,
    `[als] pending state: ${result.state_file}`,
  ].join("\n");
}

async function runCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "Usage:",
        "  primary-clone-convergence.ts converge --repo-root <path> [--publisher <label>]",
        "  primary-clone-convergence.ts guard --repo-root <path>",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const parsed = parseNamedArgs(rest);
  const repoRoot = parsed["--repo-root"];
  if (!repoRoot) {
    process.stderr.write("--repo-root is required.\n");
    return 2;
  }

  if (command === "converge") {
    const result = await convergePrimaryClone({
      repoRoot,
      publisher: parsed["--publisher"] ?? null,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "blocked" ? 1 : 0;
  }

  if (command === "guard") {
    const result = await convergePrimaryClone({
      repoRoot,
      publisher: "git-pre-commit-guard",
    });
    if (result.status === "converged") {
      return 0;
    }
    process.stderr.write(`${formatGuardFailure(result)}\n`);
    return 1;
  }

  process.stderr.write(`Unknown command '${command}'.\n`);
  return 2;
}

function parseNamedArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Unknown argument '${key ?? "<missing>"}'.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument '${key}' requires a value.`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
