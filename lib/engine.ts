import {
  ALL_CARDS,
  cardValue,
  makeDeck,
  powerOf,
  shuffle,
  type Card,
  type PowerKind,
  type Rank,
} from "./cards";

/**
 * Deterministic Cambio engine. All rules live here; neither the model nor the LLM can break them.
 * Pure functions: every move returns a new Game plus the public events it produced.
 */

export type Side = "human" | "ai";
export const other = (s: Side): Side => (s === "human" ? "ai" : "human");

export type Hand = (Card | null)[];
export type Phase = "peek" | "start" | "drawn" | "power" | "king" | "ended";

export const MIN_TURNS_BEFORE_CALL = 0;
/** Everyone starts by looking at these two of their own cards. */
export const START_PEEK_SLOTS: [number, number] = [0, 1];
export const MAX_SLOTS = 8;
/** Safety net: a round that somehow runs this long is scored as it stands. */
export const MAX_TOTAL_TURNS = 80;

export interface Result {
  human: number;
  ai: number;
  winner: Side | "tie";
  calledBy: Side | null;
}

export interface Game {
  deck: Card[];
  discard: Card[];
  hands: Record<Side, Hand>;
  /** Card ids each side has looked at. Knowledge follows the card, wherever it moves. */
  seen: Record<Side, number[]>;
  turn: Side;
  phase: Phase;
  drawn: { card: Card; from: "deck" | "discard" } | null;
  power: PowerKind | null;
  /** In the king phase: the opponent slot the current player just looked at. */
  kingTarget: number | null;
  /** In the king phase: the current player's own slot they just looked at. */
  kingOwn: number | null;
  /**
   * Burning. Whenever a new card lands on the discard pile, anyone may burn a card of the same
   * rank from any hand. The first player to burn it locks the other out (and may keep going).
   */
  burnRank: Rank | null;
  burnedBy: Side | null;
  /** Players who guessed wrong on the current card; they can't try again until a new card lands. */
  burnMissed: Side[];
  /** After burning an opponent's card, the burner owes them a card for that empty slot. */
  pendingGive: { by: Side; slot: number } | null;
  turnsTaken: Record<Side, number>;
  calledBy: Side | null;
  finalFor: Side | null;
  peeked: Record<Side, boolean>;
  result: Result | null;
}

/** Everything observers (the AI's model, the move log) are allowed to know about a move. */
export type GameEvent =
  | { t: "peekStart"; side: Side; slots: number[] }
  | { t: "draw"; side: Side; from: "deck" | "discard"; card?: Card }
  | { t: "swap"; side: Side; slot: number; old: Card; from: "deck" | "discard"; incoming?: Card; newId: number }
  | { t: "discard"; side: Side; card: Card }
  | { t: "power"; side: Side; kind: PowerKind; ownSlot?: number; oppSlot?: number }
  | { t: "powerSkip"; side: Side; kind: PowerKind }
  | { t: "kingSwap"; side: Side; ownSlot: number; oppSlot: number; swapped: boolean }
  | { t: "burn"; side: Side; target: Side; slot: number; card: Card; success: boolean }
  | { t: "give"; side: Side; from: number; to: number; id: number }
  | { t: "cambio"; side: Side }
  | { t: "end" };

