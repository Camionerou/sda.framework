const commandAliases = new Map([
  ["?", "help"],
  ["h", "help"],
  ["ok", "doctor"],
  ["d", "doctor"],
  ["r", "redis"],
  ["i", "indexing"],
  ["idx", "indexing"],
  ["dp", "deploy"],
  ["dep", "deploy"],
  ["v", "invite"],
  ["inv", "invite"],
  ["sh", "ship"],
  ["s", "ssh"]
]);

function hasSubstantialArgs(argv, offset) {
  return argv.slice(offset).some((arg) => arg !== "--help" && arg !== "-h");
}

function shouldInsertDefaultSubcommand(argv, offset) {
  return !argv[offset] || argv[offset].startsWith("-");
}

/**
 * Normalize a raw argv array applying alias resolution and default subcommand insertion.
 * Does not mutate the input; returns a new array.
 *
 * @param {string[]} argv - process.argv-like array (first two elements are node + script)
 * @returns {string[]}
 */
export function normalizeArgv(argv) {
  const out = [...argv];

  if (!out[2]) {
    out.splice(2, 0, "help");
  }

  if (commandAliases.has(out[2])) {
    out[2] = commandAliases.get(out[2]);
  }

  if (out[2] === "doctor" && !hasSubstantialArgs(out, 3)) {
    out.splice(3, 0, "--quick");
  }

  if (out[2] === "redis" && shouldInsertDefaultSubcommand(out, 3)) {
    out.splice(3, 0, "ping");
  }

  if (out[2] === "indexing" && shouldInsertDefaultSubcommand(out, 3)) {
    out.splice(3, 0, "list");
  }

  if (out[2] === "deploy" && shouldInsertDefaultSubcommand(out, 3)) {
    out.splice(3, 0, "all", "--version");
  }

  if (out[2] === "invite" && out[3]?.includes("@")) {
    out.splice(3, 0, "create");
  }

  return out;
}
