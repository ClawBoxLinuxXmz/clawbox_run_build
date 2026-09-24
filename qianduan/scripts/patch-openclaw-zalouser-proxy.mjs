import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR || "/home/clawbox/.openclaw";
const openclawRoot = process.env.OPENCLAW_INSTALL_ROOT || "/home/clawbox/.npm-global/lib/node_modules/openclaw";
const distDir = path.join(openclawRoot, "dist");
const files = (await fs.readdir(distDir)).filter((name) => /^zalo-js-.*\.js$/.test(name));
if (files.length === 0) process.exit(0);

for (const name of files) {
  const file = path.join(distDir, name);
  let source = await fs.readFile(file, "utf8");
  if (source.includes("__clawboxProxyAgent")) continue;
  const marker = "async function createZalo(options) {";
  const replacement = `${marker}\n\tconst proxyAgent = globalThis.__clawboxProxyAgent?.("zalouser");\n\tif (proxyAgent) options = { ...options, agent: proxyAgent };`;
  if (!source.includes(marker) || !source.includes("return new Zalo(options);")) {
    throw new Error(`Unexpected OpenClaw Zalo runtime source: ${file}`);
  }
  source = source.replace(marker, replacement);
  await fs.writeFile(file, source, "utf8");
}
