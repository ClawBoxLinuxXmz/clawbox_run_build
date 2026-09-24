import fs from "fs/promises";
import os from "os";
import path from "path";
import { get } from "@/lib/config-store";

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const DATA_DIR = path.join(CONFIG_ROOT, "data");
const IDENTITY_PATH = path.join(DATA_DIR, "device-identity.json");
const WIFI_INTERFACE = process.env.NETWORK_INTERFACE || "wlan0";
const HOST_PREFIX = "clawbox";
const SUFFIX_LENGTH = Math.max(
  4,
  Number(process.env.CLAWBOX_HOST_SUFFIX_LENGTH) || 6,
);

interface StoredIdentity {
  hostname?: unknown;
  localDnsAlias?: unknown;
}

export interface DeviceAccessInfo {
  hostname: string;
  mdnsHost: string;
  accessUrl: string;
  localDnsAlias: string | null;
}

function sanitizeHostSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;

  const sanitized = sanitizeHostSegment(value);
  if (!sanitized || sanitized === HOST_PREFIX) {
    return null;
  }

  return sanitized;
}

function buildHostname(suffix: string): string {
  const normalizedSuffix = sanitizeHostSegment(suffix);
  if (!normalizedSuffix) {
    return `${HOST_PREFIX}-device`;
  }
  return `${HOST_PREFIX}-${normalizedSuffix}`;
}

function normalizeAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

async function readStoredIdentity(): Promise<StoredIdentity | null> {
  try {
    const raw = await fs.readFile(IDENTITY_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as StoredIdentity)
      : null;
  } catch {
    return null;
  }
}

async function writeStoredIdentity(identity: DeviceAccessInfo): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      IDENTITY_PATH,
      JSON.stringify(
        {
          hostname: identity.hostname,
          localDnsAlias: identity.localDnsAlias,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  } catch (err) {
    console.warn(
      "[device-identity] Failed to persist identity:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function readMacSuffix(iface: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(`/sys/class/net/${iface}/address`, "utf-8");
    const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (hex.length < SUFFIX_LENGTH) return null;
    return hex.slice(-SUFFIX_LENGTH);
  } catch {
    return null;
  }
}

async function readMachineIdSuffix(): Promise<string | null> {
  try {
    const raw = await fs.readFile("/etc/machine-id", "utf-8");
    const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (hex.length < SUFFIX_LENGTH) return null;
    return hex.slice(-SUFFIX_LENGTH);
  } catch {
    return null;
  }
}

async function deriveStableHostname(): Promise<string> {
  const envHostname = normalizeHostname(process.env.CLAWBOX_DEVICE_HOSTNAME);
  if (envHostname) {
    return envHostname;
  }

  const currentHostname = normalizeHostname(os.hostname());
  if (currentHostname?.startsWith(`${HOST_PREFIX}-`)) {
    return currentHostname;
  }

  const macSuffix = await readMacSuffix(WIFI_INTERFACE);
  if (macSuffix) {
    return buildHostname(macSuffix);
  }

  const machineIdSuffix = await readMachineIdSuffix();
  if (machineIdSuffix) {
    return buildHostname(machineIdSuffix);
  }

  if (currentHostname) {
    return currentHostname;
  }

  return `${HOST_PREFIX}-device`;
}

export async function getDeviceAccessInfo(): Promise<DeviceAccessInfo> {
  const stored = await readStoredIdentity();
  const hostname =
    normalizeHostname(
      typeof stored?.hostname === "string" ? stored.hostname : undefined,
    ) ?? (await deriveStableHostname());

  const configAlias = normalizeAlias(await get("local_dns_alias"));
  const envAlias = normalizeAlias(process.env.CLAWBOX_LOCAL_DNS_ALIAS);
  const storedAlias = normalizeAlias(stored?.localDnsAlias);
  const localDnsAlias = configAlias ?? envAlias ?? storedAlias;

  const identity: DeviceAccessInfo = {
    hostname,
    mdnsHost: `${hostname}.local`,
    accessUrl: `http://${hostname}.local/`,
    localDnsAlias,
  };

  if (
    stored?.hostname !== identity.hostname ||
    normalizeAlias(stored?.localDnsAlias) !== identity.localDnsAlias
  ) {
    await writeStoredIdentity(identity);
  }

  return identity;
}
