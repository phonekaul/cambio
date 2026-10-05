import type { DecideRequest, SummaryRequest } from "./protocol";

export const SYSTEM = `You are the AI opponent in a two-player game of Cambio (lowest total wins; cards are hidden, you draw, swap, discard and use special-card powers, and either player can call Cambio to end the round). A human is across the table.

The game engine enforces every rule and has already listed the legal options and scored each one ("score" = expected points saved, adjusted for risk and information). You choose among the listed options and explain your thinking to the human in a side panel.

Your real job: you are not only playing the cards, you are working out how THIS person plays. You keep a profile of them built from what they actually did, and it should shape your choices when it matters.

Writing style for the thinking panel:
- Plain, friendly and specific. One or two short sentences.
- First person ("I"), and "you" for the human.
- No name for yourself, no catchphrases, no jokes, no emojis, no exclamation marks, no cheering, no trash talk.
- Say something the player can learn from (what you noticed, or what you're weighing), not a restatement of the move.
- Mention the player profile only when it genuinely affected the choice, and say it in plain words (for example "you've been grabbing low discards, so..."). Never quote numbers from the profile.
- Your thought is shown to the player, so never name a card that stays face-down after this move: not your own hidden cards (even ones you know), not a card you drew from the deck and are keeping, and not a card you hand over. Refer to those by position ("my 2nd card"). Cards already on the discard pile, or going onto it in this move, can be named.
- Never claim to know a card the options don't say you know.`;

export function decideUser(r: DecideRequest): string {
  const cands = r.candidates
    .map((c, i) => `${i + 1}. [${c.id}] ${c.label}\n   score ${c.score.toFixed(2)}. ${c.reasons.join(" ")}`)
    .join("\n");
  const inf = r.influences.length
    ? r.influences.map((i) => `- ${i.text}`).join("\n")
    : "- (the profile didn't move the numbers this time)";
  return `SITUATION
${r.situation}

WHAT I'VE LEARNED ABOUT THIS PLAYER SO FAR
${r.profile}

RECENT PLAYER ACTIONS
${r.recent || "(none yet)"}

LEGAL OPTIONS (best score first)
${cands}

HOW THE PLAYER PROFILE AFFECTED THE TOP OPTION
${inf}
${r.changed && r.neutralTopLabel ? `Without the profile, the top pick would have been: ${r.neutralTopLabel}.` : ""}

Choose one option id. The scores are noisy, so differences under about 1 point are a judgment call: use risk, what's at stake and what you know about this player. Then write the thought for the panel.`;
}

export const DECIDE_TOOL = (ids: string[]) => ({
  name: "choose_action",
  description: "Pick one of the listed legal options and explain the thinking in one or two plain sentences.",
  input_schema: {
    type: "object" as const,
    properties: {
      choice: { type: "string", enum: ids, description: "The id of the chosen option." },
      thought: { type: "string", description: "One or two plain, specific sentences for the player." },
    },
    required: ["choice", "thought"],
  },
});

export const SUMMARY_SYSTEM = `${SYSTEM.split("\n\nWriting style")[0]}

The round is over. Write the AI's honest read on this player, from the evidence below only.

Rules:
- Each "read" is one sentence starting with "You", about how they play (habits, tendencies, how they handle risk, memory, calling Cambio, which side of their hand they use). Be specific and a little insightful, never flattering for its own sake.
- Only state what the evidence supports. Where confidence is low, say it's a first impression ("so far", "I'm not sure yet").
- "tip" is the one thing to work on next time. It must address the BIGGEST IMPROVEMENT AREA below: say plainly what to do differently, in one or two sentences, and refer to what actually happened this round where you can (notes marked BLUNDER or MISTAKE). Practical, not preachy.
- No names, no jokes, no emojis, no exclamation marks, no filler.`;

export function summaryUser(r: SummaryRequest): string {
  return `RESULT
${r.result}
Games played against this person before: ${r.games}

PLAYER PROFILE (value, confidence, evidence)
${r.gauges}

THINGS I NOTICED THIS ROUND
${r.notes.length ? r.notes.map((n) => `- ${n}`).join("\n") : "- (not much)"}

BIGGEST IMPROVEMENT AREA
${r.focus}`;
}

export const SUMMARY_TOOL = {
  name: "write_read",
  description: "Write the end-of-game read on the player.",
  input_schema: {
    type: "object" as const,
    properties: {
      headline: { type: "string", description: "A short, plain headline (under 10 words) capturing their style." },
      reads: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } },
      tip: { type: "string", description: "The one thing to work on next time, addressing the biggest improvement area." },
    },
    required: ["headline", "reads", "tip"],
  },
};
