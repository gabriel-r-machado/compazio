import { writeReleaseArtifactManifest } from "./release-artifacts";

const options = parseArguments(process.argv.slice(2));
const manifest = await writeReleaseArtifactManifest({
  artifactsDirectory: options.directory,
  channel: options.channel,
  version: options.version
});
process.stdout.write(`${JSON.stringify(manifest)}\n`);

function parseArguments(args: readonly string[]): {
  readonly directory: string;
  readonly channel: "beta" | "stable";
  readonly version: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--directory", "--channel", "--version"].includes(key)
    ) {
      throw new Error(
        "Usage: release:manifest --directory <directory> --channel <beta|stable> --version <semver>"
      );
    }
    if (values.has(key)) throw new Error("Release manifest option was provided twice");
    values.set(key, value);
  }
  const directory = values.get("--directory");
  const channel = values.get("--channel");
  const version = values.get("--version");
  if (
    directory === undefined ||
    version === undefined ||
    (channel !== "beta" && channel !== "stable")
  ) {
    throw new Error(
      "Usage: release:manifest --directory <directory> --channel <beta|stable> --version <semver>"
    );
  }
  return { directory, channel, version };
}
