# CLAUDE.md - MentionFi

## What is MentionFi?
Forward-looking information prediction market on MegaETH testnet. Players stake ETH + REP on whether a keyword will appear in NEW RSS articles published during a time window. An autonomous oracle resolves outcomes by scanning feeds every 15 seconds.

**Key innovation:** Only articles with `pubDate >= windowStart` count. Each article can only resolve ONE quest. This creates genuine uncertainty — you're predicting future publications, not betting on already-published content.

## Project Structure
```
mentionfi/
├── src/                  # Solidity contracts (Foundry)
│   ├── MentionQuest.sol  # Core prediction market (parimutuel)
│   └── ReputationToken.sol # EIP-6909 multi-token soulbound REP
├── oracle/               # TypeScript oracle + API (Railway)
│   └── src/
│       ├── index.ts      # Oracle loop + HTTP API server
│       └── feeds.ts      # RSS feed registry with metadata
├── frontend/             # React + Vite (Vercel)
│   ├── src/App.jsx       # Single-file React app
│   └── public/           # Static files (agent-card, etc.)
├── test/                 # Foundry tests
├── lib/                  # forge-std
└── script/               # Deploy scripts
```

## Build & Deploy

### Contracts (Foundry)
```bash
forge build
forge test
forge script script/Deploy.s.sol --rpc-url https://carrot.megaeth.com/rpc --broadcast
```

### Oracle (Railway)
```bash
cd oracle && npm install && npm run build   # TypeScript compile
npm run dev                                  # Local dev with tsx
```
**Deploy to Railway:** From mentionfi root (NOT oracle/):
```bash
cd ~/Rufus/projects/mentionfi && railway up --detach
```
Railway root dir is configured as `/oracle`.

Required env: `PRIVATE_KEY`, `QUEST_ADDRESS`
Optional env: `REP_ADDRESS`, `RPC_URL`, `PORT`, `INTERVAL_MS`, `KEYWORDS`

### Frontend (Vercel)
```bash
cd frontend && npm install && npm run build  # Vite build → dist/
npm run dev                                  # Local dev server :3002
npx vercel --prod                            # Manual deploy
```

## Contract Addresses (MegaETH Testnet, Chain 6343)
- **MentionQuest:** `0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c`
- **ReputationToken:** `0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b`
- **Oracle Wallet:** `0x3058ff5B62E67a27460904783aFd670fF70c6A4A`
- **RPC:** `https://carrot.megaeth.com/rpc`
- **Chain ID:** 6343

## Oracle API Reference

Base URL: `https://oracle-production-aa8f.up.railway.app`

All responses use JSON-LD format with `@context`, `success`, `data`, `meta`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — uptime, errors, quests resolved, pending count |
| GET | `/api/v1/quests` | List all quests with stakes, odds, status, keyword |
| GET | `/api/v1/quests/:id` | Single quest detail |
| GET | `/api/v1/feeds` | RSS feeds with name, tier (S/A/B/C), category, update frequency |
| GET | `/api/v1/stats` | Protocol stats: total quests, ETH staked, feed count, oracle uptime |
| GET | `/api/v1/keywords` | Hash→plaintext keyword map (all keywords discovered from chain) |
| GET | `/api/v1/agent/:address` | Agent REP balance |

### Example Responses

**GET /health**
```json
{
  "status": "healthy",
  "uptime": "2h 15m",
  "questsResolved": 5,
  "lastCheck": "2026-02-09T12:00:00.000Z",
  "pendingQuests": 2,
  "errors": 0
}
```

**GET /api/v1/quests**
```json
{
  "@context": "https://mentionfi.vercel.app/schema/v1",
  "success": true,
  "data": [{
    "id": 10,
    "creator": "0x3058...",
    "keywordHash": "0x7dee...",
    "keyword": "bitcoin",
    "sourceUrl": "https://cointelegraph.com/rss",
    "windowStart": 1770636225,
    "windowEnd": 1770636515,
    "status": "resolved",
    "outcome": "yes",
    "stakes": { "yesRep": "10000000000000000000", "noRep": "0", "yesEth": "1000000000000000", "noEth": "0" },
    "odds": { "yes": 100, "no": 0 }
  }]
}
```

**GET /api/v1/feeds**
```json
{
  "success": true,
  "data": {
    "coindesk": { "url": "https://feeds.feedburner.com/CoinDesk", "name": "CoinDesk", "tier": "S", "category": "crypto", "updateFrequency": "2-5min" },
    "cointelegraph": { "url": "https://cointelegraph.com/rss", "name": "Cointelegraph", "tier": "S", "category": "crypto", "updateFrequency": "2-5min" }
  }
}
```

**GET /api/v1/keywords**
```json
{
  "success": true,
  "data": {
    "0x7dee...": "bitcoin",
    "0x541...": "ethereum"
  },
  "meta": { "count": 42 }
}
```

### RSS Feeds (12 Active)

