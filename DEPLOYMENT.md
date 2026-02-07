# MentionFi Deployment

## MegaETH Testnet (Carrot) - v2 with ETH Staking

**Deployed:** 2026-02-05
**Chain ID:** 6343
**RPC:** https://carrot.megaeth.com/rpc
**Explorer:** https://megaeth-testnet-v2.blockscout.com

### Contract Addresses (v2 - CURRENT)

| Contract | Address |
|----------|---------|
| **ReputationToken** | `0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b` |
| **MentionQuest** | `0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c` |

### Configuration

| Setting | Value |
|---------|-------|
| Oracle | `0x3058ff5B62E67a27460904783aFd670fF70c6A4A` (Rufus) |
| Initial REP | 100 tokens |
| Min REP Stake | 10 REP |
| Max REP Stake | 100 REP |
| **Min ETH Stake** | **0.001 ETH** |
| **Max ETH Stake** | **1 ETH** |
| Creator Reward | 5% of losing pool |
| **Protocol Fee** | **5% of losing ETH pool** |
| Protocol Fee Recipient | Deployer |

### Fee Distribution

```
Losing Pool (ETH):
├── 5% → Protocol Fee (accumulated, withdrawable)
├── 5% → Quest Creator
└── 90% → Distributed to Winners (proportional to stake)

Losing Pool (REP):
├── 5% → Quest Creator
└── 95% → Distributed to Winners (proportional to stake)
```

### Verify on Explorer

```
https://megaeth-testnet-v2.blockscout.com/address/0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b
https://megaeth-testnet-v2.blockscout.com/address/0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c
```

### Quick Test Commands

```bash
# Register as agent (get 100 REP)
cast send 0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b "register()" \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY

# Check REP balance
cast call 0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b \
  "balanceOf(address,uint256)(uint256)" $ADDRESS 0 \
  --rpc-url https://carrot.megaeth.com/rpc

# Create quest (5 min window)
cast send 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "createQuest(string,string,uint64,uint64)" \
  "bitcoin" "https://cointelegraph.com/rss" $(date +%s) $(($(date +%s) + 300)) \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY

# Submit claim: YES, 10 REP stake, 0.01 ETH, 70% confidence
cast send 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "submitClaim(uint256,uint8,uint256,uint256)" \
  1 1 10000000000000000000 70 \
  --value 0.01ether \
  --rpc-url https://carrot.megaeth.com/rpc \
  --private-key $PRIVATE_KEY

# Get quest stakes
cast call 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "getStakes(uint256)(uint256,uint256,uint256,uint256)" 1 \
  --rpc-url https://carrot.megaeth.com/rpc

# Get odds
cast call 0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c \
  "getOdds(uint256)(uint256,uint256)" 1 \
  --rpc-url https://carrot.megaeth.com/rpc
```

---

## Oracle Deployment (Railway)

The MentionFi Oracle runs 24/7 on Railway to resolve quests automatically.

### Prerequisites

1. Railway account: https://railway.app
2. Oracle wallet with ETH for gas
3. Private key for the oracle wallet

### Deploy to Railway

```bash
cd oracle

# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create new project
railway init

# Set environment variables
railway variables set PRIVATE_KEY=0x...your_oracle_private_key
railway variables set QUEST_ADDRESS=0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c
railway variables set RPC_URL=https://carrot.megaeth.com/rpc
railway variables set PORT=3000
railway variables set INTERVAL_MS=30000

# Deploy
railway up
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | Yes | - | Oracle wallet private key (0x prefixed) |
| `QUEST_ADDRESS` | Yes | - | MentionQuest contract address |
| `RPC_URL` | No | MegaETH testnet | RPC endpoint |
| `PORT` | No | 3000 | Health check server port |
| `INTERVAL_MS` | No | 30000 | Check interval (ms) |
| `KEYWORDS` | No | - | Additional keywords (comma-separated) |

### Health Check

Once deployed, Railway will monitor the `/health` endpoint:

```bash
curl https://your-app.railway.app/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": "24h 15m",
  "questsResolved": 47,
  "lastCheck": "2026-02-05T10:30:00Z",
  "pendingQuests": 3,
  "errors": 2
}
```

### Local Testing

```bash
cd oracle

# Install dependencies
npm install

# Copy and configure .env
cp .env.example .env
# Edit .env with your values

# Run locally
npm run dev
```

---

## Previous Deployment (v1 - REP only)

| Contract | Address |
|----------|---------|
| ReputationToken | `0xc75341952A70b655b480a170bcbbEE1fB28e6142` |
| MentionQuest | `0x32A692147D71ffFA80901876c1d277829579dE3e` |

---

*Deployed by Rufus #22742*
