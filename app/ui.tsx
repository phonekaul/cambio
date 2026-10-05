"use client";

import type { ReactNode } from "react";
import { SUIT_GLYPH, isRed, slotName, type Card } from "../lib/cards";
import type { Hand, Side } from "../lib/engine";
import { behindInsight, gauges, localReads, positionInfo, type PlayerModel, type TraitKey } from "../lib/model";

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

export type FlashKind = "eye" | "swap" | "match" | "miss";
export interface Flash {
  id: number;
  side: Side;
  slot: number;
  kind: FlashKind;
}

const FLASH_ICON: Record<FlashKind, string> = { eye: "👀", swap: "↔", match: "✓", miss: "✗" };

export function PlayingCard(props: {
  card?: Card | null;
  faceUp?: boolean;
  onClick?: () => void;
  selected?: boolean;
  selectable?: boolean;
  glow?: boolean;
  flash?: FlashKind | null;
  label?: string;
}) {
  const { card, faceUp, onClick, selected, selectable, glow, flash, label } = props;
  const show = !!card && !!faceUp;
  const cls = ["pcard", show ? "up" : "down", selected ? "selected" : "", selectable ? "selectable" : "", glow ? "glow" : "", flash ? `flash-${flash}` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} onClick={onClick} disabled={!onClick} aria-label={label ?? (show ? `${card!.rank} card` : "face-down card")}>
      {show ? <Face card={card!} /> : <Back />}
      {flash && <span className="flash-badge">{FLASH_ICON[flash]}</span>}
    </button>
  );
}

function Face({ card }: { card: Card }) {
  const joker = card.rank === "JK";
  const tone = joker ? "joker" : isRed(card) ? "red" : "black";
  return (
    <div className={`face ${tone}`} key={card.id}>
      <div className="corner tl">
        <b>{joker ? "JK" : card.rank}</b>
        {!joker && <span>{SUIT_GLYPH[card.suit]}</span>}
      </div>
      <div className={`pip ${joker ? "joker-word" : ""}`}>{joker ? "Joker" : SUIT_GLYPH[card.suit]}</div>
      <div className="corner br">
        <b>{joker ? "JK" : card.rank}</b>
        {!joker && <span>{SUIT_GLYPH[card.suit]}</span>}
      </div>
    </div>
  );
}

function Back() {
  return (
    <div className="back">
      <div className="back-inner" />
    </div>
  );
}