export interface Move {
  g: Game;
  ev: GameEvent[];
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const clone = (g: Game): Game => structuredClone(g);

function see(g: Game, side: Side, c: Card) {
  if (!g.seen[side].includes(c.id)) g.seen[side].push(c.id);
}
function seeBoth(g: Game, c: Card) {
  see(g, "human", c);
  see(g, "ai", c);
}
export const hasSeen = (g: Game, side: Side, c: Card) => g.seen[side].includes(c.id);

export const handScore = (h: Hand) => h.reduce((s, c) => s + (c ? cardValue(c) : 0), 0);
export const handCount = (h: Hand) => h.filter(Boolean).length;
export const topDiscard = (g: Game): Card | null => g.discard[g.discard.length - 1] ?? null;

function popDeck(g: Game): Card | null {
  if (g.deck.length === 0 && g.discard.length > 1) {
    const top = g.discard.pop()!;
    const back = new Set(g.discard.map((c) => c.id));
    g.seen.human = g.seen.human.filter((id) => !back.has(id));
    g.seen.ai = g.seen.ai.filter((id) => !back.has(id));
    g.deck = shuffle(g.discard);
    g.discard = [top];
  }
  return g.deck.pop() ?? null;
}

/** A new card just landed face-up on the discard pile: it opens a fresh burn window. */
function openBurn(g: Game, c: Card) {
  g.burnRank = c.rank;
  g.burnedBy = null;
  g.burnMissed = [];
}

function finish(g: Game, ev: GameEvent[]) {
  const human = handScore(g.hands.human);
  const ai = handScore(g.hands.ai);
  let winner: Result["winner"];
  if (g.calledBy) {
    // The caller must be strictly lower. A tie goes to the player who did NOT call.
    const caller = g.calledBy === "human" ? human : ai;
    const rival = g.calledBy === "human" ? ai : human;
    winner = caller < rival ? g.calledBy : other(g.calledBy);
  } else winner = human === ai ? "tie" : human < ai ? "human" : "ai";
  g.phase = "ended";
  g.result = { human, ai, winner, calledBy: g.calledBy };
  ev.push({ t: "end" });
}

function endTurn(g: Game, side: Side, ev: GameEvent[]) {
  g.turnsTaken[side] += 1;
  g.drawn = null;
  g.power = null;
  g.kingTarget = null;
  g.kingOwn = null;
  if (g.finalFor === side || g.turnsTaken.human + g.turnsTaken.ai >= MAX_TOTAL_TURNS) return finish(g, ev);
  g.turn = other(side);
  g.phase = "start";
}

/* ------------------------------------------------------------------ */
/* setup                                                               */
/* ------------------------------------------------------------------ */

export function newGame(): Game {
  const deck = shuffle(makeDeck());
  const hands: Record<Side, Hand> = { human: [], ai: [] };
  for (let i = 0; i < 4; i++) {
    hands.human.push(deck.pop()!);
    hands.ai.push(deck.pop()!);
  }
  const first = deck.pop()!;
  const g: Game = {
    deck,
    discard: [first],
    hands,
    seen: { human: [first.id], ai: [first.id] },
    turn: "human",
    phase: "peek",
    drawn: null,
    power: null,
    kingTarget: null,
    kingOwn: null,
    burnRank: first.rank,
    burnedBy: null,
    burnMissed: [],
    pendingGive: null,
    turnsTaken: { human: 0, ai: 0 },
    calledBy: null,
    finalFor: null,
    peeked: { human: false, ai: false },
    result: null,
  };
  return g;
}

/** Each side privately looks at two of its own cards before play begins. */
export function peekStart(g0: Game, side: Side, slots: number[]): Move | null {
  const g = clone(g0);
  if (g.phase !== "peek" || g.peeked[side]) return null;
  const uniq = Array.from(new Set(slots));
  if (uniq.length !== 2 || uniq.some((s) => !g.hands[side][s])) return null;
  uniq.forEach((s) => see(g, side, g.hands[side][s]!));
  g.peeked[side] = true;
  if (g.peeked.human && g.peeked.ai) {
    g.phase = "start";
    g.turn = "human";
  }
  return { g, ev: [{ t: "peekStart", side, slots: uniq }] };
}

/* ------------------------------------------------------------------ */
/* legality                                                            */
/* ------------------------------------------------------------------ */

/** Cambio is called instead of drawing, at the start of your turn (once per round). */
export function canCallCambio(g: Game, side: Side) {
  return legalStart(g, side).canCall;
}

export function legalStart(g: Game, side: Side) {
  const active = g.phase === "start" && g.turn === side && !g.pendingGive;
  const top = topDiscard(g);
  return {
    canCall: active && g.calledBy === null && g.turnsTaken[side] >= MIN_TURNS_BEFORE_CALL,
    canDraw: active && (g.deck.length > 0 || g.discard.length > 1),
    // Taking the pile means swapping it into your hand, so you need a card to swap with.
    canTake: active && !!top && g.hands[side].some(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* burning (any time, either player)                                   */
/* ------------------------------------------------------------------ */

export function canBurn(g: Game, side: Side) {
  if (g.phase === "peek" || g.phase === "ended" || g.pendingGive) return false;
  const top = topDiscard(g);
  if (!top || g.burnRank === null || top.rank !== g.burnRank) return false;
  return (g.burnedBy === null || g.burnedBy === side) && !g.burnMissed.includes(side);
}

function handEmptyEnds(g: Game, ev: GameEvent[]) {
  if ((g.hands.human.every((c) => c === null) || g.hands.ai.every((c) => c === null)) && g.phase !== "ended") finish(g, ev);
}

/**
 * Burn: reveal a card (yours or your opponent's) that matches the rank on top of the discard pile.
 * Right: it goes on the pile; if it was theirs you owe them one of your cards. Wrong: it's shown to
 * everyone, stays where it was, and you draw a penalty card.
 */
export function burn(g0: Game, side: Side, target: Side, slot: number): Move | null {
  const g = clone(g0);
  if (!canBurn(g, side)) return null;
  const card = g.hands[target][slot];
  if (!card) return null;
  const success = card.rank === g.burnRank;
  seeBoth(g, card);
  const ev: GameEvent[] = [{ t: "burn", side, target, slot, card, success }];
  if (success) {
    g.hands[target][slot] = null;
    g.discard.push(card);
    g.burnedBy = side;
    if (target !== side && g.hands[side].some(Boolean)) g.pendingGive = { by: side, slot };
    else handEmptyEnds(g, ev);
  } else {
    g.burnMissed.push(side);
    const pen = popDeck(g);
    if (pen) {
      const empty = g.hands[side].findIndex((c) => c === null);
      if (empty >= 0) g.hands[side][empty] = pen;
      else if (g.hands[side].length < MAX_SLOTS) g.hands[side].push(pen);
      else g.discard.push(pen);
    }
  }
  return { g, ev };
}

/** After burning an opponent's card: hand them one of your face-down cards to fill the gap. */
export function giveCard(g0: Game, side: Side, ownSlot: number): Move | null {
  const g = clone(g0);
  if (!g.pendingGive || g.pendingGive.by !== side) return null;
  const card = g.hands[side][ownSlot];
  if (!card) return null;
  const to = g.pendingGive.slot;
  g.hands[other(side)][to] = card;
  g.hands[side][ownSlot] = null;
  g.pendingGive = null;
  const ev: GameEvent[] = [{ t: "give", side, from: ownSlot, to, id: card.id }];
  handEmptyEnds(g, ev);
  return { g, ev };
}

export function callCambio(g0: Game, side: Side): Move | null {
  const g = clone(g0);
  if (!canCallCambio(g, side)) return null;
  g.calledBy = side;
  g.finalFor = other(side);
  g.turnsTaken[side] += 1;
  g.turn = other(side);
  g.phase = "start";
  return { g, ev: [{ t: "cambio", side }] };
}

export function drawDeck(g0: Game, side: Side): Move | null {
  const g = clone(g0);
  if (!legalStart(g, side).canDraw) return null;
  const card = popDeck(g);
  if (!card) {
    const ev: GameEvent[] = [];
    finish(g, ev);
    return { g, ev };
  }
  see(g, side, card);
  g.drawn = { card, from: "deck" };
  g.phase = "drawn";
  return { g, ev: [{ t: "draw", side, from: "deck" }] };
}

export function takeDiscard(g0: Game, side: Side): Move | null {
  const g = clone(g0);
  if (!legalStart(g, side).canTake) return null;
  const card = g.discard.pop()!;
  g.burnRank = null; // nothing new landed: the card underneath can't be burned on
  g.drawn = { card, from: "discard" };
  g.phase = "drawn";
  return { g, ev: [{ t: "draw", side, from: "discard", card }] };
}

/* ------------------------------------------------------------------ */
/* after drawing                                                       */
/* ------------------------------------------------------------------ */

export function swapDrawn(g0: Game, side: Side, slot: number): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (g.phase !== "drawn" || g.turn !== side || !g.drawn) return null;
  const old = g.hands[side][slot];
  if (!old) return null;
  const { card, from } = g.drawn;
  g.hands[side][slot] = card;
  g.discard.push(old);
  seeBoth(g, old); // the replaced card lands face-up on the pile
  openBurn(g, old);
  const ev: GameEvent[] = [
    { t: "swap", side, slot, old, from, incoming: from === "discard" ? card : undefined, newId: card.id },
  ];
  endTurn(g, side, ev);
  return { g, ev };
}

/** Only a card drawn from the deck may be discarded; if it has a power you may use it. */
export function discardDrawn(g0: Game, side: Side): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (g.phase !== "drawn" || g.turn !== side || !g.drawn || g.drawn.from !== "deck") return null;
  const { card } = g.drawn;
  g.discard.push(card);
  seeBoth(g, card);
  openBurn(g, card);
  g.drawn = null;
  const ev: GameEvent[] = [{ t: "discard", side, card }];
  const p = powerOf(card);
  if (p) {
    g.phase = "power";
    g.power = p;
  } else endTurn(g, side, ev);
  return { g, ev };
}

/* ------------------------------------------------------------------ */
/* powers                                                              */
/* ------------------------------------------------------------------ */

function powerReady(g: Game, side: Side, kind: PowerKind) {
  return g.phase === "power" && g.turn === side && g.power === kind;
}

export function skipPower(g0: Game, side: Side): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (g.phase !== "power" || g.turn !== side || !g.power) return null;
  const ev: GameEvent[] = [{ t: "powerSkip", side, kind: g.power }];
  endTurn(g, side, ev);
  return { g, ev };
}

export function usePeekOwn(g0: Game, side: Side, slot: number): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (!powerReady(g, side, "peekOwn")) return null;
  const c = g.hands[side][slot];
  if (!c) return null;
  see(g, side, c);
  const ev: GameEvent[] = [{ t: "power", side, kind: "peekOwn", ownSlot: slot }];
  endTurn(g, side, ev);
  return { g, ev };
}

