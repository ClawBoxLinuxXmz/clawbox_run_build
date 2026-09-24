"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import StatusMessage from "./StatusMessage";
import { useI18n } from "./I18nProvider";
import type { LocalizedMessage } from "@/lib/i18n";

interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  freq: string;
}

interface ScanResponse {
  scanning?: boolean;
  networks?: WifiNetwork[] | null;
  error?: string | null;
}

interface ErrorResponse {
  error?: string;
}

interface ConnectResponse {
  message?: string;
  mdnsHost?: string;
  nextUrlHint?: string;
}

interface WifiStatusHint {
  type: "success" | "error";
  message: LocalizedMessage;
}

interface WifiStatusSnapshot {
  hostname?: string;
  mdnsHost?: string;
  accessUrl?: string;
}

function isScanResponse(value: unknown): value is ScanResponse {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const candidate = (value as ErrorResponse).error;
  return typeof candidate === "string" ? candidate : undefined;
}

function getConnectResponse(value: unknown): ConnectResponse | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as ConnectResponse;
}

export default function WifiStep({
  externalStatus = null,
}: {
  externalStatus?: WifiStatusHint | null;
}) {
  const { t } = useI18n();
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [showNetworkList, setShowNetworkList] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: LocalizedMessage;
  } | null>(null);
  const [statusSnapshot, setStatusSnapshot] = useState<WifiStatusSnapshot | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const visibleStatus = status ?? externalStatus;

  useEffect(() => {
    const controller = new AbortController();
    const loadStatusSnapshot = async () => {
      try {
        const res = await fetch("/setup-api/wifi/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data: unknown = await res.json().catch(() => null);
        if (typeof data !== "object" || data === null) return;
        const snapshot = data as WifiStatusSnapshot;
        setStatusSnapshot({
          hostname: snapshot.hostname,
          mdnsHost: snapshot.mdnsHost,
          accessUrl: snapshot.accessUrl,
        });
      } catch {
        // ignore
      }
    };

    void loadStatusSnapshot();
    return () => {
      controller.abort();
      controllerRef.current?.abort();
    };
  }, []);

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const scanWifi = async () => {
    setScanning(true);
    setStatus(null);
    try {
      const trigger = await fetch("/setup-api/wifi/scan", { method: "POST" });
      if (!trigger.ok) {
        throw new Error(`Scan failed (${trigger.status})`);
      }

      let data: ScanResponse | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(attempt === 0 ? 800 : 1000);
        const poll = await fetch("/setup-api/wifi/scan", { cache: "no-store" });
        if (!poll.ok) {
          throw new Error(`Scan failed (${poll.status})`);
        }
        const payload: unknown = await poll.json();
        if (!isScanResponse(payload)) {
          throw new Error("Invalid scan response");
        }
        data = payload;
        if (!data?.scanning) {
          break;
        }
      }

      if (!data || data.scanning) {
        throw new Error("Scan timed out");
      }

      if (data.error) {
        throw new Error(data.error);
      }

      const list = data.networks || [];
      setNetworks(list);
      setShowNetworkList(true);
      if (list.length === 0) {
        setStatus({
          type: "error",
          message: { key: "No networks found. Move closer to the router and try Scan Networks again." },
        });
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: {
          key: "Scan failed: {error}",
          values: { error: err instanceof Error ? err.message : String(err) },
        },
      });
    } finally {
      setScanning(false);
    }
  };

  const connectWifi = async () => {
    if (!ssid.trim()) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setConnecting(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: ssid.trim(), password }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const errData: unknown = await res.json().catch(() => null);
        throw new Error(getErrorMessage(errData) || `Connection failed (${res.status})`);
      }
      const okData = getConnectResponse(await res.json().catch(() => null));
      const serverMessage =
        okData?.message ||
        `Settings saved. The hotspot will disconnect shortly while the device joins your Wi‑Fi. Then reconnect your phone to the same Wi‑Fi and open ${okData?.nextUrlHint || "the device .local address"}. If .local does not resolve on your phone, use the IP shown on the device screen.`;

      setConnecting(false);
      setStatus({
        type: "success",
        message: serverMessage,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setConnecting(false);
        const mdnsHint =
          statusSnapshot?.accessUrl ||
          (statusSnapshot?.mdnsHost ? `http://${statusSnapshot.mdnsHost}/` : "");
        const hostnameHint = statusSnapshot?.hostname || t("the ClawBox device");

        setStatus({
          type: "success",
          message: {
            key: "The setup hotspot disconnected while the device was joining WiFi. Reconnect your phone to the target WiFi, then open {address}. If .local is unavailable, use the IPv4 shown on the device screen or find {host} in your router's client list.",
            values: {
              address: mdnsHint || t("the device's .local address"),
              host: hostnameHint,
            },
          },
        });
        return;
      }
      setStatus({
        type: "error",
        message: {
          key: "Connection failed: {error}",
          values: { error: err instanceof Error ? err.message : String(err) },
        },
      });
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  };

  const selectNetwork = (network: WifiNetwork) => {
    setSsid(network.ssid);
    setPassword("");
    setShowNetworkList(false);
  };

  const getSignalBars = (signal: number) => {
    if (signal >= 80) return "●●●●●";
    if (signal >= 60) return "●●●●○";
    if (signal >= 40) return "●●●○○";
    if (signal >= 20) return "●●○○○";
    return "●○○○○";
  };

  return (
    <div className="w-full max-w-[520px]">
      <div className="card-surface rounded-2xl p-8">
        <div className="flex flex-col items-center gap-2 mb-6">
          <Image
            src="/clawbox-logo.png"
            alt="ClawBox"
            width={120}
            height={120}
            className="w-[120px] h-[120px] object-contain"
            priority
          />
          <h1 className="text-2xl font-bold font-display text-center title-gradient">
            {t("Welcome to ClawBox")}
          </h1>
        </div>
        <p className="text-[var(--text-secondary)] mb-6 leading-relaxed text-center">
          {t("Connect to your WiFi network to get started.")}
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label
                htmlFor="wifi-ssid"
                className="text-xs font-semibold text-[var(--text-secondary)]"
              >
                {t("Network Name (SSID)")}
              </label>
              <button
                type="button"
                onClick={scanWifi}
                disabled={scanning}
                className="text-xs text-[var(--coral-bright)] hover:underline cursor-pointer disabled:opacity-50"
              >
                {scanning ? t("Scanning...") : t("Scan Networks")}
              </button>
            </div>
            <input
              id="wifi-ssid"
              type="text"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") connectWifi();
              }}
              placeholder={t("Enter WiFi network name")}
              autoComplete="off"
              className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
            />
            
            {showNetworkList && networks.length > 0 && (
              <div className="mt-2 bg-[var(--bg-surface)] border border-gray-700 rounded-lg max-h-48 overflow-y-auto">
                {networks.map((network, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => selectNetwork(network)}
                    className="w-full px-3 py-2 text-left hover:bg-[var(--bg-elevated)] text-sm text-gray-200 flex justify-between items-center border-b border-gray-700 last:border-b-0"
                  >
                    <span>{network.ssid}</span>
                    <span className="text-xs text-gray-500">{getSignalBars(network.signal)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label
              htmlFor="wifi-password"
              className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
            >
              {t("Password")}
            </label>
            <div className="relative">
              <input
                id="wifi-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") connectWifi();
                }}
                placeholder={t("Enter WiFi password (leave empty if open)")}
                autoComplete="off"
                className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t("Hide password") : t("Show password")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
              >
                {showPassword ? (
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {visibleStatus && (
          <div className="mt-4">
            <StatusMessage
              type={visibleStatus.type}
              message={visibleStatus.message}
            />
          </div>
        )}

        <p className="text-xs text-amber-400/80 mt-4 leading-relaxed">
          <span className="font-semibold">{t("Note:")}</span>{" "}
          {t("Connecting to WiFi will stop the setup hotspot. You will lose this connection. After reconnecting to the same WiFi, open the device's .local address first. If your phone does not resolve .local, use the IP shown on the device screen.")}
        </p>

        <div className="flex items-center gap-3 mt-3">
          <button
            type="button"
            onClick={connectWifi}
            disabled={connecting || !ssid.trim()}
            className="px-7 py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer"
          >
            {connecting ? t("Connecting...") : t("Connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
