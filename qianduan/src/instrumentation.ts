export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmChannelStatusCache } = await import(
    "@/lib/channels/channel-status-cache"
  );
  warmChannelStatusCache();
}