export function usePeekOpp(g0: Game, side: Side, oppSlot: number): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (!powerReady(g, side, "peekOpp")) return null;
  const c = g.hands[other(side)][oppSlot];
  if (!c) return null;
  see(g, side, c);
  const ev: GameEvent[] = [{ t: "power", side, kind: "peekOpp", oppSlot }];
  endTurn(g, side, ev);
  return { g, ev };
}

export function useBlindSwap(g0: Game, side: Side, ownSlot: number, oppSlot: number): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (!powerReady(g, side, "blindSwap")) return null;
  const mine = g.hands[side][ownSlot];
  const theirs = g.hands[other(side)][oppSlot];
  if (!mine || !theirs) return null;
  g.hands[side][ownSlot] = theirs;
  g.hands[other(side)][oppSlot] = mine;
  const ev: GameEvent[] = [{ t: "power", side, kind: "blindSwap", ownSlot, oppSlot }];
  endTurn(g, side, ev);
  return { g, ev };
}

/** Black King, step one: look at one of your own cards and one of the opponent's. */
export function useKingLook(g0: Game, side: Side, ownSlot: number, oppSlot: number): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (!powerReady(g, side, "king")) return null;
  const mine = g.hands[side][ownSlot];
  const c = g.hands[other(side)][oppSlot];
  if (!mine || !c) return null;
  see(g, side, mine);
  see(g, side, c);
  g.kingOwn = ownSlot;
  g.kingTarget = oppSlot;
  g.phase = "king";
  return { g, ev: [{ t: "power", side, kind: "king", ownSlot, oppSlot }] };
}

