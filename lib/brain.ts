import { cardLabel, cardValue, powerOf, slotCol, slotName, type Card, type PowerKind } from "./cards";
import { MIN_TURNS_BEFORE_CALL, START_PEEK_SLOTS, type AiView, type SlotView } from "./engine";

/** The AI only calls Cambio when it believes its own hand is under this many points... */
const AI_CALL_MAX_OWN = 5;
/** ...and that it is more likely than not to win. */
const AI_CALL_MIN_WIN = 0.5;
import { NEUTRAL_PROFILE, TRAIT_LABEL, type Profile } from "./model";

/**
 * The AI's decision layer.
 *
 *   AiView (what it may know) -> beliefs -> every legal action -> a score for each
 *   -> (close call? ask the LLM to choose and explain) -> engine executes.
 *
 * Scores are in "expected points saved", adjusted for risk, information and the player profile.
 * Every number here is deterministic and inspectable.
 */

export type AiAction =
  | { type: "call" }
  | { type: "draw" }
  | { type: "take" }
  | { type: "swap"; slot: number }
  | { type: "discard" }
  | { type: "power"; kind: PowerKind; ownSlot?: number; oppSlot?: number };

export interface Candidate {
  id: string;
  label: string;
  action: AiAction;
  score: number;
  reasons: string[];
}

export type Feature = "risk" | "memory" | "cambio" | "discard" | "position" | "inference";
export const FEATURE_LABEL: Record<Feature, string> = {
  risk: TRAIT_LABEL.risk,
  memory: TRAIT_LABEL.memory,
  cambio: TRAIT_LABEL.cambio,
  discard: TRAIT_LABEL.discard,
  position: TRAIT_LABEL.position,
  inference: "Reads on your cards",
};

export interface Influence {
  feature: Feature;
  delta: number;
  text: string;
}

export interface Decision {
  kind: "start" | "drawn";
  candidates: Candidate[];
  neutralTopId: string;
  /** True when the player model changed which move ranks first. */
  changed: boolean;
  influences: Influence[];
  needLLM: boolean;
  pWin: number | null;
  callThr: number | null;
  estimates: Estimates;
}

export interface Estimates {
  ownMean: number;
  ownSd: number;
  oppMean: number;
  oppSd: number;
}

/* ------------------------------------------------------------------ */
/* math                                                                */
/* ------------------------------------------------------------------ */

const VAR_UNKNOWN = 12;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function erf(x: number) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
const phi = (x: number) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const f1 = (x: number) => x.toFixed(1);

/* ------------------------------------------------------------------ */
/* beliefs                                                             */
/* ------------------------------------------------------------------ */

interface OwnEst {
  slot: number;
  v: number;
  known: boolean;
  card: Card | null;
}
interface OppEst {
  slot: number;
  id: number;
  est: number;
  exact: boolean;
  vr: number;
  /** 0-1: how strongly we think this is a good card they're protecting. */
  protect: number;
  card: Card | null;
}

interface Params {
  lambda: number;
  scoreW: number;
  infoW: number;
  durability: number;
  trust: number;
  giftCoef: number;
  callThr: number;
}

function params(p: Profile, final: boolean): Params {
  return {
    // Risk aversion: rises when the player has been gambling (their hand is more volatile).
    lambda: final ? 0 : 0.1 + 0.3 * p.risk,
    // A player who calls early means points off my hand now beat information for later.
    scoreW: 0.8 + 0.4 * p.cambio,
    infoW: final ? 0 : 1.3 - 0.6 * p.cambio,
    // A forgetful player leaves a card I dump on them where it is.
    durability: 1 - p.memory,
    // How much to believe what the player's choices say about their hidden cards.
    trust: 0.35 + 0.65 * (0.6 * p.memory + 0.4 * p.predict),
    // A discard-pile grabber punishes me for throwing away good cards.
    giftCoef: 0.4 + 0.8 * p.discard,
    callThr: 0.64 + 0.16 * p.risk - 0.12 * (p.cambio - 0.5),
  };
}

interface Ctx {
  view: AiView;
  p: Profile;
  prm: Params;
  m: number;
  own: OwnEst[];
  opp: OppEst[];
  V: number;
  final: boolean;
}

