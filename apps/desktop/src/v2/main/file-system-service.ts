import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  FileEntry,
  FilePreview,
  FilePreviewKind,
  FileReadResult,
  FileRevision,
  FileSystemEvent,
  WorkspaceRelativePath
} from "@forgedeck/compazio-v2-domain";

export interface ImportedFile {
  readonly path: WorkspaceRelativePath;
  readonly previewKind: FilePreviewKind;
  readonly copied: boolean;
}

const attachmentDirectory = ".compazio/anexos";
const maximumImportBytes = 50 * 1_024 * 1_024;
const maximumTextBytes = 1_048_576;
const maximumPreviewBytes = 5 * 1_024 * 1_024;
const maximumSearchResults = 200;
const ignoredDirectoryNames = new Set([".git", "node_modules", ".compazio"]);

export type FileSystemErrorCode =
  | "FILE_NOT_FOUND"
  | "FILE_ACCESS_DENIED"
  | "FILE_OUTSIDE_WORKSPACE"
  | "FILE_TOO_LARGE"
  | "FILE_ENCODING_UNSUPPORTED"
  | "FILE_CHANGED_EXTERNALLY"
  | "FILE_WRITE_CONFLICT"
  | "DIRECTORY_NOT_FOUND"
  | "PATH_TRAVERSAL_BLOCKED"
  | "SYMLINK_ESCAPE_BLOCKED"
  | "PREVIEW_UNSUPPORTED"
  | "PREVIEW_GENERATION_FAILED"
  | "WATCHER_FAILED";

export class FileSystemError extends Error {
  public constructor(
    public readonly code: FileSystemErrorCode,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}

export interface FileSystemServiceOptions {
  readonly workspaceRoot: (workspaceId: string) => Promise<string>;
  readonly now?: () => string;
  readonly onEvent?: (event: FileSystemEvent) => void;
}

/**
 * Main-process-only filesystem boundary. Every public path is workspace-relative and every
 * existing target is realpathed before use, which prevents traversal and symlink/junction escape.
 */
export class FileSystemService {
  private readonly watchers = new Map<
    string,
    { readonly workspaceId: string; readonly watcher: FSWatcher; timer: NodeJS.Timeout | null }
  >();
  private readonly now: () => string;

