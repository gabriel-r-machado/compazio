const branchPrefix = "forgedeck";

export function createTaskBranchName(taskTitle: string, taskKey: string): string {
  const slug = toSlug(taskTitle).slice(0, 48).replace(/-+$/g, "") || "task";
  const suffix = toSlug(taskKey).slice(0, 16).replace(/-+$/g, "");
  if (suffix.length === 0) {
    throw new Error("Task key must contain at least one letter or number");
  }
  return `${branchPrefix}/${slug}-${suffix}`;
}

export function assertForgeDeckBranchName(branchName: string): void {
  if (
    branchName.length > 96 ||
    !/^forgedeck\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName) ||
    branchName.includes("..") ||
    branchName.endsWith(".lock")
  ) {
    throw new Error("Branch name is outside the ForgeDeck managed namespace");
  }
}

export function assertSafeGitRef(ref: string): void {
  if (
    ref.length < 1 ||
    ref.length > 256 ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith(".lock") ||
    !/^[A-Za-z0-9._/-]+$/.test(ref)
  ) {
    throw new Error("Git ref contains unsafe characters");
  }
}

function toSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
