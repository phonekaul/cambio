/* Simulation harness: AI (no LLM) vs scripted players. Checks invariants and profile learning. */
import { aiMoves } from "../lib/aiplay";
import { buildDecision, isHumanBehind, describeSituation, templateThought } from "../lib/brain";
import { cardLabel, ALL_CARDS } from "../lib/cards";
import { cardValue, powerOf } from "../lib/cards";
import {
  callCambio, discardDrawn, drawDeck, handScore, hasSeen, kingDecide, legalStart, makeAiView, newGame, peekStart,
  skipPower, slam, swapDrawn, takeDiscard, topDiscard, useBlindSwap, useKingLook, usePeekOpp, usePeekOwn,
  type Game, type Move,
} from "../lib/engine";
import { carryOver, emptyModel, gauges, observeHuman, profileFromModel, type PlayerModel } from "../lib/model";
import { pickPeekSlots } from "../lib/brain";

type Style = "risky" | "careful" | "random";
let failures = 0;
const check = (c: boolean, msg: string) => { if (!c) { failures++; console.log("  FAIL:", msg); } };

let lastEv = "";
function conservation(g: Game, label: string) {
  if (g.hands.human.every((c) => c === null) && !(globalThis as any).__warned) { (globalThis as any).__warned = true; console.log("  NOTE: human hand became empty; last event:", lastEv); }
  const ids = [...g.deck, ...g.discard, ...g.hands.human.filter(Boolean), ...g.hands.ai.filter(Boolean)].map((c) => c!.id);
  if (g.drawn) ids.push(g.drawn.card.id);
  check(ids.length === 54 && new Set(ids).size === 54, `${label}: card conservation broken (${ids.length}, unique ${new Set(ids).size})`);
}

const rnd = (n: number) => Math.floor(Math.random() * n);

function humanTurn(g0: Game, style: Style): Move[] {
  const moves: Move[] = [];
  let g = g0;
  const push = (m: Move | null, what: string) => { if (!m) throw new Error("illegal human move: " + what + " phase=" + g.phase + " turn=" + g.turn + " drawn=" + JSON.stringify(g.drawn) + " hand=" + JSON.stringify(g.hands.human.map((c) => c && c.rank)) + " final=" + g.finalFor); moves.push(m); g = m.g; };
  const slots = (h: (any | null)[]) => h.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  const mine = () => slots(g.hands.human);
  const knownSlots = () => mine().filter((i) => hasSeen(g, "human", g.hands.human[i]!));
  const unseenSlots = () => mine().filter((i) => !hasSeen(g, "human", g.hands.human[i]!));

  // matching
  const top = topDiscard(g);
  if (legalStart(g, "human").canSlam && top) {
    const hit = knownSlots().find((i) => g.hands.human[i]!.rank === top.rank);
    if (hit !== undefined) push(slam(g, "human", hit), "slam");
    else if (style === "risky" && Math.random() < 0.15) push(slam(g, "human", mine()[rnd(mine().length)]), "blind slam");
  }
  if (g.phase === "ended") return moves;
  // calling
  const t = g.turnsTaken.human;
  if (legalStart(g, "human").canCall) {
    if (style === "risky" && t >= 4) return [...moves, { ...callCambio(g, "human")! }];
    if (style === "careful" && t >= 8) return [...moves, { ...callCambio(g, "human")! }];
  }
  // draw
  const topNow = topDiscard(g);
  if (topNow && cardValue(topNow) <= 3 && style !== "careful" && legalStart(g, "human").canTake) push(takeDiscard(g, "human"), "take");
  else push(drawDeck(g, "human"), "draw");
  if (g.phase === "ended") return moves;

  const x = g.drawn!;
  const xv = cardValue(x.card);
  if (mine().length === 0) push(discardDrawn(g, "human"), "discard-empty");
  else if (style === "risky") {
    if (xv <= 5 && unseenSlots().length) push(swapDrawn(g, "human", unseenSlots()[0]), "swap");
    else if (x.from === "deck") push(discardDrawn(g, "human"), "discard");
    else push(swapDrawn(g, "human", mine()[0]), "swap");
  } else if (style === "careful") {
    const worstKnown = knownSlots().sort((a, b) => cardValue(g.hands.human[b]!) - cardValue(g.hands.human[a]!))[0];
    if (worstKnown !== undefined && cardValue(g.hands.human[worstKnown]!) > xv + 1) push(swapDrawn(g, "human", worstKnown), "swap");
    else if (x.from === "deck") push(discardDrawn(g, "human"), "discard");
    else push(swapDrawn(g, "human", worstKnown ?? mine()[0]), "swap");
  } else {
    if (x.from === "deck" && Math.random() < 0.5) push(discardDrawn(g, "human"), "discard");
    else push(swapDrawn(g, "human", mine()[rnd(mine().length)]), "swap");
  }
  if (g.phase === "power") {
    const p = g.power!;
    const aiSlots = slots(g.hands.ai);
    if (Math.random() < 0.2 || (aiSlots.length === 0 && (p === "peekOpp" || p === "blindSwap" || p === "king")) || (mine().length === 0 && (p === "peekOwn" || p === "blindSwap"))) push(skipPower(g, "human"), "skip");
    else if (p === "peekOwn") push(usePeekOwn(g, "human", mine()[rnd(mine().length)]), "peekOwn");
    else if (p === "peekOpp") push(usePeekOpp(g, "human", aiSlots[rnd(aiSlots.length)]), "peekOpp");
    else if (p === "blindSwap") push(useBlindSwap(g, "human", mine()[rnd(mine().length)], aiSlots[rnd(aiSlots.length)]), "blindSwap");
    else {
      push(useKingLook(g, "human", mine()[rnd(mine().length)], aiSlots[rnd(aiSlots.length)]), "kingLook");
      const swap = Math.random() < 0.5 && mine().length && slots(g.hands.ai).length;
      push(kingDecide(g, "human", swap ? mine()[0] : null, swap ? slots(g.hands.ai)[0] : null), "kingDecide");
    }
  }
  return moves;
}

