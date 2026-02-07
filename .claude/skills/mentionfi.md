---
name: mentionfi
description: MentionFi prediction market operations - query quests, check feeds, manage stakes, deploy contracts
---

# MentionFi Skill

## When to Use
- User asks about prediction markets, quests, RSS feeds, or staking
- User wants to check MentionFi API or contract state
- User wants to create quests, submit claims, or check rewards
- User mentions MentionFi, MentionQuest, or ReputationToken

## API Quick Reference

Base URL: `https://oracle-production-aa8f.up.railway.app`

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/quests` | List all quests with stakes & odds |
| `GET /api/v1/quests/:id` | Single quest detail |
| `GET /api/v1/feeds` | RSS feeds with tier/category |
| `GET /api/v1/stats` | Protocol totals |
| `GET /api/v1/agent/:addr` | Agent REP balance |
| `GET /health` | Oracle health check |

```bash
# Check quests
curl https://oracle-production-aa8f.up.railway.app/api/v1/quests

# Check stats
curl https://oracle-production-aa8f.up.railway.app/api/v1/stats

# Check agent
curl https://oracle-production-aa8f.up.railway.app/api/v1/agent/0x3058ff5B62E67a27460904783aFd670fF70c6A4A
```

## Smart Contract Operations

Chain: MegaETH Testnet (6343) | RPC: `https://carrot.megaeth.com/rpc`

**MentionQuest:** `0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c`
**ReputationToken:** `0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b`

```javascript
import { ethers } from "ethers";
const provider = new ethers.JsonRpcProvider("https://carrot.megaeth.com/rpc");

// Register agent (get 100 REP)
const rep = new ethers.Contract("0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b",
  ["function register()"], signer);
await rep.register();

// Create quest (5 min window)
const quest = new ethers.Contract("0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c",
  ["function createQuest(string,string,uint64,uint64)"], signer);
const now = Math.floor(Date.now() / 1000);
await quest.createQuest("bitcoin", "https://cointelegraph.com/rss", now, now + 300);

// Submit claim: YES, 10 REP, 70% confidence, 0.01 ETH
const questContract = new ethers.Contract("0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c",
  ["function submitClaim(uint256,uint8,uint256,uint256)"], signer);
await questContract.submitClaim(1, 1, ethers.parseEther("10"), 70,
  { value: ethers.parseEther("0.01") });
```

## Stake Limits
- REP: 10-100 REP per claim
- ETH: 0.001-1 ETH per claim
- Need 50+ REP to create quests
- Position: 1=Yes, 2=No

## Fee Distribution
- 5% protocol fee (ETH only)
- 5% quest creator reward
- 90% to winning stakers (proportional)

## Project Paths
- Oracle: `oracle/src/index.ts`
- Feeds: `oracle/src/feeds.ts`
- Contracts: `src/MentionQuest.sol`, `src/ReputationToken.sol`
- Frontend: `frontend/src/`
- Agent files: `frontend/public/`
