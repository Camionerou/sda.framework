import { defineCommand } from "citty";

import { createRedis, prefixedRedisKey } from "../shared/redis.mjs";

const pingCommand = defineCommand({
  meta: {
    name: "ping",
    alias: "p",
    description: "Ping a Upstash Redis"
  },
  async run() {
    const { config, redis } = createRedis();
    const startedAt = Date.now();
    const response = await redis.ping();

    console.log(
      JSON.stringify(
        {
          latency_ms: Date.now() - startedAt,
          ok: response === "PONG",
          prefix: config.keyPrefix,
          response,
          url_host: new URL(config.url).host
        },
        null,
        2
      )
    );
  }
});

const listCommand = defineCommand({
  meta: {
    name: "ls",
    alias: ["l", "list"],
    description: "Lista keys dentro del namespace"
  },
  args: {
    pattern: {
      type: "positional",
      description: "Pattern opcional sin prefijo",
      default: "*"
    },
    limit: {
      type: "string",
      alias: "n",
      description: "Maximo de keys a mostrar",
      default: "100"
    }
  },
  async run({ args }) {
    const { config, redis } = createRedis();
    const limit = positiveInt(args.limit, 100);
    const match = prefixedRedisKey(args.pattern, config.keyPrefix);
    const keys = [];
    let cursor = "0";

    do {
      const [nextCursor, batch] = await redis.scan(cursor, {
        count: Math.min(100, limit),
        match
      });
      cursor = String(nextCursor);
      keys.push(...batch.map(String));
    } while (cursor !== "0" && keys.length < limit);

    for (const key of keys.slice(0, limit)) {
      console.log(key);
    }
  }
});

const getCommand = defineCommand({
  meta: {
    name: "get",
    alias: "g",
    description: "Imprime un valor Redis"
  },
  args: {
    key: {
      type: "positional",
      required: true,
      description: "Key con o sin prefijo"
    }
  },
  async run({ args }) {
    const { config, redis } = createRedis();
    const key = prefixedRedisKey(args.key, config.keyPrefix);
    const value = await redis.get(key);

    console.log(JSON.stringify({ key, value }, null, 2));
  }
});

const deleteCommand = defineCommand({
  meta: {
    name: "del",
    alias: ["d", "rm"],
    description: "Borra una key Redis"
  },
  args: {
    key: {
      type: "positional",
      required: true,
      description: "Key con o sin prefijo"
    }
  },
  async run({ args }) {
    const { config, redis } = createRedis();
    const key = prefixedRedisKey(args.key, config.keyPrefix);
    const deleted = await redis.del(key);

    console.log(JSON.stringify({ deleted, key }, null, 2));
  }
});

const flushCommand = defineCommand({
  meta: {
    name: "flush",
    alias: "f",
    description: "Borra todas las keys del namespace"
  },
  args: {
    namespace: {
      type: "boolean",
      description: "Confirmacion requerida para borrar el namespace"
    }
  },
  async run({ args }) {
    if (!args.namespace) {
      throw new Error("Usa --namespace para confirmar el borrado acotado al prefijo.");
    }

    const { config, redis } = createRedis();
    const match = `${config.keyPrefix}:*`;
    const deletedKeys = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await redis.scan(cursor, {
        count: 100,
        match
      });
      cursor = String(nextCursor);

      if (keys.length > 0) {
        await redis.del(...keys);
        deletedKeys.push(...keys.map(String));
      }
    } while (cursor !== "0");

    console.log(JSON.stringify({ deleted: deletedKeys.length, prefix: config.keyPrefix }, null, 2));
  }
});

const snapshotCommand = defineCommand({
  meta: {
    name: "snapshot",
    alias: "s",
    description: "Imprime el ultimo snapshot de indexing"
  },
  async run() {
    const { config, redis } = createRedis();
    const key = `${config.keyPrefix}:cache:indexing-latest`;
    const value = await redis.get(key);

    console.log(JSON.stringify({ key, value }, null, 2));
  }
});

function positiveInt(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const redisCommand = defineCommand({
  meta: {
    name: "redis",
    alias: "r",
    description: "Operaciones sobre Upstash Redis"
  },
  subCommands: {
    del: deleteCommand,
    flush: flushCommand,
    get: getCommand,
    ls: listCommand,
    ping: pingCommand,
    snapshot: snapshotCommand
  }
});