let leakChecks = 0;
function leakCheck(g: Game, d: ReturnType<typeof buildDecision>, view: ReturnType<typeof makeAiView>) {
  // Every card face mentioned in anything handed to the LLM / the panel must be one the AI has actually seen.
  const visibleIds = new Set<number>([...g.seen.ai, ...g.discard.map((c) => c.id)]);
  if (g.drawn && g.turn === "ai") visibleIds.add(g.drawn.card.id);
  const allowed = new Set(ALL_CARDS.filter((c) => visibleIds.has(c.id)).map(cardLabel));
  const text = [describeSituation(view, d), ...d.candidates.flatMap((c) => [c.label, ...c.reasons]), ...d.influences.map((i) => i.text), templateThought(d, d.candidates[0])].join("\n");
  const found = text.match(/(10|[2-9]|A|J|Q|K)[♠♥♦♣]|Joker/g) ?? [];
  leakChecks++;
  for (const f of found) check(allowed.has(f), `LEAK: text mentions ${f}, which the AI has not seen`);
}

function aiTurn(g0: Game, model: PlayerModel, stats: { changed: number; decisions: number; influenced: Record<string, number> }): Move[] {
  const out: Move[] = [];
  let g = g0;
  const profile = profileFromModel(model);
  for (let guard = 0; guard < 6; guard++) {
    if (g.phase !== "start" || g.turn !== "ai") break;
    const v1 = makeAiView(g);
    const d = buildDecision(v1, profile, "start");
    leakCheck(g, d, v1);
    stats.decisions++; if (d.changed) stats.changed++;
    d.influences.forEach((i) => (stats.influenced[i.feature] = (stats.influenced[i.feature] ?? 0) + 1));
    const ms = aiMoves(g, d.candidates[0].action);
    out.push(...ms); g = ms[ms.length - 1].g;
    if (d.candidates[0].action.type === "call") return out;
  }
  if (g.phase === "drawn") {
    const v2 = makeAiView(g);
    const d = buildDecision(v2, profile, "drawn");
    leakCheck(g, d, v2);
    stats.decisions++; if (d.changed) stats.changed++;
    d.influences.forEach((i) => (stats.influenced[i.feature] = (stats.influenced[i.feature] ?? 0) + 1));
    const ms = aiMoves(g, d.candidates[0].action);
    out.push(...ms);
  }
  return out;
}

