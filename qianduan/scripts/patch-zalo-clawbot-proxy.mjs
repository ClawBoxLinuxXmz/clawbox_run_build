import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
const projectsDir = path.join(root, "npm", "projects");

async function findApiFile() {
  const projects = await fs.readdir(projectsDir, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory() || !project.name.startsWith("zalo-platforms-openclaw-zaloclawbot-")) continue;
    const packageDir = path.join(projectsDir, project.name, "node_modules", "@zalo-platforms", "openclaw-zaloclawbot");
    const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
    if (packageJson.version !== "0.1.4") throw new Error(`Unsupported Zalo ClawBot version: ${String(packageJson.version)}`);
    return path.join(packageDir, "dist", "src", "api", "api.js");
  }
  return null;
}

const file = await findApiFile();
if (!file) process.exit(0);
let source = await fs.readFile(file, "utf8");
if (source.includes("__clawboxProxyFetch")) process.exit(0);
const marker = 'const DEFAULT_ZALO_API_BASE = "https://bot-api.zaloplatforms.com";';
if (!source.includes(marker) || !source.includes("const fetcher = options?.fetch ?? fetch;") || !source.includes("const effectiveFetch = fetcher ?? fetch;")) {
  throw new Error("Unexpected Zalo ClawBot API source; refusing to patch.");
}
source = source.replace(
  marker,
  `${marker}\nfunction channelFetch(input, init) {\n    const proxyFetch = globalThis.__clawboxProxyFetch;\n    return typeof proxyFetch === "function" ? proxyFetch("openclaw-zaloclawbot", input, init) : fetch(input, init);\n}`,
);
source = source.replace("const fetcher = options?.fetch ?? fetch;", "const fetcher = options?.fetch ?? channelFetch;");
source = source.replace("const effectiveFetch = fetcher ?? fetch;", "const effectiveFetch = fetcher ?? channelFetch;");
await fs.writeFile(file, source, "utf8");
