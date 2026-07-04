import { createContext, useContext } from "react";

export type Theme = "dark" | "light";

export type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

export const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
});

export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

export function useThemeControls(): ThemeContextValue {
  return useContext(ThemeContext);
}
