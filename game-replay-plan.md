# Game Replay — Redesign Plan

*A plan to 100× the UI/UX of the match replay feature. Grounded in the current
implementation (`web/src/pages/MatchDetailPage.tsx`, ~4,090 lines) and the
amber-on-black "night operations" design system in `web/src/styles.css`.*

Status markers: ✅ done · 🔲 open · 🟡 in progress

> **Progress — 2026-06-16:** ✅ **Phase 0 complete.** The enabling refactor
> shipped: pure replay logic extracted to `web/src/lib/replay/index.ts` (78
> declarations; the page dropped ~4,090 → ~3,030 lines), the duplicated transport
> state machine unified into `web/src/lib/replay/useReplayPlayer.ts`, and a test
> runner wired up (`bun test`) with `web/test/replay.test.ts`. No behavior change
> — verified by `tsc -b`, `bun run build`, and **21 passing tests**. Next up:
> **Phase 1** (HUD strip + keyboard nav + speed control).

---

## TL;DR

The replay is **functionally rich but perceptually a database viewer**. The data
model is genuinely excellent — every frame carries per-object power/toughness,
tapped/summoning-sick, attack & block state, counters, controller-vs-owner
(stolen), plus frame-level life totals, win reason, and an annotations stream
already mined for spell targets and exile-under-card. That is a *complete
game-state diff stream*.

The UI spends that richness on clinical narration and vertical stacking. The work
is not "add features" — it is **re-found the screen around watching a game**, then
layer analysis affordances on top. Five moves do most of it: a mirrored arena, a
persistent HUD, a scrubber with a life sparkline, a turn-grouped play-by-play
rail, and keyboard + speed controls.

Phases 1–3 alone deliver ~80% of the perceived "100×."

---

## Core diagnosis

What's strong:
- The amber-on-black terminal aesthetic is distinctive and consistent.
- Real card art, tapped/summoning-sick badges, combat/spell-target arrows,
  zone viewer dialogs, linked exile stacks — all already implemented.
- The underlying frame/object/change/annotation model is complete and per-step.

What's holding it back:
1. **Vertical scroll instead of a board.** The board is three lanes stacked
   top-to-bottom (`opponent → you → hand`) that you scroll through
   (`MatchDetailPage.tsx` ~3010). You never see the whole game state at once. A
   real MTG table is two mirrored halves seen together.
2. **Life totals are buried.** They live as stat tiles in a left sidebar and are
   re-stated inside a muted sentence —
   `"30 tracked cards visible • stack empty • You 20 • Opponent 18"`
   (`frameVisibilitySummary`, ~2801). The most important number in the game is
   the hardest to find.
3. **Narration is literal GRE-speak.** `describeReplayChange` (~1255) emits
   *"Opponent declared Otter as a blocker."* — correct, but a log line, not a
   play-by-play.
4. **Navigation is thin.** Five buttons + a turn-pill row (~2866–2942). No
   scrubber, no keyboard shortcuts, no speed control, no life graph. Autoplay is
   hardcoded to `1200ms` (~2572). Keyboard nav exists only on the game *tabs*
   (~3727), not the board.
5. **Inverted hierarchy.** Section chrome (`OPPONENT BATTLEFIELD`, `LANDS`,
   `ARTIFACTS + ENCHANTMENTS`…) is as visually heavy as the cards. The labels
   shout, the cards whisper.

---

## The five big moves

### 1. A fixed-height mirrored "arena," not a scroll 🔲
Collapse the sidebar + three vertical lanes into one board taken in at a glance:
opponent's permanents on top, yours on the bottom, hand fanned at the foot, stack
floating top-right, life pods at the poles.

- Change `.match-replay-canvas` (`styles.css` ~1948) from
  `sidebar + board-column` to a single arena; make the lanes share a row instead
  of stacking.
- The per-side components already exist (`MatchReplayFrameBattlefield`,
  `MatchReplayHand`, `MatchReplayStack`) — they need to be composed spatially,
  not in a column.
- Biggest perceptual jump; mostly layout/CSS.

### 2. A persistent HUD strip 🔲
Both players' life **big**, a Δ flash on change (reuse `replayFrameHasLifeDelta`,
~992), turn + phase, active player, and the current beat as a **headline**.
Replaces the buried `frameVisibilitySummary` sentence. The "what's happening now"
anchor that never moves.

### 3. A scrubber with a dual life sparkline 🔲
REVIEW items 5 & 6 in one component. A full-width track: one tick per step, turn
boundaries marked, a draggable playhead, and your/opponent life drawn as two
lines across the whole game (the comeback, the burn turn made visible) and
clickable.

- Replaces the turn-pill row (`MatchReplayTurnSelector`, ~2470) with something
  denser and more useful.
- All data already on the frames (`selfLifeTotal` / `opponentLifeTotal`).

### 4. A turn-grouped play-by-play rail 🔲
The "List" view reborn as a chess-style move list that co-pilots the board
instead of living in a separate tab. Current beat highlighted, click any line to
jump, turns as group headers. Where the narration improvements pay off.

### 5. Keyboard + speed 🔲
`←/→` step, `Shift+←/→` turn, `Space` play/pause, `Home/End`, and a
0.5×/1×/2×/4× speed control. Cheapest win, highest "feels pro" payoff.

---

## Polish wins that punch above their weight

- **Coalesce GRE noise and humanize narration** (REVIEW item 4) 🔲 —
  `filterMeaningfulReplayFrames` (~1016) drops empty frames but doesn't *merge* a
  cast→target→resolve, or roll all attackers into one "attacks with Otter + 2
  others" beat. Narration should fold in P/T and the life swing: *"Otter (2/2)
  blocks Tarmogoyf (4/4) — attacker survives, you take 0."* All inputs exist
  (`replayObjectPTLabel`, block-attacker IDs, life deltas).
