# Cambio vs. an opponent that learns how you play

A two-player Cambio web app. The opponent doesn't just try to win the round, it builds a model of how *you* play (what you keep, what you dump, how well you remember, how early you call Cambio) and uses that model to choose its moves. You can watch the model build live.

## Run it

```bash
npm install
cp .env.example .env.local     # add ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

No key? Set `AI_MOCK=1` in `.env.local`. The opponent still plays using its deterministic evaluator and a local summary; only the LLM tie-breaks and writing are skipped.

## Deploy (Vercel)
Import the repo, set `ANTHROPIC_API_KEY` (optionally `AI_DECISION_MODEL`, `AI_SUMMARY_MODEL`, `AI_RATE_PER_HOUR`, `AI_DAILY_CAP`). No database; game state and the player model live in the browser (localStorage).

## How the agent works

```
Game state -> AI view (hidden info stripped) -> beliefs
   -> legal candidate actions -> evaluator (uses player profile)
   -> [LLM picks only when the top options are close] -> engine executes
   -> observe human move -> update player model (evidence + confidence)
```

- **Engine (`lib/engine.ts`)** enforces every rule. The LLM never touches game state and can only choose from candidates the engine already deemed legal.
- **Information hygiene** (`makeAiView`): the brain only sees cards the AI has actually seen. Checked by a leak test across simulated games.
- **Player model (`lib/model.ts`)**: weighted evidence per trait (risk, memory, Cambio aggression, discard habits, position preference, predictability) with a confidence that grows with observations. Low confidence shrinks a trait toward neutral, so the AI doesn't overreact to one move. Persists across games with decay.
- **Evaluator (`lib/brain.ts`)**: expected points saved, win probability, risk and information value, parameterised by the profile. Examples: forgetful player means dumping bad cards on them is safer; risk-taking player means the AI plays more conservatively; aggressive caller means it values low totals earlier.
- **Counterfactuals**: each decision is re-scored with a neutral profile and per-trait ablations, producing the "Your profile changed this move" notes and the influences shown in the thoughts panel.
- **LLM (`app/api/ai`)**: forced tool calls with structured schemas. Used for (1) choosing among near-tied candidates, (2) wording the thoughts, (3) the end-of-game read. Falls back to the evaluator's top pick or a local summary on any failure.

## Tests
```bash
npm run sim      # AI vs scripted humans: card conservation, termination, scoring, info-leak checks
npm run test:ui  # full games through the React UI in jsdom with a mocked API
npm run typecheck
```
