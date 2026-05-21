import { defineCommand } from "citty";
import pc from "picocolors";

export const helpCommand = defineCommand({
  meta: {
    name: "help",
    description: "Ayuda corta y atajos ergonomicos"
  },
  run() {
    const bin = process.argv[1]?.includes("sdaframework")
      ? "sdaframework"
      : process.argv[1]?.endsWith("/sdf")
        ? "sdf"
        : process.argv[1]?.endsWith("/sda")
          ? "sda"
          : "sf";

    console.log(pc.bold("SDA Framework CLI"));
    console.log("");
    console.log(`${pc.cyan(bin)}              ayuda corta`);
    console.log(`${pc.cyan(`${bin} d`)}            doctor rapido`);
    console.log(`${pc.cyan(`${bin} d --deep`)}     doctor + indexing`);
    console.log(`${pc.cyan(`${bin} r`)}            redis ping`);
    console.log(`${pc.cyan(`${bin} r ls`)}         redis keys`);
    console.log(`${pc.cyan(`${bin} i`)}            ultimos runs`);
    console.log(`${pc.cyan(`${bin} i t <doc>`)}    tail eventos`);
    console.log(`${pc.cyan(`${bin} i rq <doc>`)}   requeue doc`);
    console.log(`${pc.cyan(`${bin} dp`)}           versiones workers`);
    console.log(`${pc.cyan(`${bin} dp all -y`)}    deploy workers`);
    console.log(`${pc.cyan(`${bin} db p`)}         migraciones remotas`);
    console.log(`${pc.cyan(`${bin} v ls`)}         invites`);
    console.log(`${pc.cyan(`${bin} v a@b.com`)}    crear invite`);
    console.log(`${pc.cyan(`${bin} sh -m "msg"`)}  checks + commit + push`);
    console.log("");
    console.log(pc.dim("Aliases: sf, sdf, sda, sdaframework"));
  }
});
