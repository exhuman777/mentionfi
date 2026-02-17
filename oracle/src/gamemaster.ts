// Game Master — Hourly auto-round engine for MentionFi
// Picks a word, creates a quest on-chain, tracks rounds.
// Does NOT run its own timer — exposes methods that index.ts calls.

import { ethers } from "ethers";
import { pickWord, getWordBankStats, type WordEntry } from "./wordbank.js";

// ─── Types ─────────────────────────────────────────────────────

export interface Round {
  id: number;
  word: string;
  category: string;
  difficulty: string;
  questId: number | null;
  startTime: number; // unix seconds
  endTime: number; // unix seconds
  status: "betting" | "resolving" | "resolved";
  outcome?: "yes" | "no";
}

// ─── GameMaster Class ──────────────────────────────────────────

export class GameMaster {
  private contract: ethers.Contract;
  private currentRound: Round | null = null;
  private history: Round[] = [];
  private roundCounter = 0;

  constructor(
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet,
    questContractAddress: string,
    questAbi: string[]
  ) {
    this.contract = new ethers.Contract(
      questContractAddress,
      questAbi,
      wallet
    );
  }

  /**
   * Create a new round: pick a word, submit createQuest on-chain.
   * Window: now+10s → now+1810s (30 min). 10s buffer for block.timestamp.
   * Source: "https://cointelegraph.com/rss"
   */
  async startRound(): Promise<Round> {
    const entry: WordEntry = pickWord();

    const now = Math.floor(Date.now() / 1000);
    const windowStart = now + 10;
    const windowEnd = windowStart + 1800;

    this.roundCounter++;
    const round: Round = {
      id: this.roundCounter,
      word: entry.word,
      category: entry.category,
      difficulty: entry.difficulty,
      questId: null,
      startTime: windowStart,
      endTime: windowEnd,
      status: "betting",
    };

    this.log(
      `Starting round #${round.id}: "${entry.word}" [${entry.category}/${entry.difficulty}]`
    );
    this.log(
      `  Window: ${new Date(windowStart * 1000).toISOString()} → ${new Date(windowEnd * 1000).toISOString()}`
    );

    try {
      const tx = await this.contract.createQuest(
        entry.word,
        "https://cointelegraph.com/rss",
        windowStart,
        windowEnd
      );
      this.log(`  TX sent: ${tx.hash}`);

      const receipt = await tx.wait();
      this.log(`  Confirmed in block ${receipt?.blockNumber}`);

      // Parse QuestCreated event to get questId
      let questId: number | null = null;
      if (receipt?.logs) {
        const iface = this.contract.interface;
        for (const eventLog of receipt.logs) {
          try {
            const parsed = iface.parseLog({
              topics: eventLog.topics as string[],
              data: eventLog.data,
            });
            if (parsed?.name === "QuestCreated") {
              questId = Number(parsed.args[0]);
              break;
            }
          } catch {
            // Not our event
          }
        }
      }

      // Fallback: read questCount
      if (questId === null) {
        try {
          questId = Number(await this.contract.questCount());
        } catch {
          this.logError("Could not determine questId");
        }
      }

      round.questId = questId;
      this.log(
        `  Round #${round.id} live! Quest #${questId} — "${entry.word}" for 30 min`
      );
    } catch (error: any) {
      if (error.message?.includes("InsufficientReputation")) {
        this.logError(
          "Oracle wallet lacks REP to create quests (need >= 50 REP)"
        );
      } else if (error.message?.includes("InvalidWindow")) {
        this.logError("Window timing rejected — possible clock skew");
      } else {
        this.logError("Failed to create quest on-chain:", error);
      }
      // Round still tracked even if tx failed (questId stays null)
    }

    // Archive previous round to history
    if (this.currentRound) {
      this.history.unshift(this.currentRound);
      if (this.history.length > 24) {
        this.history.pop();
      }
    }
    this.currentRound = round;

    return round;
  }

  /**
   * Get the current active round, or null if none started yet.
   */
  getCurrentRound(): Round | null {
    if (!this.currentRound) return null;
    return { ...this.currentRound };
  }

  /**
   * Get round history (most recent first), last 24 rounds.
   */
  getRoundHistory(): Round[] {
    const all = this.currentRound
      ? [this.currentRound, ...this.history]
      : [...this.history];
    return all.slice(0, 24).map((r) => ({ ...r }));
  }

  /**
   * Mark a round as resolved by its on-chain questId.
   * Called by the oracle resolution loop after the quest is resolved on-chain.
   */
  completeRound(outcome: "yes" | "no", questId: number): void {
    // Check current round first
    if (this.currentRound?.questId === questId) {
      this.currentRound.status = "resolved";
      this.currentRound.outcome = outcome;
      this.log(
        `Round #${this.currentRound.id} resolved: ${outcome.toUpperCase()} (quest #${questId})`
      );
      return;
    }

    // Check history
    const round = this.history.find((r) => r.questId === questId);
    if (round) {
      round.status = "resolved";
      round.outcome = outcome;
      this.log(
        `Round #${round.id} resolved: ${outcome.toUpperCase()} (quest #${questId})`
      );
    }
  }

  /**
   * Seconds until the next 30-minute boundary (:00:00 or :30:00).
   */
  getNextRoundIn(): number {
    const now = new Date();
    const mins = now.getMinutes();
    const next = new Date(now);
    if (mins < 30) {
      next.setMinutes(30, 0, 0);
    } else {
      next.setHours(next.getHours() + 1, 0, 0, 0);
    }
    return Math.round((next.getTime() - now.getTime()) / 1000);
  }

  // ─── Internal ──────────────────────────────────────────────────

  private log(msg: string) {
    console.log(`[${new Date().toISOString()}] [GameMaster] ${msg}`);
  }

  private logError(msg: string, error?: unknown) {
    console.error(
      `[${new Date().toISOString()}] [GameMaster] ERROR: ${msg}`,
      error || ""
    );
  }
}
