import { cardLabel, cardValue, powerOf, slotCol, slotName } from "./cards";
import { MIN_TURNS_BEFORE_CALL, type AiView, type GameEvent } from "./engine";

/**
 * The AI's model of this particular player.
 *
 * It's a deliberately small evidence/confidence system: every observation adds weighted
 * evidence to a trait, each trait has a value (0-1) and a confidence that grows with evidence,
 * and the decision code shrinks every trait toward "neutral" in proportion to how unsure it is.
 * It only ever uses what a real opponent at the table could see.
 */

export type TraitKey = "risk" | "memory" | "cambio" | "discard" | "predict" | "position";

export interface Acc {
  pos: number;
  neg: number;
}

export interface PlayerModel {
  risk: Acc;
  memory: Acc;
  cambio: Acc;
  discard: Acc;
  riskBehind: Acc;
  riskAhead: Acc;
  /** Times the player interacted with each of their own card slots. */
  slotUse: number[];
  actionTally: Record<string, number>;
  swapSlotTally: number[];
  /** Per physical card: weighted count of times the player saw it in their hand and kept it. */
  cardKeeps: Record<number, number>;
  /** Cards the player chose to take into their hand blind-ish from the deck. */
  accepted: Record<number, number>;
  turns: number;
  games: number;
  evidence: number;
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);
const acc = (): Acc => ({ pos: 0, neg: 0 });

export function emptyModel(): PlayerModel {
  return {
    risk: acc(),
    memory: acc(),
    cambio: acc(),
    discard: acc(),
    riskBehind: acc(),
    riskAhead: acc(),
    slotUse: zeros(8),
    actionTally: {},
    swapSlotTally: zeros(4),
    cardKeeps: {},
    accepted: {},
    turns: 0,
    games: 0,
    evidence: 0,
  };
}

/** Start of a new game: keep what we learned, but let it fade so this game's evidence matters. */
export function carryOver(m: PlayerModel): PlayerModel {
  const k = 0.55;
  const s = (a: Acc): Acc => ({ pos: a.pos * k, neg: a.neg * k });
  const tally: Record<string, number> = {};
  for (const [key, v] of Object.entries(m.actionTally)) tally[key] = v * k;
  return {
    risk: s(m.risk),
    memory: s(m.memory),
    cambio: s(m.cambio),
    discard: s(m.discard),
    riskBehind: s(m.riskBehind),
    riskAhead: s(m.riskAhead),
    slotUse: m.slotUse.map((x) => x * k),
    actionTally: tally,
    swapSlotTally: m.swapSlotTally.map((x) => x * k),
    cardKeeps: {},
    accepted: {},
    turns: 0,
    games: m.games + 1,
    evidence: m.evidence * k,
  };
}

/* ------------------------------------------------------------------ */
/* Gauges                                                              */
/* ------------------------------------------------------------------ */

export interface Gauge {
  key: TraitKey;
  label: string;
  /** 0-1. For `position` this is the strength of the bias. */
  value: number;
  /** 0-1, how much evidence backs it. */
  conf: number;
  n: number;
  level: "Low" | "Medium" | "High";
  /** Short human text, e.g. "Left side". */
  headline: string;
  blurb: string;
}

export const TRAIT_LABEL: Record<TraitKey, string> = {
  risk: "Risk tolerance",
  memory: "Memory",
  cambio: "Cambio aggression",
  discard: "Discard habit",
  predict: "Predictability",
  position: "Position preference",
};

const level = (v: number): Gauge["level"] => (v >= 0.62 ? "High" : v <= 0.38 ? "Low" : "Medium");
const conf = (n: number, k = 3) => n / (n + k);
const smooth = (a: Acc, prior = 0.5, k = 2) => (a.pos + prior * k) / (a.pos + a.neg + k);

function entropy(counts: number[]) {
  const n = counts.reduce((x, y) => x + y, 0);
  if (n <= 0) return 0;
  return -counts.reduce((s, c) => (c > 0 ? s + (c / n) * Math.log(c / n) : s), 0);
}

