"use client";

import { useState, type ReactNode } from "react";
import { SUIT_GLYPH, isRed, slotName, type Card } from "../lib/cards";
import type { Hand, Side } from "../lib/engine";
import { behindInsight, gauges, localReads, positionInfo, type PlayerModel, type TraitKey, type Verdict } from "../lib/model";

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
  verdict?: Verdict;
}

const VERDICT_LABEL: Record<Verdict, string> = { blunder: "Blunder", mistake: "Mistake", risky: "Risky", good: "Good", read: "Read" };

/** Top-right box: the opponent's reasoning and what it notices about you (newest first). */
export function ThoughtsPanel(props: { feed: FeedItem[]; thinking: boolean; offline: string | null }) {
  const { feed, thinking, offline } = props;
  const [why, setWhy] = useState(false);
  return (
    <section className="thoughts" aria-label="Opponent's thoughts">
      <header className="thoughts-head">
        <h2>Opponent&apos;s thoughts</h2>
        {thinking && <span className="dots" aria-label="Thinking"><i /><i /><i /></span>}
        {offline && (
          <button className="offline-btn" onClick={() => setWhy((v) => !v)} aria-expanded={why}>
            Playing offline
          </button>
        )}
      </header>
      {offline && why && (
        <p className="offline-why">
          Claude can&apos;t be reached, so the opponent is using its built-in engine: same rules and strategy, simpler thoughts. {offline}
        </p>
      )}
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
            <article key={f.id} className="notice">
              <span className={`verdict ${f.verdict ?? "read"}`}>{VERDICT_LABEL[f.verdict ?? "read"]}</span>
              <p>{f.text}</p>
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

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const confLabel = (c: number) => (c < 0.34 ? "low" : c < 0.6 ? "medium" : "high");

export function ProfilePanel(props: { model: PlayerModel; pulse: Partial<Record<TraitKey, number>>; priorGames: number }) {
  const { model, pulse, priorGames } = props;
  const g = gauges(model);
  const pos = positionInfo(model);
  const order: TraitKey[] = ["risk", "memory", "discard", "predict", "cambio", "position"];
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
                  {cap(confLabel(x.conf))} confidence
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

        <h3>Goal</h3>
        <p>
          Have the <b>lowest score</b> when the round ends. Your cards stay face down, so remember the cards you&apos;ve seen and try to
          replace high cards with low ones. If you think you have the lowest score, call <b>CAMBIO!</b>
        </p>

        <h3>Card values</h3>
        <ul className="vals">
          <li><b>Ace – 10</b>: face value</li>
          <li><b>J, Q, Black K</b>: 10</li>
          <li><b>Red K</b>: −1</li>
          <li><b>Joker</b>: 0</li>
        </ul>

        <h3>Special cards</h3>
        <div className="table-scroll">
          <table className="abilities">
            <tbody>
              <tr><th>7 / 8</th><td>Peek at one of your own cards</td></tr>
              <tr><th>9 / 10</th><td>Peek at another player&apos;s card</td></tr>
              <tr><th>J / Q</th><td>Swap one of your cards with another player&apos;s card without looking</td></tr>
              <tr><th>Black K</th><td>Look at one of your cards and another player&apos;s card, then choose whether to swap</td></tr>
            </tbody>
          </table>
        </div>
        <p className="small">
          Special abilities can only be used when the card is <b>drawn from the draw pile and discarded on the same turn</b>.
        </p>

        <h3>Setup</h3>
        <ul className="plain">
          <li>You have <b>4 face-down cards</b>.</li>
          <li>
            At the start, look at the <b>2 cards closest to you</b> (here, your two leftmost cards). Remember them — you can&apos;t look at
            them again unless a card effect lets you.
          </li>
          <li>The remaining cards form the draw pile.</li>
        </ul>

        <h3>On your turn</h3>
        <p className="small">Choose one:</p>
        <ol className="plain">
          <li><b>Take the most recent face-up discard</b> (click the discard pile). Replace one of your face-down cards with it.</li>
          <li>
            <b>Draw from the face-down draw pile</b> (click the deck). Either replace one of your cards with it, or discard it (click the
            discard pile) and use its special ability, if it has one.
          </li>
          <li>
            <b>Call CAMBIO!</b> if you think you have the lowest score. You don&apos;t draw a card. Everyone else gets <b>one final turn</b>,
            then all cards are revealed and the lowest-scoring hand wins. (A tie goes to the player who didn&apos;t call.)
          </li>
        </ol>

        <h3>Burning</h3>
        <p>
          Whenever a new card enters the face-up discard pile, players may try to <b>burn</b> a card of the same rank that they know is on
          the table. For example, if an <b>8</b> is discarded and you know another player&apos;s card is an 8, you can reveal that card and
          place it on the discard pile. Press <b>Burn</b> next to the pile, then click the card. You can do this at any time, on anyone&apos;s
          turn, as long as nobody has burned on that card yet.
        </p>
        <ul className="plain">
          <li>If you burn <b>your own card</b>, the empty space remains empty.</li>
          <li>If you burn <b>another player&apos;s card</b>, give them one of your face-down cards to replace it.</li>
          <li>Only the <b>first player to match</b> gets the opportunity to burn.</li>
          <li>Once a player successfully matches, all other players are locked out and the successful player may continue burning matching cards.</li>
          <li>If you guess wrong, the card stays where it was and you take a <b>penalty card</b> from the draw pile.</li>
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
