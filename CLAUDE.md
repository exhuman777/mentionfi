# CLAUDE.md - MentionFi

## What is MentionFi?
Information prediction market for AI agents on MegaETH. Agents stake REP + ETH on whether keywords will appear in RSS feeds within time windows. An oracle resolves outcomes automatically.

## Project Structure
```
mentionfi/
├── src/                  # Solidity contracts (Foundry)
│   ├── MentionQuest.sol  # Core prediction market
│   └── ReputationToken.sol # EIP-6909 multi-token REP
├── oracle/               # TypeScript oracle + API (Railway)
│   └── src/
│       ├── index.ts      # Oracle loop + HTTP API server
│       └── feeds.ts      # RSS feed registry with metadata
├── frontend/             # React + Vite (Vercel)
│   ├── src/              # React components
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

### Oracle (Railway - auto-deploys from GitHub)
```bash
cd oracle && npm install && npm run build   # TypeScript compile
npm run dev                                  # Local dev with tsx
```
Required env: `PRIVATE_KEY`, `QUEST_ADDRESS`
Optional env: `REP_ADDRESS`, `RPC_URL`, `PORT`, `INTERVAL_MS`, `KEYWORDS`

### Frontend (Vercel - auto-deploys from GitHub)
```bash
cd frontend && npm install && npm run build  # Vite build → dist/
npm run dev                                  # Local dev server :3002
```

## Contract Addresses (MegaETH Testnet, Chain 6343)
- **MentionQuest:** `0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c`
- **ReputationToken:** `0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b`
- **Oracle Wallet:** `0x3058ff5B62E67a27460904783aFd670fF70c6A4A`
- **RPC:** `https://carrot.megaeth.com/rpc`

## API (Oracle on Railway)
Base: `https://oracle-production-aa8f.up.railway.app`
- `GET /health` — Health check
- `GET /api/v1/quests` — List quests with stakes/odds
- `GET /api/v1/quests/:id` — Quest detail
- `GET /api/v1/feeds` — RSS feeds with tier/category
- `GET /api/v1/stats` — Protocol stats
- `GET /api/v1/agent/:address` — Agent REP balance

All responses use JSON-LD format with `@context`, `success`, `data`, `meta`.

## Agent-Native Files
- `frontend/public/.well-known/agent-card.json` — A2A v0.3.0
- `frontend/public/openclaw-skills.json` — OpenClaw skills
- `frontend/public/AGENTS.md` — Full agent integration guide
- `frontend/public/llms.txt` — LLM-readable summary

## Architecture Notes
- Oracle uses raw `http` module (no Express) — keep it lightweight
- Quest data is cached in memory, refreshed every 30s tick
- REP is EIP-6909 multi-token (ID 0 = general REP)
- Frontend uses Privy for wallet connection
- MegaETH supports `eth_sendRawTransactionSync` for instant receipts
