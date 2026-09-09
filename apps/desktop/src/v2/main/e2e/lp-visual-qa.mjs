import { app, BrowserWindow } from "electron";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.env.COMPAZIO_V2_VISUAL_QA_URL ?? "http://127.0.0.1:4175/";
const outputDirectory = await mkdtemp(join(tmpdir(), "compazio-v2-visual-qa-"));

// This helper is intentionally isolated: it must never use an installed profile or the real landing
// project as a screenshot destination.
app.setPath("userData", join(outputDirectory, "userData"));
app.on("window-all-closed", () => undefined);

async function capture(width, height, name) {
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width,
    height,
    webPreferences: { sandbox: true }
  });
  window.setContentSize(width, height);
  let loaded = false;
  for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
    try {
      await window.loadURL(target);
      loaded = true;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const metrics = await window.webContents.executeJavaScript(`({
    innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    main: Boolean(document.querySelector('main')),
    menuVisible: getComputedStyle(document.querySelector('.menu-toggle')).display !== 'none'
  })`);
  const image = await window.webContents.capturePage();
  await writeFile(join(outputDirectory, name), image.toPNG());
  window.destroy();
  if (metrics.scrollWidth > metrics.clientWidth || !metrics.main)
    throw new Error(`Viewport ${width}px is invalid: ${JSON.stringify(metrics)}`);
  process.stdout.write(`PASS ${width}px ${JSON.stringify(metrics)}\n`);
}

app
  .whenReady()
  .then(async () => {
    try {
      await capture(390, 844, "mobile-preview-electron.png");
      await capture(1440, 1000, "desktop-preview-electron.png");
      process.stdout.write(`Artifacts: ${outputDirectory}\n`);
    } finally {
      app.quit();
    }
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });
