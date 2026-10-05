import {
  callCambio,
  discardDrawn,
  drawDeck,
  kingDecide,
  makeAiView,
  skipPower,
  swapDrawn,
  takeDiscard,
  useBlindSwap,
  useKingLook,
  usePeekOpp,
  usePeekOwn,
  type Game,
  type Move,
} from "./engine";
import { kingDecision, type AiAction } from "./brain";

/**
 * One step of an AI action, applied to whatever the game looks like *at that moment*. Burns can
 * happen between steps (from either player), so steps never reuse a stale game state. A step
 * returns null when it no longer applies; the caller then re-decides.
 */
export type Step = (g: Game) => Move | null;

export function aiSteps(a: AiAction): Step[] {
  switch (a.type) {
    case "call": return [(g) => callCambio(g, "ai")];
    case "draw": return [(g) => drawDeck(g, "ai")];
    case "take": return [(g) => takeDiscard(g, "ai")];
    case "swap": return [(g) => swapDrawn(g, "ai", a.slot)];
    case "discard":
      return [(g) => discardDrawn(g, "ai"), (g) => (g.phase === "power" ? skipPower(g, "ai") : null)];
    case "power": {
      const use: Step =
        a.kind === "peekOwn" ? (g) => usePeekOwn(g, "ai", a.ownSlot!)
        : a.kind === "peekOpp" ? (g) => usePeekOpp(g, "ai", a.oppSlot!)
        : a.kind === "blindSwap" ? (g) => useBlindSwap(g, "ai", a.ownSlot!, a.oppSlot!)
        : (g) => useKingLook(g, "ai", a.ownSlot!, a.oppSlot!);
      const steps: Step[] = [(g) => discardDrawn(g, "ai"), use];
      if (a.kind === "king")
        steps.push((g) => {
          const pick = kingDecision(makeAiView(g));
          return kingDecide(g, "ai", pick?.own ?? null, pick?.opp ?? null);
        });
      return steps;
    }
  }
}

/** Play an action straight through (used by the simulator, where nothing happens in between). */
export function aiMoves(g0: Game, a: AiAction): Move[] {
  const moves: Move[] = [];
  let g = g0;
  for (const step of aiSteps(a)) {
    const m = step(g);
    if (!m) {
      // A discard with no power has no power to skip; anything else is a real error.
      if (a.type === "discard" && g.phase !== "power") break;
      throw new Error(`Illegal AI move: ${JSON.stringify(a)}`);
    }
    moves.push(m);
    g = m.g;
  }
  return moves;
}
