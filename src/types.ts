export interface RunRecord {
  timestamp: string;
  skill: string;
  command: string;
  intent: string | null;
  raw_bytes: number;
  summary_bytes: number;
  savings_pct: number;
}

export interface SessionEvent {
  timestamp: string;
  session_id: string;
  event_type: string;
  priority: Priority;
  priority_level: number;
  data: string;
  byte_size: number;
}

export type Priority = "critical" | "high" | "medium" | "low";

export const PRIORITY_CONFIG: Record<
  Priority,
  { level: number; label: string; budget_pct: number }
> = {
  critical: { level: 1, label: "P1", budget_pct: 0.4 },
  high: { level: 2, label: "P2", budget_pct: 0.3 },
  medium: { level: 3, label: "P3", budget_pct: 0.2 },
  low: { level: 4, label: "P4", budget_pct: 0.1 },
};

export interface Snapshot {
  session_id: string;
  snapshot_time: string;
  events: Record<string, SnapshotEvent[]>;
}

export interface SnapshotEvent {
  t: string;
  type: string;
  d: unknown;
}

export interface ExecuteResult {
  success: boolean;
  skill?: string;
  command?: string;
  output?: string;
  summary?: unknown;
  raw_bytes?: number;
  summary_bytes?: number;
  bytes_saved?: number;
  savings_pct?: number;
  indexed?: boolean;
  error?: string;
}

export interface BatchResult {
  success: boolean;
  timestamp: string;
  commands_run: number;
  commands_succeeded: number;
  commands_failed: number;
  total_raw_bytes: number;
  total_summary_bytes: number;
  total_bytes_saved: number;
  total_savings_pct: number;
  results: ExecuteResult[];
  search_results?: SearchResult[];
}

export interface SearchResult {
  source: string;
  label: string;
  content: string;
  timestamp: string;
  rank?: number;
}

export interface DeliveryResult {
  backend: string;
  to: string;
  status: "delivered" | "failed";
  detail: string;
}

export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "shell"
  | "ruby"
  | "go"
  | "rust"
  | "php"
  | "perl"
  | "r"
  | "elixir";

export const LANGUAGE_COMMANDS: Record<SupportedLanguage, string[]> = {
  javascript: ["node", "-e"],
  typescript: ["npx", "tsx", "-e"],
  python: ["python3", "-c"],
  shell: ["bash", "-c"],
  ruby: ["ruby", "-e"],
  go: ["go", "run"],
  rust: ["rustc", "--edition", "2021", "-o"],
  php: ["php", "-r"],
  perl: ["perl", "-e"],
  r: ["Rscript", "-e"],
  elixir: ["elixir", "-e"],
};
