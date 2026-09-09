import type { WorkspaceDto } from "@forgedeck/schemas";

export function selectInitialWorkspace(
  workspaces: readonly WorkspaceDto[],
  activeWorkspaceId: string | null
): WorkspaceDto | null {
  const open = workspaces.filter((workspace) => workspace.isOpen);
  return open.find((workspace) => workspace.id === activeWorkspaceId) ?? open[0] ?? null;
}

export function findWorkspaceForProject(
  workspaces: readonly WorkspaceDto[],
  projectId: string
): WorkspaceDto | null {
  return workspaces.find((workspace) => workspace.projectId === projectId) ?? null;
}

export function replaceWorkspace(
  workspaces: readonly WorkspaceDto[],
  replacement: WorkspaceDto
): readonly WorkspaceDto[] {
  const next = workspaces.map((workspace) =>
    workspace.id === replacement.id ? replacement : workspace
  );
  return next.some((workspace) => workspace.id === replacement.id)
    ? next
    : [...next, replacement].sort((left, right) => left.position - right.position);
}
