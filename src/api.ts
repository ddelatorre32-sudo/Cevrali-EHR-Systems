export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let expectedPractice: string | undefined;
let expectedUser: string | undefined;
let expectedRole: string | undefined;
let expectedAdmin: boolean | undefined;
let contextVersion = 0;
export const SESSION_EXPIRED_EVENT = "cevrali:session-expired";
export const SESSION_CHANGED_EVENT = "cevrali:session-changed";
const channelName = "cevrali-session";
let sessionChannel: BroadcastChannel | undefined;
if (
  typeof window !== "undefined" &&
  import.meta.env.MODE !== "standalone-preview"
) {
  if ("BroadcastChannel" in window) {
    sessionChannel = new BroadcastChannel(channelName);
    sessionChannel.onmessage = () =>
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  }
  window.addEventListener("storage", (event) => {
    if (event.key === channelName)
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  });
}
function notifyOtherTabs() {
  sessionChannel?.postMessage("changed");
  if (!sessionChannel) {
    try {
      localStorage.setItem(channelName, `${Date.now()}:${Math.random()}`);
    } catch {
      /* Focus revalidation remains available. */
    }
  }
}
export function setPracticeContext(
  id?: string,
  userId?: string,
  role?: string,
  isAdmin?: boolean,
) {
  if (
    id !== expectedPractice ||
    userId !== expectedUser ||
    role !== expectedRole ||
    isAdmin !== expectedAdmin
  )
    contextVersion++;
  expectedPractice = id;
  expectedUser = userId;
  expectedRole = role;
  expectedAdmin = isAdmin;
}
export const sessionContextVersion = () => contextVersion;
export function assertCurrentSession(version: number) {
  if (version !== contextVersion)
    throw new ApiError(
      409,
      "Your account session changed while this request was processing.",
    );
}
function responseError(status: number) {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You do not have permission to perform this action.";
  if (status >= 500)
    return "Cevrali is temporarily unavailable. Please try again.";
  return "The server returned an unexpected response. Please try again.";
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  if (isStandalonePreview) {
    const { previewApi } = await import("./preview-api");
    return previewApi<T>(path, options);
  }
  const version = contextVersion;
  const checkContext = !path.startsWith("/accounts/") &&
    !path.startsWith("/auth/mfa/") && path !== "/auth/login" && path !== "/runtime";
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(expectedPractice && checkContext
        ? { "X-Cevrali-Practice": expectedPractice }
        : {}),
      ...(expectedUser && checkContext
        ? { "X-Cevrali-User": expectedUser }
        : {}),
      ...(expectedRole && checkContext
        ? { "X-Cevrali-Role": expectedRole }
        : {}),
      ...(expectedAdmin !== undefined && checkContext
        ? { "X-Cevrali-Admin": String(expectedAdmin) }
        : {}),
      ...options?.headers,
    },
  });
  // Hosting gateways can return HTML while the application is restarting.
  // Keep the HTTP status and show a useful error instead of a JSON parser error.
  const body = await res.text();
  // Runtime metadata is public and independent of the account being signed in.
  if (path !== "/runtime") assertCurrentSession(version);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    // The error response below deliberately excludes gateway markup.
  }
  if (!res.ok) {
    if (res.status === 401 && checkContext && expectedUser)
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    const message =
      data && typeof data === "object" && "error" in data &&
      typeof data.error === "string"
        ? data.error
        : responseError(res.status);
    throw new ApiError(res.status, message);
  }
  if (data === undefined)
    throw new ApiError(502, responseError(502));
  const changedUser = data && typeof data === "object" && "id" in data;
  const verifiedSecurity = data && typeof data === "object" && "ok" in data && data.ok === true;
  if ((options?.method || "GET") !== "GET" && (
    path === "/auth/logout" ||
    (changedUser && (path === "/auth/login" || path === "/account/password" ||
      path === "/accounts/signup" || /^\/accounts\/invitations\/[^/]+\/accept$/.test(path))) ||
    (verifiedSecurity && /^\/(?:auth\/mfa\/(?:complete|enroll)|account\/mfa\/(?:confirm|enroll|recovery-codes|disable))$/.test(path))
  ))
    notifyOtherTabs();
  return data as T;
}
export const isStandalonePreview =
  import.meta.env.MODE === "standalone-preview";
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
