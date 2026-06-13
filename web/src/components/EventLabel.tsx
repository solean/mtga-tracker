import { eventDisplayName, parseEventName } from "../lib/events";
import type { SetLookup } from "../lib/useEventSets";
import { SetSymbol } from "./SetSymbol";

/**
 * Renders a raw Arena event name as a friendly label (kind + set name) with the
 * set symbol when available. Pass `lookup` from useEventSets to resolve set
 * metadata.
 */
export function EventLabel({
  eventName,
  lookup,
  showSymbol = true,
  fallback = "-",
}: {
  eventName?: string | null;
  lookup?: SetLookup;
  showSymbol?: boolean;
  /** Shown when there is no event name at all. */
  fallback?: string;
}) {
  if (!eventName || !eventName.trim()) {
    return <>{fallback}</>;
  }

  const parsed = parseEventName(eventName);
  const setInfo = lookup?.(parsed.setCode);
  const label = eventDisplayName(parsed, setInfo);

  return (
    <span className="event-label" title={parsed.raw}>
      {showSymbol && setInfo?.iconSvgUri ? (
        <SetSymbol iconSvgUri={setInfo.iconSvgUri} name={setInfo.name} />
      ) : null}
      <span className="event-label-text">{label}</span>
    </span>
  );
}
