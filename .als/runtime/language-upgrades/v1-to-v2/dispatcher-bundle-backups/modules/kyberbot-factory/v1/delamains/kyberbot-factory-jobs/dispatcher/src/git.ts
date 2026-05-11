import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Dispatcher callers read whole git object contents via stdout/stderr.
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

interface RunCommandOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

interface CommandExecutionError extends Error {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
}

export async function runGit(
  cwd: string,
  args: string[],
  options: Omit<RunCommandOptions, "cwd"> = {},
): Promise<string> {
  const result = await runCommand(["git", ...args], {
    cwd,
    env: options.env,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in '${cwd}': ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }

  return result.stdout.trim();
}

export async function runCommand(
  cmd: string[],
  options: RunCommandOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [file, ...args] = cmd;
  if (!file) {
    throw new Error("runCommand requires a command");
  }

  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });

    return {
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const commandError = error as CommandExecutionError;
    if (typeof commandError.code !== "number") {
      throw error;
    }

    return {
      stdout: typeof commandError.stdout === "string" ? commandError.stdout : "",
      stderr: typeof commandError.stderr === "string" ? commandError.stderr : "",
      exitCode: commandError.code,
    };
  }
}

export async function gitHeadCommit(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

export async function gitRepoRoot(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function gitRepoPrefix(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--show-prefix"]);
}

export async function gitCommonDir(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--git-common-dir"]);
}

export async function gitCurrentBranch(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function gitStatusPorcelain(cwd: string): Promise<string> {
  return runGit(cwd, ["status", "--porcelain"]);
}

export async function gitStatusPorcelainNoUntracked(cwd: string): Promise<string> {
  return runGit(cwd, ["status", "--porcelain", "--untracked-files=no"]);
}

export async function gitStatusPorcelainNoUntrackedIgnoreSubmodules(
  cwd: string,
): Promise<string> {
  return runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--ignore-submodules=all",
  ]);
}

export async function gitListTrackedFilesAtHead(
  cwd: string,
  pathspec?: string,
): Promise<string[]> {
  const args = ["ls-tree", "-r", "--name-only", "HEAD"];
  if (pathspec) {
    args.push("--", pathspec);
  }

  const output = await runGit(cwd, args);
  if (output.length === 0) return [];
  return output.split("\n").filter(Boolean);
}

export async function gitChangedFilesAgainstHead(
  cwd: string,
  pathspec?: string,
): Promise<string[]> {
  const args = ["diff", "--name-only", "HEAD"];
  if (pathspec) {
    args.push("--", pathspec);
  }

  const output = await runGit(cwd, args);
  if (output.length === 0) return [];
  return output.split("\n").filter(Boolean);
}

async function readGitObject(
  cwd: string,
  objectSpec: string,
): Promise<string | null> {
  const result = await runCommand(["git", "show", objectSpec], { cwd });
  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout;
}

export async function readGitFileAtHead(
  cwd: string,
  repoRelativePath: string,
): Promise<string | null> {
  return readGitObject(cwd, `HEAD:${repoRelativePath}`);
}

export async function readGitFileFromIndex(
  cwd: string,
  repoRelativePath: string,
): Promise<string | null> {
  return readGitObject(cwd, `:${repoRelativePath}`);
}

export async function gitHasChanges(cwd: string, baseCommit: string): Promise<boolean> {
  const [status, head] = await Promise.all([
    gitStatusPorcelain(cwd),
    gitHeadCommit(cwd),
  ]);

  return status.length > 0 || head !== baseCommit;
}

export async function gitIsClean(cwd: string): Promise<boolean> {
  return (await gitStatusPorcelainNoUntracked(cwd)).length === 0;
}

export async function gitIsCleanIgnoreSubmodules(cwd: string): Promise<boolean> {
  return (await gitStatusPorcelainNoUntrackedIgnoreSubmodules(cwd)).length === 0;
}

export async function gitIsAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runCommand(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    { cwd },
  );

  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;

  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed in '${cwd}': ${
      result.stderr || result.stdout || `exit ${result.exitCode}`
    }`,
  );
}

export async function gitMergeFastForward(
  cwd: string,
  commit: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommand(["git", "merge", "--ff-only", commit], { cwd });
}

export async function gitMerge(
  cwd: string,
  commit: string,
  message: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommand(
    [
      "git",
      "-c",
      "user.name=Delamain Dispatcher",
      "-c",
      "user.email=delamain@local",
      "merge",
      "--no-gpg-sign",
      "--no-ff",
      "-m",
      message,
      commit,
    ],
    { cwd },
  );
}

export async function gitRebase(
  cwd: string,
  onto: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommand(["git", "rebase", onto], { cwd });
}

export async function gitPush(
  cwd: string,
  remote: string,
  refspec: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommand(["git", "push", remote, refspec], { cwd });
}

export async function gitAbortRebase(cwd: string): Promise<void> {
  const result = await runCommand(["git", "rebase", "--abort"], { cwd });
  const stderr = result.stderr.toLowerCase();
  if (result.exitCode !== 0 && !stderr.includes("no rebase in progress")) {
    throw new Error(
      `git rebase --abort failed in '${cwd}': ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

export async function gitAbortMerge(cwd: string): Promise<void> {
  const result = await runCommand(["git", "merge", "--abort"], { cwd });
  const stderr = result.stderr.toLowerCase();
  if (
    result.exitCode !== 0
    && !stderr.includes("there is no merge to abort")
    && !stderr.includes("merge_head missing")
    && !stderr.includes("no merge to abort")
  ) {
    throw new Error(
      `git merge --abort failed in '${cwd}': ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
