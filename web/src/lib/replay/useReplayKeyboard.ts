import { useEffect, useRef } from "react";

export type ReplayKeyboardHandlers = {
  /** When false, the listener is detached entirely. Defaults to true. */
  enabled?: boolean;
  onStepBackward: () => void;
  onStepForward: () => void;
  onPrevTurn: () => void;
  onNextTurn: () => void;
  onTogglePlay: () => void;
  onFirst: () => void;
  onLast: () => void;
};

/**
 * Skip the global shortcut when focus is on an element that handles keys itself
 * — text inputs, the transport buttons (Space activates them), the game-tab
 * roving tablist (arrows switch games), links, etc. Shortcuts then fire when the
 * page body / board has focus, which is the default state.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [role="tab"], [contenteditable="true"]',
    ),
  );
}

/**
 * Board-level keyboard transport: ←/→ step, Shift+←/→ jump a turn, Space
 * play/pause, Home/End to the ends. Attaches once and reads the latest handlers
 * from a ref so inline callbacks don't churn the listener.
 */
export function useReplayKeyboard(handlers: ReplayKeyboardHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const current = handlersRef.current;
      if (current.enabled === false) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          if (event.shiftKey) {
            current.onPrevTurn();
          } else {
            current.onStepBackward();
          }
          break;
        case "ArrowRight":
          event.preventDefault();
          if (event.shiftKey) {
            current.onNextTurn();
          } else {
            current.onStepForward();
          }
          break;
        case " ":
        case "Spacebar":
          event.preventDefault();
          current.onTogglePlay();
          break;
        case "Home":
          event.preventDefault();
          current.onFirst();
          break;
        case "End":
          event.preventDefault();
          current.onLast();
          break;
        default:
          break;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
