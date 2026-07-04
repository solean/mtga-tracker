import { createContext, useContext } from "react";

export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

export type ThemeContextValue = {
  /** Resolved theme actually applied to the document. */
  theme: Theme;
  /** Stored preference; "system" follows prefers-color-scheme. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

export const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  preference: "dark",
  setPreference: () => {},
});

export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

export function useThemeControls(): ThemeContextValue {
  return useContext(ThemeContext);
}
