import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { DeckDetailPage } from "./pages/DeckDetailPage";
import { DecksPage } from "./pages/DecksPage";
import { DraftDetailPage } from "./pages/DraftDetailPage";
import { DraftsPage } from "./pages/DraftsPage";
import { MatchDetailPage } from "./pages/MatchDetailPage";
import { MatchesPage } from "./pages/MatchesPage";
import { OverviewPage } from "./pages/OverviewPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="matches" element={<MatchesPage />} />
        <Route path="matches/:matchId" element={<MatchDetailPage />} />
        <Route path="decks" element={<DecksPage />} />
        <Route path="decks/:deckId" element={<DeckDetailPage />} />
        <Route path="drafts" element={<DraftsPage />} />
        <Route path="drafts/:draftId" element={<DraftDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
