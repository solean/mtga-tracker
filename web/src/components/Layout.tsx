import { NavLink, Outlet } from "react-router-dom";

const tabs = [
  { to: "/", label: "Overview" },
  { to: "/matches", label: "Matches" },
  { to: "/decks", label: "Decks" },
  { to: "/drafts", label: "Drafts" },
];

export function Layout() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">MTGA Local Tracker</p>
          <h1>MTGData Control Room</h1>
        </div>
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
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
