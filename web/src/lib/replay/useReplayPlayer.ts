import { useEffect, useState } from "react";

const AUTOPLAY_INTERVAL_MS = 1200;

type ReplayPlayer = {
  /** Current step, always clamped to the valid range for `length`. */
  index: number;
  setIndex: (next: number | ((current: number) => number)) => void;
  isPlaying: boolean;
  setIsPlaying: (next: boolean | ((current: boolean) => boolean)) => void;
  /** Highest valid index (0 when the timeline is empty). */
  lastIndex: number;
};

/**
 * Owns the shared replay transport state — selected step, play/pause, autoplay
 * advance, and re-clamping when the underlying timeline shrinks. Extracted from
 * the previously duplicated state machines in the frame board and the observed
 * timeline board so both stay in lockstep (and so the scrubber/keyboard work in
 * the redesign hangs off one place).
 */
export function useReplayPlayer(
  length: number,
  initialIndex: number,
): ReplayPlayer {
  const [index, setIndex] = useState(initialIndex);
  const [isPlaying, setIsPlaying] = useState(false);
  const lastIndex = length > 0 ? length - 1 : 0;
  const safeIndex = Math.min(index, lastIndex);

  useEffect(() => {
    if (length === 0) {
      setIndex(0);
      setIsPlaying(false);
      return;
    }
    setIndex((current) => Math.min(current, length - 1));
  }, [length]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    if (safeIndex >= lastIndex) {
      setIsPlaying(false);
      return;
    }

    const timeoutID = window.setTimeout(() => {
      setIndex(Math.min(safeIndex + 1, lastIndex));
    }, AUTOPLAY_INTERVAL_MS);

    return () => window.clearTimeout(timeoutID);
  }, [isPlaying, lastIndex, safeIndex]);

  return { index: safeIndex, setIndex, isPlaying, setIsPlaying, lastIndex };
}
