/**
 * Evidence used to tell a harness-created workspace from one a person built.
 *
 * A workspace matches only when the fixture name and every node title that harness always created
 * are present. Anything a person could plausibly have built by hand fails at least one clause, so
 * the cleanup tool lists it as "keep" and refuses to remove it.
 */
export interface HarnessFingerprint {
  /** Stable diagnostic identifier for the fixture source. */
  readonly harness: string;
  readonly name: string;
  readonly requiredNodeTitles: readonly string[];
}

export const HARNESS_FINGERPRINTS: readonly HarnessFingerprint[] = [
  {
    // Legacy beta fixture. The environment-specific harness itself is intentionally not public.
    harness: "legacy:compazio-lp-validation",
    name: "LP — validação final",
    requiredNodeTitles: [
      "Briefing e progresso",
      "Arquivos do projeto",
      "Rosto-minimalista-em-preto-e-branco.png",
      "Screenshot_24.png"
    ]
  },
  {
    harness: "apps/desktop/src/v2/main/e2e/compazio-real-agents.ts",
    name: "Compazio real",
    requiredNodeTitles: []
  }
];

/** Returns the fixture identifier that created this workspace, or null when nothing proves it was a test. */
export function matchHarness(
  name: string,
  nodeTitles: readonly string[],
  fingerprints: readonly HarnessFingerprint[] = HARNESS_FINGERPRINTS
): string | null {
  const match = fingerprints.find(
    (fingerprint) =>
      fingerprint.name === name &&
      fingerprint.requiredNodeTitles.every((title) => nodeTitles.includes(title))
  );
  return match?.harness ?? null;
}
