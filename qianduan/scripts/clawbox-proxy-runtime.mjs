import fs from "node:fs";
import { createRequire } from "node:module";

const stateDir = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
const configPath = process.env.CLAWBOX_PROXY_CONFIG_PATH || `${stateDir}/clawbox-proxy.json`;
const undiciPath = process.env.CLAWBOX_UNDICI_PATH || "/home/clawbox/.npm-global/lib/node_modules/openclaw/node_modules/undici";
const agentCache = new Map();
let ProxyAgentCtor = null;
let fetchImpl = globalThis.fetch;

try {
  const require = createRequire(import.meta.url);
  const undici = require(undiciPath);
  ProxyAgentCtor = undici.ProxyAgent;
  if (typeof undici.fetch === "function") fetchImpl = undici.fetch;
} catch {
  ProxyAgentCtor = null;
  fetchImpl = globalThis.fetch;
}

function readConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function validProxy(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return value.trim().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveProxy(channelId) {
  const config = readConfig();
  const global = config.global && typeof config.global === "object" ? config.global : {};
  const globalProxy = global.enabled === true ? validProxy(global.url) : null;
  const channels = config.channels && typeof config.channels === "object" ? config.channels : {};
  const channel = channels[channelId] && typeof channels[channelId] === "object" ? channels[channelId] : {};
  if (channel.mode === "channel") return validProxy(channel.url);
  if (channel.mode === "global") return globalProxy;
  return null;
}

function getAgent(channelId) {
  const proxy = resolveProxy(channelId);
  if (!proxy || !ProxyAgentCtor) return null;
  let agent = agentCache.get(proxy);
  if (!agent) {
    agent = new ProxyAgentCtor(proxy);
    agentCache.set(proxy, agent);
  }
  return agent;
}

globalThis.__clawboxProxyAgent = (channelId) => getAgent(channelId);
globalThis.__clawboxProxyFetch = (channelId, input, init = {}) => {
  const agent = getAgent(channelId);
  return agent
    ? fetchImpl(input, { ...init, dispatcher: agent })
    : fetchImpl(input, init);
};
