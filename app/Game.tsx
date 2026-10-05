"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { aiSteps } from "../lib/aiplay";
import {
  buildDecision,
  burnDecision,
  describeSituation,
  FEATURE_LABEL,
  giveDecision,
  isHumanBehind,
  kingDecision,
  pickPeekSlots,
  templateThought,
  type AiAction,
  type Candidate,
  type Decision,
} from "../lib/brain";
import { cardLabel, POWER_TEXT, powerOf, slotName } from "../lib/cards";
import {
  burn,
  callCambio,
  canBurn,
  canCallCambio,
  discardDrawn,
  drawDeck,
  giveCard,
  kingDecide,
  legalStart,
  makeAiView,
  newGame,
  peekStart,
  skipPower,
  START_PEEK_SLOTS,
  swapDrawn,
  takeDiscard,
  topDiscard,
  usePeekOpp as peekOppPower,
  usePeekOwn as peekOwnPower,
  useBlindSwap as blindSwapPower,
  useKingLook as kingLookPower,
  type AiView,
  type Game as GameState,
  type GameEvent,
  type Move,
  type Side,
} from "../lib/engine";
import {
  carryOver,
  emptyModel,
  forgetModel,
  gauges,
  loadModel,
  localReads,
  observeHuman,
  profileFromModel,
  saveModel,
  type PlayerModel,
  type TraitKey,
} from "../lib/model";
import type { DecideRequest, DecideResponse, SummaryResponse } from "../lib/protocol";
import {
  EmptySlot,
  HandView,
  PlayingCard,
  ProfilePanel,
  RulesModal,
  ThoughtsPanel,
  type Flash,
  type FeedItem,
} from "./ui";

/* ------------------------------------------------------------------ */
/* Types & helpers                                                     */
/* ------------------------------------------------------------------ */

interface RevealCell {
  side: Side;
  slot: number;
}

interface State {
  screen: "menu" | "game";
  g: GameState;
  model: PlayerModel;
  priorGames: number;
  feed: FeedItem[];
  ticker: string[];
  thinking: boolean;
  reveal: RevealCell[];
  revealNote: string;
  flashes: Flash[];
  /** The player pressed Burn and is choosing a card. The opponent holds off while they choose. */
  burning: boolean;
  pendingOwn: number | null;
  pulse: Partial<Record<TraitKey, number>>;
  /** Moves where its read on you changed what it played (vs. the same position with no profile). */
  adaptations: Adaptation[];
  /** Why Claude can't be reached, if it can't; the opponent then plays on its built-in engine. */
  offline: string | null;
  notices: string[];
  summary: SummaryResponse | null;
  summaryLoading: boolean;
  showResult: boolean;
  showRules: boolean;
  showProfile: boolean;
}

const blankGame = newGame();

const initial: State = {
  screen: "menu",
  g: blankGame,
  model: emptyModel(),
  priorGames: 0,
  feed: [],
  ticker: [],
  thinking: false,
  reveal: [],
  revealNote: "",
  flashes: [],
  burning: false,
  pendingOwn: null,
  pulse: {},
  adaptations: [],
  offline: null,
  notices: [],
  summary: null,
  summaryLoading: false,
  showResult: false,
  showRules: false,
  showProfile: false,
};

interface Adaptation {
  played: string;
  instead: string;
  because: string;
}

/** Candidate labels carry estimates in brackets, e.g. "(unknown (about 5.9))"; drop them for display. */
const plainLabel = (label: string) => label.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, "");

/** A short, fixable reason for the "Playing offline" note. */
function offlineReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/workspace/i.test(m)) return "Reason: the API key isn't tied to a workspace. Add ANTHROPIC_WORKSPACE_ID to .env.local (or use a workspace key) and restart the server.";
  if (/ANTHROPIC_API_KEY/.test(m)) return "Reason: the server has no ANTHROPIC_API_KEY set.";
  if (/401|authentication|invalid x-api-key/i.test(m)) return "Reason: the API key was rejected.";
  if (/429|budget|slow down/i.test(m)) return "Reason: the request limit was reached for now.";
  if (/abort/i.test(m)) return "Reason: Claude took too long to answer.";
  return "Reason: Claude couldn't be reached.";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opponent pacing (ms), slow enough to follow each step it takes. */
const PACE = {
  start: 1100, // pause before it starts its turn
  afterThought: 1300, // time to read its thought before it acts
  step: 1700, // between each move it makes (draw, swap, power...)
  holdDrawn: 2000, // how long its drawn card hangs in the air before it decides
  last: 1000, // after its final move of the turn
  burnReaction: 2500, // how long it waits after a card lands before burning (your chance to go first)
  give: 1200, // after it burns one of your cards, before it hands you a card
  reveal: 3000, // all cards face-up on the table before the result appears
};
const who = (s: Side) => (s === "human" ? "You" : "The opponent");
const its = (s: Side) => (s === "human" ? "your" : "its");
const theirs = (s: Side) => (s === "human" ? "the opponent's" : "your");

