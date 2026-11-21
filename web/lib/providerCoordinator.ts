/** Self-hosted provider gateway. Only ARVIO account JWTs cross the browser/API boundary.
 * OAuth access/refresh grants stay in the private-cloud PostgreSQL coordinator.
 */
import { config } from "./config";
import { HttpError } from "./http";
import { authClient } from "./store/clients";

export type ProviderName = "simkl" | "wetrakr";
export type ProviderAction = "status" | "start" | "poll" | "disconnect" | "request";
export type ProviderStatus = {
  provider: ProviderName;
  status: string;
  connected: boolean;
  username: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
};
export type DeviceCodeStart = { userCode: string; verificationUrl: string; expiresIn: number; interval: number };

export async function providerCoordinatorEnvelope<T>(
  provider: ProviderName,
  profileId: string,
  action: ProviderAction,
  extra: Record<string, unknown> = {}
): Promise<{ data: T; headers: Headers }> {
  if (!config.selfHosted) throw new Error("Cloud provider coordination requires self-hosted ARVIO.");
  if (!profileId || profileId.length > 128) throw new Error("Select a valid ARVIO profile first.");
  const sessionId = authClient.session?.userId;
  if (!sessionId) throw new Error("Sign in to ARVIO to use this provider.");
  const bearer = await authClient.accessToken();
  if (authClient.session?.userId !== sessionId) throw new Error("ARVIO account changed while authorizing.");
  const base = config.netlifyBackendUrl.replace(/\/+$/, "");
  if (!base) throw new Error("ARVIO private-cloud API is not configured.");
  const response = await fetch(`${base}/provider-coordinator`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ provider, profileId, action, ...extra }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000)
  });
  const data: unknown = await response.json().catch(() => ({}));
  // Never publish a response from a different account or profile generation.
  if (authClient.session?.userId !== sessionId) throw new Error("ARVIO account changed during provider request.");
  if (!response.ok) {
    const error = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error?: unknown }).error ?? "") : "";
    const safe = error === "reconnect_required" ? "Reconnect the provider in ARVIO Settings."
      : error === "connection_required" ? "Connect the provider in ARVIO Settings."
      : error === "provider_coordinator_unavailable" ? "The provider service is temporarily unavailable. Please retry."
      : error === "device_code_expired" ? "The device code expired. Request another."
      : error || `Provider request failed (${response.status}).`;
    throw new HttpError(response.status, safe, response.headers.get("retry-after"));
  }
  return { data: data as T, headers: response.headers };
}

export async function providerCoordinator<T>(
  provider: ProviderName, profileId: string, action: ProviderAction,
  extra: Record<string, unknown> = {}
): Promise<T> {
  return (await providerCoordinatorEnvelope<T>(provider, profileId, action, extra)).data;
}

export async function providerCoordinatorRequest<T>(
  provider: ProviderName, profileId: string, path: string, method = "GET", body?: unknown
): Promise<{ data: T; headers: Headers }> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid provider API path.");
  return providerCoordinatorEnvelope<T>(provider, profileId, "request", {
    path, method, ...(body === undefined ? {} : { body })
  });
}
