import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigationType } from "react-router-dom";

const tabs = [
  { to: "/", label: "Overview" },
  { to: "/matches", label: "Matches" },
  { to: "/decks", label: "Decks" },
  { to: "/drafts", label: "Drafts" },
];

const THEME_STORAGE_KEY = "mtgdata.theme";
const scrollPositions = new Map<string, number>();

type Theme = "dark" | "light";

function pageTitle(pathname: string): string {
  if (pathname === "/") return "Overview";
  if (pathname === "/matches") return "Matches";
  if (pathname.startsWith("/matches/")) return "Match Detail";
  if (pathname === "/decks") return "Decks";
  if (pathname.startsWith("/decks/")) return "Deck Detail";
  if (pathname === "/drafts") return "Drafts";
  if (pathname.startsWith("/drafts/")) return "Draft Detail";
  return "MTGData Control Room";
}

function applyThemeColorMeta(theme: Theme) {
  const head = document.head;
  if (!head) return;

  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement("meta");
    metaThemeColor.setAttribute("name", "theme-color");
    head.appendChild(metaThemeColor);
  }

  metaThemeColor.setAttribute("content", theme === "dark" ? "#080c15" : "#e2e8ee");
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function Layout() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyThemeColorMeta(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures and keep the in-memory theme.
    }
  }, [theme]);

  useEffect(() => {
    const context = pageTitle(location.pathname);
    document.title = context === "MTGData Control Room" ? context : `${context} · MTGData Control Room`;
  }, [location.pathname]);

  useEffect(() => {
    return () => {
      scrollPositions.set(location.key, window.scrollY);
    };
  }, [location.key]);

  useEffect(() => {
    if (navigationType === "POP") {
      const top = scrollPositions.get(location.key) ?? 0;
      window.scrollTo({ top, left: 0, behavior: "auto" });
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.key, navigationType]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <p className="kicker">Tactical Data System</p>
          <div className="title-row">
            <span className="title-sigil" aria-hidden="true" />
            <h1>MTGData Control Room</h1>
          </div>
        </div>
        <div className="topbar-controls">
          <nav className="tabs" aria-label="Primary">
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
            aria-pressed={theme === "light"}
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
      <main id="main-content" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
