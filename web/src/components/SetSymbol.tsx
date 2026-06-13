/**
 * Renders a Scryfall set icon (a monochrome SVG) as a CSS mask so it picks up
 * the surrounding text color instead of rendering as invisible black on the
 * dark theme.
 */
export function SetSymbol({ iconSvgUri, name }: { iconSvgUri: string; name?: string }) {
  return (
    <span
      className="set-symbol"
      role="img"
      aria-label={name ? `${name} set symbol` : "Set symbol"}
      style={{
        maskImage: `url("${iconSvgUri}")`,
        WebkitMaskImage: `url("${iconSvgUri}")`,
      }}
    />
  );
}
