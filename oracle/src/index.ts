import { ethers } from "ethers";
import Parser from "rss-parser";
import http from "http";
import "dotenv/config";
import { RSS_FEEDS_META, type FeedInfo } from "./feeds.js";

// MegaETH RPC
const MEGAETH_TESTNET_RPC = "https://carrot.megaeth.com/rpc";

// Contract ABIs (minimal) - v2 with separate stakes mapping
const MENTION_QUEST_ABI = [
  "function questCount() view returns (uint256)",
  "function quests(uint256) view returns (uint256 id, address creator, bytes32 keywordHash, string sourceUrl, uint64 windowStart, uint64 windowEnd, uint64 createdAt, uint8 status, uint8 outcome)",
  "function questStakes(uint256) view returns (uint256 totalYesRepStake, uint256 totalNoRepStake, uint256 totalYesEthStake, uint256 totalNoEthStake)",
  "function resolveQuest(uint256 questId, uint8 outcome, bytes32 proof) external",
  "function closeQuest(uint256 questId) external",
  "event QuestCreated(uint256 indexed questId, address indexed creator, bytes32 keywordHash, string sourceUrl, uint64 windowStart, uint64 windowEnd)",
  "event QuestResolved(uint256 indexed questId, uint8 outcome, address indexed oracle)",
];

// REP Token ABI (read-only for API)
const REP_TOKEN_ABI = [
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function registered(address) view returns (bool)",
];

// Quest status enum
enum QuestStatus {
  Open = 0,
  Closed = 1,
  Resolved = 2,
  Cancelled = 3,
}

// Position enum
enum Position {
  None = 0,
  Yes = 1,
  No = 2,
}

interface Quest {
  id: bigint;
  creator: string;
  keywordHash: string;
  sourceUrl: string;
  windowStart: bigint;
  windowEnd: bigint;
  createdAt: bigint;
  status: number;
  outcome: number;
}

interface QuestStakes {
  totalYesRepStake: bigint;
  totalNoRepStake: bigint;
  totalYesEthStake: bigint;
  totalNoEthStake: bigint;
}

interface CachedQuest {
  id: number;
  creator: string;
  keywordHash: string;
  sourceUrl: string;
  windowStart: number;
  windowEnd: number;
  createdAt: number;
  status: string;
  outcome: string;
  stakes: {
    yesRep: string;
    noRep: string;
    yesEth: string;
    noEth: string;
  };
  odds: {
    yes: number;
    no: number;
  };
}

interface OracleStats {
  startTime: Date;
  questsResolved: number;
  lastCheck: Date | null;
  pendingQuests: number;
  errors: number;
}

const STATUS_LABELS = ["open", "closed", "resolved", "cancelled"];
const OUTCOME_LABELS = ["none", "yes", "no"];

class MentionFiOracle {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private questContract: ethers.Contract;
  private repContract: ethers.Contract | null = null;
  private rssParser: Parser;
  private stats: OracleStats;

  // Cache for keyword → hash mapping
  private keywordCache: Map<string, string> = new Map();

  // API quest cache (refreshed every tick)
  private questCache: CachedQuest[] = [];
  private questCacheTime: number = 0;

  constructor(
    rpc: string,
    privateKey: string,
    questAddress: string,
    repAddress?: string
  ) {
    this.provider = new ethers.JsonRpcProvider(rpc);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.questContract = new ethers.Contract(
      questAddress,
      MENTION_QUEST_ABI,
      this.wallet
    );

    if (repAddress) {
      this.repContract = new ethers.Contract(
        repAddress,
        REP_TOKEN_ABI,
        this.provider
      );
    }

    this.rssParser = new Parser({
      timeout: 10000,
      headers: {
        "User-Agent": "MentionFi-Oracle/1.0",
      },
    });

    this.stats = {
      startTime: new Date(),
      questsResolved: 0,
      lastCheck: null,
      pendingQuests: 0,
      errors: 0,
    };

    this.log("Oracle initialized");
    this.log(`Wallet: ${this.wallet.address}`);
    this.log(`Quest Contract: ${questAddress}`);
    if (repAddress) this.log(`REP Contract: ${repAddress}`);
  }

