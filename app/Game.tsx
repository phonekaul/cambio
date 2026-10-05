"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { aiMoves } from "../lib/aiplay";
import {
  buildDecision,
  describeSituation,
  FEATURE_LABEL,
  isHumanBehind,
  pickPeekSlots,
  templateThought,
  type AiAction,
  type Candidate,
  type Decision,
} from "../lib/brain";
import { cardLabel, POWER_TEXT, powerOf, slotName } from "../lib/cards";
import {
  callCambio,
  canCallCambio,
  discardDrawn,
  drawDeck,
  kingDecide,
  legalStart,
  makeAiView,
  newGame,
  peekStart,
  skipPower,
  slam,
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
  slamming: boolean;
  pendingOwn: number | null;
  peekSel: number[];
  pulse: Partial<Record<TraitKey, number>>;
  adaptations: string[];
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
  slamming: false,
  pendingOwn: null,
  peekSel: [],
  pulse: {},
  adaptations: [],
  notices: [],
  summary: null,
  summaryLoading: false,
  showResult: false,
  showRules: false,
  showProfile: false,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opponent pacing (ms), slow enough to follow each step it takes. */
const PACE = {
  start: 1100, // pause before it starts its turn
  afterThought: 1300, // time to read its thought before it acts
  step: 1700, // between each move it makes (draw, swap, power...)
  holdDrawn: 2000, // how long its drawn card hangs in the air before it decides
  last: 1000, // after its final move of the turn
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
    case "slam":
      return ev.success
        ? `${who(ev.side)} matched the ${cardLabel(ev.card)} and threw it away.`
        : `${who(ev.side)} tried to match with a ${cardLabel(ev.card)} and missed. Penalty card.`;
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
    case "slam":
      return [{ side: ev.side, slot: ev.slot, kind: ev.success ? "match" : "miss" }];
    default:
      return [];
  }
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
      if (d) lines.push(d);
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
    ref.current = { ...initial, screen: "game", g: newGame(), model, priorGames: model.games };
    setState(ref.current);
  }

  function forget() {
    forgetModel();
    setStored(null);
  }

  /* ---------- opening peek ---------- */

  function togglePeek(slot: number) {
    const s = ref.current;
    if (s.g.phase !== "peek" || s.g.peeked.human) return;
    let sel = s.peekSel.includes(slot) ? s.peekSel.filter((x) => x !== slot) : [...s.peekSel, slot];
    if (sel.length > 2) sel = sel.slice(1);
    set((x) => ({ ...x, peekSel: sel }));
    if (sel.length === 2) {
      const a = peekStart(ref.current.g, "human", sel);
      if (!a) return;
      const b = peekStart(a.g, "ai", pickPeekSlots());
      if (!b) return;
      commit(a);
      commit(b);
      set((x) => ({ ...x, reveal: sel.map((slot) => ({ side: "human" as Side, slot })), peekSel: [] }));
    }
  }

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

  function onOwnSlot(slot: number) {
    const s = ref.current;
    const g = s.g;
    if (g.phase === "peek") return togglePeek(slot);
    if (s.reveal.length || g.turn !== "human") return;
    if (g.phase === "start" && s.slamming) {
      const m = slam(g, "human", slot);
      if (!m) return;
      commit(m);
      const ev = m.ev[0];
      if (ev.t === "slam" && !ev.success) {
        set((x) => ({
          ...x,
          slamming: false,
          reveal: [{ side: "human", slot }],
          revealNote: `That was a ${cardLabel(ev.card)}, not a match. You take a penalty card.`,
        }));
      } else set((x) => ({ ...x, slamming: false }));
      return;
    }
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
    if (s.reveal.length || g.turn !== "human") return;
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
      const cand = dec.candidates.find((c) => c.id === res.choice) ?? top;
      return { cand, thought: res.thought, llm: true };
    } catch (e) {
      console.warn("LLM decision unavailable, using the engine's top pick:", e);
      return { cand: top, thought: templateThought(dec, top), llm: false };
    }
  }

  function addThought(dec: Decision, cand: Candidate, thought: string, llm: boolean) {
    const trivial = cand.action.type === "draw" && !llm && dec.influences.length === 0;
    if (trivial) return;
    const tags = Array.from(new Set(dec.influences.map((i) => FEATURE_LABEL[i.feature])));
    const changed = dec.changed && dec.candidates[0].id === cand.id;
    set((x) => ({
      ...x,
      feed: [{ id: nextId.current++, kind: "thought" as const, text: thought, tags, changed }, ...x.feed].slice(0, 60),
      adaptations:
        dec.influences.length > 0 && (changed || Math.abs(dec.influences[0].delta) >= 0.5)
          ? [...x.adaptations, `${cand.label}. ${dec.influences[0].text}${changed ? " Without the profile I would have chosen a different move." : ""}`].slice(-8)
          : x.adaptations,
    }));
  }

  async function playAction(action: AiAction, gid: number) {
    const moves = aiMoves(ref.current.g, action);
    for (const mv of moves) {
      if (gid !== gameId.current) return;
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
      for (let guard = 0; guard < 4; guard++) {
        const g = ref.current.g;
        if (gid !== gameId.current || g.turn !== "ai" || g.phase !== "start") break;
        const view = makeAiView(g);
        const dec = buildDecision(view, profileFromModel(ref.current.model), "start");
        const pick = await choose(dec, view);
        if (gid !== gameId.current) return;
        addThought(dec, pick.cand, pick.thought, pick.llm);
        await sleep(PACE.afterThought);
        await playAction(pick.cand.action, gid);
        if (pick.cand.action.type !== "slam") break;
      }
      const g2 = ref.current.g;
      if (gid === gameId.current && g2.turn === "ai" && g2.phase === "drawn") {
        const view = makeAiView(g2);
        const dec = buildDecision(view, profileFromModel(ref.current.model), "drawn");
        const pick = await choose(dec, view);
        if (gid !== gameId.current) return;
        addThought(dec, pick.cand, pick.thought, pick.llm);
        await sleep(PACE.afterThought);
        await playAction(pick.cand.action, gid);
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
    if (state.screen === "game" && g.phase !== "ended" && g.phase !== "peek" && g.turn === "ai" && g.phase === "start" && state.reveal.length === 0 && !aiBusy.current) {
      void runAi();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.g, state.reveal.length, state.screen]);

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
    set((x) => ({ ...x, showResult: true, summaryLoading: true, thinking: false }));
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
          adaptations: s.adaptations.slice(-6),
          result: resultText,
          games: s.priorGames,
        },
        30000,
      );
      set((x) => ({ ...x, summary: res, summaryLoading: false }));
    } catch (e) {
      console.warn("Summary unavailable, using local read:", e);
      set((x) => ({
        ...x,
        summary: {
          headline: "My read on you",
          reads,
          adapted: s.adaptations.slice(-2).map((a) => a.split(". ").slice(-1)[0]),
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
    if (blocked || ended) return false;
    if (g.phase === "peek") return !g.peeked.human;
    if (g.turn !== "human") return false;
    if (g.phase === "start") return s.slamming;
    return g.phase === "drawn" || g.phase === "power" && g.power !== "peekOpp" || g.phase === "king";
  };
  const oppSelectable = (slot: number) => {
    if (blocked || ended || g.turn !== "human") return false;
    if (g.phase === "king") return s.pendingOwn !== null;
    if (g.phase !== "power") return false;
    if (g.power === "peekOpp") return true;
    return (g.power === "blindSwap" || g.power === "king") && s.pendingOwn !== null;
  };

  // The piles are the controls: click the deck to draw, the discard pile to take its top card,
  // or (holding a card you drew) the discard pile to throw it away.
  const ready = humanTurn && !blocked && !s.slamming;
  const canDrawPile = ready && legal.canDraw;
  const canTakePile = ready && legal.canTake;
  const canDiscardHeld = ready && g.phase === "drawn" && g.drawn?.from === "deck";
  const canCall = ready && canCallCambio(g, "human");

  let prompt: React.ReactNode = null;
  let buttons: React.ReactNode = null;
  if (ended) {
    prompt = <>Round over.</>;
    buttons = <button className="btn primary" onClick={() => set((x) => ({ ...x, showResult: true }))}>See result</button>;
  } else if (g.phase === "peek") {
    prompt = g.peeked.human ? <>Ready?</> : <>Pick <b>two</b> of your cards to peek at ({s.peekSel.length}/2). Then memorise them.</>;
  } else if (blocked) {
    prompt = <>{s.revealNote || (g.phase === "start" && g.turn === "human" && g.turnsTaken.human === 0 ? "Memorise your cards." : "Take a good look.")}</>;
    buttons = <button className="btn primary" onClick={dismissReveal}>Got it</button>;
  } else if (aiTurn) {
    prompt = g.calledBy === "human" ? <>You called Cambio. The opponent gets <b>one last turn</b>.</> : <>The opponent is taking its turn.</>;
  } else if (humanTurn && g.phase === "start") {
    if (s.slamming) {
      prompt = <>Which of your cards matches the <b>{top ? cardLabel(top) : ""}</b>? Wrong guesses cost a penalty card.</>;
      buttons = <button className="btn small" onClick={() => set((x) => ({ ...x, slamming: false }))}>Cancel</button>;
    } else {
      prompt = (
        <>
          {g.finalFor === "human" && <><b>Last turn!</b> </>}Your turn. Draw from the deck{top ? <>, or take the <b>{cardLabel(top)}</b></> : null}.
        </>
      );
      buttons = legal.canSlam ? (
        <button className="btn small" onClick={() => set((x) => ({ ...x, slamming: true }))} title="Throw away one of your cards if it matches the top discard">
          Match the {top ? cardLabel(top) : "discard"}
        </button>
      ) : null;
    }
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
  const lastEvent = s.ticker[0];

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <h1>Cambio</h1>
          <button className="btn small ghost" onClick={startGame}>New game</button>
          <button className="btn small ghost" onClick={() => set((x) => ({ ...x, showRules: true }))}>Rules</button>
          <button className="btn small ghost" onClick={() => set((x) => ({ ...x, showProfile: true }))}>Your profile</button>
        </div>
        <ThoughtsPanel feed={s.feed} thinking={s.thinking} />
      </header>

      <main className="table">
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
            selected={(i) => s.peekSel.includes(i) || s.pendingOwn === i}
            flashes={s.flashes}
            onSlot={onOwnSlot}
          />
        </div>

        <div className="actionbar">
          {lastEvent && <p className="last-event" aria-live="polite">{lastEvent}</p>}
          <p className="prompt">{prompt}</p>
          <div className="btns">{buttons}</div>
        </div>
      </main>

      {canCall && (
        <button className="btn cambio" onClick={doCall} title="End the round: the opponent gets one last turn">
          Call Cambio
        </button>
      )}

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
        <h1>Cambio</h1>
        <p className="lead">A memory card game against an opponent that's trying to figure out how <i>you</i> play.</p>
        <ul className="points">
          <li>
            <span>🃏</span> Keep the lowest total. Your cards stay face-down.
          </li>
          <li>
            <span>🧠</span> It watches what you keep, swap, risk and remember, and builds a profile of you as you play.
          </li>
          <li>
            <span>🎯</span> Then it uses that profile against you. You can see both its thinking and your profile live.
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
              {sm.adapted.length > 0 && (
                <>
                  <h4>How it used that</h4>
                  <ul className="adapted">
                    {sm.adapted.map((x, i) => (
                      <li key={i}>{x}</li>
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
