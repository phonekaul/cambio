# Write-up draft (edit into your own voice)

## What I built
A two-player Cambio web app against an AI opponent whose real job is to figure out how you play. The game is the vehicle; the product is a live player model you can watch update, and an opponent that visibly changes its play because of it.

## Why Cambio
It is a game of hidden information, memory and bluffing, so the human's habits carry real signal: what they keep vs. throw away, whether they remember their cards, when they call. An opponent that exploits those habits is meaningfully different from one that plays a fixed strategy.

## How the agent decides
Game state -> view with hidden info stripped -> legal candidate actions -> deterministic evaluator parameterised by the player profile -> (LLM only if the top choices are close) -> engine executes -> observe the human -> update the model.
The engine enforces all rules. The LLM never manages state; it chooses among already-legal candidates, writes the thoughts, and writes the end-of-game read.

## The player model
Evidence-weighted traits (risk, memory, Cambio aggression, discard habits, position preference, predictability), each with a confidence. Low-confidence traits are shrunk toward neutral so the agent doesn't overfit. It persists across games with decay.

## Deliberate design choices
- Rules and legality in code, not in the LLM.
- Strict information hygiene: the agent only sees cards it has actually seen (tested with a leak check).
- Counterfactual scoring: each move is re-evaluated against a neutral profile, so "your profile changed this move" is a measured claim, not flavour text.
- LLM only where it adds value (close calls, language); deterministic fallbacks everywhere.
- No mascot, name or catchphrases; the personality is in the reasoning, not in jokes.
- Visible, small profile panel and plain-language thoughts feed.

## Tools used
Claude Code / Claude for building, Next.js + TypeScript, Anthropic API (Haiku for in-game decisions, Sonnet for the summary), tsx/jsdom simulation and UI tests, Vercel.

## Verification
Thousands of simulated games against scripted risky/careful/random players (invariants, termination, leaks); full UI games in jsdom. Against the scripted players the profile separates styles and changes the agent's top choice in roughly 8-12% of decisions.

## Honest limitations
- Tested against scripted opponents, not many real players; win rate vs. humans is unknown.
- Game state is client-side (fine for a demo, not tamper-proof).
- Two-player rule set: burning on any new discard (first to burn locks the other out), Cambio instead of drawing, hands laid out in a single row.

## What I'd do next
Learn from many players to seed priors; model bluffing and burn behaviour; multi-round sessions with adaptation across rounds; server-side state; richer evaluation of the opponent's hidden cards.
