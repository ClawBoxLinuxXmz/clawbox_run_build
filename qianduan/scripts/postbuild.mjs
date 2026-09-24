import { cp, mkdir } from "fs/promises";
import path from "path";

async function copyIfExists(from, to) {
  try {
    await cp(from, to, { recursive: true, force: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

const standaloneRoot = path.join(".next", "standalone");

await mkdir(path.join(standaloneRoot, ".next"), { recursive: true });
await copyIfExists(path.join(".next", "static"), path.join(standaloneRoot, ".next", "static"));
await copyIfExists("public", path.join(standaloneRoot, "public"));