- **Make combat a moment** 🔲 — the attack/block arrows
  (`MatchReplayConnectionOverlay`, ~1674) are nice and underused. In an arena
  layout, highlight the combat step, advance attackers toward the defender, show
  damage math.
- **Card motion between zones (the real 100× kicker)** 🔲 — `instanceId` is
  stable across frames, so a FLIP transition can slide a card
  hand→stack→battlefield→graveyard as you step. Converts "stepping through
  snapshots" into "watching a replay." Big effort, biggest wow.
- **Auto-detected key moments** 🔲 — chapter pins on the scrubber: biggest life
  swing, the turn the game was decided (derive from existing
  `terminalReplayFrameConfidence`), each mulligan. Turns a 66-step replay into a
  skimmable story.
- **Rename "T?" → "Pre-game"** and fix "G1: Play/Draw reads as a result"
  (REVIEW item 3) while in here. 🔲

---

## Enabling refactor (do this first — it is load-bearing)

You cannot comfortably build the above inside a 4,090-line file. REVIEW already
calls this *"the highest-value refactor in the repo."*

- ✅ **Extract `lib/replay/`** as pure, unit-testable functions — *done: 78
  declarations (types, zone/label helpers, object inspection, annotations, life,
  frame filtering, turn boundaries, narration, game summaries) moved verbatim out
  of the page into `web/src/lib/replay/index.ts`. The component dropped from
  ~4,090 → ~3,030 lines and now imports them. No behavior change; verified by
  typecheck + build + tests.*
- ✅ **Extract a `useReplayPlayer` hook** owning the transport state machine
  (selected step, play/pause, autoplay advance, re-clamp on shrink) — *done:
  `web/src/lib/replay/useReplayPlayer.ts`, now the single source for both
  `MatchReplayFrameBoard` and `MatchTimelineBoard`, which previously held
  duplicated copies. `speed` + `keyboard` are deliberately left for Phase 1 to
  keep Phase 0 a pure no-behavior-change refactor — the hook is structured so
  they drop in here.*
- ✅ **Test runner wired up** — *done: standardized on `bun test` (added `test`
  + `typecheck` scripts to `web/package.json`) rather than adding vitest, since
  the existing `rankProgress.test.ts` already uses `bun:test` and Bun is the
  package manager. New `web/test/replay.test.ts` covers zone classification,
  turn boundaries, meaningful-frame filtering, narration, win-reason formatting,
  and game-result inference. 21 tests pass.*
- 🔲 **Split `components/replay/`**: `Arena`, `Hud`, `Scrubber`, `MoveList`,
  `Board`, `ConnectionOverlay`. Mechanical, but it makes moves 1–5 each a
  contained PR. *(Not started — the React components still live in
  `MatchDetailPage.tsx`. Splitting `lib/replay/index.ts` into themed files
  — `labels`, `objects`, `frames`, `summary`, `narration` — is a trivial
  follow-up too.)*
- 🔲 **Smoothness prerequisite**: previews fetch per-card from Scryfall at render
  (`lib/scryfall.ts`), so the board pops in. The local-card-DB bulk import
  (REVIEW item) makes the arena render instantly and unblocks the card-motion
  idea.

---

## Sequencing

| Phase | Ships | Effort | Notes |
|---|---|---|---|
| 0 ✅ | Extract `lib/replay/` + `useReplayPlayer` + wire up `bun test` | M | Done — unblocks everything; no behavior change (typecheck + build + 21 tests green) |
| 1 | HUD strip + keyboard + speed | S | Immediate feel upgrade |
| 2 | Scrubber + life sparkline (retire turn pills) | M | |
| 3 | Mirrored arena layout | M | Biggest visual jump |
| 4 | Coalesced beats + humanized play-by-play rail | M | |
| 5 | Combat moments, card motion, key-moment pins | L | The "wow" tier |

Phases 1–3 get ~80% of the perceived "100×."

---

## Code reference index

| Concern | Location (`web/src/pages/MatchDetailPage.tsx` unless noted) |
|---|---|
| Main board component (owns index/playing) | `MatchReplayFrameBoard` ~2525 |
| Observed-plays fallback board (duplicate state machine) | `MatchTimelineBoard` ~3231 |
| Transport buttons (no scrubber/keyboard/speed) | ~2866–2942 |
| Hardcoded autoplay interval (`1200ms`) | ~2572 |
| Turn-pill row (replace with scrubber) | `MatchReplayTurnSelector` ~2470 |
| Clinical narration | `describeReplayChange` ~1255 |
| Frame filtering (no coalescing yet) | `filterMeaningfulReplayFrames` ~1016 |
| Life delta detection | `replayFrameHasLifeDelta` ~992 |
| Buried life/visibility sentence | `frameVisibilitySummary` ~2801 |
| Combat / spell-target arrows | `MatchReplayConnectionOverlay` ~1674 |
| Game-result inference | `summarizeReplayGame` / `terminalReplayFrameConfidence` ~1144 / ~1127 |
| Keyboard nav (tabs only, not board) | `handleTimelineGameTabKeyDown` ~3727 |
| Canvas layout (sidebar + board column) | `.match-replay-canvas` `styles.css` ~1948 |
| Data model | `web/src/lib/types.ts` ~60–120 |
| Per-card preview fetch (pops in at render) | `web/src/lib/scryfall.ts` |