  private log(msg: string) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  private logError(msg: string, error?: unknown) {
    console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, error || "");
    this.stats.errors++;
  }

  getStats(): OracleStats {
    return { ...this.stats };
  }

  // ─── API Methods ───────────────────────────────────────────────

  /**
   * Get all quests with stakes and odds (cached)
   */
  async getAllQuests(limit: number = 30): Promise<CachedQuest[]> {
    // Return cache if fresh (< 30s)
    if (
      this.questCache.length > 0 &&
      Date.now() - this.questCacheTime < 30000
    ) {
      return this.questCache.slice(0, limit);
    }
    await this.refreshQuestCache();
    return this.questCache.slice(0, limit);
  }

  /**
   * Get a single quest by ID
   */
  async getQuestDetail(id: number): Promise<CachedQuest | null> {
    const quests = await this.getAllQuests(100);
    return quests.find((q) => q.id === id) || null;
  }

  /**
   * Get all RSS feeds with metadata
   */
  getFeeds(): FeedInfo[] {
    return Object.values(RSS_FEEDS_META);
  }

  /**
   * Get protocol stats
   */
  async getProtocolStats(): Promise<Record<string, unknown>> {
    const quests = await this.getAllQuests(100);
    const stats = this.getStats();
    const uptime = Math.floor(
      (Date.now() - stats.startTime.getTime()) / 1000
    );

    let totalEthStaked = 0n;
    for (const q of quests) {
      totalEthStaked +=
        BigInt(q.stakes.yesEth) + BigInt(q.stakes.noEth);
    }

    return {
      totalQuests: quests.length,
      openQuests: quests.filter((q) => q.status === "open").length,
      resolvedQuests: quests.filter((q) => q.status === "resolved").length,
      totalEthStaked: ethers.formatEther(totalEthStaked),
      totalFeeds: Object.keys(RSS_FEEDS_META).length,
      oracleUptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      questsResolvedByOracle: stats.questsResolved,
      errors: stats.errors,
    };
  }

  /**
   * Get agent profile: REP balance + registration status
   */
  async getAgentProfile(
    address: string
  ): Promise<Record<string, unknown> | null> {
    if (!this.repContract) {
      return { error: "REP contract not configured" };
    }
    try {
      const [balance, isRegistered] = await Promise.all([
        this.repContract.balanceOf(address, 0),
        this.repContract.registered(address),
      ]);
      return {
        address,
        registered: isRegistered,
        repBalance: ethers.formatEther(balance),
        repBalanceWei: balance.toString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Refresh the quest cache from on-chain data
   */
  private async refreshQuestCache(): Promise<void> {
    try {
      const questCount = Number(await this.questContract.questCount());
      const quests: CachedQuest[] = [];

      // Fetch last 50 quests
      const start = Math.max(1, questCount - 49);
      for (let i = questCount; i >= start; i--) {
        try {
          const [q, s] = await Promise.all([
            this.questContract.quests(i),
            this.questContract.questStakes(i),
          ]);

          const yesEth = BigInt(s[2]);
          const noEth = BigInt(s[3]);
          const totalEth = yesEth + noEth;
          const yesOdds =
            totalEth > 0n ? Number((yesEth * 10000n) / totalEth) / 100 : 50;
          const noOdds =
            totalEth > 0n ? Number((noEth * 10000n) / totalEth) / 100 : 50;

          quests.push({
            id: Number(q[0]),
            creator: q[1],
            keywordHash: q[2],
            sourceUrl: q[3],
            windowStart: Number(q[4]),
            windowEnd: Number(q[5]),
            createdAt: Number(q[6]),
            status: STATUS_LABELS[Number(q[7])] || "unknown",
            outcome: OUTCOME_LABELS[Number(q[8])] || "unknown",
            stakes: {
              yesRep: s[0].toString(),
              noRep: s[1].toString(),
              yesEth: s[2].toString(),
              noEth: s[3].toString(),
            },
            odds: { yes: yesOdds, no: noOdds },
          });
        } catch {
          // Skip quests that fail to load
        }
      }

      this.questCache = quests;
      this.questCacheTime = Date.now();
    } catch (error) {
      this.logError("Failed to refresh quest cache:", error);
    }
  }

  // ─── RSS Checking ──────────────────────────────────────────────

  /**
   * Fetch RSS feed and check for keyword
   */
  async checkRSSForKeyword(
    feedUrl: string,
    keywordHash: string,
    windowStart: number,
    windowEnd: number
  ): Promise<{ found: boolean; proof: string; matchedItem?: string }> {
    try {
      const feed = await this.rssParser.parseURL(feedUrl);
      this.log(`Fetched ${feed.items?.length || 0} items from ${feedUrl}`);

      for (const item of feed.items || []) {
        // Check if item is within time window
        const pubDate = item.pubDate
          ? new Date(item.pubDate).getTime() / 1000
          : 0;

        // Be lenient with time - check items from slightly before window
        if (pubDate < windowStart - 3600 || pubDate > windowEnd + 60) {
          continue;
        }

        // Combine all text content
        const text = [item.title, item.content, item.contentSnippet]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        // Check all cached keywords
        for (const [keyword, hash] of this.keywordCache.entries()) {
          if (hash === keywordHash && text.includes(keyword.toLowerCase())) {
            this.log(`Found keyword "${keyword}" in: ${item.title}`);
            const proof = ethers.keccak256(
              ethers.toUtf8Bytes(
                JSON.stringify({ url: item.link, title: item.title })
              )
            );
            return { found: true, proof, matchedItem: item.title };
          }
        }
      }

      return { found: false, proof: ethers.ZeroHash };
    } catch (error) {
      this.logError(`Error fetching RSS feed ${feedUrl}:`, error);
      return { found: false, proof: ethers.ZeroHash };
    }
  }

  /**
   * Register a keyword → hash mapping for lookup
   */
  registerKeyword(keyword: string) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(keyword));
    this.keywordCache.set(keyword.toLowerCase(), hash);
    this.log(`Registered keyword: "${keyword}" => ${hash.slice(0, 18)}...`);
  }

  /**
   * Get all pending quests that need resolution
   */
  async getPendingQuests(): Promise<Quest[]> {
    const questCount = await this.questContract.questCount();
    const now = Math.floor(Date.now() / 1000);
    const pending: Quest[] = [];

    // Only check last 50 quests for efficiency
    const start = questCount > 49n ? questCount - 49n : 1n;

    for (let i = questCount; i >= start; i--) {
      try {
        const q = await this.questContract.quests(i);
        const quest: Quest = {
          id: q[0],
          creator: q[1],
          keywordHash: q[2],
          sourceUrl: q[3],
          windowStart: q[4],
          windowEnd: q[5],
          createdAt: q[6],
          status: Number(q[7]),
          outcome: Number(q[8]),
        };

        // Check if quest needs resolution (window ended, still open/closed)
        if (
          (quest.status === QuestStatus.Open ||
            quest.status === QuestStatus.Closed) &&
          Number(quest.windowEnd) <= now
        ) {
          pending.push(quest);
        }
      } catch (error) {
        this.logError(`Error fetching quest ${i}:`, error);
      }
    }

    return pending;
  }

  /**
   * Resolve a single quest
   */
  async resolveQuest(quest: Quest): Promise<boolean> {
    this.log(`Resolving quest #${quest.id}`);
    this.log(`  Source: ${quest.sourceUrl}`);
    this.log(
      `  Window: ${new Date(Number(quest.windowStart) * 1000).toISOString()} - ${new Date(Number(quest.windowEnd) * 1000).toISOString()}`
    );

    // Check RSS for keyword
    const { found, proof, matchedItem } = await this.checkRSSForKeyword(
      quest.sourceUrl,
      quest.keywordHash,
      Number(quest.windowStart),
      Number(quest.windowEnd)
    );

    const outcome = found ? Position.Yes : Position.No;
    this.log(
      `  Result: ${found ? `YES - "${matchedItem}"` : "NO (keyword not found)"}`
    );

    try {
      const tx = await this.questContract.resolveQuest(
        quest.id,
        outcome,
        proof
      );
      this.log(`  TX sent: ${tx.hash}`);

      const receipt = await tx.wait();
      this.log(`  Resolved in block ${receipt?.blockNumber}`);
      this.stats.questsResolved++;
      return true;
    } catch (error: any) {
      // Check if already resolved
      if (
        error.message?.includes("QuestNotClosed") ||
        error.message?.includes("already")
      ) {
        this.log(`  Quest already resolved or invalid state`);
        return false;
      }
      this.logError(`  Error resolving quest:`, error);
      return false;
    }
  }

  /**
   * Run the oracle loop
   */
  async run(intervalMs: number = 30000): Promise<void> {
    this.log("=== MentionFi Oracle Started ===");
    this.log(`Checking every ${intervalMs / 1000}s`);

    const tick = async () => {
      this.stats.lastCheck = new Date();
      try {
        // Refresh quest cache on every tick (powers the API)
        await this.refreshQuestCache();

        const pending = await this.getPendingQuests();
        this.stats.pendingQuests = pending.length;

        if (pending.length > 0) {
          this.log(`Found ${pending.length} quests pending resolution`);
          for (const quest of pending) {
            await this.resolveQuest(quest);
            // Small delay between resolutions
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } catch (error) {
        this.logError("Oracle tick error:", error);
      }
    };

    // Initial tick
    await tick();

    // Loop
    setInterval(tick, intervalMs);
  }
}

// ─── JSON-LD Response Helper ───────────────────────────────────

function jsonLD(data: unknown, meta?: Record<string, unknown>) {
  return JSON.stringify({
    "@context": "https://mentionfi.vercel.app/schema/v1",
    success: true,
    data,
    meta: {
      source: "mentionfi-oracle",
      chain: "megaeth-testnet",
      chainId: 6343,
      timestamp: new Date().toISOString(),
      ...meta,
    },
  });
}

function jsonError(message: string, status: number = 400) {
  return {
    status,
    body: JSON.stringify({
      "@context": "https://mentionfi.vercel.app/schema/v1",
      success: false,
      error: message,
      meta: {
        source: "mentionfi-oracle",
        timestamp: new Date().toISOString(),
      },
    }),
  };
}

// ─── HTTP Server with API Routes ─────────────────────────────

function startServer(oracle: MentionFiOracle, port: number) {
  const server = http.createServer(async (req, res) => {
    // CORS headers on all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      // ─── Health ────────────────────────────────────────────
      if (path === "/health" || path === "/") {
        const stats = oracle.getStats();
        const uptime = Math.floor(
          (Date.now() - stats.startTime.getTime()) / 1000
        );
        res.writeHead(200);
        res.end(
          JSON.stringify({
            status: "healthy",
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            questsResolved: stats.questsResolved,
            lastCheck: stats.lastCheck?.toISOString() || null,
            pendingQuests: stats.pendingQuests,
            errors: stats.errors,
          })
        );
        return;
      }

      // ─── API v1: List Quests ───────────────────────────────
      if (path === "/api/v1/quests") {
        const limit = parseInt(url.searchParams.get("limit") || "30");
        const quests = await oracle.getAllQuests(
          Math.min(limit, 100)
        );
        res.writeHead(200);
        res.end(jsonLD(quests, { count: quests.length }));
        return;
      }

      // ─── API v1: Quest Detail ──────────────────────────────
      const questMatch = path.match(/^\/api\/v1\/quests\/(\d+)$/);
      if (questMatch) {
        const id = parseInt(questMatch[1]);
        const quest = await oracle.getQuestDetail(id);
        if (!quest) {
          const err = jsonError(`Quest ${id} not found`, 404);
          res.writeHead(err.status);
          res.end(err.body);
          return;
        }
        res.writeHead(200);
        res.end(jsonLD(quest));
        return;
      }

      // ─── API v1: Feeds ────────────────────────────────────
      if (path === "/api/v1/feeds") {
        const feeds = oracle.getFeeds();
        res.writeHead(200);
        res.end(jsonLD(feeds, { count: feeds.length }));
        return;
      }

      // ─── API v1: Protocol Stats ───────────────────────────
      if (path === "/api/v1/stats") {
        const stats = await oracle.getProtocolStats();
        res.writeHead(200);
        res.end(jsonLD(stats));
        return;
      }

      // ─── API v1: Agent Profile ────────────────────────────
      const agentMatch = path.match(
        /^\/api\/v1\/agent\/(0x[a-fA-F0-9]{40})$/
      );
      if (agentMatch) {
        const address = agentMatch[1];
        const profile = await oracle.getAgentProfile(address);
        if (!profile) {
          const err = jsonError("Agent not found", 404);
          res.writeHead(err.status);
          res.end(err.body);
          return;
        }
        res.writeHead(200);
        res.end(jsonLD(profile));
        return;
      }

      // ─── 404 ──────────────────────────────────────────────
      const err = jsonError("Not found. Try /api/v1/quests, /api/v1/feeds, /api/v1/stats, /api/v1/agent/:address", 404);
      res.writeHead(err.status);
      res.end(err.body);
    } catch (error: any) {
      const err = jsonError(error.message || "Internal server error", 500);
      res.writeHead(err.status);
      res.end(err.body);
    }
  });

  server.listen(port, () => {
    console.log(
      `[${new Date().toISOString()}] API server running on port ${port}`
    );
    console.log(`  GET /health`);
    console.log(`  GET /api/v1/quests`);
    console.log(`  GET /api/v1/quests/:id`);
    console.log(`  GET /api/v1/feeds`);
    console.log(`  GET /api/v1/stats`);
    console.log(`  GET /api/v1/agent/:address`);
  });

  return server;
}

// Common keywords to track
const DEFAULT_KEYWORDS = [
  // Crypto
  "bitcoin",
  "ethereum",
  "solana",
  "xrp",
  "defi",
  "nft",
  "stablecoin",
  "binance",
  "coinbase",
  "sec",
  "etf",
  // AI
  "deepseek",
  "openai",
  "anthropic",
  "chatgpt",
  "claude",
  "ai",
  "llm",
  "gpt",
  // Markets
  "fed",
  "inflation",
  "nasdaq",
  "recession",
  "tariff",
  // Politics
  "trump",
  "musk",
  "china",
  "russia",
  "ukraine",
  // Tech
  "apple",
  "google",
  "microsoft",
  "meta",
  "nvidia",
  // MegaETH specific
  "megaeth",
  "mega",
];

// Main
async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║       MENTIONFI ORACLE v2.0              ║
║   Information Prediction Market Oracle   ║
║   + APIPOOL-Compatible API               ║
╚══════════════════════════════════════════╝
  `);

  const rpc = process.env.RPC_URL || MEGAETH_TESTNET_RPC;
  const privateKey = process.env.PRIVATE_KEY;
  const questAddress = process.env.QUEST_ADDRESS;
  const repAddress = process.env.REP_ADDRESS;
  const port = parseInt(process.env.PORT || "3000");
  const interval = parseInt(process.env.INTERVAL_MS || "30000");

  if (!privateKey) {
    console.error("ERROR: PRIVATE_KEY env required");
    process.exit(1);
  }
  if (!questAddress) {
    console.error("ERROR: QUEST_ADDRESS env required");
    process.exit(1);
  }

  const oracle = new MentionFiOracle(rpc, privateKey, questAddress, repAddress);

  // Register default keywords
  for (const keyword of DEFAULT_KEYWORDS) {
    oracle.registerKeyword(keyword);
  }

  // Register custom keywords from env
  const customKeywords =
    process.env.KEYWORDS?.split(",")
      .map((k) => k.trim())
      .filter(Boolean) || [];
  for (const keyword of customKeywords) {
    oracle.registerKeyword(keyword);
  }

  // Start API server (replaces old health-only server)
  startServer(oracle, port);

  // Start oracle loop
  await oracle.run(interval);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { MentionFiOracle };
