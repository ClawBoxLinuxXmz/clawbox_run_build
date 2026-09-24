export interface SetupFlowStatus {
  setup_complete?: boolean;
  wifi_configured?: boolean;
  wifi_mode?: string;
  hotspot_active?: boolean;
}

export interface SetupFlowState {
  currentStep: 1 | 2;
  setupComplete: boolean;
}

export function isLocalChannelPreview(
  location: Pick<Location, "hostname" | "search">,
): boolean {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!localHosts.has(location.hostname)) return false;
  return new URLSearchParams(location.search).get("preview") === "channels";
}

export function resolveSetupFlowState(
  data: SetupFlowStatus,
): SetupFlowState {
  const wifiMode = typeof data.wifi_mode === "string" ? data.wifi_mode : "unknown";
  const hotspotActive = data.hotspot_active === true || wifiMode === "ap";

  if (hotspotActive) {
    return {
      currentStep: 1,
      setupComplete: false,
    };
  }

  if (data.setup_complete) {
    return {
      currentStep: 2,
      setupComplete: true,
    };
  }

  if (data.wifi_configured) {
    return {
      currentStep: 2,
      setupComplete: false,
    };
  }

  return {
    currentStep: 1,
    setupComplete: false,
  };
}
