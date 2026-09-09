import { mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AtomicWriteError,
  isTransient,
  pruneOrphanTemporaries,
  readFileWithRecovery,
  withPathLock,
  withTransientRetry,
  writeFileAtomically
} from "./atomic-file";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "compazio-atomic-"));
  roots.push(created);
  return created;
}

const parseJson = (contents: string): { readonly value: number } => {
  const parsed = JSON.parse(contents) as { value?: unknown };
  if (typeof parsed.value !== "number") throw new Error("schema inválido");
  return { value: parsed.value };
};

/** Makes a temporary look abandoned by a dead process. */
async function age(path: string, milliseconds: number): Promise<void> {
  const when = new Date(Date.now() - milliseconds);
  await utimes(path, when, when);
}

describe("escrita atômica sob concorrência", () => {
  it("serializa duas gravações simultâneas no mesmo arquivo", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    const order: string[] = [];
    await Promise.all(
      ["a", "b"].map((label) =>
        writeFileAtomically(path, JSON.stringify({ value: label === "a" ? 1 : 2 }), {
          operation: `save-${label}`,
          validate: (contents) => void parseJson(contents),
          keepBackup: true
        }).then(() => order.push(label))
      )
    );
    expect(order).toHaveLength(2);
    // Whoever won, the file is one complete document, never a mix of both.
    expect(parseJson(await readFile(path, "utf8")).value).toBeGreaterThan(0);
  });

  it("um leitor concorrente não quebra mais a substituição (regressão do EPERM em agents.json)", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFileAtomically(path, JSON.stringify({ value: 0 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });

    // Three terminals starting together: one write and three catalog reads, repeatedly.
    for (let round = 0; round < 60; round += 1) {
      const results = await Promise.allSettled([
        writeFileAtomically(path, JSON.stringify({ value: round }), {
          operation: "saveAgentCatalog",
          validate: (contents) => void parseJson(contents),
          keepBackup: true
        }),
        readFileWithRecovery(path, { operation: "loadAgentCatalog", parse: parseJson }),
        readFileWithRecovery(path, { operation: "loadAgentCatalog", parse: parseJson }),
        readFileWithRecovery(path, { operation: "loadAgentCatalog", parse: parseJson })
      ]);
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    }
  });

  it("serializa uma gravação enquanto outro caminho é lido, sem bloquear caminhos distintos", async () => {
    const directory = await root();
    const busy = join(directory, "a.json");
    const other = join(directory, "b.json");
    let otherFinished = false;
    const held = withPathLock(busy, "long-write", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "done";
    });
    await withPathLock(other, "quick-write", async () => {
      otherFinished = true;
    });
    // A different path is never blocked by a busy one.
    expect(otherFinished).toBe(true);
    await expect(held).resolves.toBe("done");
  });
});

