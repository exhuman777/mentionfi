// Word bank for MentionFi auto-round game engine
// ~80 words/phrases across 4 categories with difficulty ratings
//
// Difficulty guide:
//   easy   — appears almost every hour in crypto RSS (bitcoin, ethereum, ai)
//   medium — common but not guaranteed hourly (solana, openai, fed)
//   hard   — rare, event-driven, spicy (halving, SEC lawsuit, bank run)

export type Difficulty = "easy" | "medium" | "hard";

export interface WordEntry {
  word: string;
  category: string;
  difficulty: Difficulty;
}

export const WORD_BANK: WordEntry[] = [
  // ─── Crypto (25) ──────────────────────────────────────────────
  // Easy
  { word: "bitcoin", category: "crypto", difficulty: "easy" },
  { word: "ethereum", category: "crypto", difficulty: "easy" },
  { word: "crypto", category: "crypto", difficulty: "easy" },
  { word: "blockchain", category: "crypto", difficulty: "easy" },
  { word: "token", category: "crypto", difficulty: "easy" },
  { word: "binance", category: "crypto", difficulty: "easy" },
  { word: "coinbase", category: "crypto", difficulty: "easy" },
  { word: "defi", category: "crypto", difficulty: "easy" },
  // Medium
  { word: "solana", category: "crypto", difficulty: "medium" },
  { word: "xrp", category: "crypto", difficulty: "medium" },
  { word: "stablecoin", category: "crypto", difficulty: "medium" },
  { word: "nft", category: "crypto", difficulty: "medium" },
  { word: "staking", category: "crypto", difficulty: "medium" },
  { word: "wallet", category: "crypto", difficulty: "medium" },
  { word: "altcoin", category: "crypto", difficulty: "medium" },
  { word: "memecoin", category: "crypto", difficulty: "medium" },
  { word: "layer 2", category: "crypto", difficulty: "medium" },
  { word: "whale", category: "crypto", difficulty: "medium" },
  { word: "airdrop", category: "crypto", difficulty: "medium" },
  { word: "etf", category: "crypto", difficulty: "medium" },
  // Hard
  { word: "halving", category: "crypto", difficulty: "hard" },
  { word: "SEC lawsuit", category: "crypto", difficulty: "hard" },
  { word: "megaeth", category: "crypto", difficulty: "hard" },
  { word: "liquidation", category: "crypto", difficulty: "hard" },
  { word: "rug pull", category: "crypto", difficulty: "hard" },

  // ─── Tech (20) ────────────────────────────────────────────────
  // Easy
  { word: "ai", category: "tech", difficulty: "easy" },
  { word: "openai", category: "tech", difficulty: "easy" },
  { word: "google", category: "tech", difficulty: "easy" },
  { word: "apple", category: "tech", difficulty: "easy" },
  { word: "nvidia", category: "tech", difficulty: "easy" },
  { word: "microsoft", category: "tech", difficulty: "easy" },
  // Medium
  { word: "meta", category: "tech", difficulty: "medium" },
  { word: "chatgpt", category: "tech", difficulty: "medium" },
  { word: "tesla", category: "tech", difficulty: "medium" },
  { word: "semiconductor", category: "tech", difficulty: "medium" },
  { word: "robot", category: "tech", difficulty: "medium" },
  { word: "llm", category: "tech", difficulty: "medium" },
  { word: "deepseek", category: "tech", difficulty: "medium" },
  { word: "anthropic", category: "tech", difficulty: "medium" },
  { word: "startup", category: "tech", difficulty: "medium" },
  { word: "open source", category: "tech", difficulty: "medium" },
  // Hard
  { word: "quantum computing", category: "tech", difficulty: "hard" },
  { word: "data breach", category: "tech", difficulty: "hard" },
  { word: "neuralink", category: "tech", difficulty: "hard" },
  { word: "antitrust", category: "tech", difficulty: "hard" },

  // ─── Markets (18) ─────────────────────────────────────────────
  // Easy
  { word: "rally", category: "markets", difficulty: "easy" },
  { word: "investor", category: "markets", difficulty: "easy" },
  { word: "stock", category: "markets", difficulty: "easy" },
  { word: "fed", category: "markets", difficulty: "easy" },
  { word: "inflation", category: "markets", difficulty: "easy" },
  // Medium
  { word: "rate cut", category: "markets", difficulty: "medium" },
  { word: "nasdaq", category: "markets", difficulty: "medium" },
  { word: "sec", category: "markets", difficulty: "medium" },
  { word: "earnings", category: "markets", difficulty: "medium" },
  { word: "bull market", category: "markets", difficulty: "medium" },
  { word: "volatility", category: "markets", difficulty: "medium" },
  { word: "sell-off", category: "markets", difficulty: "medium" },
  { word: "treasury", category: "markets", difficulty: "medium" },
  // Hard
  { word: "recession", category: "markets", difficulty: "hard" },
  { word: "crash", category: "markets", difficulty: "hard" },
  { word: "default", category: "markets", difficulty: "hard" },
  { word: "black swan", category: "markets", difficulty: "hard" },
  { word: "bank run", category: "markets", difficulty: "hard" },

  // ─── Culture (19) ─────────────────────────────────────────────
  // Easy
  { word: "elon musk", category: "culture", difficulty: "easy" },
  { word: "trump", category: "culture", difficulty: "easy" },
  { word: "regulation", category: "culture", difficulty: "easy" },
  // Medium
  { word: "hack", category: "culture", difficulty: "medium" },
  { word: "scam", category: "culture", difficulty: "medium" },
  { word: "china", category: "culture", difficulty: "medium" },
  { word: "tariff", category: "culture", difficulty: "medium" },
  { word: "sanction", category: "culture", difficulty: "medium" },
  { word: "privacy", category: "culture", difficulty: "medium" },
  { word: "congress", category: "culture", difficulty: "medium" },
  { word: "executive order", category: "culture", difficulty: "medium" },
  { word: "ban", category: "culture", difficulty: "medium" },
  { word: "russia", category: "culture", difficulty: "medium" },
  { word: "ukraine", category: "culture", difficulty: "medium" },
  // Hard
  { word: "indictment", category: "culture", difficulty: "hard" },
  { word: "whistleblower", category: "culture", difficulty: "hard" },
  { word: "subpoena", category: "culture", difficulty: "hard" },
  { word: "money laundering", category: "culture", difficulty: "hard" },
  { word: "cbdc", category: "culture", difficulty: "hard" },
];

