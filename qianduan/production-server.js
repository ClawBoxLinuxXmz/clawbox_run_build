const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const host = process.env.HOSTNAME || "0.0.0.0";
const port = process.env.PORT || "80";

const standaloneServer = path.join(__dirname, ".next", "standalone", "server.js");
const nextCli = require.resolve("next/dist/bin/next");
const command = fs.existsSync(standaloneServer)
  ? [standaloneServer]
  : [nextCli, "start", "--hostname", host, "--port", port];

const child = spawn(process.execPath, command, {
  cwd: __dirname,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
