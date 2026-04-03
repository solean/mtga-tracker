import { useEffect, useState } from "react";

const SCRYFALL_SYMBOL_BASE_URL = "https://svgs.scryfall.io/card-symbols";

function manaSymbolAssetToken(token: string): string {
  return token.trim().toUpperCase().replace(/\//g, "").replace(/\s+/g, "");
}

function manaSymbolURL(token: string): string {
  return `${SCRYFALL_SYMBOL_BASE_URL}/${encodeURIComponent(
    manaSymbolAssetToken(token),
  )}.svg`;
}

export function ManaSymbol({ token }: { token: string }) {
  const [didFail, setDidFail] = useState(false);
  const label = `{${token}}`;

  useEffect(() => {
    setDidFail(false);
  }, [token]);

  if (didFail) {
    return (
      <code className="mana-symbol-fallback" aria-label={label}>
        {label}
      </code>
    );
  }

  return (
    <img
      className="mana-symbol-icon"
      src={manaSymbolURL(token)}
      alt={label}
      loading="lazy"
      decoding="async"
      onError={() => setDidFail(true)}
    />
  );
}
