import { commandOutput, run } from "./process.mjs";

export async function currentBranch() {
  return commandOutput("git", ["branch", "--show-current"]);
}

export async function gitStatusRows() {
  const output = await commandOutput("git", ["status", "--porcelain=v1"]);

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      path: line.slice(3),
      raw: line,
      staged: line[0] !== " " && line[0] !== "?",
      unstaged: line[1] !== " " || line[0] === "?"
    }));
}

export async function hasStagedChanges() {
  const result = await run("git", ["diff", "--cached", "--quiet"], { allowFailure: true });

  return result.code === 1;
}

export async function headSha() {
  return commandOutput("git", ["rev-parse", "HEAD"]);
}

export async function remoteHeadSha(branch = "main") {
  const output = await commandOutput("git", ["ls-remote", "origin", `refs/heads/${branch}`]);

  return output.split(/\s+/)[0] ?? "";
}