function playGame(style: Style, model: PlayerModel, stats: any) {
  let g = newGame();
  // initial peeks
  const hs = style === "careful" ? [2, 3] : [rnd(2), 2 + rnd(2)];
  g = peekStart(g, "human", hs)!.g;
  g = peekStart(g, "ai", pickPeekSlots())!.g;
  let m = model;
  let safety = 0;
  while (g.phase !== "ended" && safety++ < 200) {
    conservation(g, "loop");
    const side = g.turn;
    const moves = side === "human" ? humanTurn(g, style) : aiTurn(g, m, stats);
    for (const mv of moves) {
      if (side === "human") {
        const before = makeAiView(g);
        const behind = isHumanBehind(before);
        for (const ev of mv.ev) m = observeHuman(m, ev, before, { behind }).model;
        // `before` must be recomputed per move; approximate by stepping
      }
      g = mv.g; lastEv = mv.ev.map((e) => JSON.stringify(e).slice(0, 140)).join(" ; ");
      conservation(g, "after-move");
    }
    check(moves.length > 0 || g.phase === "ended", "turn produced no moves");
  }
  if (g.phase !== "ended") console.log("  STUCK:", JSON.stringify({ phase: g.phase, turn: g.turn, turns: g.turnsTaken, deck: g.deck.length, discard: g.discard.length, human: g.hands.human.map((c) => c && c.rank), ai: g.hands.ai.map((c) => c && c.rank), calledBy: g.calledBy, top: topDiscard(g)?.rank }));
  check(g.phase === "ended", `game did not end (style ${style})`);
  if (g.result) {
    check(g.result.human === handScore(g.hands.human) && g.result.ai === handScore(g.hands.ai), "result mismatch");
  }
  return { g, model: m };
}

const styles: Style[] = ["risky", "careful", "random"];
for (const style of styles) {
  let model = emptyModel();
  const stats = { changed: 0, decisions: 0, influenced: {} as Record<string, number> };
  const results = { human: 0, ai: 0, tie: 0 };
  const turns: number[] = [];
  const t0 = Date.now();
  const N = 40;
  for (let i = 0; i < N; i++) {
    const { g, model: m2 } = playGame(style, i % 5 === 0 ? emptyModel() : model, stats);
    model = i % 5 === 0 ? m2 : carryOver(m2);
    results[g.result!.winner]++;
    turns.push(g.turnsTaken.human + g.turnsTaken.ai);
    if (i === N - 1) model = m2;
  }
  const gg = gauges(model);
  const avgTurns = (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1);
  console.log(`\n== ${style} player ==  wins: human ${results.human}, AI ${results.ai}, tie ${results.tie}  | avg total turns ${avgTurns} | ${(Date.now() - t0)}ms`);
  console.log(`  decisions ${stats.decisions}, changed by profile ${stats.changed} (${((100 * stats.changed) / stats.decisions).toFixed(1)}%), influences:`, stats.influenced);
  console.log(`  last-game gauges: risk ${gg.risk.value.toFixed(2)} (conf ${gg.risk.conf.toFixed(2)}), memory ${gg.memory.value.toFixed(2)}, cambio ${gg.cambio.value.toFixed(2)}, discard ${gg.discard.value.toFixed(2)}, predict ${gg.predict.value.toFixed(2)}, position ${gg.position.headline}`);
}
console.log(`leak checks run: ${leakChecks}`);
console.log(failures === 0 ? "\nALL SIMULATION CHECKS PASSED" : `\n${failures} FAILURES`);
void powerOf;
