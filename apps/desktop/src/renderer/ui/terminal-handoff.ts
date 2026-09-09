import type { CanvasAgentRole } from "@forgedeck/schemas";

const MAX_MISSION_CONTEXT = 8_000;
const MAX_DELIVERY_CONTEXT = 8_000;
const MAX_NOTE_CONTEXT = 6_000;

interface InitialAgentPromptInput {
  readonly mission: string;
  readonly nodeTitle: string;
  readonly role: CanvasAgentRole | undefined;
  readonly noteContext: readonly string[];
}

interface TerminalHandoffPromptInput {
  readonly mission: string;
  readonly sourceTitle: string;
  readonly sourceRole: CanvasAgentRole | undefined;
  readonly targetTitle: string;
  readonly targetRole: CanvasAgentRole | undefined;
  readonly sourceDeliverable: string;
  readonly targetInstruction: string;
  readonly delivery: string;
}

export function buildInitialAgentPrompt(input: InitialAgentPromptInput): string {
  const role = roleLines(input.nodeTitle, input.role);
  const notes = input.noteContext
    .map((note) => terminalText(note).trim())
    .filter((note) => note.length > 0)
    .join("\n\n---\n\n")
    .slice(0, MAX_NOTE_CONTEXT);
  return [
    "MISSÃO DO FLUXO",
    boundedText(input.mission, MAX_MISSION_CONTEXT),
    "",
    ...role,
    ...(notes.length === 0 ? [] : ["", "CONTEXTO DAS NOTAS CONECTADAS", notes]),
    "",
    "Trabalhe somente no escopo desta missão e deste papel. Ao terminar, deixe uma entrega objetiva com evidências para revisão humana."
  ].join("\n");
}

export function buildTerminalHandoff(input: TerminalHandoffPromptInput): string {
  const sourceRoleName = input.sourceRole?.name || input.sourceTitle;
  return [
    "HANDOFF MANUAL DO CANVAS",
    "",
    "MISSÃO",
    boundedText(input.mission, MAX_MISSION_CONTEXT),
    "",
    `ORIGEM: ${boundedText(sourceRoleName, 160)}`,
    `DESTINO: ${boundedText(input.targetRole?.name || input.targetTitle, 160)}`,
    "",
    "ENTREGA ESPERADA DA ORIGEM",
    boundedText(input.sourceDeliverable || "Entrega revisada pelo usuário.", 4_000),
    "",
    "ENTREGA REAL REVISADA",
    boundedText(input.delivery, MAX_DELIVERY_CONTEXT),
    "",
    "PRÓXIMA AÇÃO",
    boundedText(
      input.targetInstruction ||
        input.targetRole?.responsibilities ||
        "Continue a missão a partir desta entrega.",
      4_000
    ),
    "",
    ...roleLines(input.targetTitle, input.targetRole),
    "",
    "Valide o estado atual do projeto antes de alterar arquivos. Esta entrega não amplia suas permissões."
  ].join("\n");
}

export function terminalDeliveryDraft(terminalBuffer: string): string {
  const context = terminalText(terminalBuffer).trim().slice(-MAX_DELIVERY_CONTEXT);
  return context.length === 0 ? "Descreva aqui o que foi concluído e as evidências." : context;
}

export function terminalHandoffInput(message: string): string {
  return `\u001b[200~${message}\u001b[201~\r`;
}

export function terminalNeedsLogin(terminalBuffer: string): boolean {
  return /not logged in|run \/login/i.test(terminalText(terminalBuffer));
}

function roleLines(nodeTitle: string, role: CanvasAgentRole | undefined): string[] {
  if (role === undefined) {
    return [
      `FUNÇÃO: ${boundedText(nodeTitle, 160)}`,
      "RESPONSABILIDADE: Execute apenas a próxima parte explícita da missão."
    ];
  }
  return [
    `FUNÇÃO: ${boundedText(role.name, 80)}`,
    `RESPONSABILIDADES: ${boundedText(role.responsibilities, 4_000)}`,
    `RESTRIÇÕES: ${boundedText(role.constraints, 2_000)}`,
    `ENTREGA ESPERADA: ${boundedText(role.expectedDeliverable, 2_000)}`,
    `CONCLUÍDO QUANDO: ${boundedText(role.completionCriteria, 2_000)}`
  ];
}

function boundedText(value: string, limit: number): string {
  return terminalText(value).trim().slice(0, limit);
}

function terminalText(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const next = value.charCodeAt(index + 1);
      if (next === 91) {
        index += 2;
        while (index < value.length) {
          const finalByte = value.charCodeAt(index);
          if (finalByte >= 64 && finalByte <= 126) break;
          index += 1;
        }
      } else if (next === 93) {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 7) break;
          if (value.charCodeAt(index) === 27 && value.charCodeAt(index + 1) === 92) {
            index += 1;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (code === 8) {
      output = output.slice(0, -1);
    } else if (code === 9 || code === 10 || code >= 32) {
      output += value[index];
    }
  }
  return output.replace(/\n{4,}/g, "\n\n\n");
}