/** Black King, step two: swap any one of your cards with any one of theirs, or keep everything. */
export function kingDecide(g0: Game, side: Side, ownSlot: number | null, oppSlot: number | null = null): Move | null {
  const g = clone(g0);
  if (g.pendingGive) return null;
  if (g.phase !== "king" || g.turn !== side || g.kingTarget === null) return null;
  let swapped = false;
  if (ownSlot !== null && oppSlot !== null) {
    const mine = g.hands[side][ownSlot];
    const theirs = g.hands[other(side)][oppSlot];
    if (!mine || !theirs) return null;
    g.hands[side][ownSlot] = theirs;
    g.hands[other(side)][oppSlot] = mine;
    swapped = true;
  }
  const ev: GameEvent[] = [{ t: "kingSwap", side, ownSlot: swapped ? ownSlot! : -1, oppSlot: swapped ? oppSlot! : -1, swapped }];
  endTurn(g, side, ev);
  return { g, ev };
}

/* ------------------------------------------------------------------ */
/* What the AI is allowed to know                                      */
/* ------------------------------------------------------------------ */

export interface SlotView {
  slot: number;
  /** Opaque handle, so the AI can follow a card as it moves without knowing what it is. */
  id: number;
  /** The face, only if this side has actually seen it. */
  card: Card | null;
  /** Whether the *other* side has seen this card (you can watch an opponent peek). */
  seenByOther: boolean;
}