| Feed | Tier | Category | Update Freq | Status |
|------|------|----------|-------------|--------|
| CoinDesk (Feedburner) | S | crypto | 2-5min | Working |
| Cointelegraph | S | crypto | 2-5min | Working (46KB) |
| CNBC Crypto | S | markets | 5-10min | Working |
| Hacker News | S | tech | continuous | Working |
| Decrypt | A | crypto | 5-10min | Working |
| The Block | A | crypto | 5-10min | Working |
| Bitcoin Magazine | A | crypto | 10-30min | Working |
| CryptoSlate | A | crypto | 5-10min | Working (148KB) |
| The Defiant | A | defi | 10-30min | Working (221KB) |
| TechCrunch | A | tech | 5-15min | Working |
| CryptoPotato | B | crypto | 5-10min | Working (230KB) |
| CryptoNews | B | crypto | 5-10min | Working (160KB) |

## Oracle Resolution Logic

### Forward-Looking Prediction Model
The oracle resolves quests by checking if a keyword appears in **newly published** RSS articles:

1. **Time filter:** `pubDate >= windowStart` — only articles published AFTER the market opens count
2. **Article dedup:** Each article can only resolve ONE quest (tracked in `usedArticles` Set)
3. **No-date skip:** Articles without valid `pubDate` are skipped
4. **Text matching:** Keyword checked against `title + content + contentSnippet` (case-insensitive)

### Resolution Flow
```
Every 15s tick:
  For each quest:
    IF window is ACTIVE (now < windowEnd):
      Scan RSS → cache found result + reserve article
      (Do NOT resolve yet — more bets may come in)
    IF window EXPIRED (now >= windowEnd):
      Use cached result OR do final scan
      Close quest on-chain (if not already closed)
      Resolve: YES (keyword found) or NO (not found)
      Mark article as used (if YES)
```

### Why This Design Works
- **Genuine uncertainty:** You can't know what will be published in the next 5-30 minutes
- **Article dedup prevents gaming:** Can't reuse the same article across multiple quests
- **Short windows (5/10/30/60 min):** Forces real-time information assessment
- **Parimutuel system:** Odds shift naturally based on collective bets
- **Soulbound REP:** Prevents Sybil attacks, tracks prediction skill

## Game Mechanics

### Quest Lifecycle
1. **Create** — Pick keyword + RSS feed + time window (5/10/30/60 min)
2. **Bet** — Stake ETH + REP on YES or NO position
3. **Active window** — Oracle scans every 15s, caches results
4. **Close** — Window expires, quest auto-closes
5. **Resolve** — Oracle submits YES/NO with proof hash
6. **Claim** — Winners claim proportional share of losing pool

### Fee Structure
- 5% protocol fee on winnings
- 5% creator fee (goes to quest creator)
- 90% to winners (proportional to stake)

### REP System
- EIP-6909 multi-token, soulbound (non-transferable)
- Token ID 0 = general REP
- Required to create quests and place bets
- Correct predictions earn bonus REP
- Tracks prediction skill over time

## Contract Interaction (cast)

### Create a Quest
```bash
KEYWORD_HASH=$(cast keccak "bitcoin")
FEED_URL="https://cointelegraph.com/rss"
WINDOW_START=$(($(cast block latest -r --rpc-url https://carrot.megaeth.com/rpc -j | python3 -c "import sys,json; print(json.load(sys.stdin)['timestamp'])") + 10))
WINDOW_END=$((WINDOW_START + 300))  # 5-min window

cast send 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "createQuest(bytes32,string,uint256,uint256)" \
  $KEYWORD_HASH "$FEED_URL" $WINDOW_START $WINDOW_END \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY
```

### Place a Bet
```bash
# Position: 1=YES, 2=NO | repStake in wei | confidence (unused, pass 0)
cast send 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "submitClaim(uint256,uint8,uint256,uint256)" \
  QUEST_ID 1 10000000000000000000 0 \
  --value 0.001ether \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY
```

### Approve REP Operator (required once)
```bash
cast send 0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b \
  "setOperator(address,bool)" \
  0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c true \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY
```

### Claim Rewards
```bash
cast send 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "claimReward(uint256)" QUEST_ID \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY
```

## Agent-Native Files
- `frontend/public/.well-known/agent-card.json` — A2A v0.3.0
- `frontend/public/openclaw-skills.json` — OpenClaw skills
- `frontend/public/AGENTS.md` — Full agent integration guide
- `frontend/public/llms.txt` — LLM-readable summary

## Architecture Notes
- Oracle uses raw `http` module (no Express) — keep it lightweight
- Oracle ticks every 15 seconds (configurable via `INTERVAL_MS`)
- Quest data cached in memory, refreshed each tick
- Keywords discovered from chain via `QuestCreated` events + `getKeywordByHash()` reverse lookup
- `foundCache` Map stores scan results during active windows
- `usedArticles` Set ensures one-article-per-quest dedup
- REP is EIP-6909 multi-token (ID 0 = general REP), soulbound
- Frontend uses Privy for wallet connection
- MegaETH supports `eth_sendRawTransactionSync` for instant receipts

## Known Issues & Gotchas
- `createQuest` is NOT payable — do not send `--value` with it
- `submitClaim` requires 4 params: `(questId, position, repStake, confidence)` — not 2
- REP operator must be approved before placing bets: `setOperator(questContract, true)`
- Quest must be Closed before resolution — oracle handles this automatically after `windowEnd`
- CoinDesk old URL (`coindesk.com/arc/outboundfeeds/rss/`) returns redirect HTML — use Feedburner URL
- Railway deploys from mentionfi root, not oracle/ (root dir `/oracle` is configured in Railway)
- `usedArticles` Set resets on oracle restart — acceptable for testnet, needs persistence for mainnet