// ─── Internal State ───────────────────────────────────────────
// Module-level recent words tracker (auto-pruned to last 24 entries)
const recentWords: string[] = [];

/**
 * Pick a random word from the bank, avoiding recently used words.
 * Manages its own recent-word dedup internally (last 24 entries).
 * Difficulty bias: 50% medium, 30% easy, 20% hard.
 *
 * Always returns a WordEntry — falls back to the full bank if all words exhausted.
 */
export function pickWord(): WordEntry {
  const recentSet = new Set(recentWords.slice(-24).map((w) => w.toLowerCase()));

  // Filter out recently used words
  const available = WORD_BANK.filter(
    (entry) => !recentSet.has(entry.word.toLowerCase())
  );

  // If we've somehow exhausted the bank, reset (82 words > 24 dedup window)
  const pool = available.length > 0 ? available : WORD_BANK;

  // Group by difficulty
  const easy = pool.filter((w) => w.difficulty === "easy");
  const medium = pool.filter((w) => w.difficulty === "medium");
  const hard = pool.filter((w) => w.difficulty === "hard");

  // Roll for difficulty tier: 30% easy, 50% medium, 20% hard
  const roll = Math.random();
  let tier: WordEntry[];
  if (roll < 0.3 && easy.length > 0) {
    tier = easy;
  } else if (roll < 0.8 && medium.length > 0) {
    tier = medium;
  } else if (hard.length > 0) {
    tier = hard;
  } else {
    tier = pool; // fallback
  }

  const picked = tier[Math.floor(Math.random() * tier.length)];

  // Track internally and auto-prune to 24
  recentWords.push(picked.word);
  if (recentWords.length > 24) {
    recentWords.shift();
  }

  return picked;
}

/**
 * Get the list of recently used words (for debugging/inspection).
 */
export function getRecentWords(): string[] {
  return [...recentWords];
}

/**
 * Get word bank statistics.
 */
export function getWordBankStats(): {
  total: number;
  byCategory: Record<string, number>;
  byDifficulty: Record<string, number>;
  recentlyUsed: number;
  available: number;
} {
  const recentSet = new Set(recentWords.slice(-24).map((w) => w.toLowerCase()));

  const byCategory: Record<string, number> = {};
  const byDifficulty: Record<string, number> = {};

  for (const entry of WORD_BANK) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    byDifficulty[entry.difficulty] = (byDifficulty[entry.difficulty] || 0) + 1;
  }

  const availableCount = WORD_BANK.filter(
    (entry) => !recentSet.has(entry.word.toLowerCase())
  ).length;

  return {
    total: WORD_BANK.length,
    byCategory,
    byDifficulty,
    recentlyUsed: recentWords.length,
    available: availableCount,
  };
}