export interface AiView {
  phase: Phase;
  turn: Side;
  top: Card | null;
  deckCount: number;
  drawn: { card: Card; from: "deck" | "discard" } | null;
  own: (SlotView | null)[];
  opp: (SlotView | null)[];
  /** Every card identity the AI cannot currently locate. Used for odds, never for locations. */
  pool: Card[];
  turnsTaken: Record<Side, number>;
  calledBy: Side | null;
  finalFor: Side | null;
  /** Whether the AI may burn right now, and the rank it would have to match. */
  canBurn: boolean;
  burnRank: Rank | null;
  /** The human slot the AI owes a card to, after burning one of theirs. */
  owesSlot: number | null;
  power: PowerKind | null;
  kingLook: Card | null;
}

/**
 * The only door between the true game state and the AI's brain. Faces of cards the AI has not
 * seen are stripped here, so nothing downstream can accidentally read them.
 */
export function makeAiView(g: Game): AiView {
  const visible = new Set<number>();
  g.discard.forEach((c) => visible.add(c.id));
  const slotView = (c: Card | null, i: number): SlotView | null => {
    if (!c) return null;
    const known = hasSeen(g, "ai", c);
    if (known) visible.add(c.id);
    return { slot: i, id: c.id, card: known ? c : null, seenByOther: hasSeen(g, "human", c) };
  };
  const own = g.hands.ai.map((c, i) => slotView(c, i));
  const opp = g.hands.human.map((c, i) => slotView(c, i));
  const mineDrawn = g.drawn && g.turn === "ai" ? g.drawn : null;
  if (mineDrawn) visible.add(mineDrawn.card.id);
  const kingLook =
    g.phase === "king" && g.turn === "ai" && g.kingTarget !== null ? g.hands.human[g.kingTarget] : null;
  return {
    phase: g.phase,
    turn: g.turn,
    top: topDiscard(g),
    deckCount: g.deck.length,
    drawn: mineDrawn,
    own,
    opp,
    pool: ALL_CARDS.filter((c) => !visible.has(c.id)),
    turnsTaken: { ...g.turnsTaken },
    calledBy: g.calledBy,
    finalFor: g.finalFor,
    canBurn: canBurn(g, "ai"),
    burnRank: g.burnRank,
    owesSlot: g.pendingGive?.by === "ai" ? g.pendingGive.slot : null,
    power: g.power,
    kingLook,
  };
}
