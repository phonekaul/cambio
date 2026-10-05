export interface DecideRequest {
  action: "decide";
  situation: string;
  profile: string;
  candidates: Array<{ id: string; label: string; score: number; reasons: string[] }>;
  influences: Array<{ feature: string; text: string }>;
  changed: boolean;
  neutralTopLabel: string | null;
  recent: string;
}

export interface DecideResponse {
  choice: string;
  thought: string;
}

export interface SummaryRequest {
  action: "summary";
  gauges: string;
  notes: string[];
  /** The biggest weak spot this round, worked out by the game; the tip should address it. */
  focus: string;
  result: string;
  games: number;
}

export interface SummaryResponse {
  headline: string;
  reads: string[];
  tip: string;
}

export type AiRequest = DecideRequest | SummaryRequest;