function oppEstimate(o: SlotView, m: number, p: Profile, prm: Params): OppEst {
  if (o.card) {
    return { slot: o.slot, id: o.id, est: cardValue(o.card), exact: true, vr: 0, protect: 0, card: o.card };
  }
  let adj = 0;
  if (o.seenByOther) {
    const keeps = p.cardKeeps[o.id] ?? 0;
    if (keeps > 0) adj -= Math.min(2.6, 0.9 * keeps) * prm.trust;
    // A card the player chose to keep after drawing it is usually a good one (around 4).
    if (p.accepted[o.id]) adj += Math.min(0, 4.2 - m) * (0.55 + 0.45 * prm.trust);
    if (p.protectedCol !== null && slotCol(o.slot) === p.protectedCol) adj -= 1.0 * p.posStrength;
  }
  const est = Math.max(1, m + adj);
  return { slot: o.slot, id: o.id, est, exact: false, vr: adj !== 0 ? 7 : VAR_UNKNOWN, protect: clamp((m - est) / 3, 0, 1), card: null };
}

function makeCtx(view: AiView, p: Profile): Ctx {
  const final = view.finalFor === "ai";
  const prm = params(p, final);
  const m = view.pool.length ? mean(view.pool.map(cardValue)) : 6.2;
  const own: OwnEst[] = view.own
    .filter((s): s is SlotView => !!s)
    .map((s) => ({ slot: s.slot, v: s.card ? cardValue(s.card) : m, known: !!s.card, card: s.card }));
  const opp = view.opp.filter((s): s is SlotView => !!s).map((s) => oppEstimate(s, m, p, prm));
  const V = own.reduce((s, o) => s + (o.known ? 0 : VAR_UNKNOWN), 0);
  return { view, p, prm, m, own, opp, V, final };
}

export function estimates(view: AiView, p: Profile = NEUTRAL_PROFILE): Estimates {
  const c = makeCtx(view, p);
  return {
    ownMean: c.own.reduce((s, o) => s + o.v, 0),
    ownSd: Math.sqrt(c.V),
    oppMean: c.opp.reduce((s, o) => s + o.est, 0),
    oppSd: Math.sqrt(c.opp.reduce((s, o) => s + o.vr, 0)),
  };
}

/** Probability that calling Cambio now wins (ties go to the non-caller). */
export function winProb(view: AiView, p: Profile): number {
  const e = estimates(view, p);
  const catchUp = 1.3; // the opponent gets one more turn to improve
  const d = e.oppMean - catchUp - e.ownMean - 0.5;
  const sd = Math.sqrt(e.ownSd ** 2 + e.oppSd ** 2 + 4);
  return Phi(d / sd);
}

/** Is the human worse off than the AI by the AI's own reckoning? (uses neutral beliefs) */
export function isHumanBehind(view: AiView): boolean {
  const e = estimates(view, NEUTRAL_PROFILE);
  return e.oppMean - e.ownMean >= 2;
}

/* ------------------------------------------------------------------ */
/* scoring individual actions                                          */
/* ------------------------------------------------------------------ */

const sigma = (V: number) => Math.sqrt(Math.max(0, V));

function ownDesc(o: OwnEst) {
  return o.known ? `a known ${cardLabel(o.card!)}` : `unknown (about ${f1(o.v)})`;
}

function swapCand(c: Ctx, o: OwnEst, x: Card, from: "deck" | "discard"): Candidate {
  const xv = cardValue(x);
  const dEV = o.v - xv;
  const sigAfter = sigma(c.V - (o.known ? 0 : VAR_UNKNOWN));
  const gift = c.final ? 0 : c.prm.giftCoef * 0.5 * Math.max(0, 6 - o.v) * 0.3;
  const score = c.prm.scoreW * dEV - c.prm.lambda * sigAfter - gift;
  const reasons = [
    `${cardLabel(x)} replaces my ${slotName(o.slot)} card, ${ownDesc(o)}: ${dEV >= 0 ? `saves about ${f1(dEV)}` : `costs about ${f1(-dEV)}`} points.`,
  ];
  if (!o.known) reasons.push("Also makes my hand more certain.");
  if (gift > 0.3 && o.card) reasons.push(`Puts a ${cardLabel(o.card)} on the pile where it can be picked up.`);
  return {
    id: `swap:${o.slot}`,
    label: `${from === "discard" ? "Take" : "Keep"} the ${cardLabel(x)} and swap it into my ${slotName(o.slot)} card (${ownDesc(o)})`,
    action: { type: "swap", slot: o.slot },
    score,
    reasons,
  };
}

