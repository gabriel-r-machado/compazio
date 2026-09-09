import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLocalMigrations } from "./migrate";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databasePath = resolve(
  process.env.FORGEDECK_DB_PATH ?? resolve(workspaceRoot, ".forgedeck", "forgedeck.db")
);

mkdirSync(dirname(databasePath), { recursive: true });
runLocalMigrations({ filename: databasePath });
process.stdout.write(`ForgeDeck local migrations applied to ${databasePath}\n`);
