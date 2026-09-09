import { cp, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";

import { matchHarness } from "./workspace-cleanup-rules";

/**
 * Removes workspace records left behind by e2e harnesses that wrote into the installed user data
 * before the creation gate became mandatory.
 *
 * It only ever touches the Compazio state root. A workspace's `workingDirectory` — the user's real
 * project, such as C:\Users\<user>\Documents\lp — is never moved, emptied or deleted.
 *
 *   pnpm --filter @forgedeck/desktop workspace:cleanup
 *   pnpm --filter @forgedeck/desktop workspace:cleanup --remove <id> --remove <id>
 */
interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly workingDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly harness: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataDirectory = valueOf(argv, "--data-dir") ?? defaultDataDirectory();
  const requested = valuesOf(argv, "--remove");
  const assumeYes = argv.includes("--yes");

  const repository = new V2WorkspaceRepository({ rootDirectory: dataDirectory });
  const listing = await repository.list();
  const candidates: Candidate[] = [];
  for (const summary of listing.workspaces) {
    const workspace = await repository.get(summary.id);
    candidates.push({
      id: workspace.id,
      name: workspace.name,
      workingDirectory: workspace.workingDirectory,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      harness: matchHarness(
        workspace.name,
        workspace.nodes.map((node) => node.title)
      )
    });
  }

  process.stdout.write(`Raiz de estado: ${dataDirectory}\n\n`);
  report(candidates);

  const removable = candidates.filter((candidate) => candidate.harness !== null);
  if (requested.length === 0) {
    process.stdout.write(
      removable.length === 0
        ? "Nenhum workspace de teste encontrado. Nada a remover.\n"
        : `${removable.length} workspace(s) de teste identificado(s). Para remover, repita o comando com --remove <id> para cada um.\n`
    );
    return;
  }

  const unknown = requested.filter((id) => !candidates.some((candidate) => candidate.id === id));
  if (unknown.length > 0) throw new Error(`Workspace inexistente: ${unknown.join(", ")}`);
  const refused = requested.filter((id) => removable.every((candidate) => candidate.id !== id));
  if (refused.length > 0) {
    throw new Error(
      `Recusado: ${refused.join(", ")} não corresponde a nenhuma assinatura de harness conhecida. Esta ferramenta remove apenas workspaces comprovadamente criados por teste.`
    );
  }

  const selected = removable.filter((candidate) => requested.includes(candidate.id));
  process.stdout.write("Serão removidos APENAS estes registros de workspace:\n");
  for (const candidate of selected) {
    process.stdout.write(`  - ${candidate.name} (${candidate.id})\n`);
    process.stdout.write(`    diretório do projeto preservado: ${candidate.workingDirectory}\n`);
  }
  if (!(await confirm(selected.length, assumeYes))) {
    process.stdout.write("Cancelado. Nada foi alterado.\n");
    return;
  }

  const backup = `${dataDirectory}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await backupDomainState(dataDirectory, backup);
  process.stdout.write(`\nBackup do estado de domínio: ${backup}\n`);

  for (const candidate of selected) {
    // Metadata only. V2WorkspaceRepository.delete never touches the working directory.
    await repository.delete(candidate.id);
    process.stdout.write(`Removido: ${candidate.name} (${candidate.id})\n`);
  }
  const remaining = await repository.list();
  process.stdout.write(`\nWorkspaces restantes: ${remaining.workspaces.length}\n`);
}

function report(candidates: readonly Candidate[]): void {
  for (const candidate of candidates) {
    process.stdout.write(
      `[${candidate.harness === null ? "MANTER" : "TESTE"}] ${candidate.name}\n`
    );
    process.stdout.write(`  id:         ${candidate.id}\n`);
    process.stdout.write(`  caminho:    ${candidate.workingDirectory}\n`);
    process.stdout.write(`  criado:     ${candidate.createdAt}\n`);
    process.stdout.write(`  atualizado: ${candidate.updatedAt}\n`);
    if (candidate.harness !== null) process.stdout.write(`  origem:     ${candidate.harness}\n`);
    process.stdout.write("\n");
  }
}

/** Copies the domain state so a wrong selection can be restored by hand. */
async function backupDomainState(dataDirectory: string, destination: string): Promise<void> {
  for (const entry of await readdir(dataDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && !["workspaces", "operations"].includes(entry.name)) continue;
    if (!entry.isDirectory() && !entry.name.startsWith("index.json")) continue;
    await cp(join(dataDirectory, entry.name), join(destination, entry.name), {
      recursive: true,
      force: true
    });
  }
}

async function confirm(count: number, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\nDigite REMOVER para confirmar a remoção de ${count} registro(s): `
    );
    return answer.trim() === "REMOVER";
  } finally {
    rl.close();
  }
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function valuesOf(argv: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  argv.forEach((argument, index) => {
    if (argument !== flag) return;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  });
  return values;
}

function defaultDataDirectory(): string {
  const appData = process.env.APPDATA ?? join(homedir(), ".config");
  return join(appData, "Compazio", "compazio", "v2");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
