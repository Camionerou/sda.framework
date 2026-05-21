import { spawn } from "node:child_process";

export function run(command, args = [], options = {}) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: options.stdio ?? "pipe"
    });
    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (options.prefix) {
          process.stdout.write(prefixLines(options.prefix, chunk.toString()));
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (options.prefix) {
          process.stderr.write(prefixLines(options.prefix, chunk.toString()));
        }
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        durationMs: Date.now() - startedAt,
        stderr,
        stdout
      };

      if (code !== 0 && !options.allowFailure) {
        const error = new Error(
          `${command} ${args.join(" ")} fallo con codigo ${code}.\n${stderr || stdout}`.trim()
        );
        error.result = result;
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

export function runInherited(command, args = [], options = {}) {
  return run(command, args, { ...options, stdio: "inherit" });
}

function prefixLines(prefix, chunk) {
  return chunk
    .split(/(\r?\n)/)
    .map((part) => (/^\r?\n$/.test(part) || part === "" ? part : `[${prefix}] ${part}`))
    .join("");
}

export async function commandOutput(command, args = [], options = {}) {
  const result = await run(command, args, options);

  return result.stdout.trim();
}