function drawnCandidates(c: Ctx, x: Card, from: "deck" | "discard"): Candidate[] {
  const out: Candidate[] = [];
  for (const o of c.own) out.push(swapCand(c, o, x, from));
  if (from === "discard") return out;

  const sigNow = sigma(c.V);
  out.push({
    id: "discard",
    label: `Discard the ${cardLabel(x)} and do nothing else`,
    action: { type: "discard" },
    score: -c.prm.lambda * sigNow,
    reasons: [`Keeps my hand as it is.`],
  });

  const power = powerOf(x);
  if (!power) return out;
  const { lambda, scoreW, infoW, durability, trust } = c.prm;

  if (power === "peekOwn") {
    for (const o of c.own) {
      const sigAfter = sigma(c.V - (o.known ? 0 : VAR_UNKNOWN));
      out.push({
        id: `power:peekOwn:${o.slot}`,
        label: `Discard the ${cardLabel(x)} and peek at my ${slotName(o.slot)} card (${ownDesc(o)})`,
        action: { type: "power", kind: "peekOwn", ownSlot: o.slot },
        score: (o.known ? 0.05 : infoW * 1.0) - lambda * sigAfter,
        reasons: [o.known ? "I already know that card." : "Turns an unknown card into a known one."],
      });
    }
  } else if (power === "peekOpp") {
    for (const b of c.opp) {
      out.push({
        id: `power:peekOpp:${b.slot}`,
        label: `Discard the ${cardLabel(x)} and peek at your ${slotName(b.slot)} card`,
        action: { type: "power", kind: "peekOpp", oppSlot: b.slot },
        score: (b.exact ? 0.05 : infoW * (0.5 + 0.9 * b.protect)) - lambda * sigNow,
        reasons: [
          b.exact ? "I already know that card." : b.protect > 0.2 ? `I suspect your ${slotName(b.slot)} card is a keeper.` : "Learning one of your cards helps me judge when to call.",
        ],
      });
    }
  } else if (power === "blindSwap") {
    for (const a of c.own) {
      for (const b of c.opp) {
        const gain = a.v - b.est;
        const factor = (a.known ? 0.5 + 0.5 * durability : 1) * (b.exact ? 1 : 0.5 + 0.5 * trust);
        const sigAfter = sigma(c.V - (a.known ? 0 : VAR_UNKNOWN) + (b.exact ? 0 : VAR_UNKNOWN));
        const reasons = [
          `Trade my ${slotName(a.slot)} card (${ownDesc(a)}) for your ${slotName(b.slot)} card (${b.exact ? `a known ${cardLabel(b.card!)}` : `about ${f1(b.est)}`}).`,
        ];
        if (a.known && a.v >= 8) reasons.push(`Hands you a ${cardLabel(a.card!)}.`);
        out.push({
          id: `power:blindSwap:${a.slot}:${b.slot}`,
          label: `Discard the ${cardLabel(x)} and blind-swap my ${slotName(a.slot)} card with your ${slotName(b.slot)} card`,
          action: { type: "power", kind: "blindSwap", ownSlot: a.slot, oppSlot: b.slot },
          score: scoreW * gain * factor - lambda * sigAfter,
          reasons,
        });
      }
    }
  } else if (power === "king") {
    // Look at my most uncertain card (an unknown one if I have it), and one of theirs.
    const look = [...c.own].sort((p1, p2) => Number(p1.known) - Number(p2.known) || p2.v - p1.v)[0];
    const worst = [...c.own].sort((p1, p2) => p2.v - p1.v)[0];
    for (const b of look && worst ? c.opp : []) {
      const d = worst.v - b.est;
      const sd = Math.sqrt((worst.known ? 0 : VAR_UNKNOWN) + b.vr + 1);
      const opt = d * Phi(d / sd) + sd * phi(d / sd);
      const sigAfter = sigma(c.V - (look.known ? 0 : VAR_UNKNOWN));
      out.push({
        id: `power:king:${look.slot}:${b.slot}`,
        label: `Discard the ${cardLabel(x)}, look at my ${slotName(look.slot)} card and your ${slotName(b.slot)} card, then maybe swap`,
        action: { type: "power", kind: "king", ownSlot: look.slot, oppSlot: b.slot },
        score: scoreW * opt + infoW * ((look.known ? 0 : 0.8) + 0.4 + 0.8 * b.protect) - lambda * sigAfter,
        reasons: [`Two looks for the price of one, then I swap only if it clearly helps me.`],
      });
    }
  }
  return out;
}

