import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  args.set(process.argv[index], process.argv[index + 1]);
const directory = resolve(args.get("--directory") ?? "");
if (!directory) throw new Error("Usage: audit-linux-package.mjs --directory <linux-unpacked>");

const files = await listFiles(directory);
const forbiddenNames = files.filter((file) => {
  const relative = file
    .slice(directory.length + 1)
    .replaceAll("\\", "/")
    .toLowerCase();
  return (
    relative === ".env" ||
    relative.includes("/.env") ||
    relative.includes(".claude/settings.local.json") ||
    relative.includes(".codex/config")
  );
});
const textExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".html",
  ".css",
  ".txt",
  ".yml",
  ".yaml",
  ".xml",
  ".ini"
]);
const sensitiveValues = [
  process.env.SUPABASE_SECRET_KEY,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  process.env.COMPAZIO_MCP_TOKEN,
  process.env.COMPAZIO_BRIDGE_TOKEN
].filter((value) => value !== undefined && value.length > 0);
const personalPathPatterns = [
  /[A-Za-z]:\\Users\\[^\\\r\n"'`]+\\/i,
  /\/Users\/[^/\r\n"'`]+\//i,
  /\/home\/[^/\r\n"'`]+\//i
];
const suspiciousContent = [];
for (const file of files) {
  if (!textExtensions.has(extname(file).toLowerCase())) continue;
  const content = await readFile(file, "utf8").catch(() => "");
  if (sensitiveValues.some((value) => content.includes(value))) suspiciousContent.push(file);
  if (personalPathPatterns.some((pattern) => pattern.test(content))) suspiciousContent.push(file);
}

const executable = join(directory, "compazio");
const executableValid = await isExecutable(executable);

async function isExecutable(path) {
  try {
    const executableStat = await stat(path);
    return executableStat.isFile() && (executableStat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const report = {
  packageDirectory: basename(directory),
  fileCount: files.length,
  executableFound: executableValid,
  forbiddenNames,
  suspiciousContent: [...new Set(suspiciousContent)],
  passed: forbiddenNames.length === 0 && suspiciousContent.length === 0 && executableValid,
  checkedAt: new Date().toISOString()
};
const reportPath = args.get("--report");
if (reportPath)
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) process.exitCode = 1;

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const filename = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(filename)));
    else if ((await stat(filename)).isFile()) result.push(filename);
  }
  return result;
}
