import { ethers } from "ethers";
import Parser from "rss-parser";
import http from "http";
import "dotenv/config";

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

interface OracleStats {
  startTime: Date;
  questsResolved: number;
  lastCheck: Date | null;
  pendingQuests: number;
  errors: number;
}

class MentionFiOracle {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private questContract: ethers.Contract;
  private rssParser: Parser;
  private stats: OracleStats;

  // Cache for keyword → hash mapping
  private keywordCache: Map<string, string> = new Map();

  constructor(
    rpc: string,
    privateKey: string,
    questAddress: string
  ) {
    this.provider = new ethers.JsonRpcProvider(rpc);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.questContract = new ethers.Contract(
      questAddress,
      MENTION_QUEST_ABI,
      this.wallet
    );
    this.rssParser = new Parser({
      timeout: 10000,
      headers: {
        'User-Agent': 'MentionFi-Oracle/1.0'
      }
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
  }

  private log(msg: string) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  private logError(msg: string, error?: unknown) {
    console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, error || '');
    this.stats.errors++;
  }

  getStats(): OracleStats {
    return { ...this.stats };
  }

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
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() / 1000 : 0;

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
              ethers.toUtf8Bytes(JSON.stringify({ url: item.link, title: item.title }))
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
          (quest.status === QuestStatus.Open || quest.status === QuestStatus.Closed) &&
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
    this.log(`  Window: ${new Date(Number(quest.windowStart) * 1000).toISOString()} - ${new Date(Number(quest.windowEnd) * 1000).toISOString()}`);

    // Check RSS for keyword
    const { found, proof, matchedItem } = await this.checkRSSForKeyword(
      quest.sourceUrl,
      quest.keywordHash,
      Number(quest.windowStart),
      Number(quest.windowEnd)
    );

    const outcome = found ? Position.Yes : Position.No;
    this.log(`  Result: ${found ? `YES - "${matchedItem}"` : "NO (keyword not found)"}`);

    try {
      const tx = await this.questContract.resolveQuest(quest.id, outcome, proof);
      this.log(`  TX sent: ${tx.hash}`);

      const receipt = await tx.wait();
      this.log(`  Resolved in block ${receipt?.blockNumber}`);
      this.stats.questsResolved++;
      return true;
    } catch (error: any) {
      // Check if already resolved
      if (error.message?.includes("QuestNotClosed") || error.message?.includes("already")) {
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
        const pending = await this.getPendingQuests();
        this.stats.pendingQuests = pending.length;

        if (pending.length > 0) {
          this.log(`Found ${pending.length} quests pending resolution`);
          for (const quest of pending) {
            await this.resolveQuest(quest);
            // Small delay between resolutions
            await new Promise(r => setTimeout(r, 1000));
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

// Health check HTTP server for Railway
function startHealthServer(oracle: MentionFiOracle, port: number) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const stats = oracle.getStats();
      const uptime = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        questsResolved: stats.questsResolved,
        lastCheck: stats.lastCheck?.toISOString() || null,
        pendingQuests: stats.pendingQuests,
        errors: stats.errors,
      }));
    } else if (req.url === '/stats') {
      const stats = oracle.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`[${new Date().toISOString()}] Health server running on port ${port}`);
  });

  return server;
}

// Common keywords to track
const DEFAULT_KEYWORDS = [
  // Crypto
  "bitcoin", "ethereum", "solana", "xrp", "defi", "nft", "stablecoin",
  "binance", "coinbase", "sec", "etf",
  // AI
  "deepseek", "openai", "anthropic", "chatgpt", "claude", "ai", "llm", "gpt",
  // Markets
  "fed", "inflation", "nasdaq", "recession", "tariff",
  // Politics
  "trump", "musk", "china", "russia", "ukraine",
  // Tech
  "apple", "google", "microsoft", "meta", "nvidia",
  // MegaETH specific
  "megaeth", "mega",
];

// Main
async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║       MENTIONFI ORACLE v1.0              ║
║   Information Prediction Market Oracle   ║
╚══════════════════════════════════════════╝
  `);

  const rpc = process.env.RPC_URL || MEGAETH_TESTNET_RPC;
  const privateKey = process.env.PRIVATE_KEY;
  const questAddress = process.env.QUEST_ADDRESS;
  const port = parseInt(process.env.PORT || '3000');
  const interval = parseInt(process.env.INTERVAL_MS || '30000');

  if (!privateKey) {
    console.error("ERROR: PRIVATE_KEY env required");
    process.exit(1);
  }
  if (!questAddress) {
    console.error("ERROR: QUEST_ADDRESS env required");
    process.exit(1);
  }

  const oracle = new MentionFiOracle(rpc, privateKey, questAddress);

  // Register default keywords
  for (const keyword of DEFAULT_KEYWORDS) {
    oracle.registerKeyword(keyword);
  }

  // Register custom keywords from env
  const customKeywords = process.env.KEYWORDS?.split(',').map(k => k.trim()).filter(Boolean) || [];
  for (const keyword of customKeywords) {
    oracle.registerKeyword(keyword);
  }

  // Start health server
  startHealthServer(oracle, port);

  // Start oracle loop
  await oracle.run(interval);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { MentionFiOracle };