/** Expected utility of drawing from the deck, averaged over every card it could be. */
function evDraw(c: Ctx): number {
  const pool = c.view.pool;
  if (pool.length === 0) return -1;
  let total = 0;
  for (const x of pool) {
    const cands = drawnCandidates(c, x, "deck");
    total += Math.max(...cands.map((k) => k.score));
  }
  return total / pool.length;
}

function startCandidates(c: Ctx): { cands: Candidate[]; pWin: number | null } {
  const v = c.view;
  const out: Candidate[] = [];

  const draw = evDraw(c);
  out.push({
    id: "draw",
    label: "Draw from the deck",
    action: { type: "draw" },
    score: draw,
    reasons: [`Average outcome of an unseen card is worth about ${f1(draw)}.`],
  });

  if (v.top) {
    const best = c.own.map((o) => swapCand(c, o, v.top!, "discard")).sort((a, b) => b.score - a.score)[0];
    if (best) {
      out.push({
        id: "take",
        label: `Take the ${cardLabel(v.top)} from the discard pile, then swap it into my ${slotName((best.action as { slot: number }).slot)} card`,
        action: { type: "take" },
        score: best.score,
        reasons: best.reasons,
      });
    }
  }

  let pWin: number | null = null;
  const canCall = v.calledBy === null && v.turnsTaken.ai >= MIN_TURNS_BEFORE_CALL;
  const e = estimates(v, c.p);
  if (canCall) pWin = winProb(v, c.p);
  // It only considers calling when it thinks its hand is under 5 points and that it's ahead.
  if (pWin !== null && e.ownMean < AI_CALL_MAX_OWN && pWin > AI_CALL_MIN_WIN) {
    const bestOther = Math.max(...out.map((k) => k.score));
    out.push({
      id: "call",
      label: "Call Cambio",
      action: { type: "call" },
      score: bestOther + (pWin - c.prm.callThr) * 14,
      reasons: [
        `My hand is about ${f1(e.ownMean)} and yours about ${f1(e.oppMean)}: roughly ${Math.round(pWin * 100)}% to win if I call (I need ${Math.round(c.prm.callThr * 100)}%).`,
      ],
    });
  }
  return { cands: out, pWin };
}

/* ------------------------------------------------------------------ */
/* the decision, with a counterfactual                                 */
/* ------------------------------------------------------------------ */

const FEATURES: Feature[] = ["risk", "memory", "cambio", "discard", "position", "inference"];

function only(p: Profile, f: Feature): Profile {
  const n: Profile = { ...NEUTRAL_PROFILE, cardKeeps: {}, accepted: {} };
  switch (f) {
    case "risk": n.risk = p.risk; break;
    case "memory": n.memory = p.memory; break;
    case "cambio": n.cambio = p.cambio; break;
    case "discard": n.discard = p.discard; break;
    case "position": n.posStrength = p.posStrength; n.protectedCol = p.protectedCol; break;
    case "inference": n.cardKeeps = p.cardKeeps; n.accepted = p.accepted; n.predict = p.predict; break;
  }
  return n;
}

function generate(view: AiView, p: Profile, kind: "start" | "drawn"): { cands: Candidate[]; pWin: number | null; callThr: number } {
  const c = makeCtx(view, p);
  if (kind === "start") {
    const s = startCandidates(c);
    return { cands: s.cands, pWin: s.pWin, callThr: c.prm.callThr };
  }
  const d = view.drawn!;
  return { cands: drawnCandidates(c, d.card, d.from), pWin: null, callThr: c.prm.callThr };
}