function describe(ev: GameEvent): string | null {
  switch (ev.t) {
    case "peekStart":
      return `${who(ev.side)} peeked at two of ${its(ev.side)} cards.`;
    case "draw":
      return ev.from === "deck" ? `${who(ev.side)} drew from the deck.` : `${who(ev.side)} took the ${cardLabel(ev.card!)} from the discard pile.`;
    case "swap":
      return `${who(ev.side)} swapped a card into ${its(ev.side)} ${slotName(ev.slot)} spot. The ${cardLabel(ev.old)} went on the pile.`;
    case "discard":
      return `${who(ev.side)} discarded the ${cardLabel(ev.card)}.`;
    case "power":
      if (ev.kind === "peekOwn") return `${who(ev.side)} peeked at ${its(ev.side)} ${slotName(ev.ownSlot!)} card.`;
      if (ev.kind === "peekOpp") return `${who(ev.side)} peeked at ${theirs(ev.side)} ${slotName(ev.oppSlot!)} card.`;
      if (ev.kind === "blindSwap") return `${who(ev.side)} swapped ${its(ev.side)} ${slotName(ev.ownSlot!)} card with ${theirs(ev.side)} ${slotName(ev.oppSlot!)} card.`;
      return `${who(ev.side)} used a King to look at ${its(ev.side)} ${slotName(ev.ownSlot!)} card and ${theirs(ev.side)} ${slotName(ev.oppSlot!)} card.`;
    case "powerSkip":
      return `${who(ev.side)} skipped the power.`;
    case "kingSwap":
      return ev.swapped
        ? `${who(ev.side)} swapped ${its(ev.side)} ${slotName(ev.ownSlot)} card with ${theirs(ev.side)} ${slotName(ev.oppSlot)} card.`
        : `${who(ev.side)} kept everything as it was.`;
    case "burn": {
      const whose = ev.target === ev.side ? its(ev.side) : theirs(ev.side);
      return ev.success
        ? `${who(ev.side)} burned ${whose} ${slotName(ev.slot)} card, the ${cardLabel(ev.card)}.`
        : `${who(ev.side)} tried to burn ${whose} ${slotName(ev.slot)} card, but it was a ${cardLabel(ev.card)}. Penalty card.`;
    }
    case "give":
      return `${who(ev.side)} gave ${ev.side === "human" ? "the opponent" : "you"} ${its(ev.side)} ${slotName(ev.from)} card to fill the gap.`;
    case "cambio":
      return `${who(ev.side)} called Cambio! ${ev.side === "human" ? "The opponent gets" : "You get"} one last turn.`;
    default:
      return null;
  }
}

function flashFor(ev: GameEvent): Array<Omit<Flash, "id">> {
  const o = (s: Side): Side => (s === "human" ? "ai" : "human");
  switch (ev.t) {
    case "swap":
      return [{ side: ev.side, slot: ev.slot, kind: "swap" }];
    case "power":
      if (ev.kind === "peekOwn") return [{ side: ev.side, slot: ev.ownSlot!, kind: "eye" }];
      if (ev.kind === "peekOpp") return [{ side: o(ev.side), slot: ev.oppSlot!, kind: "eye" }];
      if (ev.kind === "king")
        return [
          { side: ev.side, slot: ev.ownSlot!, kind: "eye" },
          { side: o(ev.side), slot: ev.oppSlot!, kind: "eye" },
        ];
      return [
        { side: ev.side, slot: ev.ownSlot!, kind: "swap" },
        { side: o(ev.side), slot: ev.oppSlot!, kind: "swap" },
      ];
    case "kingSwap":
      return ev.swapped
        ? [
            { side: ev.side, slot: ev.ownSlot, kind: "swap" },
            { side: o(ev.side), slot: ev.oppSlot, kind: "swap" },
          ]
        : [];
    case "burn":
      return ev.success ? [] : [{ side: ev.target, slot: ev.slot, kind: "miss" }];
    case "give":
      return [{ side: o(ev.side), slot: ev.to, kind: "swap" }];
    default:
      return [];
  }
}

/**
 * A card the AI drew from the deck and swaps into its hand stays hidden from you, so its thought
 * must not name it (or give away its value). Discards and pile takes are public, so they can.
 */
function hideSecretDraw(view: AiView, cand: Candidate, thought: string, dec: Decision): string {
  if (view.drawn?.from !== "deck" || cand.action.type !== "swap") return thought;
  const why = dec.influences[0]?.text;
  const line = `I'm keeping the card I drew. It goes where my ${slotName(cand.action.slot)} card was.`;
  return why ? `${line} ${why}` : line;
}

const confLabel = (c: number) => (c < 0.34 ? "low" : c < 0.6 ? "medium" : "high");

function profileText(m: PlayerModel): string {
  const g = gauges(m);
  const line = (k: Exclude<TraitKey, "position">) =>
    `${g[k].label}: ${g[k].n < 1 ? "no evidence yet" : `${g[k].headline} (${Math.round(g[k].value * 100)}%, ${confLabel(g[k].conf)} confidence, ${g[k].n.toFixed(1)} observations)`}`;
  return [line("risk"), line("memory"), line("cambio"), line("discard"), line("predict"), `Position preference: ${g.position.headline} (${g.position.blurb})`].join("\n");
}

