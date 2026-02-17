import { ethers } from "ethers";
import Parser from "rss-parser";
import http from "http";
import "dotenv/config";
import { RSS_FEEDS_META, type FeedInfo } from "./feeds.js";
import { GameMaster } from "./gamemaster.js";

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
  keyword?: string;
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

  // Game Master instance (set from main after construction)
  public gameMaster: GameMaster | null = null;

  // Cache for keyword → hash mapping
  private keywordCache: Map<string, string> = new Map();

  // Cache for quests where keyword was found during active window
  // questId → { proof, matchedItem, articleId }
  private foundCache: Map<
    number,
    { proof: string; matchedItem: string; articleId: string }
  > = new Map();

  // Track articles already used as proof for quest resolution.
  // Each article can only resolve ONE quest (prevents gaming).
  // Key = article identifier (URL or title+pubDate fingerprint)
  private usedArticles: Set<string> = new Set();

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

          // Reverse lookup keyword from cache
          const kwHash = String(q[2]).toLowerCase();
          let keyword: string | undefined;
          for (const [kw, h] of this.keywordCache.entries()) {
            if (h.toLowerCase() === kwHash) { keyword = kw; break; }
          }

          quests.push({
            id: Number(q[0]),
            creator: q[1],
            keywordHash: q[2],
            keyword,
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
   * Reverse-lookup keyword string from hash
   */
  getKeywordByHash(hash: string): string | undefined {
    const target = String(hash).toLowerCase();
    for (const [kw, h] of this.keywordCache.entries()) {
      if (h.toLowerCase() === target) return kw;
    }
    return undefined;
  }

  /**
   * Fetch RSS feed and check for keyword in articles published during the window.
   *
   * GAME DESIGN — "Will a NEW article containing [keyword] be published
   * on [feed] during [window]?"
   *
   * Rules:
   * 1. Only articles with pubDate >= windowStart count (forward-looking)
   * 2. Articles without pubDate are skipped (can't verify freshness)
   * 3. Each article can only resolve ONE quest (usedArticles dedup)
   * 4. This creates genuine uncertainty — predicting future news events
   *
   * Difficulty spectrum:
   *   "bitcoin" on Cointelegraph, 30min → ~50% YES (coin flip)
   *   "trump" on CryptoSlate, 30min    → ~2% YES  (underdog)
   *   "megaeth" on Hacker News, 1hr    → ~1% YES  (moonshot)
   *
   * Production: 100+ feeds + Twitter = fresh content every minute,
   * making even 5-min windows viable.
   */
  async checkRSSForKeyword(
    feedUrl: string,
    keyword: string,
    windowStart: number,
    windowEnd: number,
    questId?: number
  ): Promise<{
    found: boolean;
    proof: string;
    matchedItem?: string;
    articleId?: string;
  }> {
    try {
      const feed = await this.rssParser.parseURL(feedUrl);
      const items = feed.items || [];

      const kw = keyword.toLowerCase().trim();
      let tooOld = 0;
      let noDate = 0;
      let alreadyUsed = 0;
      let checked = 0;

      for (const item of items) {
        // Parse publication date
        const pubDate = item.pubDate
          ? Math.floor(new Date(item.pubDate).getTime() / 1000)
          : 0;

        // Rule 1: Skip articles without pubDate (can't verify freshness)
        if (pubDate === 0 || isNaN(pubDate)) {
          noDate++;
          continue;
        }

        // Rule 2: Only articles published DURING or AFTER the window opens
        // (players are predicting FUTURE news, not checking past data)
        if (pubDate < windowStart) {
          tooOld++;
          continue;
        }

        // Rule 3: Article deduplication — each article resolves only ONE quest
        const articleId =
          item.link || `${item.title || ""}-${item.pubDate || ""}`;
        if (this.usedArticles.has(articleId)) {
          alreadyUsed++;
          continue;
        }

        checked++;

        // Check text content for keyword
        const text = [item.title, item.content, item.contentSnippet]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (text.includes(kw)) {
          this.log(
            `  FOUND "${keyword}" in: ${item.title} (published: ${item.pubDate})`
          );
          const proof = ethers.keccak256(
            ethers.toUtf8Bytes(
              JSON.stringify({
                questId: questId || 0,
                url: item.link,
                title: item.title,
                pubDate: item.pubDate,
              })
            )
          );
          return { found: true, proof, matchedItem: item.title, articleId };
        }
      }

      this.log(
        `  Not found: "${keyword}" — ${checked} eligible, ${tooOld} pre-window, ${alreadyUsed} used, ${noDate} no-date (of ${items.length})`
      );
      return { found: false, proof: ethers.ZeroHash };
    } catch (error) {
      this.logError(`  Error fetching RSS feed ${feedUrl}:`, error);
      return { found: false, proof: ethers.ZeroHash };
    }
  }

  /**
   * Resolve feed URLs for a quest's sourceUrl.
   * - "multi" → scan all MVP_FEEDS (CoinDesk + Cointelegraph)
   * - specific URL → scan just that feed (backwards compatible)
   */
  private getFeedUrlsForQuest(sourceUrl: string): string[] {
    if (sourceUrl === "multi") {
      return MVP_FEEDS.map((key) => RSS_FEEDS_META[key]?.url).filter(
        (url): url is string => !!url
      );
    }
    return [sourceUrl];
  }

  /**
   * Discover keywords from on-chain QuestCreated events by decoding tx calldata
   */
  async discoverKeywordsFromChain(): Promise<void> {
    try {
      const questCount = Number(await this.questContract.questCount());
      if (questCount === 0) return;

      this.log(`Discovering keywords from ${questCount} on-chain quests...`);
      const iface = new ethers.Interface([
        "function createQuest(string keyword, string sourceUrl, uint64 windowStart, uint64 windowEnd) external returns (uint256)",
      ]);

      // Get QuestCreated events
      const filter = this.questContract.filters.QuestCreated();
      const events = await this.questContract.queryFilter(filter, 0, "latest");

      for (const event of events) {
        try {
          const tx = await this.provider.getTransaction(event.transactionHash);
          if (!tx) continue;
          const decoded = iface.decodeFunctionData("createQuest", tx.data);
          const keyword = decoded[0] as string;
          const hash = ethers.keccak256(ethers.toUtf8Bytes(keyword));
          if (!this.keywordCache.has(keyword.toLowerCase())) {
            this.keywordCache.set(keyword.toLowerCase(), hash);
            this.log(`Discovered keyword: "${keyword}" => ${hash.slice(0, 18)}...`);
          }
        } catch {
          // Skip events we can't decode
        }
      }
      this.log(`Keyword cache now has ${this.keywordCache.size} entries`);
    } catch (error) {
      this.logError("Failed to discover keywords from chain:", error);
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
   * Get keyword hash → keyword text mapping (for frontend display)
   */
  getKeywordMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [keyword, hash] of this.keywordCache.entries()) {
      map[hash] = keyword;
    }
    return map;
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

        // Check if quest needs attention:
        // 1. Window active + open → scan RSS, resolve YES if keyword found
        // 2. Window expired + still open/closed → resolve NO (timeout)
        if (
          quest.status === QuestStatus.Open ||
          quest.status === QuestStatus.Closed
        ) {
          const windowStarted = Number(quest.windowStart) <= now;
          const windowExpired = Number(quest.windowEnd) <= now;
          if (windowStarted) {
            pending.push(quest);
          }
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
    const questId = Number(quest.id);
    const now = Math.floor(Date.now() / 1000);
    const windowExpired = Number(quest.windowEnd) <= now;
    const windowActive =
      Number(quest.windowStart) <= now && !windowExpired;

    // Look up the keyword plaintext from cache
    const keyword = this.getKeywordByHash(quest.keywordHash);
    if (!keyword) {
      this.log(
        `  Quest #${questId}: unknown keyword hash ${String(quest.keywordHash).slice(0, 18)}... — skipping`
      );
      // If window expired with unknown keyword, resolve as NO
      if (windowExpired) {
        this.log(`  Window expired, resolving as NO (unknown keyword)`);
      } else {
        return false;
      }
    }

    // During active window: scan RSS and cache result, don't resolve on-chain yet
    // (Contract requires quest to be Closed, which only happens after windowEnd)
    if (windowActive) {
      if (this.foundCache.has(questId)) return false; // Already cached
      if (!keyword) return false;

      this.log(`  Quest #${questId}: scanning for "${keyword}" (active window)`);

      // Determine which feed URLs to scan
      const feedUrls = this.getFeedUrlsForQuest(quest.sourceUrl);

      for (const feedUrl of feedUrls) {
        const { found, proof, matchedItem, articleId } =
          await this.checkRSSForKeyword(
            feedUrl,
            keyword,
            Number(quest.windowStart),
            Number(quest.windowEnd),
            questId
          );

        if (found && articleId) {
          this.log(
            `  Quest #${questId}: "${keyword}" FOUND — cached for resolution after expiry`
          );
          // Reserve this article so no other quest can use it
          this.usedArticles.add(articleId);
          this.foundCache.set(questId, {
            proof,
            matchedItem: matchedItem || "",
            articleId,
          });
          break; // Found in one feed, no need to check others
        }
      }
      return false; // Never resolve during active window
    }

    // Window expired — resolve on-chain
    this.log(`Resolving quest #${questId}: "${keyword || "unknown"}"`);
    this.log(`  Source: ${quest.sourceUrl}`);

    // Check if we already found the keyword during the active window
    let found = false;
    let proof = ethers.ZeroHash;
    let matchedItem: string | undefined;

    const cached = this.foundCache.get(questId);
    if (cached) {
      found = true;
      proof = cached.proof;
      matchedItem = cached.matchedItem;
      this.log(`  Using cached result from active window scan`);
    } else if (keyword) {
      // Final scan after window expired — check all relevant feeds
      const feedUrls = this.getFeedUrlsForQuest(quest.sourceUrl);
      for (const feedUrl of feedUrls) {
        const result = await this.checkRSSForKeyword(
          feedUrl,
          keyword,
          Number(quest.windowStart),
          Number(quest.windowEnd),
          questId
        );
        if (result.found) {
          found = true;
          proof = result.proof;
          matchedItem = result.matchedItem;
          if (result.articleId) {
            this.usedArticles.add(result.articleId);
          }
          break; // Found in one feed, done
        }
      }
    }

    const outcome = found ? Position.Yes : Position.No;
    this.log(
      `  Result: ${found ? `YES - "${matchedItem}"` : "NO (window expired, keyword not found)"}`
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
      this.foundCache.delete(questId);

      // Notify GameMaster so round status updates for frontend
      if (this.gameMaster) {
        const outcomeStr = found ? "yes" : "no";
        this.gameMaster.completeRound(outcomeStr, Number(quest.id));
      }
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

    // Discover keywords from on-chain history (fills gaps from custom quests)
    await this.discoverKeywordsFromChain();

    // Game Master: track 30-min boundary for auto-round creation
    const getHalfHourSlot = () => {
      const now = new Date();
      return now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0);
    };
    let lastGameMasterSlot = getHalfHourSlot();

    const tick = async () => {
      // Game Master: detect new 30-min boundary for auto-round creation
      const currentSlot = getHalfHourSlot();
      if (currentSlot !== lastGameMasterSlot) {
        lastGameMasterSlot = currentSlot;
        if (this.gameMaster) {
          this.log("[GameMaster] New 30-min boundary — creating new round");
          try {
            const round = await this.gameMaster.startRound();
            // Register the new word so the oracle can resolve it
            if (round.word) {
              this.registerKeyword(round.word);
            }
            this.log(`[GameMaster] Round #${round.id} started: "${round.word}" (quest #${round.questId})`);
          } catch (error) {
            this.logError("[GameMaster] Failed to start round:", error);
          }
        } else {
          this.log("[GameMaster] New 30-min boundary — GameMaster not initialized");
        }
      }

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

function startServer(oracle: MentionFiOracle, port: number, gameMaster?: GameMaster) {
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

      // ─── API v1: Keyword Map ────────────────────────────
      if (path === "/api/v1/keywords" && req.method === "GET") {
        const keywords = oracle.getKeywordMap();
        res.writeHead(200);
        res.end(jsonLD(keywords, { count: Object.keys(keywords).length }));
        return;
      }

      // ─── API v1: Register Keyword (POST) ──────────────
      if (path === "/api/v1/keywords" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const { keyword } = JSON.parse(body);
            if (!keyword || typeof keyword !== "string" || keyword.length > 100) {
              res.writeHead(400);
              res.end(JSON.stringify({ success: false, error: "Invalid keyword" }));
              return;
            }
            oracle.registerKeyword(keyword.toLowerCase().trim());
            const hash = ethers.keccak256(ethers.toUtf8Bytes(keyword.toLowerCase().trim()));
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, hash, keyword: keyword.toLowerCase().trim() }));
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
          }
        });
        return;
      }

      // ─── API v1: Current Round (Game Master) ────────────
      if (path === "/api/v1/current-round") {
        const round = gameMaster?.getCurrentRound() ?? null;
        if (!round) {
          res.writeHead(200);
          res.end(jsonLD(null, { message: "No active round. Next round starts on the hour." }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        // Try to get quest stakes from oracle cache for pool data
        let pool = { totalEth: "0", bets: 0, yesEth: "0", noEth: "0" };
        if (round.questId) {
          const questDetail = await oracle.getQuestDetail(round.questId);
          if (questDetail) {
            const yesEth = BigInt(questDetail.stakes.yesEth);
            const noEth = BigInt(questDetail.stakes.noEth);
            pool = {
              totalEth: ethers.formatEther(yesEth + noEth),
              bets: 0, // TODO: track bet count
              yesEth: ethers.formatEther(yesEth),
              noEth: ethers.formatEther(noEth),
            };
          }
        }
        res.writeHead(200);
        res.end(jsonLD({
          questId: round.questId,
          word: round.word,
          category: round.category,
          difficulty: round.difficulty,
          sources: ["CoinDesk", "Cointelegraph"],
          roundStart: round.startTime,
          roundEnd: round.endTime,
          timeRemaining: Math.max(0, round.endTime - now),
          status: round.status,
          outcome: round.outcome ?? null,
          pool,
        }));
        return;
      }

      // ─── API v1: Round History (Game Master) ────────────
      if (path === "/api/v1/rounds") {
        const history = gameMaster?.getRoundHistory() ?? [];
        res.writeHead(200);
        res.end(jsonLD(history, { count: history.length }));
        return;
      }

      // ─── API v1: Game Master Status ────────────────────
      if (path === "/api/v1/gamemaster/status") {
        if (!gameMaster) {
          res.writeHead(200);
          res.end(jsonLD({ active: false, message: "GameMaster not initialized" }));
          return;
        }
        const round = gameMaster.getCurrentRound();
        const history = gameMaster.getRoundHistory();
        const nextRoundIn = gameMaster.getNextRoundIn();
        res.writeHead(200);
        res.end(jsonLD({
          active: true,
          currentRound: round,
          totalRoundsPlayed: history.length,
          nextRoundIn,
          mvpFeeds: MVP_FEEDS,
        }));
        return;
      }

      // ─── API v1: Next Word Countdown ────────────────────
      if (path === "/api/v1/next-word-in") {
        const now = new Date();
        const mins = now.getMinutes();
        const next = new Date(now);
        if (mins < 30) {
          next.setMinutes(30, 0, 0);
        } else {
          next.setHours(next.getHours() + 1, 0, 0, 0);
        }
        const seconds = Math.round((next.getTime() - now.getTime()) / 1000);
        res.writeHead(200);
        res.end(jsonLD({ seconds }));
        return;
      }

      // ─── 404 ──────────────────────────────────────────────
      const err = jsonError("Not found. Try /api/v1/quests, /api/v1/feeds, /api/v1/stats, /api/v1/keywords, /api/v1/current-round, /api/v1/rounds, /api/v1/gamemaster/status, /api/v1/next-word-in, /api/v1/agent/:address", 404);
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
    console.log(`  GET /api/v1/keywords`);
    console.log(`  GET /api/v1/agent/:address`);
    console.log(`  GET /api/v1/current-round`);
    console.log(`  GET /api/v1/rounds`);
    console.log(`  GET /api/v1/gamemaster/status`);
  });

  return server;
}

// MVP: Only scan S-tier feeds for game master rounds
// Other feeds remain in feeds.ts for future use
const MVP_FEEDS = ["coindesk", "cointelegraph"];

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
  const interval = parseInt(process.env.INTERVAL_MS || "15000");

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

  // Initialize Game Master — reuses same provider/wallet/contract address
  const gmProvider = new ethers.JsonRpcProvider(rpc);
  const gmWallet = new ethers.Wallet(privateKey, gmProvider);
  const gameMaster = new GameMaster(gmProvider, gmWallet, questAddress!, MENTION_QUEST_ABI as string[]);
  oracle.gameMaster = gameMaster;
  console.log(`[${new Date().toISOString()}] Game Master initialized — hourly auto-rounds enabled`);

  // Start API server with GameMaster
  startServer(oracle, port, gameMaster);

  // Start oracle loop
  await oracle.run(interval);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { MentionFiOracle };