function influenceText(f: Feature, cand: Candidate, p: Profile): string {
  const isCall = cand.id === "call";
  switch (f) {
    case "risk":
      if (isCall) return p.risk > 0.5 ? "You gamble a lot, so I want a bigger lead before I call." : "You rarely gamble, so I'll trust a smaller lead.";
      return p.risk > 0.5 ? "You've been taking gambles, so I'm playing for certainty in my own hand." : "You play it safe, so I can live with a little more uncertainty.";
    case "memory":
      if (cand.id.startsWith("power:blindSwap")) {
        return p.memory < 0.5 ? "You tend to forget what you've seen, so a bad card I hand you will likely stay in your hand." : "You remember your cards well, so a bad card I hand you wouldn't stay hidden for long.";
      }
      return p.memory > 0.5 ? "You remember your cards well, so I trust what your choices say about them." : "Your memory looks shaky, so I'm not reading much into what you keep.";
    case "cambio":
      return p.cambio > 0.5 ? "You call Cambio early, so I'm taking points off my hand now instead of gathering information." : "You rarely call early, so I have time to gather information.";
    case "discard":
      return p.discard > 0.5 ? "You grab good cards from the discard pile, so I'd rather not feed it." : "You rarely use the discard pile, so I can toss cards there freely.";
    case "position": {
      const side = p.protectedCol === 0 ? "left" : "right";
      return `You leave your ${side} cards alone, so I think those are your keepers.`;
    }
    case "inference":
      return "Based on what you've kept and taken, I have a read on your hidden cards.";
  }
}

export function buildDecision(view: AiView, profile: Profile, kind: "start" | "drawn"): Decision {
  const base = generate(view, profile, kind);
  const cands = [...base.cands].sort((a, b) => b.score - a.score);
  const top = cands[0];

  const neutral = generate(view, NEUTRAL_PROFILE, kind).cands;
  const neutralTop = [...neutral].sort((a, b) => b.score - a.score)[0];
  const neutralScore = new Map(neutral.map((x) => [x.id, x.score]));

  const influences: Influence[] = [];
  for (const f of FEATURES) {
    const only_ = generate(view, only(profile, f), kind).cands;
    const s = only_.find((x) => x.id === top.id)?.score;
    const flips = [...only_].sort((a, b) => b.score - a.score)[0]?.id === top.id && neutralTop.id !== top.id;
    if (s === undefined) continue;
    const delta = s - (neutralScore.get(top.id) ?? s);
    if (Math.abs(delta) >= 0.25 || flips) influences.push({ feature: f, delta, text: influenceText(f, top, profile) });
  }
  influences.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const second = cands[1];
  const callStake = base.pWin !== null && Math.abs(base.pWin - base.callThr) < 0.1;
  const needLLM = !!second && (callStake || top.score - second.score < (kind === "start" ? 1.2 : 0.8));

  return {
    kind,
    candidates: cands,
    neutralTopId: neutralTop.id,
    changed: neutralTop.id !== top.id,
    influences,
    needLLM,
    pWin: base.pWin,
    callThr: base.callThr,
    estimates: estimates(view, profile),
  };
}

/* ------------------------------------------------------------------ */
/* small deterministic choices                                         */
/* ------------------------------------------------------------------ */

/** Everyone looks at the same two starting cards (see START_PEEK_SLOTS in the engine). */
export function pickPeekSlots(): [number, number] {
  return [...START_PEEK_SLOTS];
}

/**
 * After the black King's two looks: swap the pair (any of mine, any of yours) that saves me the
 * most points. Known cards are trusted; guesses about unseen cards need a much bigger edge.
 */
export function kingDecision(view: AiView): { own: number; opp: number } | null {
  if (!view.kingLook) return null;
  const c = makeCtx(view, NEUTRAL_PROFILE);
  let best: { own: number; opp: number; gain: number } | null = null;
  for (const a of c.own) {
    for (const b of c.opp) {
      const gain = a.v - b.est - (b.exact ? 0.5 : 3) - (a.known ? 0 : 1);
      if (gain > 0 && (!best || gain > best.gain)) best = { own: a.slot, opp: b.slot, gain };
    }
  }
  return best ? { own: best.own, opp: best.opp } : null;
}