async function post<T>(body: unknown, timeoutMs = 20000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({ error: "Bad response." }));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data as T;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function Game() {
  const [state, setState] = useState<State>(initial);
  const ref = useRef<State>(initial);
  const aiBusy = useRef(false);
  const gameId = useRef(0);
  const nextId = useRef(1);
  const finalized = useRef(false);
  const [stored, setStored] = useState<PlayerModel | null>(null);

  const set = useCallback((fn: (s: State) => State) => {
    ref.current = fn(ref.current);
    setState(ref.current);
  }, []);

  useEffect(() => {
    setStored(loadModel());
  }, []);

  /* ---------- committing a move ---------- */

  function commit(mv: Move) {
    const s = ref.current;
    const before = makeAiView(s.g);
    const behind = isHumanBehind(before);
    let model = s.model;
    const notices: FeedItem[] = [];
    const lines: string[] = [];
    const flashes: Flash[] = [];
    const pulse: Partial<Record<TraitKey, number>> = {};
    for (const ev of mv.ev) {
      const r = observeHuman(model, ev, before, { behind });
      model = r.model;
      for (const n of r.notes) {
        notices.push({ id: nextId.current++, kind: "notice", text: n.text, trait: n.trait, dir: n.dir });
        if (n.trait !== "info") pulse[n.trait] = nextId.current;
      }
      const d = describe(ev);
      if (d && "side" in ev && ev.side === "ai") lines.push(d);
      flashFor(ev).forEach((f) => flashes.push({ ...f, id: nextId.current++ }));
    }
    if (model !== s.model) saveModel(model);
    set((x) => ({
      ...x,
      g: mv.g,
      model,
      feed: [...notices.reverse(), ...x.feed].slice(0, 60),
      notices: [...x.notices, ...notices.map((n) => n.text)].slice(-30),
      ticker: [...lines.reverse(), ...x.ticker].slice(0, 4),
      flashes: [...x.flashes, ...flashes],
      pulse: { ...x.pulse, ...pulse },
    }));
    if (flashes.length) {
      const ids = new Set(flashes.map((f) => f.id));
      setTimeout(() => set((x) => ({ ...x, flashes: x.flashes.filter((f) => !ids.has(f.id)) })), 3600);
    }
  }

  /* ---------- starting ---------- */

  function startGame() {
    gameId.current += 1;
    aiBusy.current = false;
    finalized.current = false;
    const prev = loadModel();
    const model = prev ? carryOver(prev) : emptyModel();
    ref.current = { ...initial, screen: "game", g: newGame(), model, priorGames: model.games, offline: ref.current.offline };
    setState(ref.current);
    // Both players look at their two starting cards; the player's stay face-up until "Got it".
    const a = peekStart(ref.current.g, "human", [...START_PEEK_SLOTS]);
    const b = a && peekStart(a.g, "ai", pickPeekSlots());
    if (!a || !b) return;
    commit(a);
    commit(b);
    set((x) => ({
      ...x,
      reveal: START_PEEK_SLOTS.map((slot) => ({ side: "human" as Side, slot })),
      revealNote: "These are your two starting cards. Memorise them.",
    }));
  }

  function forget() {
    forgetModel();
    setStored(null);
  }

  /* ---------- opening peek ---------- */

  function dismissReveal() {
    set((x) => ({ ...x, reveal: [], revealNote: "" }));
  }

  /* ---------- human actions ---------- */

  function doDraw() {
    const m = drawDeck(ref.current.g, "human");
    if (m) commit(m);
  }
  function doTake() {
    const m = takeDiscard(ref.current.g, "human");
    if (m) commit(m);
  }
  function doCall() {
    const m = callCambio(ref.current.g, "human");
    if (m) commit(m);
  }
  /** Play the drawn card to the pile. A power card then offers its power (which can be skipped). */
  function doDiscard() {
    const m = discardDrawn(ref.current.g, "human");
    if (m) commit(m);
  }
  function doSkip() {
    const m = skipPower(ref.current.g, "human");
    if (m) commit(m);
    set((x) => ({ ...x, pendingOwn: null }));
  }

  /** Burn: any time a fresh card is on the pile, on anyone's turn, from either hand. */
  function tryBurn(target: Side, slot: number) {
    const rank = ref.current.g.burnRank;
    const m = burn(ref.current.g, "human", target, slot);
    if (!m) return set((x) => ({ ...x, burning: false }));
    commit(m);
    const ev = m.ev[0];
    if (ev.t === "burn" && !ev.success) {
      set((x) => ({
        ...x,
        burning: false,
        reveal: [{ side: target, slot }],
        revealNote: `That was a ${cardLabel(ev.card)}, not a ${rank === "JK" ? "Joker" : rank}. You take a penalty card.`,
      }));
    } else set((x) => ({ ...x, burning: false }));
  }

  function doGive(slot: number) {
    const m = giveCard(ref.current.g, "human", slot);
    if (m) commit(m);
  }

  function onOwnSlot(slot: number) {
    const s = ref.current;
    const g = s.g;
    if (s.reveal.length || g.phase === "peek" || g.phase === "ended") return;
    if (g.pendingGive?.by === "human") return doGive(slot);
    if (s.burning) return tryBurn("human", slot);
    if (g.turn !== "human") return;
    if (g.phase === "drawn") {
      const m = swapDrawn(g, "human", slot);
      if (m) commit(m);
    } else if (g.phase === "power" && g.power === "peekOwn") {
      const m = peekOwnPower(g, "human", slot);
      if (m) {
        commit(m);
        set((x) => ({ ...x, reveal: [{ side: "human", slot }] }));
      }
    } else if ((g.phase === "power" && (g.power === "blindSwap" || g.power === "king")) || g.phase === "king") {
      set((x) => ({ ...x, pendingOwn: x.pendingOwn === slot ? null : slot }));
    }
  }

  function onOppSlot(slot: number) {
    const s = ref.current;
    const g = s.g;
    if (s.reveal.length || g.phase === "peek" || g.phase === "ended") return;
    if (s.burning) return tryBurn("ai", slot);
    if (g.turn !== "human") return;
    if (g.phase === "king") {
      if (s.pendingOwn === null) return;
      const m = kingDecide(g, "human", s.pendingOwn, slot);
      if (m) {
        commit(m);
        set((x) => ({ ...x, pendingOwn: null }));
      }
      return;
    }
    if (g.phase !== "power") return;
    if (g.power === "peekOpp") {
      const m = peekOppPower(g, "human", slot);
      if (m) {
        commit(m);
        set((x) => ({ ...x, reveal: [{ side: "ai", slot }] }));
      }
    } else if (g.power === "blindSwap" && s.pendingOwn !== null) {
      const own = s.pendingOwn;
      const m = blindSwapPower(g, "human", own, slot);
      if (m) {
        commit(m);
        set((x) => ({ ...x, pendingOwn: null }));
      }
    } else if (g.power === "king" && s.pendingOwn !== null) {
      const m = kingLookPower(g, "human", s.pendingOwn, slot);
      if (m) {
        commit(m);
        set((x) => ({ ...x, pendingOwn: null }));
      }
    }
  }

  function doKeep() {
    const m = kingDecide(ref.current.g, "human", null);
    if (m) commit(m);
    set((x) => ({ ...x, pendingOwn: null }));
  }

  /* ---------- the AI's turn ---------- */

  async function choose(dec: Decision, view: AiView): Promise<{ cand: Candidate; thought: string; llm: boolean }> {
    const top = dec.candidates[0];
    if (!dec.needLLM) return { cand: top, thought: templateThought(dec, top), llm: false };
    try {
      const neutral = dec.candidates.find((c) => c.id === dec.neutralTopId);
      const req: DecideRequest = {
        action: "decide",
        situation: describeSituation(view, dec),
        profile: profileText(ref.current.model),
        candidates: dec.candidates.slice(0, 4).map((c) => ({ id: c.id, label: c.label, score: c.score, reasons: c.reasons })),
        influences: dec.influences.map((i) => ({ feature: i.feature, text: i.text })),
        changed: dec.changed,
        neutralTopLabel: dec.changed ? neutral?.label ?? null : null,
        recent: ref.current.notices.slice(-5).join("\n"),
      };
      const res = await post<DecideResponse>(req, 15000);
      if (ref.current.offline) set((x) => ({ ...x, offline: null }));
      const cand = dec.candidates.find((c) => c.id === res.choice) ?? top;
      return { cand, thought: res.thought, llm: true };
    } catch (e) {
      console.warn("LLM decision unavailable, using the engine's top pick:", e);
      set((x) => ({ ...x, offline: offlineReason(e) }));
      return { cand: top, thought: templateThought(dec, top), llm: false };
    }
  }

  function addThought(dec: Decision, cand: Candidate, thought: string, llm: boolean) {
    const trivial = cand.action.type === "draw" && !llm && dec.influences.length === 0;
    if (trivial) return;
    // Taking from the pile and then placing the card can produce the same sentence twice.
    const latest = ref.current.feed.find((f) => f.kind === "thought");
    if (latest?.text === thought) return;
    const tags = Array.from(new Set(dec.influences.map((i) => FEATURE_LABEL[i.feature])));
    const changed = dec.changed && dec.candidates[0].id === cand.id;
    // Only record moves your profile actually changed: same position, no profile, different move.
    const neutral = dec.candidates.find((c) => c.id === dec.neutralTopId);
    const adapted: Adaptation | null =
      changed && neutral && dec.influences[0]
        ? { played: plainLabel(cand.label), instead: plainLabel(neutral.label), because: dec.influences[0].text }
        : null;
    set((x) => ({
      ...x,
      feed: [{ id: nextId.current++, kind: "thought" as const, text: thought, tags, changed }, ...x.feed].slice(0, 60),
      adaptations: adapted ? [...x.adaptations, adapted].slice(-8) : x.adaptations,
    }));
  }

  /** The opponent holds off while you're mid-burn, reading a reveal, or a card is owed. */
  const aiPaused = () => {
    const s = ref.current;
    return s.burning || s.reveal.length > 0 || !!s.g.pendingGive;
  };
  async function waitWhilePaused(gid: number) {
    while (gid === gameId.current && aiPaused()) await sleep(150);
  }

  /** Play an action one step at a time. Each step reads the table as it is now (you may have burned
   * something in between); if a step no longer applies, stop and let the turn loop re-decide. */
  async function playAction(action: AiAction, gid: number) {
    for (const step of aiSteps(action)) {
      await waitWhilePaused(gid);
      if (gid !== gameId.current) return;
      const mv = step(ref.current.g);
      if (!mv) return;
      commit(mv);
      await sleep(mv.g.phase === "ended" ? PACE.last : mv.g.phase === "drawn" ? PACE.holdDrawn : mv.g.turn !== "ai" ? PACE.last : PACE.step);
    }
  }

  async function runAi() {
    if (aiBusy.current) return;
    aiBusy.current = true;
    const gid = gameId.current;
    set((x) => ({ ...x, thinking: true }));
    try {
      await sleep(PACE.start);
      for (let guard = 0; guard < 10; guard++) {
        await waitWhilePaused(gid);
        const g = ref.current.g;
        if (gid !== gameId.current || g.turn !== "ai" || g.phase === "ended" || g.phase === "peek") break;
        if (g.phase === "start" || g.phase === "drawn") {
          const view = makeAiView(g);
          const dec = buildDecision(view, profileFromModel(ref.current.model), g.phase);
          const pick = await choose(dec, view);
          if (gid !== gameId.current) return;
          if (ref.current.g !== g) continue; // the table changed while it thought (a burn): think again
          addThought(dec, pick.cand, hideSecretDraw(view, pick.cand, pick.thought, dec), pick.llm);
          await sleep(PACE.afterThought);
          await playAction(pick.cand.action, gid);
        } else if (g.phase === "power") {
          const m = skipPower(g, "ai");
          if (m) commit(m);
        } else if (g.phase === "king") {
          const k = kingDecision(makeAiView(g));
          const m = kingDecide(g, "ai", k?.own ?? null, k?.opp ?? null);
          if (m) commit(m);
        }
      }
    } catch (e) {
      console.error("AI turn failed, playing a safe fallback move", e);
      try {
        let g = ref.current.g;
        if (g.turn === "ai" && g.phase === "start") {
          await playAction({ type: "draw" }, gid);
          g = ref.current.g;
        }
        if (g.turn === "ai" && g.phase === "drawn") {
          const slot = g.hands.ai.findIndex(Boolean);
          await playAction(g.drawn?.from === "deck" ? { type: "discard" } : { type: "swap", slot }, gid);
        }
      } catch (e2) {
        console.error(e2);
      }
    } finally {
      aiBusy.current = false;
      if (gid === gameId.current) set((x) => ({ ...x, thinking: false }));
    }
  }

  useEffect(() => {
    const g = state.g;
    if (state.screen === "game" && g.phase !== "ended" && g.phase !== "peek" && g.turn === "ai" && state.reveal.length === 0 && !aiBusy.current) {
      void runAi();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.g, state.reveal.length, state.screen]);

  /* ---------- the AI burns, on anyone's turn ---------- */

  // A fresh burn window (new card on the pile, or the AI just burned and may keep going) arms one
  // timer. It waits PACE.burnReaction so you get the first chance, then burns only cards it knows.
  const burnKey = `${topDiscard(state.g)?.id ?? "-"}:${state.g.burnRank ?? "-"}:${state.g.burnedBy ?? "-"}:${state.g.burnMissed.join(",")}`;
  useEffect(() => {
    if (state.screen !== "game" || state.reveal.length || state.burning) return;
    const g = state.g;
    if (g.phase === "peek" || g.phase === "ended" || g.pendingGive || !burnDecision(makeAiView(g))) return;
    const gid = gameId.current;
    const t = setTimeout(() => {
      const s = ref.current;
      if (gid !== gameId.current || s.burning || s.reveal.length || s.g.pendingGive) return;
      const pick = burnDecision(makeAiView(s.g));
      if (!pick) return;
      const m = burn(s.g, "ai", pick.target, pick.slot);
      if (!m) return;
      set((x) => ({ ...x, feed: [{ id: nextId.current++, kind: "thought" as const, text: pick.thought, tags: [], changed: false }, ...x.feed].slice(0, 60) }));
      commit(m);
      if (m.g.pendingGive) {
        setTimeout(() => {
          if (gid !== gameId.current) return;
          const slot = giveDecision(makeAiView(ref.current.g));
          const gv = slot === null ? null : giveCard(ref.current.g, "ai", slot);
          if (gv) commit(gv);
        }, PACE.give);
      }
    }, PACE.burnReaction);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burnKey, state.reveal.length, state.burning, state.screen]);

  /* ---------- the end ---------- */

  useEffect(() => {
    if (state.screen === "game" && state.g.phase === "ended" && !finalized.current) {
      finalized.current = true;
      void finalize();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.g.phase, state.screen]);

  async function finalize() {
    const s = ref.current;
    const r = s.g.result!;
    saveModel(s.model);
    set((x) => ({ ...x, summaryLoading: true, thinking: false }));
    // Every card turns face-up on the table first; the result follows a moment later.
    const gid = gameId.current;
    setTimeout(() => {
      if (gid === gameId.current) set((x) => ({ ...x, showResult: true }));
    }, PACE.reveal);
    const resultText = `${r.winner === "human" ? "The player won" : r.winner === "ai" ? "The AI won" : "It was a tie"}. Final totals: player ${r.human}, AI ${r.ai}.${
      r.calledBy ? ` ${r.calledBy === "human" ? "The player" : "The AI"} called Cambio.` : ""
    }`;
    const reads = localReads(s.model);
    try {
      const res = await post<SummaryResponse>(
        {
          action: "summary",
          gauges: profileText(s.model),
          notes: s.notices.slice(-14),
          adaptations: s.adaptations.slice(-6).map((a) => `${a.played} instead of ${a.instead}: ${a.because}`),
          result: resultText,
          games: s.priorGames,
        },
        30000,
      );
      set((x) => ({ ...x, summary: res, summaryLoading: false, offline: null }));
    } catch (e) {
      console.warn("Summary unavailable, using local read:", e);
      set((x) => ({ ...x, offline: offlineReason(e) }));
      set((x) => ({
        ...x,
        summary: {
          headline: "My read on you",
          reads,
          adapted: [],
          tip: "",
        },
        summaryLoading: false,
      }));
    }
  }

  /* ---------- render helpers ---------- */

  const s = state;
  const g = s.g;

  if (s.screen === "menu") {
    return (
      <Menu
        stored={stored}
        onPlay={startGame}
        onForget={forget}
        showRules={s.showRules}
        setRules={(v) => set((x) => ({ ...x, showRules: v }))}
      />
    );
  }

  const ended = g.phase === "ended";
  const humanTurn = g.turn === "human" && !ended;
  const aiTurn = g.turn === "ai" && !ended && g.phase !== "peek";
  const blocked = s.reveal.length > 0;
  const kingLooking = g.phase === "king" && g.turn === "human";
  const legal = legalStart(g, "human");
  const top = topDiscard(g);

  const faceUp = (side: Side, slot: number) =>
    ended ||
    s.reveal.some((r) => r.side === side && r.slot === slot) ||
    (kingLooking && side === "ai" && slot === g.kingTarget) ||
    (kingLooking && side === "human" && slot === g.kingOwn);

  const ownSelectable = (slot: number) => {
    if (blocked || ended || g.phase === "peek") return false;
    if (g.pendingGive) return g.pendingGive.by === "human";
    if (s.burning) return true;
    if (g.turn !== "human") return false;
    if (g.phase === "start") return false;
    return g.phase === "drawn" || g.phase === "power" && g.power !== "peekOpp" || g.phase === "king";
  };
  const oppSelectable = (slot: number) => {
    if (blocked || ended || g.pendingGive) return false;
    if (s.burning) return true;
    if (g.turn !== "human") return false;
    if (g.phase === "king") return s.pendingOwn !== null;
    if (g.phase !== "power") return false;
    if (g.power === "peekOpp") return true;
    return (g.power === "blindSwap" || g.power === "king") && s.pendingOwn !== null;
  };

  // The piles are the controls: click the deck to draw, the discard pile to take its top card,
  // or (holding a card you drew) the discard pile to throw it away.
  const ready = humanTurn && !blocked && !s.burning && !g.pendingGive;
  const canDrawPile = ready && legal.canDraw;
  const canTakePile = ready && legal.canTake;
  const canDiscardHeld = ready && g.phase === "drawn" && g.drawn?.from === "deck";
  const canCall = ready && canCallCambio(g, "human");
  const burnOpen = !blocked && !s.burning && canBurn(g, "human");
  const rankName = (r: string | null) => (r === "JK" ? "Joker" : r ?? "");

  let prompt: React.ReactNode = null;
  let buttons: React.ReactNode = null;
  if (ended) {
    prompt = g.result ? <>Round over. You <b>{g.result.human}</b> · Opponent <b>{g.result.ai}</b></> : <>Round over.</>;
    buttons = <button className="btn primary" onClick={() => set((x) => ({ ...x, showResult: true }))}>See result</button>;
  } else if (g.phase === "peek") {
    prompt = <>Dealing…</>;
  } else if (blocked) {
    prompt = <>{s.revealNote || "Take a good look."}</>;
    buttons = <button className="btn primary" onClick={dismissReveal}>Got it</button>;
  } else if (g.pendingGive?.by === "human") {
    prompt = <>Burned! Now click one of <b>your</b> cards to give the opponent in its place.</>;
  } else if (g.pendingGive) {
    prompt = <>The opponent burned one of your cards and is choosing a card to give you.</>;
  } else if (s.burning) {
    prompt = <>Burn: click any card you know is a <b>{rankName(g.burnRank)}</b>, yours or the opponent&apos;s. A wrong guess costs a penalty card.</>;
    buttons = <button className="btn small" onClick={() => set((x) => ({ ...x, burning: false }))}>Cancel</button>;
  } else if (aiTurn) {
    prompt = g.calledBy === "human" ? <>You called Cambio. The opponent gets <b>one last turn</b>.</> : <>The opponent is taking its turn.</>;
  } else if (humanTurn && g.phase === "start") {
    prompt = (
      <>
        {g.finalFor === "human" && <><b>Last turn!</b> </>}Your turn. Draw from the deck{top && legal.canTake ? <>, or take the <b>{cardLabel(top)}</b></> : null}.
      </>
    );
  } else if (humanTurn && g.phase === "drawn" && g.drawn) {
    const power = g.drawn.from === "deck" ? powerOf(g.drawn.card) : null;
    prompt =
      g.drawn.from === "discard" ? (
        <>Click one of your cards to swap in the <b>{cardLabel(g.drawn.card)}</b>.</>
      ) : power ? (
        <>Swap it into your hand, or play it on the discard pile to <b>{POWER_TEXT[power].toLowerCase()}</b>.</>
      ) : (
        <>Swap it into your hand, or throw it on the discard pile.</>
      );
  } else if (humanTurn && g.phase === "power" && g.power) {
    const hint =
      g.power === "peekOwn" ? "Click one of your cards to peek at it."
      : g.power === "peekOpp" ? "Click one of the opponent's cards to peek at it."
      : g.power === "blindSwap" ? (s.pendingOwn === null ? "Click one of your cards, then one of theirs, to swap them." : "Now click the opponent's card you want.")
      : s.pendingOwn === null ? "Click one of your cards, then one of theirs, to look at both."
      : "Now click the opponent's card you want to look at.";
    prompt = <><b>Power!</b> {POWER_TEXT[g.power]}. {hint}</>;
    buttons = <button className="btn small" onClick={doSkip}>Skip</button>;
  } else if (humanTurn && kingLooking) {
    prompt =
      s.pendingOwn === null
        ? <>Take a look. To swap, click any one of your cards, then any one of theirs. Or keep things as they are.</>
        : <>Now click the opponent&apos;s card to swap with your {slotName(s.pendingOwn)} card.</>;
    buttons = <button className="btn small" onClick={doKeep}>Keep as is</button>;
  }

  const drawnHold = g.drawn && g.turn === "human";
  const aiHolds = g.drawn && g.turn === "ai";

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <h1>Cambio Trainer</h1>
          <button className="btn small ghost" onClick={startGame}>New game</button>
          <button className="btn small ghost" onClick={() => set((x) => ({ ...x, showRules: true }))}>Rules</button>
          <button className="btn small ghost" onClick={() => set((x) => ({ ...x, showProfile: true }))}>Your profile</button>
        </div>
        <ThoughtsPanel feed={s.feed} thinking={s.thinking} offline={s.offline} />
      </header>

      <main className="table">
        <p className="opp-move" aria-live="polite">{ended ? "" : s.ticker[0] ?? ""}</p>
        <div className={`seat ai ${aiTurn ? "active" : ""}`}>
          <HandView
            side="ai"
            hand={g.hands.ai}
            faceUp={(i) => faceUp("ai", i)}
            selectable={oppSelectable}
            selected={() => false}
            flashes={s.flashes}
            onSlot={onOppSlot}
          />
          {aiHolds && g.drawn && (
            <div className="held" key={g.drawn.card.id}>
              <PlayingCard card={g.drawn.card} faceUp={g.drawn.from === "discard"} glow />
            </div>
          )}
        </div>

        <div className="center">
          {g.calledBy && !ended && (
            <div className={`cambio-tag ${g.calledBy}`}>
              <b>Cambio!</b>
              <span>{g.calledBy === "human" ? "You called it" : "Opponent called it"}</span>
              <small>{g.finalFor === "human" ? "Your last turn" : "Its last turn"}</small>
            </div>
          )}
          <div className="pile deck">
            <div className="stack">
              <PlayingCard faceUp={false} selectable={canDrawPile} onClick={canDrawPile ? doDraw : undefined} label="Deck: click to draw" />
            </div>
            <small>Deck</small>
          </div>
          <div className="pile discard">
            {top ? (
              <PlayingCard
                card={top}
                faceUp
                selectable={canTakePile || canDiscardHeld}
                onClick={canTakePile ? doTake : canDiscardHeld ? doDiscard : undefined}
                label={canDiscardHeld ? "Discard pile: click to discard your card" : "Discard pile: click to take the top card"}
              />
            ) : canDiscardHeld ? (
              <button className="slot-empty selectable-empty" onClick={doDiscard} aria-label="Discard pile: click to discard your card" />
            ) : (
              <EmptySlot />
            )}
            <small>Discard</small>
          </div>
          <div className="burn-slot">
            {burnOpen && (
              <button
                className="btn small burn"
                onClick={() => set((x) => ({ ...x, burning: true, pendingOwn: null }))}
                title="Know where a matching card is? Burn it onto the pile."
              >
                Burn a {rankName(g.burnRank)}
              </button>
            )}
          </div>
        </div>

        <div className={`seat you ${humanTurn ? "active" : ""}`}>
          {drawnHold && g.drawn && (
            <div className="held" key={g.drawn.card.id}>
              <PlayingCard card={g.drawn.card} faceUp glow />
            </div>
          )}
          <HandView
            side="human"
            hand={g.hands.human}
            faceUp={(i) => faceUp("human", i)}
            selectable={ownSelectable}
            selected={(i) => s.pendingOwn === i}
            flashes={s.flashes}
            onSlot={onOwnSlot}
          />
          {canCall && (
            <button className="btn cambio" onClick={doCall} title="Call it instead of drawing: the opponent gets one last turn, then everyone reveals">
              Cambio!
            </button>
          )}
        </div>

        <div className="actionbar">
          <p className="prompt">{prompt}</p>
          <div className="btns">{buttons}</div>
        </div>
      </main>

      {ended && s.showResult && g.result && (
        <ResultModal
          s={s}
          onAgain={startGame}
          onClose={() => set((x) => ({ ...x, showResult: false }))}
        />
      )}
      {s.showRules && <RulesModal onClose={() => set((x) => ({ ...x, showRules: false }))} />}
      {s.showProfile && (
        <div className="overlay" onClick={() => set((x) => ({ ...x, showProfile: false }))}>
          <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
            <ProfilePanel model={s.model} pulse={s.pulse} priorGames={s.priorGames} />
            <button className="btn primary" onClick={() => set((x) => ({ ...x, showProfile: false }))}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function Menu(props: {
  stored: PlayerModel | null;
  onPlay: () => void;
  onForget: () => void;
  showRules: boolean;
  setRules: (v: boolean) => void;
}) {
  const { stored } = props;
  return (
    <div className="menu">
      <div className="menu-card">
        <div className="menu-cards" aria-hidden="true">
          <PlayingCard faceUp={false} />
          <PlayingCard card={{ id: 1, rank: "K", suit: "H" }} faceUp />
          <PlayingCard faceUp={false} />
        </div>
        <h1>Cambio Trainer</h1>
        <p className="lead">Play Cambio against an AI that studies your habits, plays against them, and tells you what it found.</p>
        <ul className="points">
          <li>
            <b>A real opponent.</b> Same rules, same hidden cards. It only knows what it has actually seen, so every read it makes is earned.
          </li>
          <li>
            <b>It learns how you play.</b> What you keep, what you pass on, how well you remember, how early you call Cambio.
          </li>
          <li>
            <b>Then it shows its hand.</b> After each round you get its read on your game, the moves it made because of it, and one thing to try next time.
          </li>
        </ul>
        {stored && stored.games + 1 > 0 && stored.evidence > 0 && (
          <p className="remember">It remembers you from {stored.games + 1} earlier game{stored.games + 1 === 1 ? "" : "s"}. <button onClick={props.onForget}>Make it forget</button></p>
        )}
        <div className="menu-actions">
          <button className="btn primary big" onClick={props.onPlay}>Play</button>
          <button className="btn ghost" onClick={() => props.setRules(true)}>How to play</button>
        </div>
      </div>
      {props.showRules && <RulesModal onClose={() => props.setRules(false)} />}
    </div>
  );
}

function ResultModal({ s, onAgain, onClose }: { s: State; onAgain: () => void; onClose: () => void }) {
  const r = s.g.result!;
  const title = r.winner === "human" ? "You win!" : r.winner === "ai" ? "The opponent wins" : "It's a tie";
  const sub =
    r.calledBy === null
      ? "The deck ran out."
      : r.calledBy === "human"
        ? r.winner === "human" ? "Your Cambio call paid off." : r.human === r.ai ? "Ties go to the player who didn't call." : "Your Cambio call didn't land."
        : r.winner === "ai" ? "It called Cambio and held on." : r.human === r.ai ? "Ties go to the player who didn't call." : "It called Cambio and you beat it.";
  const sm = s.summary;
  return (
    <div className="overlay">
      <div className="modal result">
        <div className={`banner ${r.winner}`}>
          <h2>{title}</h2>
          <p>{sub}</p>
          <div className="scores">
            <div className={r.winner === "human" ? "win" : ""}>
              <small>You</small>
              <b>{r.human}</b>
            </div>
            <span>vs</span>
            <div className={r.winner === "ai" ? "win" : ""}>
              <small>Opponent</small>
              <b>{r.ai}</b>
            </div>
          </div>
        </div>

        <div className="learned">
          <div className="learned-head">
            <h3>What it learned about you</h3>
            {sm && <p className="headline">{sm.headline}</p>}
          </div>
          {s.summaryLoading || !sm ? (
            <p className="loading"><span className="dots"><i /><i /><i /></span> Writing up its read on you…</p>
          ) : (
            <>
              <ul className="reads">
                {sm.reads.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              {s.adaptations.length > 0 && (
                <>
                  <h4>Where your habits changed its play</h4>
                  <ul className="adapted">
                    {s.adaptations.slice(-3).map((a, i) => (
                      <li key={i}>
                        <div><span className="k">Played</span> {a.played}</div>
                        <div><span className="k">Would have</span> {a.instead}</div>
                        <div><span className="k">Because</span> {a.because}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {sm.tip && <p className="tip"><b>Try this:</b> {sm.tip}</p>}
            </>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onAgain}>Play again</button>
          <button className="btn ghost" onClick={onClose}>Look at the table</button>
        </div>
      </div>
    </div>
  );
}
