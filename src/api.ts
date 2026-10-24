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
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  if (isStandalonePreview) {
    const { previewApi } = await import("./preview-api");
    return previewApi<T>(path, options);
  }
  const version = contextVersion;
  const checkContext = !path.startsWith("/accounts/") && path !== "/auth/login";
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
  const data = await res.json();
  assertCurrentSession(version);
  if (!res.ok) {
    if (res.status === 401 && checkContext && expectedUser)
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(res.status, data.error || "Request failed");
  }
  if (
    (options?.method || "GET") !== "GET" &&
    (path === "/auth/login" ||
      path === "/auth/logout" ||
      path === "/account/password" ||
      path === "/accounts/signup" ||
      /^\/accounts\/invitations\/[^/]+\/accept$/.test(path))
  )
    notifyOtherTabs();
  return data;
}
export const isStandalonePreview =
  import.meta.env.MODE === "standalone-preview";
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
