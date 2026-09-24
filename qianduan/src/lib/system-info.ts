import os from "os";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDeviceAccessInfo } from "@/lib/device-identity";

const exec = promisify(execFile);
const PREFERRED_INTERFACE = process.env.NETWORK_INTERFACE || "wlan0";

const BYTES_PER_MB = 1024 * 1024;

const UNKNOWN_DISK = {
  diskTotal: "unknown",
  diskUsed: "unknown",
  diskFree: "unknown",
  diskUsedPercent: 0,
} as const;

const SIZE_MULTIPLIERS: Record<string, number> = {
  T: 1024 * 1024,
  G: 1024,
  M: 1,
  K: 1 / 1024,
};

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  memoryTotal: string;
  memoryFree: string;
  memoryUsedPercent: number;
  cpuLoadPercent: number;
  uptime: string;
  disk: string;
  diskUsed: string;
  diskFree: string;
  diskTotal: string;
  diskUsedPercent: number;
  temperature: string;
  temperatureValue: number | null;
  gpuLoadPercent: number;
  networkIp: string;
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
  mdnsHost: string;
  accessUrl: string;
  localDnsAlias: string | null;
  mdnsReady: boolean;
}

function parseSizeToMB(s: string): number {
  const match = s.match(/^([\d.]+)([GMKT]?)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || "M").toUpperCase();
  return value * (SIZE_MULTIPLIERS[unit] ?? 1);
}

function parseDfOutput(stdout: string): {
  diskTotal: string;
  diskUsed: string;
  diskFree: string;
  diskUsedPercent: number;
} {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) {
    return { ...UNKNOWN_DISK };
  }

  const [size, used, avail] = lines[1].trim().split(/\s+/);
  const diskTotal = size || "unknown";
  const diskUsed = used || "unknown";
  const diskFree = avail || "unknown";

  const totalMB = parseSizeToMB(diskTotal);
  const usedMB = parseSizeToMB(diskUsed);
  const diskUsedPercent =
    totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

  return { diskTotal, diskUsed, diskFree, diskUsedPercent };
}

function parseTemperature(raw: string): {
  temperature: string;
  temperatureValue: number | null;
} {
  const millidegrees = parseInt(raw.trim(), 10);
  if (!isFinite(millidegrees)) {
    return { temperature: "unknown", temperatureValue: null };
  }
  const celsius = millidegrees / 1000;
  return {
    temperature: `${celsius.toFixed(1)}°C`,
    temperatureValue: celsius,
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

async function getNetBytes(iface: string, dir: "rx" | "tx"): Promise<number> {
  try {
    const raw = await fs.readFile(
      `/sys/class/net/${iface}/statistics/${dir}_bytes`,
      "utf-8",
    );
    return parseInt(raw.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function getPrimaryNetwork(): Promise<{
  networkIp: string;
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
}> {
  const ifaces = os.networkInterfaces();
  const ordered = Object.entries(ifaces).sort(([left], [right]) => {
    if (left === PREFERRED_INTERFACE) return -1;
    if (right === PREFERRED_INTERFACE) return 1;
    return left.localeCompare(right);
  });

  for (const [name, addrs] of ordered) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        const [rx, tx] = await Promise.all([
          getNetBytes(name, "rx"),
          getNetBytes(name, "tx"),
        ]);
        return {
          networkIp: addr.address,
          networkInterface: name,
          networkRxBytes: rx,
          networkTxBytes: tx,
        };
      }
    }
  }

  return {
    networkIp: "No connection",
    networkInterface: "—",
    networkRxBytes: 0,
    networkTxBytes: 0,
  };
}

async function readGpuLoadPercent(): Promise<number> {
  const candidates = [
    "/sys/devices/platform/bus@0/17000000.gpu/load",
    "/sys/class/drm/card0/device/gpu_busy_percent",
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      const n = parseInt(raw.trim(), 10);
      if (Number.isFinite(n)) {
        return p.includes("gpu_busy_percent") ? Math.min(100, n) : Math.round(n / 10);
      }
    } catch {
      // try next
    }
  }
  return 0;
}

async function readMdnsReady(): Promise<boolean> {
  try {
    const [avahi, serviceFile] = await Promise.all([
      exec("systemctl", ["is-active", "avahi-daemon"]),
      exec("test", ["-f", "/etc/avahi/services/clawbox-http.service"]),
    ]);
    return avahi.stdout.trim() === "active" && serviceFile.stderr === "";
  } catch {
    return false;
  }
}

export async function gather(): Promise<SystemInfo> {
  const [
    uptimeRes,
    dfRes,
    tempRes,
    gpuPct,
    accessInfoRes,
    networkRes,
    mdnsReadyRes,
  ] = await Promise.allSettled([
    exec("uptime", ["-p"]),
    exec("df", ["-h", "--output=size,used,avail", "/"]),
    fs.readFile("/sys/devices/virtual/thermal/thermal_zone0/temp", "utf-8"),
    readGpuLoadPercent(),
    getDeviceAccessInfo(),
    getPrimaryNetwork(),
    readMdnsReady(),
  ]);

  const dfOutput = settledValue(dfRes);
  const disk = dfOutput ? parseDfOutput(dfOutput.stdout) : { ...UNKNOWN_DISK };

  const tempRaw = settledValue(tempRes);
  const temp = tempRaw
    ? parseTemperature(tempRaw)
    : { temperature: "unknown", temperatureValue: null };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuCount = os.cpus().length;
  const accessInfo = settledValue(accessInfoRes) ?? {
    hostname: os.hostname(),
    mdnsHost: `${os.hostname()}.local`,
    accessUrl: `http://${os.hostname()}.local/`,
    localDnsAlias: null,
  };
  const network = settledValue(networkRes) ?? {
    networkIp: "No connection",
    networkInterface: "—",
    networkRxBytes: 0,
    networkTxBytes: 0,
  };
  const mdnsReady = settledValue(mdnsReadyRes) ?? false;

  return {
    hostname: accessInfo.hostname,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpuCount,
    memoryTotal: `${Math.round(totalMem / BYTES_PER_MB)} MB`,
    memoryFree: `${Math.round(freeMem / BYTES_PER_MB)} MB`,
    memoryUsedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    cpuLoadPercent: Math.min(
      100,
      Math.round((os.loadavg()[0] / cpuCount) * 100),
    ),
    uptime: settledValue(uptimeRes)?.stdout.trim() ?? "unknown",
    disk: dfOutput?.stdout.trim() ?? "unknown",
    diskUsed: disk.diskUsed,
    diskFree: disk.diskFree,
    diskTotal: disk.diskTotal,
    diskUsedPercent: disk.diskUsedPercent,
    temperature: temp.temperature,
    temperatureValue: temp.temperatureValue,
    gpuLoadPercent:
      typeof settledValue(gpuPct) === "number" ? settledValue(gpuPct)! : 0,
    ...network,
    mdnsHost: accessInfo.mdnsHost,
    accessUrl: accessInfo.accessUrl,
    localDnsAlias: accessInfo.localDnsAlias,
    mdnsReady,
  };
}
