import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

const tabs = [
  { to: "/", label: "Overview" },
  { to: "/matches", label: "Matches" },
  { to: "/decks", label: "Decks" },
  { to: "/drafts", label: "Drafts" },
];

const THEME_STORAGE_KEY = "mtgdata.theme";

type Theme = "dark" | "light";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function Layout() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures and keep the in-memory theme.
    }
  }, [theme]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <p className="kicker">MTGA Local Tracker</p>
          <div className="title-row">
            <span className="title-sigil" aria-hidden="true" />
            <h1>MTGData Control Room</h1>
          </div>
        </div>
        <div className="topbar-controls">
          <nav className="tabs">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === "/"}
                className={({ isActive }) => `tab ${isActive ? "is-active" : ""}`}
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            className={`theme-toggle ${theme === "light" ? "is-light" : ""}`}
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            <span className="theme-toggle-track" aria-hidden="true">
              <span className="theme-toggle-thumb" />
            </span>
            <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