  public constructor(private readonly options: FileSystemServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async list(workspaceId: string, directory = "."): Promise<readonly FileEntry[]> {
    const root = await this.root(workspaceId);
    const full = await this.existingPath(root, directory, "DIRECTORY_NOT_FOUND");
    if (!(await stat(full)).isDirectory()) {
      throw new FileSystemError("DIRECTORY_NOT_FOUND", "O caminho selecionado não é uma pasta.");
    }
    const entries = await readdir(full, { withFileTypes: true });
    const result = await Promise.all(
      entries
        .filter((entry) => !ignoredDirectoryNames.has(entry.name))
        .map(async (entry): Promise<FileEntry | null> => {
          const path = joinRelative(directory, entry.name);
          try {
            const absolute = await this.existingPath(root, path, "FILE_NOT_FOUND");
            const info = await stat(absolute);
            return {
              path,
              name: entry.name,
              kind: info.isDirectory() ? "directory" : "file",
              size: info.size,
              modifiedAt: info.mtime.toISOString(),
              hidden: entry.name.startsWith("."),
              ...(info.isDirectory() ? {} : { previewKind: previewKindFor(path) })
            };
          } catch (error) {
            // A file may disappear between readdir and stat; stale entries are not materialised.
            if (error instanceof FileSystemError && error.code === "FILE_NOT_FOUND") return null;
            throw error;
          }
        })
    );
    return result
      .filter((entry): entry is FileEntry => entry !== null)
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
  }

  public async read(workspaceId: string, path: string): Promise<FileReadResult> {
    const root = await this.root(workspaceId);
    const full = await this.existingPath(root, path, "FILE_NOT_FOUND");
    const info = await stat(full);
    if (!info.isFile())
      throw new FileSystemError("FILE_NOT_FOUND", "O caminho selecionado não é um arquivo.");
    if (info.size > maximumTextBytes) {
      throw new FileSystemError(
        "FILE_TOO_LARGE",
        "O arquivo é grande demais para ser aberto no editor leve."
      );
    }
    const buffer = await readFile(full);
    if (buffer.includes(0)) {
      throw new FileSystemError("FILE_ENCODING_UNSUPPORTED", "Este arquivo parece ser binário.");
    }
    const content = buffer.toString("utf8");
    if (content.includes("�")) {
      throw new FileSystemError(
        "FILE_ENCODING_UNSUPPORTED",
        "O editor suporta apenas arquivos UTF-8."
      );
    }
    return {
      path: normalizeRelative(path),
      content,
      revision: revisionFor(info, buffer),
      encoding: "utf8"
    };
  }

  public async write(
    workspaceId: string,
    path: string,
    content: string,
    expectedRevision?: FileRevision
  ): Promise<FileReadResult> {
    if (Buffer.byteLength(content, "utf8") > maximumTextBytes) {
      throw new FileSystemError(
        "FILE_TOO_LARGE",
        "O editor leve não grava arquivos maiores que 1 MB."
      );
    }
    const root = await this.root(workspaceId);
    const full = await this.writePath(root, path);
    const current = await currentRevision(full);
    if (
      expectedRevision !== undefined &&
      (current === null || !sameRevision(current, expectedRevision))
    ) {
      throw new FileSystemError(
        "FILE_CHANGED_EXTERNALLY",
        "O arquivo foi alterado fora do Compazio. Recarregue, compare ou salve uma cópia.",
        true
      );
    }
    const temporary = `${full}.compazio-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, full);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw toFileSystemError(error);
    }
    return this.read(workspaceId, path);
  }

  public async createFile(
    workspaceId: string,
    path: string,
    content = ""
  ): Promise<FileReadResult> {
    const root = await this.root(workspaceId);
    const full = await this.writePath(root, path);
    try {
      await lstat(full);
      throw new FileSystemError(
        "FILE_WRITE_CONFLICT",
        "Já existe um arquivo ou pasta com este nome."
      );
    } catch (error: unknown) {
      if (error instanceof FileSystemError) throw error;
      if (!isMissing(error)) throw toFileSystemError(error);
    }
    return this.write(workspaceId, path, content);
  }

  public async createDirectory(workspaceId: string, path: string): Promise<void> {
    const root = await this.root(workspaceId);
    const full = await this.writePath(root, path);
    await mkdir(full, { recursive: false }).catch((error: unknown) => {
      throw toFileSystemError(error);
    });
  }

  public async rename(workspaceId: string, source: string, destination: string): Promise<void> {
    const root = await this.root(workspaceId);
    const from = await this.existingPath(root, source, "FILE_NOT_FOUND");
    const to = await this.writePath(root, destination);
    try {
      await lstat(to);
      throw new FileSystemError("FILE_WRITE_CONFLICT", "Já existe um item no destino.");
    } catch (error: unknown) {
      if (error instanceof FileSystemError) throw error;
      if (!isMissing(error)) throw toFileSystemError(error);
    }
    await rename(from, to).catch((error: unknown) => {
      throw toFileSystemError(error);
    });
  }

  public async remove(workspaceId: string, path: string): Promise<void> {
    const root = await this.root(workspaceId);
    const full = await this.existingPath(root, path, "FILE_NOT_FOUND");
    if (full === root)
      throw new FileSystemError(
        "FILE_OUTSIDE_WORKSPACE",
        "A raiz do workspace não pode ser excluída."
      );
    await rm(full, { recursive: true, force: false }).catch((error: unknown) => {
      throw toFileSystemError(error);
    });
  }

  public async search(
    workspaceId: string,
    query: string,
    directory = "."
  ): Promise<readonly FileEntry[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return [];
    const root = await this.root(workspaceId);
    const start = await this.existingPath(root, directory, "DIRECTORY_NOT_FOUND");
    const results: FileEntry[] = [];
    const visit = async (full: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (depth > 10 || results.length >= maximumSearchResults) return;
      for (const entry of await readdir(full, { withFileTypes: true })) {
        if (ignoredDirectoryNames.has(entry.name) || results.length >= maximumSearchResults)
          continue;
        const relativePath = joinRelative(relativeDirectory, entry.name);
        const resolved = await this.existingPath(root, relativePath, "FILE_NOT_FOUND").catch(
          () => null
        );
        if (resolved === null) continue;
        const info = await stat(resolved);
        if (entry.name.toLocaleLowerCase().includes(needle)) {
          results.push({
            path: relativePath,
            name: entry.name,
            kind: info.isDirectory() ? "directory" : "file",
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            hidden: entry.name.startsWith("."),
            ...(info.isDirectory() ? {} : { previewKind: previewKindFor(relativePath) })
          });
        }
        if (info.isDirectory()) await visit(resolved, relativePath, depth + 1);
      }
    };
    await visit(start, normalizeRelative(directory), 0);
    return results;
  }

  public async preview(workspaceId: string, path: string): Promise<FilePreview> {
    const kind = previewKindFor(path);
    const root = await this.root(workspaceId);
    let full: string;
    try {
      full = await this.existingPath(root, path, "FILE_NOT_FOUND");
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "FILE_NOT_FOUND") {
        return { path: normalizeRelative(path), kind, missing: true };
      }
      throw error;
    }
    const info = await stat(full);
    if (info.size > maximumPreviewBytes) {
      throw new FileSystemError("FILE_TOO_LARGE", "O preview é limitado a arquivos de até 5 MB.");
    }
    if (kind === "image") {
      const buffer = await readFile(full);
      const extension = extname(full).toLowerCase();
      if (extension === ".svg") {
        const safeSvg = sanitizeSvg(buffer.toString("utf8"));
        return {
          path: normalizeRelative(path),
          kind,
          missing: false,
          dataUrl: `data:image/svg+xml;base64,${Buffer.from(safeSvg).toString("base64")}`
        };
      }
      return {
        path: normalizeRelative(path),
        kind,
        missing: false,
        dataUrl: `data:${imageMime(extension)};base64,${buffer.toString("base64")}`
      };
    }
    if (kind === "text") {
      const read = await this.read(workspaceId, path);
      return { path: read.path, kind, missing: false, textPreview: read.content.slice(0, 32_000) };
    }
    return { path: normalizeRelative(path), kind, missing: false };
  }

  /**
   * Traz arquivos escolhidos por uma pessoa no seletor do sistema para dentro do workspace.
   *
   * O limite local-first continua valendo: todo o resto do serviço só sabe ler caminhos relativos
   * ao workspace. Em vez de abrir uma exceção no guarda de caminho — que valeria para agentes
   * também — um arquivo de fora é copiado para `.compazio/anexos`, e o canvas passa a apontar para
   * a cópia. Nada é sobrescrito: um nome repetido ganha sufixo.
   */
  public async importFiles(
    workspaceId: string,
    paths: readonly string[]
  ): Promise<readonly ImportedFile[]> {
    const root = await this.root(workspaceId);
    const imported: ImportedFile[] = [];
    for (const candidate of paths) {
      const source = await realpath(candidate).catch(() => {
        throw new FileSystemError("FILE_NOT_FOUND", `O arquivo não foi encontrado: ${candidate}`);
      });
      const info = await stat(source);
      if (!info.isFile()) {
        throw new FileSystemError("FILE_NOT_FOUND", "Selecione arquivos, não pastas.");
      }
      if (info.size > maximumImportBytes) {
        throw new FileSystemError(
          "FILE_TOO_LARGE",
          "Arquivos trazidos para o canvas são limitados a 50 MB."
        );
      }
      const inside = relative(root, source);
      if (inside !== "" && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
        imported.push({
          path: normalizeRelative(inside),
          previewKind: previewKindFor(source),
          copied: false
        });
        continue;
      }
      const destination = await this.attachmentDestination(root, source);
      await mkdir(dirname(resolve(root, destination)), { recursive: true });
      await copyFile(source, resolve(root, destination));
      imported.push({
        path: normalizeRelative(destination),
        previewKind: previewKindFor(source),
        copied: true
      });
    }
    return imported;
  }

  private async attachmentDestination(root: string, source: string): Promise<string> {
    const extension = extname(source);
    const base =
      basename(source, extension)
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 80) || "arquivo";
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const name = attempt === 0 ? `${base}${extension}` : `${base}-${attempt}${extension}`;
      const candidate = `${attachmentDirectory}/${name}`;
      const exists = await stat(resolve(root, candidate)).then(
        () => true,
        () => false
      );
      if (!exists) return candidate;
    }
    throw new FileSystemError("FILE_WRITE_CONFLICT", "Não foi possível nomear o arquivo trazido.");
  }

  public async watchTree(workspaceId: string, treeNodeId: string, directory = "."): Promise<void> {
    await this.unwatchTree(treeNodeId);
    const root = await this.root(workspaceId);
    const full = await this.existingPath(root, directory, "DIRECTORY_NOT_FOUND");
    try {
      const watcher = watch(full, { persistent: false });
      const state: {
        readonly workspaceId: string;
        readonly watcher: FSWatcher;
        timer: NodeJS.Timeout | null;
      } = {
        workspaceId,
        watcher,
        timer: null
      };
      watcher.on("change", (eventType, filename) => {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          const name = filename === null ? undefined : filename.toString();
          this.options.onEvent?.({
            workspaceId,
            treeNodeId,
            type: eventType === "rename" ? "renamed" : "changed",
            ...(name === undefined ? {} : { path: joinRelative(directory, name) }),
            timestamp: this.now()
          });
        }, 160);
      });
      watcher.on("error", () => {
        this.options.onEvent?.({ workspaceId, treeNodeId, type: "error", timestamp: this.now() });
      });
      this.watchers.set(treeNodeId, state);
    } catch {
      throw new FileSystemError("WATCHER_FAILED", "Não foi possível acompanhar esta pasta.", true);
    }
  }

  public async unwatchTree(treeNodeId: string): Promise<void> {
    const current = this.watchers.get(treeNodeId);
    if (current === undefined) return;
    this.watchers.delete(treeNodeId);
    if (current.timer !== null) clearTimeout(current.timer);
    current.watcher.close();
  }

  public async closeWorkspace(workspaceId: string): Promise<void> {
    const matching = [...this.watchers.entries()]
      .filter(([, watcher]) => watcher.workspaceId === workspaceId)
      .map(([treeNodeId]) => treeNodeId);
    await Promise.all(matching.map((treeNodeId) => this.unwatchTree(treeNodeId)));
  }

  public async shutdown(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((treeNodeId) => this.unwatchTree(treeNodeId)));
  }

  private async root(workspaceId: string): Promise<string> {
    try {
      return await realpath(await this.options.workspaceRoot(workspaceId));
    } catch (error: unknown) {
      throw toFileSystemError(error);
    }
  }

  private async existingPath(
    root: string,
    input: string,
    missingCode: "FILE_NOT_FOUND" | "DIRECTORY_NOT_FOUND"
  ): Promise<string> {
    const candidate = candidatePath(root, input);
    try {
      const canonical = await realpath(candidate);
      assertInside(root, canonical, "SYMLINK_ESCAPE_BLOCKED");
      return canonical;
    } catch (error: unknown) {
      if (isMissing(error))
        throw new FileSystemError(missingCode, "O arquivo ou pasta não foi encontrado.");
      if (error instanceof FileSystemError) throw error;
      throw toFileSystemError(error);
    }
  }

  private async writePath(root: string, input: string): Promise<string> {
    const candidate = candidatePath(root, input);
    const parent = dirname(candidate);
    try {
      const canonicalParent = await realpath(parent);
      assertInside(root, canonicalParent, "SYMLINK_ESCAPE_BLOCKED");
      return candidate;
    } catch (error: unknown) {
      if (isMissing(error)) {
        throw new FileSystemError("DIRECTORY_NOT_FOUND", "A pasta de destino não existe.");
      }
      if (error instanceof FileSystemError) throw error;
      throw toFileSystemError(error);
    }
  }
}

function candidatePath(root: string, input: string): string {
  const normalized = normalizeRelative(input);
  const candidate = resolve(root, normalized === "." ? "" : normalized);
  assertInside(root, candidate, "PATH_TRAVERSAL_BLOCKED");
  return candidate;
}

export function normalizeRelative(input: string): WorkspaceRelativePath {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === ".") return ".";
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new FileSystemError(
      "PATH_TRAVERSAL_BLOCKED",
      "O caminho contém uma codificação inválida."
    );
  }
  if (
    decoded.includes("\0") ||
    isAbsolute(decoded) ||
    /^[a-zA-Z]:[\\/]/.test(decoded) ||
    decoded.startsWith("\\\\")
  ) {
    throw new FileSystemError("PATH_TRAVERSAL_BLOCKED", "Use um caminho relativo ao workspace.");
  }
  const parts = decoded.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new FileSystemError("PATH_TRAVERSAL_BLOCKED", "O caminho não pode sair do workspace.");
  }
  return parts.join("/") as WorkspaceRelativePath;
}

function joinRelative(directory: string, child: string): WorkspaceRelativePath {
  const base = normalizeRelative(directory);
  return normalizeRelative(base === "." ? child : `${base}/${child}`);
}

function assertInside(
  root: string,
  target: string,
  code: "PATH_TRAVERSAL_BLOCKED" | "SYMLINK_ESCAPE_BLOCKED"
): void {
  const difference = relative(root, target);
  if (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  )
    return;
  throw new FileSystemError(code, "O caminho solicitado sai do workspace e foi bloqueado.");
}

function previewKindFor(path: string): FilePreviewKind {
  switch (extname(path).toLowerCase()) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
    case ".gif":
    case ".svg":
      return "image";
    case ".pdf":
      return "pdf";
    case ".mp4":
    case ".webm":
    case ".mov":
      return "video";
    case ".txt":
    case ".md":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".json":
    case ".css":
    case ".html":
    case ".yml":
    case ".yaml":
      return "text";
    default:
      return "unsupported";
  }
}

function imageMime(extension: string): string {
  return (
    (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif"
      } as const
    )[extension as ".png"] ?? "application/octet-stream"
  );
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /(?:href|xlink:href)\s*=\s*(?:"(?:https?:|javascript:)[^"]*"|'(?:https?:|javascript:)[^']*')/gi,
      ""
    );
}

function revisionFor(info: Awaited<ReturnType<typeof stat>>, buffer: Buffer): FileRevision {
  return {
    modifiedAt: info.mtime.toISOString(),
    size: typeof info.size === "bigint" ? Number(info.size) : info.size,
    hash: createHash("sha256").update(buffer).digest("hex")
  };
}

async function currentRevision(full: string): Promise<FileRevision | null> {
  try {
    const [info, buffer] = await Promise.all([stat(full), readFile(full)]);
    if (!info.isFile()) return null;
    return revisionFor(info, buffer);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw toFileSystemError(error);
  }
}

function sameRevision(left: FileRevision, right: FileRevision): boolean {
  return (
    left.size === right.size && left.hash === right.hash && left.modifiedAt === right.modifiedAt
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function toFileSystemError(error: unknown): FileSystemError {
  if (error instanceof FileSystemError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "EACCES" || code === "EPERM")
    return new FileSystemError("FILE_ACCESS_DENIED", "Sem permissão para acessar este arquivo.");
  if (code === "ENOENT")
    return new FileSystemError("FILE_NOT_FOUND", "O arquivo ou pasta não foi encontrado.");
  return new FileSystemError(
    "FILE_ACCESS_DENIED",
    "A operação no arquivo não pôde ser concluída.",
    true
  );
}