/* ------------------------------------------------------------------ */
/* burning (reactive: any time a new card lands on the pile)            */
/* ------------------------------------------------------------------ */

/** What handing over a card costs me: a known card's value, or the average for an unseen one. */
function giveValue(c: Ctx, o: OwnEst) {
  return o.known ? o.v : c.m;
}

/** The card I'd hand over after burning one of yours: my worst (highest) card. */
export function giveDecision(view: AiView): number | null {
  const c = makeCtx(view, NEUTRAL_PROFILE);
  const best = [...c.own].sort((a, b) => giveValue(c, b) - giveValue(c, a))[0];
  return best ? best.slot : null;
}

export interface BurnPick {
  target: "ai" | "human";
  slot: number;
  thought: string;
}

/**
 * Burn only cards I actually know (so I never miss). Burning my own card takes its points off my
 * total; burning yours means giving you my worst card, which is worth it when the swing is big.
 */
export function burnDecision(view: AiView): BurnPick | null {
  if (!view.canBurn || !view.burnRank) return null;
  const rank = view.burnRank;
  const c = makeCtx(view, NEUTRAL_PROFILE);
  let best: (BurnPick & { gain: number }) | null = null;
  for (const a of c.own) {
    if (a.card && a.card.rank === rank && a.v > 0) {
      const gain = a.v + 0.5;
      if (!best || gain > best.gain)
        best = { target: "ai", slot: a.slot, gain, thought: `I know my ${slotName(a.slot)} card is a ${cardLabel(a.card)}. Burning it takes ${a.v} off my hand.` };
    }
  }
  const giver = [...c.own].sort((x, y) => giveValue(c, y) - giveValue(c, x))[0];
  if (giver && c.own.length > 1) {
    for (const b of c.opp) {
      if (b.exact && b.card && b.card.rank === rank) {
        const give = giveValue(c, giver);
        const gain = 2 * give - b.est;
        if (gain > 2 && (!best || gain > best.gain))
          best = {
            target: "human",
            slot: b.slot,
            gain,
            thought: `I know your ${slotName(b.slot)} card is a ${cardLabel(b.card)}. I'll burn it and hand you my ${slotName(giver.slot)} card${giver.known && giver.card ? ` (the ${cardLabel(giver.card)})` : ""}.`,
          };
      }
    }
  }
  return best ? { target: best.target, slot: best.slot, thought: best.thought } : null;
}

/** A plain sentence for the thoughts panel when the LLM isn't consulted. */
export function templateThought(d: Decision, chosen: Candidate): string {
  const lead = chosen.reasons[0] ?? chosen.label;
  const why = d.influences[0]?.text;
  return why ? `${lead} ${why}` : lead;
}

/** Compact situation text for the LLM prompt. */
export function describeSituation(view: AiView, d: Decision): string {
  const own = view.own
    .map((s) => (s ? `${slotName(s.slot)}: ${s.card ? cardLabel(s.card) : "unknown"}` : null))
    .filter(Boolean)
    .join("; ");
  const opp = view.opp
    .map((s) => (s ? `${slotName(s.slot)}: ${s.card ? cardLabel(s.card) : s.seenByOther ? "unknown to me (they have looked at it)" : "unknown to me (they have not looked at it)"}` : null))
    .filter(Boolean)
    .join("; ");
  const e = d.estimates;
  return [
    `Phase: ${view.phase}${view.finalFor === "ai" ? " (FINAL TURN: the human called Cambio, so this is my last move)" : ""}`,
    `My cards: ${own}`,
    `Their cards: ${opp}`,
    `Top of discard: ${view.top ? cardLabel(view.top) : "none"}. Deck: ${view.deckCount} cards.`,
    view.drawn ? `I am holding: ${cardLabel(view.drawn.card)} (drawn from the ${view.drawn.from}).` : "",
    `Turns taken: me ${view.turnsTaken.ai}, them ${view.turnsTaken.human}.`,
    `My estimated total: ${f1(e.ownMean)} (±${f1(e.ownSd)}). Their estimated total: ${f1(e.oppMean)} (±${f1(e.oppSd)}).`,
    d.pWin !== null ? `If I call Cambio now I estimate ${Math.round(d.pWin * 100)}% to win; my threshold is ${Math.round((d.callThr ?? 0) * 100)}%.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
