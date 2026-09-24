"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import ProgressBar from "./ProgressBar";
import WifiStep from "./WifiStep";
import DoneStep from "./DoneStep";
import { isLocalChannelPreview, resolveSetupFlowState } from "@/lib/setup-flow";
import LanguageSelector from "./LanguageSelector";
import { useI18n } from "./I18nProvider";
import type { LocalizedMessage } from "@/lib/i18n";

function applyStatusData(
  data: Record<string, unknown>,
  setSetupComplete: (v: boolean) => void,
  setCurrentStep: (v: number) => void
) {
  const nextState = resolveSetupFlowState(data);
  setSetupComplete(nextState.setupComplete);
  setCurrentStep(nextState.currentStep);
}

export default function SetupWizard() {
  const { t, translateText } = useI18n();
  const [currentStep, setCurrentStep] = useState(1);
  const [setupComplete, setSetupComplete] = useState(false);
  const [localChannelPreview, setLocalChannelPreview] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [wifiStatusHint, setWifiStatusHint] = useState<{
    type: "success" | "error";
    message: LocalizedMessage;
  } | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setLocalChannelPreview(isLocalChannelPreview(window.location));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const r = await fetch("/setup-api/setup/status", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!r.ok) {
          throw new Error(`Status check failed (${r.status})`);
        }
        const data = await r.json();
        if (cancelled) return;
        applyStatusData(data, setSetupComplete, setCurrentStep);
        if (typeof data?.wifi_last_error === "string" && data.wifi_last_error.trim()) {
          setWifiStatusHint({
            type: "error",
            message: data.wifi_last_error,
          });
        } else if (data?.wifi_connecting) {
          const targetSsid =
            typeof data?.wifi_target_ssid === "string" && data.wifi_target_ssid.trim()
              ? data.wifi_target_ssid
              : "WiFi";
          setWifiStatusHint({
            type: "success",
            message: {
              key: "Connecting to {ssid} and waiting for a DHCP address. If the connection fails, reconnect to the setup hotspot and try again.",
              values: { ssid: targetSsid },
            },
          });
        } else if (data?.wifi_configured && data?.wifi_mode === "client") {
          const connectedSsid =
            typeof data?.wifi_target_ssid === "string" && data.wifi_target_ssid.trim()
              ? data.wifi_target_ssid
              : "WiFi";
          setWifiStatusHint({
            type: "success",
            message: {
              key: "Connected to {ssid}. You can continue setup on this network.",
              values: { ssid: connectedSsid },
            },
          });
        } else {
          setWifiStatusHint(null);
        }
        setSetupError(null);
        if (data?.wifi_connecting) {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error("[SetupWizard] Failed to fetch setup status:", err);
        setSetupError(err instanceof Error ? err.message : "Failed to load setup status");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [retryCount]);

  const visibleStep = localChannelPreview ? 2 : currentStep;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" role="status" aria-label={t("Loading")} />
      </div>
    );
  }

  if (setupError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <p className="text-[var(--coral-bright)] text-sm mb-4">{translateText(setupError)}</p>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer transition transform hover:scale-105"
          >
            {t("Retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="px-4 py-2.5 sm:px-6 sm:py-4 flex items-center justify-between gap-3 sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold font-display title-gradient">
              ClawBox
            </span>
            <span className="text-[10px] text-green-400 -mt-1">
              {process.env.NEXT_PUBLIC_APP_VERSION?.match(/^(v\d+\.\d+\.\d+)/)?.[1] ?? process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          </div>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          {visibleStep < 2 && <ProgressBar currentStep={visibleStep} />}
          <LanguageSelector />
        </div>
      </header>

      <main
        className="flex-1 flex flex-col items-center justify-start sm:justify-center px-4 pt-2 pb-4 sm:p-6"
      >
        {visibleStep === 1 && <WifiStep externalStatus={wifiStatusHint} />}
        {visibleStep === 2 && <DoneStep setupComplete={setupComplete} />}
      </main>

      <footer className="px-4 py-3 flex items-center justify-center gap-3">
        <a
          href="https://openclawhardware.dev/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("ClawBox website")}
          className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] transition transform hover:scale-105"
        >
          <Image src="/clawbox-logo.png" alt="ClawBox" width={28} height={28} className="w-7 h-7 object-contain" />
        </a>
      </footer>
    </>
  );
}