describe("classificação de erros do Windows", () => {
  it("retenta apenas EBUSY, EPERM e EACCES", () => {
    for (const code of ["EBUSY", "EPERM", "EACCES"])
      expect(isTransient(Object.assign(new Error("x"), { code }))).toBe(true);
    for (const code of ["ENOSPC", "EROFS", "EDQUOT", "EINVAL", "ENOENT", "ENAMETOOLONG"])
      expect(isTransient(Object.assign(new Error("x"), { code }))).toBe(false);
  });

  it("não grava nada quando o conteúdo é inválido para o schema", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFileAtomically(path, JSON.stringify({ value: 7 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });
    await expect(
      writeFileAtomically(path, JSON.stringify({ wrong: true }), {
        operation: "saveAgentCatalog",
        validate: (contents) => void parseJson(contents),
        keepBackup: true
      })
    ).rejects.toThrow(/schema inválido/);
    // O último arquivo válido continua exatamente como estava.
    expect(parseJson(await readFile(path, "utf8")).value).toBe(7);
    expect(await readdir(directory)).not.toContain(
      expect.stringContaining(".tmp") as unknown as string
    );
  });

  it("desiste na terceira tentativa de uma contenção transitória", async () => {
    let attempts = 0;
    const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    await expect(
      withTransientRetry(
        () => {
          throw busy;
        },
        (count) => {
          attempts = count;
        }
      )
    ).rejects.toBe(busy);
    expect(attempts).toBe(3);
  });

  it("não retenta uma falha permanente como disco cheio", async () => {
    let attempts = 0;
    const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    await expect(
      withTransientRetry(
        () => {
          throw full;
        },
        (count) => {
          attempts = count;
        }
      )
    ).rejects.toBe(full);
    // Uma única tentativa: repetir não faria o disco crescer.
    expect(attempts).toBe(1);
  });

  it("supera uma contenção que cede antes da terceira tentativa", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      })
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("preserva o último arquivo válido e reporta o diagnóstico quando o destino está travado", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFileAtomically(path, JSON.stringify({ value: 3 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });

    // Um handle aberto no destino é exatamente a condição de produção: no Windows o rename que
    // substitui o arquivo devolve EPERM enquanto alguém o mantém aberto.
    const handle = await open(path, "r");
    let failure: unknown;
    try {
      failure = await writeFileAtomically(path, JSON.stringify({ value: 4 }), {
        operation: "saveAgentCatalog",
        validate: (contents) => void parseJson(contents),
        keepBackup: true
      }).catch((error: unknown) => error);
    } finally {
      await handle.close();
    }

    if (process.platform === "win32") {
      expect(failure).toBeInstanceOf(AtomicWriteError);
      const diagnostics = (failure as AtomicWriteError).diagnostics;
      expect(diagnostics.code).toBe("EPERM");
      expect(diagnostics.syscall).toBe("rename");
      expect(diagnostics.operation).toBe("saveAgentCatalog");
      expect(diagnostics.attempts).toBe(3);
      expect(diagnostics.retriable).toBe(true);
      expect(diagnostics.pid).toBe(process.pid);
      expect(diagnostics.durationMs).toBeGreaterThan(0);
      expect(diagnostics.temporaryPath).toContain(".tmp");
      // O último arquivo válido continua no disco, intacto.
      expect(parseJson(await readFile(path, "utf8")).value).toBe(3);
    } else {
      // POSIX substitui um arquivo aberto sem reclamar; não há contenção a reproduzir.
      expect(failure).toBeUndefined();
    }
    // Nenhum temporário sobra, com falha ou com sucesso.
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

describe("backup e recuperação", () => {
  it("mantém exatamente uma cópia de backup, sem acumular", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    for (let value = 0; value < 5; value += 1) {
      await writeFileAtomically(path, JSON.stringify({ value }), {
        operation: "saveAgentCatalog",
        validate: (contents) => void parseJson(contents),
        keepBackup: true
      });
    }
    const entries = await readdir(directory);
    expect(entries.filter((entry) => entry.endsWith(".bak"))).toEqual(["agents.json.bak"]);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    // O backup guarda o penúltimo estado válido.
    expect(parseJson(await readFile(path, "utf8")).value).toBe(4);
    expect(parseJson(await readFile(`${path}.bak`, "utf8")).value).toBe(3);
  });

  it("recupera do backup quando o principal está corrompido, sem apagar o corrompido", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFileAtomically(path, JSON.stringify({ value: 1 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });
    await writeFileAtomically(path, JSON.stringify({ value: 2 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });
    await writeFile(path, "{corrompido", "utf8");

    const recovered = await readFileWithRecovery(path, {
      operation: "loadAgentCatalog",
      parse: parseJson
    });
    expect(recovered.source).toBe("backup");
    expect(recovered.value.value).toBe(1);
    expect(recovered.recoveredFrom).toBe("agents.json.bak");
    // Nada foi apagado silenciosamente.
    await expect(readFile(path, "utf8")).resolves.toBe("{corrompido");
  });

  it("usa um temporário abandonado apenas quando principal e backup são inúteis", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    const orphan = `${path}.abandonado.tmp`;
    await writeFile(path, "{corrompido", "utf8");
    await writeFile(`${path}.bak`, "{também corrompido", "utf8");
    await writeFile(orphan, JSON.stringify({ value: 42 }), "utf8");
    await age(orphan, 120_000);

    const recovered = await readFileWithRecovery(path, {
      operation: "loadAgentCatalog",
      parse: parseJson
    });
    expect(recovered.source).toBe("orphan-temporary");
    expect(recovered.value.value).toBe(42);
  });

  it("nunca substitui um arquivo válido por um temporário antigo", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFileAtomically(path, JSON.stringify({ value: 100 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });
    const orphan = `${path}.antigo.tmp`;
    await writeFile(orphan, JSON.stringify({ value: 1 }), "utf8");
    await age(orphan, 120_000);

    const recovered = await readFileWithRecovery(path, {
      operation: "loadAgentCatalog",
      parse: parseJson
    });
    expect(recovered.source).toBe("primary");
    expect(recovered.value.value).toBe(100);
  });

  it("ignora um temporário incompleto deixado por um kill durante a escrita", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFile(`${path}`, "{corrompido", "utf8");
    const truncated = `${path}.morto.tmp`;
    await writeFile(truncated, '{"value": 4', "utf8");
    await age(truncated, 120_000);
    await expect(
      readFileWithRecovery(path, { operation: "loadAgentCatalog", parse: parseJson })
    ).rejects.toBeInstanceOf(AtomicWriteError);
    // O temporário truncado continua no disco para inspeção.
    await expect(stat(truncated)).resolves.toBeDefined();
  });

  it("remove temporários abandonados sem tocar no principal nem no backup", async () => {
    const directory = await root();
    const path = join(directory, "agents.json");
    await writeFileAtomically(path, JSON.stringify({ value: 5 }), {
      operation: "seed",
      validate: (contents) => void parseJson(contents),
      keepBackup: true
    });
    const old = `${path}.velho.tmp`;
    const fresh = `${path}.novo.tmp`;
    await writeFile(old, "{}", "utf8");
    await writeFile(fresh, "{}", "utf8");
    await age(old, 120_000);

    const removed = await pruneOrphanTemporaries(path);
    expect(removed).toEqual(["agents.json.velho.tmp"]);
    // Um temporário recente pode pertencer a uma escrita em andamento e não é tocado.
    await expect(stat(fresh)).resolves.toBeDefined();
    expect(parseJson(await readFile(path, "utf8")).value).toBe(5);
  });

  it("devolve o valor padrão quando não existe cópia alguma", async () => {
    const directory = await root();
    const recovered = await readFileWithRecovery(join(directory, "agents.json"), {
      operation: "loadAgentCatalog",
      parse: parseJson,
      whenMissing: () => ({ value: -1 })
    });
    expect(recovered.source).toBe("empty");
    expect(recovered.value.value).toBe(-1);
  });
});