export function positionInfo(m: PlayerModel) {
  const left = m.slotUse.reduce((s, c, i) => (i % 2 === 0 ? s + c : s), 0);
  const right = m.slotUse.reduce((s, c, i) => (i % 2 === 1 ? s + c : s), 0);
  const n = left + right;
  const shareLeft = (left + 1) / (n + 2);
  const side: "left" | "right" = shareLeft >= 0.5 ? "left" : "right";
  const share = Math.max(shareLeft, 1 - shareLeft);
  return { side, share, strength: (share - 0.5) * 2, n, conf: conf(n, 4) };
}

export function gauges(m: PlayerModel): Record<TraitKey, Gauge> {
  const make = (key: TraitKey, a: Acc, hi: string, lo: string, mid: string, headlines: [string, string, string]): Gauge => {
    const n = a.pos + a.neg;
    const value = smooth(a);
    const lv = level(value);
    return {
      key,
      label: TRAIT_LABEL[key],
      value,
      conf: conf(n),
      n,
      level: lv,
      headline: lv === "High" ? headlines[0] : lv === "Low" ? headlines[2] : headlines[1],
      blurb: lv === "High" ? hi : lv === "Low" ? lo : mid,
    };
  };

  const risk = make("risk", m.risk, "Acts on cards it hasn't looked at", "Mostly plays what it knows", "A mix of safe and gambling moves", ["High", "Medium", "Low"]);
  const memory = make("memory", m.memory, "Remembers what it has seen", "Seems to forget what it has seen", "Remembers some of it", ["Strong", "Mixed", "Shaky"]);
  const cambio = make("cambio", m.cambio, "Calls early", "Plays on, patient", "Calls when it feels ahead", ["Early", "Mid-game", "Patient"]);
  const discard = make("discard", m.discard, "Grabs low cards from the pile", "Prefers the draw pile", "Takes the pile sometimes", ["Grabs it", "Sometimes", "Avoids it"]);

  const nAct = Object.values(m.actionTally).reduce((s, x) => s + x, 0);
  const slotCounts = m.swapSlotTally.slice(0, 4);
  const nSlot = slotCounts.reduce((s, x) => s + x, 0);
  const rawPred =
    0.5 * (1 - entropy(slotCounts) / Math.log(4)) +
    0.5 * (1 - entropy(Object.values(m.actionTally)) / Math.log(5));
  const nP = Math.min(nAct, nSlot + 2);
  const pv = (rawPred * nP + 0.5 * 2) / (nP + 2);
  const predict: Gauge = {
    key: "predict",
    label: TRAIT_LABEL.predict,
    value: pv,
    conf: conf(nP, 4),
    n: nP,
    level: level(pv),
    headline: level(pv) === "High" ? "Repeats itself" : level(pv) === "Low" ? "Varied" : "Somewhat steady",
    blurb: level(pv) === "High" ? "Same kind of move, same cards" : level(pv) === "Low" ? "Hard to call in advance" : "Some habits showing",
  };

  const p = positionInfo(m);
  const strong = p.share >= 0.62;
  const position: Gauge = {
    key: "position",
    label: TRAIT_LABEL.position,
    value: p.strength,
    conf: p.conf,
    n: p.n,
    level: strong ? "High" : p.share <= 0.55 ? "Low" : "Medium",
    headline: p.n < 2 ? "Unknown" : strong ? `${p.side === "left" ? "Left" : "Right"} side` : "Balanced",
    blurb: strong ? `Works mostly with its ${p.side} cards` : "No clear side yet",
  };

  return { risk, memory, cambio, discard, predict, position };
}

/** One-line reads for the end screen and as a fallback if the LLM is unavailable. */
export function behindInsight(m: PlayerModel): string | null {
  const nb = m.riskBehind.pos + m.riskBehind.neg;
  const na = m.riskAhead.pos + m.riskAhead.neg;
  if (nb < 2 || na < 2) return null;
  const rb = m.riskBehind.pos / nb;
  const ra = m.riskAhead.pos / na;
  if (rb - ra >= 0.25) return "You take more risks when you're behind.";
  if (ra - rb >= 0.25) return "You play it safer when you're behind and gamble when ahead.";
  return null;
}

