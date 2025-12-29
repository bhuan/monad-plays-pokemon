import { useEffect, useCallback, RefObject } from "react";
import { Action, type ActionType } from "../config/wagmi";

// Keyboard mapping for GameBoy controls
const KEY_MAPPINGS: Record<string, ActionType> = {
  // Arrow keys for D-pad
  ArrowUp: Action.UP,
  ArrowDown: Action.DOWN,
  ArrowLeft: Action.LEFT,
  ArrowRight: Action.RIGHT,
  // WASD alternative for D-pad
  w: Action.UP,
  W: Action.UP,
  s: Action.DOWN,
  S: Action.DOWN,
  a: Action.LEFT,
  A: Action.LEFT,
  d: Action.RIGHT,
  D: Action.RIGHT,
  // Z/X for B/A (common emulator mapping)
  z: Action.B,
  Z: Action.B,
  x: Action.A,
  X: Action.A,
  // J/K alternative for B/A
  j: Action.B,
  J: Action.B,
  k: Action.A,
  K: Action.A,
  // Enter for START
  Enter: Action.START,
  // Shift for SELECT
  Shift: Action.SELECT,
};

interface UseKeyboardControlsOptions {
  /** Ref to the focusable container element */
  containerRef: RefObject<HTMLElement>;
  /** Callback to trigger a vote action */
  onVote: (action: ActionType) => void;
  /** Whether keyboard controls are enabled */
  enabled?: boolean;
}

/**
 * Hook to handle keyboard controls for voting.
 * Only active when the container element has focus.
 *
 * Key mappings:
 * - Arrow keys / WASD: D-pad (UP, DOWN, LEFT, RIGHT)
 * - Z/J: B button
 * - X/K: A button
 * - Enter: START
 * - Shift: SELECT
 * - Escape: Blur/release focus
 */
export function useKeyboardControls({
  containerRef,
  onVote,
  enabled = true,
}: UseKeyboardControlsOptions) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      // Escape releases focus
      if (event.key === "Escape") {
        containerRef.current?.blur();
        return;
      }

      // Check if key maps to an action
      const action = KEY_MAPPINGS[event.key];
      if (action !== undefined) {
        // Prevent default browser behavior (scrolling, etc.)
        event.preventDefault();
        onVote(action);
      }
    },
    [enabled, onVote, containerRef]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    container.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("keydown", handleKeyDown);
    };
  }, [containerRef, handleKeyDown, enabled]);
}

/**
 * Returns a human-readable description of keyboard controls
 */
export function getKeyboardControlsHelp(): string {
  return `Keyboard Controls:
  ↑/W: UP    ↓/S: DOWN    ←/A: LEFT    →/D: RIGHT
  Z/J: B     X/K: A       Enter: START  Shift: SELECT
  Escape: Release focus`;
}