export function EmptySlot() {
  return <div className="slot-empty" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Hand                                                                */
/* ------------------------------------------------------------------ */

export function HandView(props: {
  side: Side;
  hand: Hand;
  faceUp: (slot: number) => boolean;
  selectable: (slot: number) => boolean;
  selected: (slot: number) => boolean;
  flashes: Flash[];
  onSlot: (slot: number) => void;
}) {
  const { side, hand, faceUp, selectable, selected, flashes, onSlot } = props;
  return (
    // one row; penalty cards extend it, and --n lets the cards shrink to keep the row on screen
    <div className={`hand ${side}`} style={{ ["--n" as string]: String(Math.max(4, hand.length)) }}>
      {hand.map((c, i) => (
        <div key={`${i}-${c?.id ?? "empty"}`} className="hand-slot">
        {c ? (
          <PlayingCard
            card={c}
            faceUp={faceUp(i)}
            selectable={selectable(i)}
            selected={selected(i)}
            flash={flashes.find((f) => f.side === side && f.slot === i)?.kind ?? null}
            onClick={selectable(i) ? () => onSlot(i) : undefined}
            label={`${side === "human" ? "Your" : "Opponent's"} ${slotName(i)} card`}
          />
        ) : (
          <EmptySlot />
        )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Thoughts panel                                                      */
/* ------------------------------------------------------------------ */

export interface FeedItem {
  id: number;
  kind: "thought" | "notice";
  text: string;
  tags?: string[];
  changed?: boolean;
  trait?: TraitKey | "info";
  dir?: 1 | -1 | 0;
}

const TRAIT_EMOJI: Record<string, string> = {
  risk: "🎲",
  memory: "🧠",
  cambio: "🔔",
  discard: "♻️",
  predict: "🔁",
  position: "🧭",
  info: "💡",
};

export function ThoughtsPanel(props: { feed: FeedItem[]; thinking: boolean }) {
  const { feed, thinking } = props;
  return (
    <section className="thoughts" aria-label="Opponent's thoughts">
      <header className="thoughts-head">
        <h2>Opponent&apos;s thoughts</h2>
        {thinking && <span className="dots" aria-label="Thinking"><i /><i /><i /></span>}
      </header>
      <div className="feed">
        {feed.length === 0 && <p className="empty">Its reasoning and what it notices about you will show up here.</p>}
        {feed.map((f) =>
          f.kind === "thought" ? (
            <article key={f.id} className="thought">
              <p>{f.text}</p>
              {(f.tags?.length || f.changed) && (
                <div className="tags">
                  {f.changed && <span className="tag changed">Your profile changed this move</span>}
                  {f.tags?.map((t) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </div>
              )}
            </article>
          ) : (
            <article key={f.id} className={`notice ${f.dir === 1 ? "up" : f.dir === -1 ? "down" : ""}`}>
              <span className="ico">{TRAIT_EMOJI[f.trait ?? "info"]}</span>
              <p>
                <b>Noticed:</b> {f.text}
              </p>
            </article>
          ),
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Player profile                                                      */
/* ------------------------------------------------------------------ */

const confLabel = (c: number) => (c < 0.34 ? "low" : c < 0.6 ? "medium" : "high");

export function ProfilePanel(props: { model: PlayerModel; pulse: Partial<Record<TraitKey, number>>; priorGames: number }) {
  const { model, pulse, priorGames } = props;
  const g = gauges(model);
  const pos = positionInfo(model);
  const order: TraitKey[] = ["risk", "memory", "cambio", "position", "discard", "predict"];
  const insight = behindInsight(model);
  const maxUse = Math.max(1, ...model.slotUse.slice(0, 4));
  return (
    <section className="panel profile" aria-label="Your player profile">
      <header className="panel-head slim">
        <div>
          <h2>Your player profile</h2>
          <p className="status">
            {Math.round(model.evidence)} observations{priorGames > 0 ? ` · remembers ${priorGames} earlier game${priorGames === 1 ? "" : "s"}` : ""}
          </p>
        </div>
      </header>
      <div className="gauges">
        {order.map((k) => {
          const x = g[k];
          const pct = k === "position" ? Math.round(pos.share * 100) : Math.round(x.value * 100);
          const unknown = x.n < 1;
          return (
            <div key={`${k}-${pulse[k] ?? 0}`} className={`gauge ${pulse[k] ? "pulse" : ""}`}>
              <div className="g-top">
                <span className="g-label">{x.label}</span>
                <span className="g-val">
                  {unknown ? "Learning…" : x.headline}
                  {!unknown && <em>{pct}%</em>}
                </span>
              </div>
              <div className="g-bar">
                <span style={{ width: `${unknown ? 0 : pct}%` }} className={`fill ${k}`} />
              </div>
              <div className="g-sub">
                <span>{unknown ? "no evidence yet" : x.blurb}</span>
                <span className="conf" title="How much evidence backs this">
                  {confLabel(x.conf)} confidence
                </span>
              </div>
              {k === "position" && (
                <div className="heat" aria-label="How often you used each of your cards">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="cell" style={{ ["--h" as string]: String(model.slotUse[i] / maxUse) }} title={`${slotName(i)}: ${Math.round(model.slotUse[i])}`}>
                      {Math.round(model.slotUse[i]) || ""}
                    </div>
                  ))}
                  <p>Times you touched each card</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {insight && <p className="insight">💡 {insight}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export function RulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal rules" onClick={(e) => e.stopPropagation()}>
        <h2>How to play</h2>
        <p className="lead">Finish with the lowest total. Your cards stay face-down, so remember them.</p>
        <div className="two">
          <div>
            <h3>Card values</h3>
            <ul className="vals">
              <li><b>Joker</b> −1</li>
              <li><b>Red King</b> 0</li>
              <li><b>Ace</b> 1</li>
              <li><b>2 – 10</b> face value</li>
              <li><b>Jack</b> 11</li>
              <li><b>Queen</b> 12</li>
              <li><b>Black King</b> 13</li>
            </ul>
          </div>
          <div>
            <h3>Powers</h3>
            <p className="small">Draw one from the deck and press <b>Use power</b>:</p>
            <ul className="vals">
              <li><b>7, 8</b> peek at one of yours</li>
              <li><b>9, 10</b> peek at one of theirs</li>
              <li><b>J, Q</b> swap yours with theirs, unseen</li>
              <li><b>Black K</b> look at one of yours and one of theirs, then swap any of yours with any of theirs if you like</li>
            </ul>
          </div>
        </div>
        <h3>On your turn</h3>
        <ul className="plain">
          <li>Click the <b>deck</b> to draw, then swap it with one of your cards or click the discard pile to throw it away (and use its power). Click the <b>discard pile</b> instead to take its top card; you must swap that one in.</li>
          <li><b>Match</b> before you draw: if one of your cards has the same rank as the top discard, throw it away. Guess wrong and you take a penalty card.</li>
          <li><b>Call Cambio</b> any time during your turn to end the round. The other player gets one last turn, then everyone reveals. Lowest total wins, and a tie goes to the player who didn't call.</li>
        </ul>
        <button className="btn primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>;
}

export { localReads };
