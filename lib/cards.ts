export type Suit = "S" | "H" | "D" | "C" | "X";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "JK";

export interface Card {
  /** Opaque handle for a physical card. Everyone can see a card move; only the face is hidden. */
  id: number;
  rank: Rank;
  suit: Suit;
}

export type PowerKind = "peekOwn" | "peekOpp" | "blindSwap" | "king";

const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS: Suit[] = ["S", "H", "D", "C"];

export const SUIT_GLYPH: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣", X: "★" };

/** 52 cards + 2 jokers. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  let id = 0;
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: id++, rank, suit });
  deck.push({ id: id++, rank: "JK", suit: "X" }, { id: id++, rank: "JK", suit: "X" });
  return deck;
}

export const ALL_CARDS: Card[] = makeDeck();

export const isRed = (c: Card) => c.suit === "H" || c.suit === "D";

/** Ace 1, 2-10 face value, J / Q / black K 10, red K -1, Joker 0. Lowest total wins. */
export function cardValue(c: Card): number {
  switch (c.rank) {
    case "A": return 1;
    case "J": return 10;
    case "Q": return 10;
    case "K": return isRed(c) ? -1 : 10;
    case "JK": return 0;
    default: return Number(c.rank);
  }
}

/** Playing a drawn card straight to the discard pile triggers its power. */
export function powerOf(c: Card): PowerKind | null {
  switch (c.rank) {
    case "7": case "8": return "peekOwn";
    case "9": case "10": return "peekOpp";
    case "J": case "Q": return "blindSwap";
    // Only the black King has a power; the red King is a 0-point keeper.
    case "K": return isRed(c) ? null : "king";
    default: return null;
  }
}

export const POWER_TEXT: Record<PowerKind, string> = {
  peekOwn: "Peek at one of your own cards",
  peekOpp: "Peek at one of your opponent's cards",
  blindSwap: "Swap one of your cards with one of theirs, unseen",
  king: "Look at one of your cards and one of theirs, then you may swap any of yours with any of theirs",
};

export function cardLabel(c: Card): string {
  return c.rank === "JK" ? "Joker" : `${c.rank}${SUIT_GLYPH[c.suit]}`;
}

export function shuffle<T>(arr: T[], rnd: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Hands are laid out in a single row, so slots are named by position from the left. */
export const slotName = (i: number) => ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"][i] ?? `${i + 1}th`;

/** Which half of the row a slot sits in: 0 = left (1st, 2nd), 1 = right (3rd onwards). */
export const slotCol = (i: number) => (i < 2 ? 0 : 1);
