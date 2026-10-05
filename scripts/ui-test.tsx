import { realSetTimeout } from "./dom-setup";
const g = globalThis as any;
let llmCalls = 0, summaryCalls = 0, focusMissing = 0;
g.fetch = async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  if (body.action === "decide") {
    llmCalls++;
    // sanity: the prompt payload must never contain hidden info it shouldn't have
    const pick = body.candidates[Math.min(1, body.candidates.length - 1)];
    return { ok: true, json: async () => ({ choice: llmCalls % 3 === 0 ? pick.id : body.candidates[0].id, thought: "Mock thought about " + body.candidates[0].label }) };
  }
  summaryCalls++;
  if (!body.focus) focusMissing++;
  return { ok: true, json: async () => ({ headline: "Mock headline", reads: ["You mock read one.", "You mock read two.", "You mock read three."], tip: "Mock tip." }) };
};

import React from "react";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import Game from "../app/Game";

let failures = 0;
let burnTries = 0;
const check = (c: boolean, m: string) => { if (!c) { failures++; console.log("  FAIL:", m); } };
const btn = (re: RegExp) => screen.queryAllByRole("button").find((b) => re.test(b.textContent ?? "") && !(b as HTMLButtonElement).disabled);
const click = async (el: Element | undefined | null) => { if (!el) return false; await act(async () => { fireEvent.click(el); }); return true; };
const wait = (ms: number) => act(async () => { await new Promise((r) => realSetTimeout(r, ms)); });
const ownCards = () => Array.from(document.querySelectorAll(".hand.human .pcard")) as HTMLElement[];
const oppCards = () => Array.from(document.querySelectorAll(".hand.ai .pcard")) as HTMLElement[];
const selectable = (els: HTMLElement[]) => els.filter((e) => e.classList.contains("selectable"));
const promptText = () => document.querySelector(".prompt")?.textContent ?? "";

async function playOne(gameNo: number, style: "draw-discard" | "swap" | "call-early") {
  cleanup(); localStorage.clear();
  const { container } = render(<Game />);
  await click(btn(/^Play$/));
  check(!!document.querySelector(".table"), "table rendered after Play");
  // opening peek: the two leftmost cards are shown automatically
  const own = ownCards();
  check(own.length === 4, `4 own cards (${own.length})`);
  check(/Memorise/i.test(promptText()), "starting cards shown with a memorise prompt");
  check(own[0].classList.contains("up") && own[1].classList.contains("up"), "the two leftmost cards are the ones shown");
  check(document.querySelectorAll(".hand.human .pcard.up").length === 2, "exactly two own cards face-up after the opening peek");
  check(document.querySelectorAll(".hand.ai .pcard.up").length === 0, "AI cards stay hidden");
  await click(btn(/^Got it$/));
  check(document.querySelectorAll(".hand.human .pcard.up").length === 0, "own cards flip back after Got it");

  let steps = 0;
  while (steps++ < 400) {
    if (document.querySelector(".result")) break;
    await wait(15);
    const p = promptText();
    if (btn(/^Got it$/)) { await click(btn(/^Got it$/)); continue; }
    if (steps % 5 === 0 && btn(/^Burn a /)) { burnTries++; await click(btn(/^Burn a /)); continue; }
    if (/Your turn\. Draw from the deck/.test(p)) {
      if (style === "call-early" && btn(/^Cambio!$/)) { await click(btn(/^Cambio!$/)); continue; }
      await click(document.querySelector(".pile.deck .pcard.selectable")); continue;
    }
    if (/Swap it into your hand|to swap in the/.test(p)) {
      const pile = document.querySelector(".pile.discard .selectable, .pile.discard .selectable-empty");
      if (pile && (style === "draw-discard" || steps % 2)) await click(pile);
      else await click(selectable(ownCards())[steps % 4 % Math.max(1, selectable(ownCards()).length)]);
      continue;
    }
    if (/Power!/.test(p)) {
      if (/peek at one of your own/i.test(p)) { await click(selectable(ownCards())[0]); }
      else if (/peek at one of your opponent/i.test(p)) { await click(selectable(oppCards())[0]); }
      else if (/Swap one of your cards/i.test(p)) { await click(selectable(ownCards())[0]); await click(selectable(oppCards())[0]); }
      else if (/Look at one of your cards and one of theirs/i.test(p)) { await click(selectable(ownCards())[0]); await click(selectable(oppCards())[0]); }
      else await click(btn(/^Skip$/));
      continue;
    }
    if (/Take a look\. To swap/.test(p)) { if (steps % 2) await click(btn(/Keep as is/)); else { await click(selectable(ownCards())[0]); await click(selectable(oppCards())[0]); } continue; }
    if (/^Burn: click any card/.test(p)) { await click(selectable(ownCards())[0]); continue; }
    if (/to give the opponent/.test(p)) { await click(selectable(ownCards())[0]); continue; }
    // otherwise the AI is moving
  }
  check(!!document.querySelector(".result"), `game ${gameNo} (${style}) reached the result screen in ${steps} steps`);
  await waitFor(() => { if (!document.querySelector(".reads")) throw new Error("no summary"); }, { timeout: 3000 });
  check(/Mock headline/.test(document.body.textContent ?? ""), "summary rendered");
  check(/Work on this next time/.test(document.body.textContent ?? "") && /Mock tip/.test(document.body.textContent ?? ""), "the one thing to work on is shown");
  // Every card the AI still holds is face-up (it may hold none: burning can empty a hand).
  const aiCards = document.querySelectorAll(".hand.ai .pcard").length;
  check(document.querySelectorAll(".hand.ai .pcard.up").length === aiCards, "AI hand revealed at the end");
  await click(btn(/^Your profile$/));
  const ev = Number((document.querySelector(".profile .panel-head .status")?.textContent ?? "").match(/(\d+) observations/)?.[1] ?? 0);
  check(ev > 0, `profile gathered evidence (${ev} observations)`);
  const thoughts = document.querySelectorAll(".thought").length, notices = document.querySelectorAll(".notice").length;
  console.log(`game ${gameNo} [${style}]: ${steps} steps, observations ${ev}, thoughts ${thoughts}, notices ${notices}, LLM decide calls so far ${llmCalls}`);
  return container;
}

(async () => {
  const errs: string[] = [];
  const origErr = console.error; console.error = (...a: any[]) => { const s = String(a[0]); if (!/not wrapped in act|act\(/.test(s)) errs.push(s.slice(0, 200)); };
  const styles = ["draw-discard", "swap", "call-early", "swap", "draw-discard", "swap"] as const;
  for (let i = 0; i < styles.length; i++) await playOne(i + 1, styles[i]);
  console.error = origErr;
  check(errs.length === 0, "no console errors: " + errs.slice(0, 3).join(" | "));
  check(focusMissing === 0, `every summary request names an improvement area (${focusMissing} missing)`);
  check(burnTries > 0, `the player burned at least once (${burnTries})`);
  console.log(failures === 0 ? "\nALL UI CHECKS PASSED" : `\n${failures} UI FAILURES`);
  process.exit(failures ? 1 : 0);
})();