export function localReads(m: PlayerModel): string[] {
  const g = gauges(m);
  const out: string[] = [];
  const add = (cond: boolean, text: string) => cond && out.push(text);
  const c = (k: TraitKey) => g[k].conf >= 0.3;
  add(c("risk") && g.risk.level === "High", "You act on cards you haven't looked at, and you make a lot of gambles.");
  add(c("risk") && g.risk.level === "Low", "You mostly stick to cards you know.");
  add(c("memory") && g.memory.level === "High", "You seem to remember your cards well.");
  add(c("memory") && g.memory.level === "Low", "Your memory of your own cards slips more than you'd like.");
  add(c("cambio") && g.cambio.level === "High", "You call Cambio earlier than I expected.");
  add(c("cambio") && g.cambio.level === "Low", "You're patient about calling Cambio.");
  add(c("discard") && g.discard.level === "High", "You jump on low cards in the discard pile.");
  add(c("discard") && g.discard.level === "Low", "You rarely take from the discard pile.");
  add(c("predict") && g.predict.level === "High", "You repeat the same kinds of moves, which makes you easy to read.");
  add(c("predict") && g.predict.level === "Low", "Your choices are hard to predict.");
  const p = positionInfo(m);
  add(p.conf >= 0.3 && p.share >= 0.62, `You work mostly with your ${p.side} cards and leave the ${p.side === "left" ? "right" : "left"} ones alone.`);
  const b = behindInsight(m);
  if (b) out.unshift(b);
  if (out.length === 0) out.push("You played a balanced game, so I couldn't pin a style on you yet.");
  return out.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Profile: what the decision code actually consumes                   */
/* ------------------------------------------------------------------ */

export interface Profile {
  risk: number;
  memory: number;
  cambio: number;
  discard: number;
  predict: number;
  /** 0-1 how strongly the player favours one side of their hand (confidence-weighted). */
  posStrength: number;
  /** The column the player leaves alone (their likely "keepers"): 0 = left, 1 = right. */
  protectedCol: 0 | 1 | null;
  cardKeeps: Record<number, number>;
  accepted: Record<number, number>;
}

export const NEUTRAL_PROFILE: Profile = {
  risk: 0.5,
  memory: 0.5,
  cambio: 0.5,
  discard: 0.5,
  predict: 0.5,
  posStrength: 0,
  protectedCol: null,
  cardKeeps: {},
  accepted: {},
};

/** Beliefs shrink toward 0.5 in proportion to how little evidence is behind them. */
export function profileFromModel(m: PlayerModel): Profile {
  const g = gauges(m);
  const eff = (x: Gauge) => 0.5 + (x.value - 0.5) * x.conf;
  const p = positionInfo(m);
  return {
    risk: eff(g.risk),
    memory: eff(g.memory),
    cambio: eff(g.cambio),
    discard: eff(g.discard),
    predict: eff(g.predict),
    posStrength: p.strength * p.conf,
    protectedCol: p.share >= 0.58 ? (p.side === "left" ? 1 : 0) : null,
    cardKeeps: m.cardKeeps,
    accepted: m.accepted,
  };
}

/* ------------------------------------------------------------------ */
/* Observing the player                                                */
/* ------------------------------------------------------------------ */

/**
 * How a move looks to an opponent at the table. Judged only on public information: which cards
 * you've looked at (anyone can watch you peek), what's on the pile, and what gets revealed.
 */
export type Verdict = "blunder" | "mistake" | "risky" | "good" | "read";

export interface ModelNote {
  trait: TraitKey | "info";
  text: string;
  dir: 1 | -1 | 0;
  verdict: Verdict;
  /** The weak spot this points at, if it's one worth fixing. */
  leak?: LeakKey;
}

/* ------------------------------------------------------------------ */
/* The one thing to work on                                            */
/* ------------------------------------------------------------------ */

export type LeakKey =
  | "repeat-peek"
  | "overwrote-low"
  | "passed-low"
  | "skipped-peek"
  | "bad-burn"
  | "guess-burn"
  | "blind-cost"
  | "blind-cambio";

export const LEAKS: Record<LeakKey, { title: string; tip: string }> = {
  "repeat-peek": {
    title: "Wasted peeks",
    tip: "When you get a peek, spend it on a card you have never seen. Re-checking a card you already know tells you nothing new.",
  },
  "overwrote-low": {
    title: "Throwing away low cards",
    tip: "Only swap over a card you know is high, or one you have never seen. A known Ace, 2, 3, Joker or red King is worth protecting.",
  },
  "passed-low": {
    title: "Passing on free low cards",
    tip: "When a Joker, red King or Ace is on top of the pile, take it and put it over your highest known card. A blind draw averages about 6.",
  },
  "skipped-peek": {
    title: "Skipping free information",
    tip: "Don't skip a 7 or 8 while you still have cards you haven't seen. The peek is free, and knowing your hand is what lets you call Cambio.",
  },
  "bad-burn": {
    title: "Burning from shaky memory",
    tip: "Only burn a card you are sure of. A wrong burn hands you a penalty card, about 6 points on average.",
  },
  "guess-burn": {
    title: "Guessing at burns",
    tip: "Don't burn cards you haven't seen. The chance of a match is about 1 in 13, and a miss costs you a penalty card.",
  },
  "blind-cost": {
    title: "Swapping into unknown cards",
    tip: "When you take a known card from the pile, put it over a card you know is high rather than one you've never seen.",
  },
  "blind-cambio": {
    title: "Calling Cambio blind",
    tip: "Before you call Cambio, know at least three of your cards. Every unknown card is worth about 6 points on average.",
  },
};

const LEAK_WEIGHT: Record<Verdict, number> = { blunder: 2, mistake: 1.5, risky: 1, good: 0, read: 0 };
/** Add one note's weight to this round's tally of weak spots. */
export function tallyLeak(tally: Partial<Record<LeakKey, number>>, n: ModelNote): Partial<Record<LeakKey, number>> {
  if (!n.leak || !LEAK_WEIGHT[n.verdict]) return tally;
  return { ...tally, [n.leak]: (tally[n.leak] ?? 0) + LEAK_WEIGHT[n.verdict] };
}

export interface Focus {
  title: string;
  tip: string;
  /** How often it happened this round (absent when the advice comes from the long-run profile). */
  times?: number;
}

/**
 * The single biggest thing to work on: this round's costliest weak spot, or, on a clean round,
 * the profile's weakest trait.
 */
export function focusFor(tally: Partial<Record<LeakKey, number>>, counts: Partial<Record<LeakKey, number>>, m: PlayerModel): Focus {
  const worst = (Object.entries(tally) as [LeakKey, number][]).sort((a, b) => b[1] - a[1])[0];
  if (worst) return { ...LEAKS[worst[0]], times: counts[worst[0]] ?? 1 };
  const g = gauges(m);
  const sure = (k: TraitKey) => g[k].conf >= 0.3;
  if (sure("memory") && g.memory.level === "Low") return { title: "Keeping track of your cards", tip: "Say your known cards to yourself after every swap. Most of your lost points came from not being sure what you held." };
  if (sure("risk") && g.risk.level === "High") return { title: "Acting on unknown cards", tip: "Use peeks to learn a card before you swap over it. Blind moves are a coin flip, and the coin is weighted against you." };
  if (sure("cambio") && g.cambio.level === "Low") return { title: "Calling Cambio sooner", tip: "Once you know your hand is under about 8 points, call Cambio. Every extra turn gives the opponent a chance to catch up." };
  if (sure("discard") && g.discard.level === "Low") return { title: "Using the discard pile", tip: "A low card on the pile is a sure thing. Take it over a blind draw whenever it beats your highest known card." };
  return { title: "Learning your hand early", tip: "Spend your early 7s and 8s on cards you haven't seen. The sooner you know your hand, the sooner you can call Cambio with confidence." };
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * Update the model from one public game event. `before` is the AI's filtered view just before
 * the event happened, so "has the player looked at this card?" is something a real opponent
 * could see at the table (you can watch someone peek).
 */
export function observeHuman(
  m0: PlayerModel,
  ev: GameEvent,
  before: AiView,
  ctx: { behind: boolean },
): { model: PlayerModel; notes: ModelNote[] } {
  if (!("side" in ev) || ev.side !== "human") return { model: m0, notes: [] };
  const m = structuredClone(m0);
  const notes: ModelNote[] = [];
  const bump = (a: Acc, pos: number, neg: number) => {
    a.pos += pos;
    a.neg += neg;
  };
  const risky = (isRisky: boolean, w = 1) => {
    bump(m.risk, isRisky ? w : 0, isRisky ? 0 : w);
    bump(ctx.behind ? m.riskBehind : m.riskAhead, isRisky ? w : 0, isRisky ? 0 : w);
  };
  const tally = (key: string) => {
    m.actionTally[key] = (m.actionTally[key] ?? 0) + 1;
  };
  const useSlot = (slot: number) => {
    if (slot < 0) return;
    m.slotUse[Math.min(slot, 7)] += 1;
    m.swapSlotTally[Math.min(slot, 3)] += 1;
  };
  const seenSlot = (slot: number) => !!before.opp[slot]?.seenByOther;
  const keepOthers = (exceptSlot: number, w: number) => {
    before.opp.forEach((o, j) => {
      if (o && j !== exceptSlot && o.seenByOther) m.cardKeeps[o.id] = (m.cardKeeps[o.id] ?? 0) + w;
    });
  };
  m.evidence += 1;

  switch (ev.t) {
    case "draw": {
      m.turns += 1;
      const top = before.top;
      const topV = top ? cardValue(top) : null;
      const canCall = before.turnsTaken.human >= MIN_TURNS_BEFORE_CALL && !before.calledBy;
      if (canCall) bump(m.cambio, 0, 0.25);
      if (topV !== null && topV <= 4) {
        if (ev.from === "discard") {
          bump(m.discard, 1, 0);
          notes.push({ trait: "discard", text: `You took the ${cardLabel(ev.card!)} (worth ${topV}) off the pile. Guaranteed low card, no guessing.`, dir: 1, verdict: "good" });
        } else {
          bump(m.discard, 0, 1);
          notes.push(
            topV <= 1
              ? { trait: "discard", text: `You passed on the ${cardLabel(top!)}, worth just ${topV}, for a blind draw. A sure low card beats a random one (average about 6).`, dir: -1, verdict: "mistake", leak: "passed-low" }
              : { trait: "discard", text: `You passed on the ${cardLabel(top!)} (worth ${topV}) in the discard pile. Either your known cards are low already, or you left points on the table.`, dir: -1, verdict: "read" },
          );
        }
      }
      break;
    }
    case "swap": {
      const slotSeen = seenSlot(ev.slot);
      const oldV = cardValue(ev.old);
      tally(ev.from === "deck" ? "swap-deck" : "swap-discard");
      useSlot(ev.slot);
      const inV = ev.incoming ? cardValue(ev.incoming) : null;
      if (!slotSeen) {
        risky(true, ev.from === "deck" ? 1 : 0.6);
        notes.push(
          inV !== null && inV > oldV
            ? { trait: "risk", text: `You swapped the ${cardLabel(ev.incoming!)} into a card you hadn't seen, and it was a ${cardLabel(ev.old)}. That cost you ${inV - oldV} points.`, dir: 1, verdict: "mistake", leak: "blind-cost" }
            : { trait: "risk", text: `You replaced your ${slotName(ev.slot)} card without knowing what it was. It turned out to be a ${cardLabel(ev.old)}.`, dir: 1, verdict: "risky" },
        );
      } else {
        risky(false, 0.5);
        if (inV !== null && inV > oldV) {
          bump(m.memory, 0, 1);
          notes.push({ trait: "memory", text: `You knew your ${slotName(ev.slot)} card was a ${cardLabel(ev.old)}, then swapped the ${cardLabel(ev.incoming!)} in over it. That cost you ${inV - oldV} points.`, dir: -1, verdict: "blunder", leak: "overwrote-low" });
        } else if (oldV >= 7) {
          bump(m.memory, 0.8, 0);
          notes.push({ trait: "memory", text: `You got rid of a ${cardLabel(ev.old)} you knew was high.`, dir: 1, verdict: "good" });
        } else if (oldV <= 3) {
          bump(m.memory, 0, 1);
          notes.push({ trait: "memory", text: `You threw away a ${cardLabel(ev.old)} you'd already seen. Cards that low are worth keeping.`, dir: -1, verdict: "blunder", leak: "overwrote-low" });
        }
      }
      keepOthers(ev.slot, 1);
      if (ev.from === "deck") m.accepted[ev.newId] = 1;
      break;
    }
    case "discard": {
      const v = cardValue(ev.card);
      if (!powerOf(ev.card)) tally("discard-deck");
      const w = powerOf(ev.card) ? 0.3 : v <= 4 ? 1.5 : v <= 7 ? 1 : 0.4;
      keepOthers(-1, w);
      if (v <= 4 && !powerOf(ev.card)) {
        notes.push({ trait: "info", text: `You threw away a ${cardLabel(ev.card)}, so I think the cards you know are already lower than ${v}.`, dir: 0, verdict: "read" });
      }
      break;
    }
    case "power": {
      tally(`power-${ev.kind}`);
      if (ev.kind === "peekOwn" && ev.ownSlot !== undefined) {
        useSlot(ev.ownSlot);
        if (seenSlot(ev.ownSlot)) {
          bump(m.memory, 0, 0.5);
          const unseen = before.opp.filter((o) => o && !o.seenByOther).length;
          notes.push({
            trait: "memory",
            text: `You peeked at your ${slotName(ev.ownSlot)} card, which you'd already seen.${unseen ? ` You still had ${unseen} card${unseen === 1 ? "" : "s"} you'd never looked at.` : ""}`,
            dir: -1,
            verdict: unseen ? "blunder" : "mistake", leak: "repeat-peek",
          });
        }
      }
      if (ev.kind === "peekOpp" && ev.oppSlot !== undefined && before.own[ev.oppSlot]?.seenByOther) {
        notes.push({ trait: "memory", text: `You peeked at my ${slotName(ev.oppSlot)} card, but you'd already seen it. Wasted peek.`, dir: -1, verdict: "blunder", leak: "repeat-peek" });
      }
      if (ev.kind === "king" && ev.ownSlot !== undefined && seenSlot(ev.ownSlot)) {
        notes.push({ trait: "memory", text: `With the King you looked at your ${slotName(ev.ownSlot)} card again, which you already knew.`, dir: -1, verdict: "mistake", leak: "repeat-peek" });
      }
      if (ev.kind === "blindSwap" && ev.ownSlot !== undefined) {
        useSlot(ev.ownSlot);
        risky(true, 0.8);
        notes.push({
          trait: "risk",
          text: seenSlot(ev.ownSlot)
            ? `You blind-swapped away your ${slotName(ev.ownSlot)} card, one you knew. Fine if it was high.`
            : `You blind-swapped a card you'd never seen for one of mine. Two unknowns.`,
          dir: 1,
          verdict: "risky",
        });
      }
      break;
    }
    case "powerSkip": {
      tally("discard-deck");
      const unseen = before.opp.filter((o) => o && !o.seenByOther).length;
      if (ev.kind === "peekOwn" && unseen > 0) {
        notes.push({ trait: "memory", text: `You skipped a free peek while ${unseen} of your cards were still unknown.`, dir: -1, verdict: "mistake", leak: "skipped-peek" });
      }
      break;
    }
    case "kingSwap": {
      if (ev.swapped && ev.ownSlot >= 0) {
        useSlot(ev.ownSlot);
        risky(!seenSlot(ev.ownSlot), 0.5);
      }
      break;
    }
    case "burn": {
      tally("burn");
      if (ev.target === "human") {
        const slotSeen = seenSlot(ev.slot);
        useSlot(ev.slot);
        if (ev.success && slotSeen) {
          bump(m.memory, 1, 0);
          risky(false, 0.3);
          notes.push({ trait: "memory", text: `You burned the ${cardLabel(ev.card)} from memory. ${cardValue(ev.card)} points gone.`, dir: 1, verdict: "good" });
        } else if (ev.success) {
          risky(true, 1);
          notes.push({ trait: "risk", text: `You burned a card you'd never seen and it happened to be a ${cardLabel(ev.card)}. Lucky.`, dir: 1, verdict: "risky", leak: "guess-burn" });
        } else if (slotSeen) {
          bump(m.memory, 0, 1.2);
          notes.push({ trait: "memory", text: `You'd seen that card, but misremembered it: it was a ${cardLabel(ev.card)}. Penalty card.`, dir: -1, verdict: "blunder", leak: "bad-burn" });
        } else {
          risky(true, 1);
          notes.push({ trait: "risk", text: `You tried to burn a card you'd never seen. It was a ${cardLabel(ev.card)}, so you took a penalty card.`, dir: 1, verdict: "mistake", leak: "guess-burn" });
        }
      } else {
        // Burning one of my cards: did they really know it, or was it a guess?
        const known = before.own[ev.slot]?.seenByOther ?? false;
        if (ev.success && known) {
          bump(m.memory, 1, 0);
          notes.push({ trait: "memory", text: `You remembered my ${slotName(ev.slot)} card was a ${cardLabel(ev.card)} and burned it.`, dir: 1, verdict: "good" });
        } else if (ev.success) {
          risky(true, 1);
          notes.push({ trait: "risk", text: `You guessed my ${slotName(ev.slot)} card without having seen it, and got it right. Lucky.`, dir: 1, verdict: "risky", leak: "guess-burn" });
        } else {
          if (known) bump(m.memory, 0, 1.2);
          else risky(true, 1);
          notes.push({
            trait: known ? "memory" : "risk",
            text: known
              ? `You'd seen my ${slotName(ev.slot)} card but misremembered it: it was a ${cardLabel(ev.card)}. Penalty card.`
              : `You guessed at my ${slotName(ev.slot)} card without having seen it. It was a ${cardLabel(ev.card)}. Penalty card.`,
            dir: known ? -1 : 1,
            verdict: known ? "blunder" : "mistake", leak: known ? "bad-burn" : "guess-burn",
          });
        }
      }
      break;
    }
    case "give": {
      useSlot(ev.from);
      break;
    }
    case "cambio": {
      tally("cambio");
      const t = before.turnsTaken.human + 1;
      const unseen = before.opp.filter((o) => o && !o.seenByOther).length;
      if (t <= 6) bump(m.cambio, 2, 0);
      else if (t <= 9) bump(m.cambio, 1, 0.5);
      else bump(m.cambio, 0.5, 1);
      risky(unseen >= 2, 1);
      notes.push({
        trait: "cambio",
        text: `You called Cambio on your ${ordinal(t)} turn${unseen >= 2 ? `, with ${unseen} cards you hadn't looked at. Each unknown card averages about 6 points` : ""}.`,
        dir: t <= 6 ? 1 : -1,
        verdict: unseen >= 2 ? "risky" : "read", leak: unseen >= 2 ? "blind-cambio" : undefined,
      });
      break;
    }
    default:
      break;
  }
  return { model: m, notes };
}

/** Save/load across games so the opponent gets to know you. */
const KEY = "cambio-player-model-v1";
export function loadModel(): PlayerModel | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? ({ ...emptyModel(), ...JSON.parse(raw) } as PlayerModel) : null;
  } catch {
    return null;
  }
}
export function saveModel(m: PlayerModel) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}
export function forgetModel() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
