import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  ApiError,
  isStandalonePreview,
  SESSION_CHANGED_EVENT,
  SESSION_EXPIRED_EVENT,
} from "./api";
import type { User } from "./types";

/** Hide cached charts while a foregrounded tab verifies its cookie identity.
 * Keep the workspace mounted so an unchanged session retains unsaved drafts. */
export function SessionPrivacyGuard({
  user,
  onUserChanged,
  onExpired,
}: {
  user: User;
  onUserChanged: (user: User) => void;
  onExpired: () => void;
}) {
  const callbacks = useRef({ onUserChanged, onExpired });
  callbacks.current = { onUserChanged, onExpired };
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    if (isStandalonePreview) return;
    let active = true;
    let sequence = 0;
    let pending: AbortController | undefined;
    const lock = (locked: boolean) => {
      document.documentElement.toggleAttribute(
        "data-cevrali-session-checking",
        locked,
      );
      const root = document.getElementById("root");
      if (root) root.inert = locked;
      setChecking(locked);
    };
    const expire = () => {
      ++sequence;
      lock(false);
      callbacks.current.onExpired();
    };
    const verify = async () => {
      const request = ++sequence;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      lock(true);
      setError("");
      try {
        const current = await api<User>("/auth/me", {
          signal: controller.signal,
        });
        if (!active || request !== sequence) return;
        if (
          current.id !== user.id ||
          current.practice?.id !== user.practice?.id ||
          current.role !== user.role ||
          Boolean(current.is_admin) !== Boolean(user.is_admin)
        ) {
          expire();
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(user))
          callbacks.current.onUserChanged(current);
        lock(false);
      } catch (cause) {
        if (!active || request !== sequence) return;
        if (cause instanceof ApiError && cause.status === 401) expire();
        else
          setError(
            "Your session could not be verified. Retry before returning to patient records.",
          );
      } finally {
        window.clearTimeout(timeout);
        if (pending === controller) pending = undefined;
      }
    };
    const check = () => {
      void verify();
    };
    const blur = () => lock(true);
    const visibility = () =>
      document.visibilityState === "hidden" ? lock(true) : check();
    retry.current = check;
    window.addEventListener("focus", check);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener(SESSION_CHANGED_EVENT, check);
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => {
      active = false;
      ++sequence;
      pending?.abort();
      document.documentElement.removeAttribute("data-cevrali-session-checking");
      const root = document.getElementById("root");
      if (root) root.inert = false;
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener(SESSION_CHANGED_EVENT, check);
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    };
  }, [user.id, user.practice?.id, user.role, user.is_admin]);
  if (!checking || isStandalonePreview) return null;
  return createPortal(
    <section
      className="session-privacy-overlay"
      aria-label="Session verification"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="session-privacy-card">
        <h2>
          {error ? "Unable to verify your session" : "Checking your session…"}
        </h2>
        <p>
          {error ||
            "Patient records are hidden until your account is verified."}
        </p>
        {error && (
          <div className="button-row">
            <button className="button primary" onClick={() => retry.current()}>
              Retry session check
            </button>
            <button
              className="button secondary"
              onClick={() => callbacks.current.onExpired()}
            >
              Return to sign in
            </button>
          </div>
        )}
      </div>
    </section>,
    document.body,
  );
}
