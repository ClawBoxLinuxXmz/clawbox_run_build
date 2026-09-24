import { rm } from "fs/promises";

await rm(".next/standalone/.next/cache/images", {
  recursive: true,
  force: true,
});
