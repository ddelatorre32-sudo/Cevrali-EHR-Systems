import { useEffect, useRef } from "react";

/** Focus an explicitly selected work item once, after its source has loaded. */
export function useWorkSourceFocus(elementId?: string) {
  const focused = useRef("");
  useEffect(() => {
    if (!elementId || focused.current === elementId) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(elementId);
      if (!element) return;
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
      focused.current = elementId;
    });
    return () => cancelAnimationFrame(frame);
  }, [elementId]);
}
