import React, { useEffect, useState, useCallback } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { privyConfig, megaethTestnet } from './privy-config';
import { ethers } from 'ethers';
import RogueASCIIBg from './RogueASCIIBg';
import { fmtEth } from './logic';

const PRIVY_APP_ID = 'cmlcigd1f01b9jm0du28i2jpx';

const REP_TOKEN_ADDRESS = '0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b';
const QUEST_ADDRESS = '0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c';
const RPC_URL = 'https://carrot.megaeth.com/rpc';
const ORACLE_API = 'https://oracle-production-aa8f.up.railway.app';

const REP_TOKEN_ABI = [
  'function register() external',
  'function balanceOf(address, uint256) view returns (uint256)',
  'function isRegistered(address) view returns (bool)',
];

const QUEST_ABI = [
  'function questCount() view returns (uint256)',
  'function quests(uint256) view returns (uint256 id, address creator, bytes32 keywordHash, string sourceUrl, uint64 windowStart, uint64 windowEnd, uint64 createdAt, uint8 status, uint8 outcome)',
  'function questStakes(uint256) view returns (uint256 totalYesRepStake, uint256 totalNoRepStake, uint256 totalYesEthStake, uint256 totalNoEthStake)',
  'function claims(uint256, address) view returns (address agent, uint8 position, uint256 repStake, uint256 ethStake, uint256 confidence, bool claimed)',
  'function createQuest(string keyword, string sourceUrl, uint64 windowStart, uint64 windowEnd) external returns (uint256)',
  'function submitClaim(uint256 questId, uint8 position, uint256 repStake, uint256 confidence) external payable',
  'function claimReward(uint256 questId) external',
  'function getOdds(uint256) view returns (uint256 yesOdds, uint256 noOdds)',
  'function minRepToCreate() view returns (uint256)',
  // Custom errors for better error decoding
  'error InsufficientReputation()',
  'error InvalidWindow()',
  'error InvalidStake()',
  'error AlreadyClaimed()',
  'error NoClaim()',
  'error InvalidPosition()',
  'error QuestNotOpen()',
  'error QuestNotClosed()',
  'error QuestNotResolved()',
  'error WindowNotStarted()',
  'error WindowEnded()',
  'error TransferFailed()',
];

const QuestStatus = ['Open', 'Closed', 'Resolved', 'Cancelled'];
const Position = ['None', 'Yes', 'No'];

// RSS Feeds — synced with oracle/src/feeds.ts (oracle = source of truth)
const RSS_FEEDS = [
  { name: 'CoinDesk', url: 'https://feeds.feedburner.com/CoinDesk', tier: 'S' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', tier: 'S' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', tier: 'A' },
  { name: 'CryptoPotato', url: 'https://cryptopotato.com/feed/', tier: 'B' },
  { name: 'The Defiant', url: 'https://thedefiant.io/feed/', tier: 'A' },
  { name: 'CryptoNews', url: 'https://cryptonews.com/news/feed/', tier: 'B' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', tier: 'A' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml', tier: 'A' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', tier: 'A' },
  { name: 'CNBC Crypto', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069', tier: 'S' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', tier: 'S' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', tier: 'A' },
];

const DURATION_PRESETS = [
  { label: '5 min', value: 300 },
  { label: '10 min', value: 600 },
  { label: '30 min', value: 1800 },
  { label: '1 hour', value: 3600 },
];

const STAKE_PRESETS = ['0.001', '0.01', '0.05', '0.1'];

// Known keywords — high-frequency words that appear constantly in crypto/tech/politics news
// Grouped by category for the Bingo board. All tested against live RSS feeds.
const KNOWN_KEYWORDS = [
  // Crypto (appear in almost every crypto article)
  'bitcoin', 'ethereum', 'solana', 'xrp', 'bnb', 'defi', 'nft', 'stablecoin', 'altcoin',
  // Companies & Entities
  'binance', 'coinbase', 'sec', 'etf', 'blackrock',
  // AI (hot topic, appears in tech + crypto feeds)
  'openai', 'chatgpt', 'ai', 'deepseek',
  // Politics (always trending)
  'trump', 'musk', 'china', 'tariff',
  // Markets
  'fed', 'inflation', 'nasdaq', 'bull', 'bear',
  // Tech Giants
  'apple', 'google', 'nvidia', 'tesla', 'spacex',
  // Crypto Culture
  'whale', 'airdrop', 'memecoin', 'layer 2', 'staking',
];

// Build hash→keyword lookup at module load (pure client-side, no API needed)
const KEYWORD_HASH_MAP = {};
for (const kw of KNOWN_KEYWORDS) {
  KEYWORD_HASH_MAP[ethers.keccak256(ethers.toUtf8Bytes(kw))] = kw;
}

// Deterministic round generator — all users see same keywords for same time slot
function seededRandom(seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function getBingoRound(nowSec) {
  const SLOT = 1800; // 30 min
  const slot = Math.floor(nowSec / SLOT);
  const roundStart = slot * SLOT;
  const roundEnd = roundStart + SLOT;
  const remaining = Math.max(0, roundEnd - nowSec);
  // Deterministic Fisher-Yates shuffle
  const idx = KNOWN_KEYWORDS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom(slot * 10000 + i) * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const shuffled = idx.map(i => KNOWN_KEYWORDS[i]);
  const feeds = RSS_FEEDS.filter(f => f.tier !== 'C');
  const pickFeed = (n) => feeds[Math.floor(seededRandom(slot * 50000 + n) * feeds.length)];
  return {
    slot, roundStart, roundEnd, remaining,
    roundNum: slot % 10000,
    main: shuffled.slice(0, 6).map((kw, i) => ({ keyword: kw, feed: pickFeed(i), hash: ethers.keccak256(ethers.toUtf8Bytes(kw)) })),
    quick: shuffled.slice(6, 9).map((kw, i) => ({ keyword: kw, feed: pickFeed(i + 6), hash: ethers.keccak256(ethers.toUtf8Bytes(kw)) })),
  };
}

function fmtCountdown(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Colors — bright neon terminal aesthetic
const C = {
  bg: '#0A0A0F',
  surface: '#12121A',
  surfaceHover: '#1A1A2E',
  border: '#2A2A3E',
  yes: '#00FF88',
  no: '#FF3366',
  info: '#00BBFF',
  warn: '#FFB800',
  text1: '#FFFFFF',
  text2: '#C0C0DD',
  text3: '#8888BB',
};

function MentionFiDashboard() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [quests, setQuests] = useState([]);
  const [userRep, setUserRep] = useState(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [view, setView] = useState('bingo');
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [liveFeed, setLiveFeed] = useState([]);
  const [newQuest, setNewQuest] = useState({ keyword: '', sourceUrl: RSS_FEEDS[0].url, duration: 3600 });
  const [stakeAmount, setStakeAmount] = useState('0.001');
  const [oracleBalance, setOracleBalance] = useState(null);
  const [userPositions, setUserPositions] = useState({});
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [oracleHealth, setOracleHealth] = useState(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [keywordMap, setKeywordMap] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mentionfi_keywords') || '{}');
      return { ...KEYWORD_HASH_MAP, ...stored };
    } catch { return { ...KEYWORD_HASH_MAP }; }
  });

  const activeWallet = wallets?.[0];

  // Toast notification system
  const addToast = useCallback((type, title, message) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev.slice(-4), { id, type, title, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      // Supplement keyword map from oracle (catches custom keywords from other users)
      try {
        const [kwRes, questsRes] = await Promise.allSettled([
          fetch(`${ORACLE_API}/api/v1/keywords`),
          fetch(`${ORACLE_API}/api/v1/quests?limit=100`),
        ]);
        const newMappings = {};
        // From keyword map endpoint
        if (kwRes.status === 'fulfilled' && kwRes.value.ok) {
          const kwJson = await kwRes.value.json();
          if (kwJson.success && kwJson.data) Object.assign(newMappings, kwJson.data);
        }
        // From quest data (oracle discovers keywords from on-chain tx calldata)
        if (questsRes.status === 'fulfilled' && questsRes.value.ok) {
          const qJson = await questsRes.value.json();
          if (qJson.success && Array.isArray(qJson.data)) {
            for (const q of qJson.data) {
              if (q.keyword && q.keywordHash) newMappings[q.keywordHash] = q.keyword;
            }
          }
        }
        if (Object.keys(newMappings).length > 0) {
          setKeywordMap(prev => {
            const merged = { ...prev, ...newMappings };
            localStorage.setItem('mentionfi_keywords', JSON.stringify(merged));
            return merged;
          });
        }
      } catch (e) { /* oracle unreachable — built-in keyword list still works */ }

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const questContract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, provider);
      const repContract = new ethers.Contract(REP_TOKEN_ADDRESS, REP_TOKEN_ABI, provider);

      const count = await questContract.questCount();
      const questList = [];
      const start = Math.max(1, Number(count) - 29);

      for (let i = Number(count); i >= start; i--) {
        try {
          const q = await questContract.quests(i);
          const stakes = await questContract.questStakes(i);
          const odds = await questContract.getOdds(i);
          questList.push({
            id: i, creator: q.creator, keywordHash: q.keywordHash, sourceUrl: q.sourceUrl,
            windowStart: Number(q.windowStart), windowEnd: Number(q.windowEnd),
            status: Number(q.status), outcome: Number(q.outcome),
            totalYesRep: ethers.formatEther(stakes.totalYesRepStake),
            totalNoRep: ethers.formatEther(stakes.totalNoRepStake),
            totalYesEth: ethers.formatEther(stakes.totalYesEthStake),
            totalNoEth: ethers.formatEther(stakes.totalNoEthStake),
            yesOdds: Number(odds.yesOdds), noOdds: Number(odds.noOdds),
          });
        } catch (e) { /* skip invalid quest */ }
      }
      setQuests(questList);

      // Oracle wallet balance
      try {
        const bal = await provider.getBalance('0x3058ff5B62E67a27460904783aFd670fF70c6A4A');
        setOracleBalance(parseFloat(ethers.formatEther(bal)).toFixed(4));
      } catch (e) { /* ignore */ }

      if (activeWallet?.address) {
        const registered = await repContract.isRegistered(activeWallet.address);
        setIsRegistered(registered);
        if (registered) {
          const repBalance = await repContract.balanceOf(activeWallet.address, 0);
          setUserRep(ethers.formatEther(repBalance));
        }
        // Track user's existing positions to prevent double-betting
        const positions = {};
        for (const q of questList) {
          try {
            const claim = await questContract.claims(q.id, activeWallet.address);
            if (Number(claim.position) !== 0) {
              positions[q.id] = { position: Number(claim.position), repStake: ethers.formatEther(claim.repStake), ethStake: ethers.formatEther(claim.ethStake), claimed: claim.claimed };
            }
          } catch (e) { /* skip */ }
        }
        setUserPositions(positions);
      }
    } catch (e) {
      console.error('Failed to fetch data:', e);
    }
  }, [activeWallet?.address]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Auto-dismiss errors after 6 seconds
  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(null), 6000);
      return () => clearTimeout(t);
    }
  }, [error]);

  // 1-second timer for bingo countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Live word feed — fetch RSS headlines and stream words like a stock ticker
  useEffect(() => {
    const fetchLive = async () => {
      try {
        const [feedRes, healthRes] = await Promise.allSettled([
          fetch(`${ORACLE_API}/api/v1/feeds`),
          fetch(`${ORACLE_API}/health`),
        ]);
        if (feedRes.status === 'fulfilled' && feedRes.value.ok) {
          const json = await feedRes.value.json();
          if (json.success && json.data) {
            const items = json.data.map(f => ({ feed: f.name || f.url, tier: f.tier, time: Date.now() }));
            setLiveFeed(items.slice(0, 12));
          }
        }
        if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
          const hJson = await healthRes.value.json();
          setOracleHealth(hJson);
        }
      } catch (e) { /* ignore */ }
    };
    fetchLive();
    const t = setInterval(fetchLive, 30000);
    // Scan progress bar — ticks every second within 15s cycle
    const sp = setInterval(() => {
      setScanProgress(prev => (prev + 1) % 15);
    }, 1000);
    return () => { clearInterval(t); clearInterval(sp); };
  }, []);

  const round = getBingoRound(now);

  // Pulse data — keyword market order book
  const pulseData = KNOWN_KEYWORDS.map(kw => {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(kw));
    const q = quests.find(x => x.keywordHash === hash && x.status === 0);
    const yesPool = q ? parseFloat(q.totalYesEth || 0) : 0;
    const noPool = q ? parseFloat(q.totalNoEth || 0) : 0;
    const total = yesPool + noPool;
    const sentiment = total > 0 ? Math.round((yesPool / total) * 100) : 50;
    return { keyword: kw, hash, quest: q, yesPool, noPool, total, sentiment, listed: !!q };
  }).sort((a, b) => b.total - a.total);
  const listedWords = pulseData.filter(d => d.listed);
  const unlistedWords = pulseData.filter(d => !d.listed);
  const maxPool = Math.max(...pulseData.map(d => Math.max(d.yesPool, d.noPool)), 0.001);

  const getSigner = async () => {
    await activeWallet.switchChain(megaethTestnet.id);
    const eip1193 = await activeWallet.getEthereumProvider();
    const provider = new ethers.BrowserProvider(eip1193);
    return provider.getSigner();
  };

  const handleRegister = async () => {
    if (!activeWallet) return;
    setLoading(true); setError(null);
    addToast('info', 'Registering...', 'Sending registration transaction');
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const repContract = new ethers.Contract(REP_TOKEN_ADDRESS, REP_TOKEN_ABI, provider);
      const alreadyReg = await repContract.isRegistered(activeWallet.address);
      if (alreadyReg) { setIsRegistered(true); fetchData(); setLoading(false); addToast('success', 'Already Registered', 'You already have 100 REP'); return; }
      const signer = await getSigner();
      const tx = await new ethers.Contract(REP_TOKEN_ADDRESS, REP_TOKEN_ABI, signer).register();
      await tx.wait();
      setIsRegistered(true);
      addToast('success', 'Registered!', 'You received 100 REP. Start betting!');
      fetchData();
    } catch (e) {
      if (e.message?.includes('AlreadyRegistered') || e.message?.includes('revert')) {
        setIsRegistered(true); fetchData();
        addToast('success', 'Already Registered', 'Your wallet is already registered');
      } else { addToast('error', 'Registration Failed', e.shortMessage || e.message?.slice(0, 100)); }
    }
    finally { setLoading(false); }
  };

  const handleCreateQuest = async () => {
    if (!activeWallet || !newQuest.keyword) return;
    const keyword = newQuest.keyword.trim();
    if (!keyword) { addToast('error', 'Missing Keyword', 'Enter a keyword for your quest'); return; }
    // Client-side REP check
    const currentRep = parseFloat(userRep || 0);
    if (currentRep < 1) {
      addToast('error', 'Not Enough REP', `Need 1 REP to create quests (you have ${currentRep.toFixed(0)}). Win bets to earn more!`);
      return;
    }
    setLoading(true); setError(null);
    addToast('info', 'Creating Quest...', `"${keyword}" — confirming transaction`);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const now = Math.floor(Date.now() / 1000);
      const duration = DURATION_PRESETS.find(p => p.value === newQuest.duration)?.label || `${newQuest.duration}s`;
      const feedName = RSS_FEEDS.find(f => f.url === newQuest.sourceUrl)?.name || 'RSS feed';
      const tx = await contract.createQuest(keyword, newQuest.sourceUrl, now + 10, now + newQuest.duration);
      await tx.wait();
      const kw = keyword.toLowerCase().trim();
      const hash = ethers.keccak256(ethers.toUtf8Bytes(kw));
      const updated = { ...keywordMap, [hash]: kw };
      setKeywordMap(updated);
      localStorage.setItem('mentionfi_keywords', JSON.stringify(updated));
      fetch(`${ORACLE_API}/api/v1/keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: kw }) }).catch(() => {});
      setNewQuest({ keyword: '', sourceUrl: RSS_FEEDS[0].url, duration: 3600 });
      addToast('success', 'Quest Created!', `"${keyword}" on ${feedName} — ${duration} window. Oracle scanning every 15s.`);
      setView('dashboard');
      fetchData();
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('InsufficientReputation')) addToast('error', 'Not Enough REP', 'Need 1 REP to create quests. Win bets to earn more!');
      else if (msg.includes('InvalidWindow')) addToast('error', 'Invalid Time', 'Time window is invalid. Try again.');
      else if (msg.includes('user rejected') || msg.includes('denied')) addToast('warning', 'Cancelled', 'Transaction was rejected');
      else if (msg.includes('insufficient')) addToast('error', 'Not Enough ETH', 'You need ETH for gas fees');
      else addToast('error', 'Quest Creation Failed', msg.slice(0, 150));
    }
    finally { setLoading(false); }
  };

  const handleBet = async (questId, position) => {
    if (!activeWallet) return;
    if (userPositions[questId]) { addToast('warning', 'Already Bet', 'You already have a position on this quest. One bet per quest.'); return; }
    const posLabel = position === 1 ? 'YES' : 'NO';
    setLoading(true); setError(null);
    addToast('info', `Betting ${posLabel}...`, `${stakeAmount} ETH + 10 REP on Quest #${questId}`);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const repStake = ethers.parseEther('10');
      const ethStake = ethers.parseEther(stakeAmount);
      const tx = await contract.submitClaim(questId, position, repStake, 70, { value: ethStake });
      await tx.wait();
      addToast('success', `Bet Placed: ${posLabel}!`, `${stakeAmount} ETH + 10 REP on Quest #${questId}. Good luck!`);
      fetchData();
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('AlreadyClaimed')) addToast('warning', 'Already Bet', 'One position per quest — no hedging.');
      else if (msg.includes('InsufficientReputation')) addToast('error', 'Not Enough REP', 'Need 10 REP minimum to bet. Win bets to earn more!');
      else if (msg.includes('InvalidStake')) addToast('error', 'Invalid Stake', 'ETH must be 0.001-1 ETH. REP must be 10-100.');
      else if (msg.includes('WindowEnded')) addToast('error', 'Window Closed', 'Betting period has ended for this quest.');
      else if (msg.includes('WindowNotStarted')) addToast('warning', 'Not Started', 'Betting window hasn\'t started yet.');
      else if (msg.includes('insufficient')) addToast('error', 'Insufficient Funds', 'Not enough ETH or REP for this bet.');
      else if (msg.includes('user rejected') || msg.includes('denied')) addToast('warning', 'Cancelled', 'Transaction was rejected');
      else addToast('error', 'Bet Failed', msg.slice(0, 150));
    }
    finally { setLoading(false); }
  };

  const handleClaim = async (questId) => {
    if (!activeWallet) return;
    setLoading(true); setError(null);
    addToast('info', 'Claiming Reward...', `Processing Quest #${questId}`);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const q = await contract.quests(questId);
      if (Number(q.status) !== 2) { addToast('warning', 'Not Ready', 'Quest not resolved yet. Oracle resolves automatically — wait for the time window to end.'); setLoading(false); return; }
      const claim = await contract.claims(questId, activeWallet.address);
      if (Number(claim.position) === 0) { addToast('warning', 'No Position', 'You have no bet on this quest.'); setLoading(false); return; }
      if (claim.claimed) { addToast('warning', 'Already Claimed', 'You already claimed rewards for this quest.'); setLoading(false); return; }
      const balBefore = await new ethers.JsonRpcProvider(RPC_URL).getBalance(activeWallet.address);
      const tx = await contract.claimReward(questId);
      await tx.wait();
      const balAfter = await new ethers.JsonRpcProvider(RPC_URL).getBalance(activeWallet.address);
      const gained = parseFloat(ethers.formatEther(balAfter - balBefore));
      const keyword = keywordMap[q.keywordHash] || `#${questId}`;
      addToast('success', 'Reward Claimed!', `"${keyword}" — ${gained > 0 ? '+' : ''}${gained.toFixed(4)} ETH + REP returned`);
      fetchData();
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('NoClaim')) addToast('error', 'No Claim', 'No position to claim on this quest.');
      else if (msg.includes('QuestNotResolved')) addToast('warning', 'Not Resolved', 'Wait for the oracle to resolve this quest.');
      else if (msg.includes('AlreadyClaimed')) addToast('warning', 'Already Claimed', 'Rewards already collected.');
      else if (msg.includes('user rejected') || msg.includes('denied')) addToast('warning', 'Cancelled', 'Transaction was rejected');
      else addToast('error', 'Claim Failed', msg.slice(0, 150));
    }
    finally { setLoading(false); }
  };

  // Create quest from bingo grid
  const handleBingoCreate = async (keyword, feedUrl) => {
    if (!activeWallet) return;
    // Client-side REP check — contract requires minRepToCreate (50 REP)
    const currentRep = parseFloat(userRep || 0);
    if (currentRep < 1) {
      addToast('error', 'Not Enough REP', `Need 1 REP to create markets (you have ${currentRep.toFixed(0)}). Place winning bets to earn more REP!`);
      return;
    }
    setLoading(true); setError(null);
    const feedName = RSS_FEEDS.find(f => f.url === feedUrl)?.name || 'RSS feed';
    addToast('info', 'Creating Market...', `"${keyword}" on ${feedName}`);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const nowSec = Math.floor(Date.now() / 1000);
      const tx = await contract.createQuest(keyword, feedUrl, nowSec + 10, round.roundEnd);
      await tx.wait();
      const kw = keyword.toLowerCase().trim();
      const hash = ethers.keccak256(ethers.toUtf8Bytes(kw));
      setKeywordMap(prev => { const m = { ...prev, [hash]: kw }; localStorage.setItem('mentionfi_keywords', JSON.stringify(m)); return m; });
      fetch(`${ORACLE_API}/api/v1/keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: kw }) }).catch(() => {});
      addToast('success', 'Market Created!', `"${keyword}" — bet YES/NO now!`);
      fetchData();
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('InsufficientReputation')) addToast('error', 'Not Enough REP', `Need 1 REP to create markets. Win bets to earn more!`);
      else if (msg.includes('InvalidWindow')) addToast('error', 'Invalid Time', 'Round may have ended. Wait for next round.');
      else if (msg.includes('user rejected') || msg.includes('denied')) addToast('warning', 'Cancelled', 'Transaction was rejected');
      else addToast('error', 'Create Failed', msg.slice(0, 150));
    }
    finally { setLoading(false); }
  };

  const handleShare = (text) => {
    if (navigator.share) navigator.share({ title: 'MentionFi', text, url: 'https://mentionfi.vercel.app' });
    else { navigator.clipboard.writeText(text + ' https://mentionfi.vercel.app'); addToast('success', 'Copied!', 'Link copied to clipboard'); }
  };

  // Find active quest matching a keyword hash
  const findBingoQuest = (hash) => quests.find(q => q.keywordHash === hash && q.status === 0);

  // Custom keyword limits based on REP
  const userRepNum = parseFloat(userRep || 0);
  const maxCustom = userRepNum >= 500 ? 5 : userRepNum >= 300 ? 2 : userRepNum >= 200 ? 1 : 0;

  const fmtAddr = (a) => (!a || a === ethers.ZeroAddress) ? 'None' : a.slice(0, 6) + '...' + a.slice(-4);
  const fmtTime = (end) => {
    const rem = end - Math.floor(Date.now() / 1000);
    if (rem <= 0) return 'Ended';
    const d = Math.floor(rem / 86400), h = Math.floor((rem % 86400) / 3600), m = Math.floor((rem % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  const fmtFeed = (url) => {
    const f = RSS_FEEDS.find(f => f.url === url);
    return f ? f.name : (url.split('/')[2] || url).replace('www.', '');
  };

  const activeQuests = quests.filter(q => q.status === 0);
  const resolvedQuests = quests.filter(q => q.status === 2);
  const totalEthStaked = quests.reduce((s, q) => s + parseFloat(q.totalYesEth) + parseFloat(q.totalNoEth), 0);
  const totalBets = Object.keys(userPositions).length;
  const wonBets = Object.entries(userPositions).filter(([qId, pos]) => {
    const q = quests.find(x => x.id === Number(qId));
    return q && q.status === 2 && q.outcome === pos.position;
  }).length;
  const winRate = totalBets > 0 ? Math.round((wonBets / totalBets) * 100) : 0;

  if (!ready) return <div style={{ color: C.text3, fontFamily: "'JetBrains Mono', monospace", padding: '50px', background: C.bg, minHeight: '100vh' }}>Loading...</div>;

  // Landing page (not authenticated)
  if (!authenticated) {
    return (
      <div style={st.container}>
        <RogueASCIIBg />
        <div style={st.content}>
          {/* Hero */}
          <div style={{ textAlign: 'center', marginBottom: '40px', paddingTop: '20px' }}>
            <h1 style={{ color: C.text1, fontSize: '48px', fontWeight: '700', margin: 0, letterSpacing: '-2px', textShadow: `0 0 40px ${C.yes}33` }}>MENTIONFI</h1>
            <div style={{ color: C.yes, fontSize: '14px', letterSpacing: '4px', marginTop: '6px', fontWeight: '600' }}>MENTION MARKETS</div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '12px' }}>
              <span style={st.badge}>MegaETH</span>
              <span style={{ ...st.badge, borderColor: `${C.yes}66`, color: C.yes, animation: 'pulse 2s infinite' }}>LIVE</span>
              <span style={{ ...st.badge, borderColor: `${C.warn}66`, color: C.warn }}>5-60 MIN</span>
            </div>
          </div>

          {/* Inline stats bar */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '32px', marginBottom: '32px', padding: '14px 24px', background: `${C.surface}CC`, borderRadius: '10px', border: `1px solid ${C.border}`, backdropFilter: 'blur(8px)' }}>
            <div style={{ textAlign: 'center' }}>
              <span style={{ color: C.yes, fontSize: '22px', fontWeight: '700' }}>{activeQuests.length}</span>
              <span style={{ color: C.text3, fontSize: '10px', display: 'block', letterSpacing: '0.5px' }}>LIVE</span>
            </div>
            <div style={{ width: '1px', background: C.border }} />
            <div style={{ textAlign: 'center' }}>
              <span style={{ color: C.text1, fontSize: '22px', fontWeight: '700' }}>{resolvedQuests.length}</span>
              <span style={{ color: C.text3, fontSize: '10px', display: 'block', letterSpacing: '0.5px' }}>RESOLVED</span>
            </div>
            <div style={{ width: '1px', background: C.border }} />
            <div style={{ textAlign: 'center' }}>
              <span style={{ color: C.warn, fontSize: '22px', fontWeight: '700' }}>{totalEthStaked > 0 ? totalEthStaked.toFixed(2) : '0'}</span>
              <span style={{ color: C.text3, fontSize: '10px', display: 'block', letterSpacing: '0.5px' }}>ETH POOL</span>
            </div>
          </div>

          {/* How it works — 3 steps */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '28px' }}>
            <div style={{ background: `${C.surface}EE`, border: `1px solid ${C.yes}44`, borderRadius: '10px', padding: '16px 12px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: '-8px', right: '-8px', width: '40px', height: '40px', background: `${C.yes}11`, borderRadius: '50%' }} />
              <div style={{ color: C.yes, fontSize: '20px', fontWeight: '700', marginBottom: '6px' }}>1</div>
              <div style={{ color: C.text1, fontSize: '12px', fontWeight: '700', marginBottom: '4px' }}>PICK A WORD</div>
              <div style={{ color: C.text2, fontSize: '10px', lineHeight: '1.5' }}>Choose keyword + news feed + time window</div>
            </div>
            <div style={{ background: `${C.surface}EE`, border: `1px solid ${C.warn}44`, borderRadius: '10px', padding: '16px 12px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: '-8px', right: '-8px', width: '40px', height: '40px', background: `${C.warn}11`, borderRadius: '50%' }} />
              <div style={{ color: C.warn, fontSize: '20px', fontWeight: '700', marginBottom: '6px' }}>2</div>
              <div style={{ color: C.text1, fontSize: '12px', fontWeight: '700', marginBottom: '4px' }}>BET YES / NO</div>
              <div style={{ color: C.text2, fontSize: '10px', lineHeight: '1.5' }}>Will a NEW article mention it?</div>
            </div>
            <div style={{ background: `${C.surface}EE`, border: `1px solid ${C.info}44`, borderRadius: '10px', padding: '16px 12px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: '-8px', right: '-8px', width: '40px', height: '40px', background: `${C.info}11`, borderRadius: '50%' }} />
              <div style={{ color: C.info, fontSize: '20px', fontWeight: '700', marginBottom: '6px' }}>3</div>
              <div style={{ color: C.text1, fontSize: '12px', fontWeight: '700', marginBottom: '4px' }}>WIN ETH</div>
              <div style={{ color: C.text2, fontSize: '10px', lineHeight: '1.5' }}>Oracle scans every 15s. Winners take pool.</div>
            </div>
          </div>

          {/* Description */}
          <p style={{ color: C.text2, fontSize: '13px', maxWidth: '500px', margin: '0 auto 24px', lineHeight: '1.7', textAlign: 'center' }}>
            Bet on what news will publish next. The oracle watches RSS feeds in real-time. Short windows create genuine uncertainty — you're predicting <span style={{ color: C.text1 }}>future publications</span>.
          </p>

          {/* CTA */}
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <button onClick={login} style={{ ...st.primaryBtn, maxWidth: '400px' }}>ENTER MENTION MARKETS</button>
            <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '12px', flexWrap: 'wrap' }}>
              <span style={{ color: C.text3, fontSize: '10px' }}>0.001 ETH min bet</span>
              <span style={{ color: C.text3, fontSize: '10px' }}>|</span>
              <span style={{ color: C.text3, fontSize: '10px' }}>90% to winners</span>
              <span style={{ color: C.text3, fontSize: '10px' }}>|</span>
              <span style={{ color: C.text3, fontSize: '10px' }}>Auto-resolved on-chain</span>
            </div>
          </div>

          {/* Show active quests preview */}
          {activeQuests.length > 0 && (
            <div style={{ width: '100%', maxWidth: '700px' }}>
              <h3 style={{ color: C.text2, fontSize: '12px', letterSpacing: '1px', marginBottom: '12px' }}>LIVE QUESTS</h3>
              {activeQuests.slice(0, 3).map(q => <QuestCard key={q.id} quest={q} fmtTime={fmtTime} fmtFeed={fmtFeed} keywordMap={keywordMap} />)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Authenticated dashboard
  return (
    <div style={st.container}>
      <RogueASCIIBg />
      <div style={st.content}>
        {/* Header bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h1 onClick={() => setView('bingo')} style={{ color: C.text1, fontSize: '24px', fontWeight: '700', margin: 0, letterSpacing: '-1px', cursor: 'pointer', textShadow: `0 0 20px ${C.yes}33` }}>MENTIONFI</h1>
            <span style={{ ...st.badge, borderColor: `${C.yes}44`, color: C.yes }}>MegaETH</span>
            <span style={{ ...st.badge, borderColor: `${C.yes}66`, color: C.yes, animation: 'pulse 2s infinite' }}>LIVE</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px' }}>
            <span style={{ color: C.text2 }}>{fmtAddr(activeWallet?.address)}</span>
            {isRegistered && <span style={{ color: C.yes, fontWeight: '600' }}>{parseFloat(userRep || 0).toFixed(0)} REP</span>}
            <button onClick={logout} style={st.outlineBtn}>Sign out</button>
          </div>
        </div>

        {/* Registration */}
        {!isRegistered ? (
          <div style={st.glass}>
            <h2 style={{ color: C.text1, fontSize: '18px', margin: '0 0 8px' }}>Join Mention Markets</h2>
            <p style={{ color: C.text2, fontSize: '13px', marginBottom: '16px' }}>Register to receive 100 REP — your reputation stake for predictions. REP grows when you win, shrinks when you lose.</p>
            <button onClick={handleRegister} disabled={loading} style={st.primaryBtn}>
              {loading ? 'REGISTERING...' : 'REGISTER & GET 100 REP'}
            </button>
          </div>
        ) : (
          <>
            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: '10px', marginBottom: '24px' }}>
              <StatBox label="Total Quests" value={quests.length} />
              <StatBox label="Active" value={activeQuests.length} color={C.yes} />
              <StatBox label="Your Bets" value={Object.keys(userPositions).length} color={C.info} />
              <StatBox label="Win Rate" value={`${winRate}%`} color={winRate > 50 ? C.yes : C.text2} />
              <StatBox label="REP" value={parseFloat(userRep || 0).toFixed(0)} color={C.yes} />
            </div>

            {/* Leaderboard — collapsible */}
            {(() => {
              const creatorCounts = {};
              quests.forEach(q => { creatorCounts[q.creator] = (creatorCounts[q.creator] || 0) + 1; });
              const top5 = Object.entries(creatorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
              if (top5.length === 0) return null;
              return (
                <div style={{ ...st.glass, padding: '12px 16px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setShowLeaderboard(!showLeaderboard)}>
                    <span style={{ color: C.text3, fontSize: '10px', letterSpacing: '1px' }}>TOP QUEST CREATORS</span>
                    <span style={{ color: C.text3, fontSize: '10px' }}>{showLeaderboard ? '▲' : '▼'}</span>
                  </div>
                  {showLeaderboard && (
                    <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingTop: '10px', paddingBottom: '4px' }}>
                      {top5.map(([addr, count], i) => (
                        <div key={addr} style={{ flexShrink: 0, background: C.bg, border: `1px solid ${i === 0 ? C.yes + '44' : C.border}`, borderRadius: '8px', padding: '10px 14px', minWidth: '120px', textAlign: 'center' }}>
                          <div style={{ color: i === 0 ? C.yes : C.text2, fontSize: '10px', fontWeight: '700', marginBottom: '2px' }}>#{i + 1}</div>
                          <div style={{ color: C.text1, fontSize: '11px', fontFamily: 'monospace' }}>{addr.slice(0, 6)}...{addr.slice(-4)}</div>
                          <div style={{ color: C.warn, fontSize: '13px', fontWeight: '700', marginTop: '4px' }}>{count} quest{count > 1 ? 's' : ''}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Navigation tabs */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: '4px' }}>
              {[
                { key: 'bingo', label: 'BINGO' },
                { key: 'pulse', label: 'PULSE' },
                { key: 'dashboard', label: 'ALL QUESTS' },
                { key: 'create', label: '+ CREATE' },
                { key: 'portfolio', label: 'MY BETS' },
                { key: 'actions', label: (() => {
                  const claimable = Object.entries(userPositions).filter(([qId, pos]) => {
                    const q = quests.find(x => x.id === Number(qId));
                    return q && q.status === 2 && !pos.claimed && ((q.outcome === 1 && pos.position === 1) || (q.outcome === 2 && pos.position === 2));
                  }).length;
                  return claimable > 0 ? `ACTIONS (${claimable})` : 'ACTIONS';
                })() },
                { key: 'howto', label: 'HOW TO PLAY' },
                { key: 'about', label: 'ABOUT' },
                { key: 'oracle', label: 'ORACLE' },
              ].map(t => (
                <button key={t.key} onClick={() => setView(t.key)} style={{ ...(view === t.key ? st.tabActive : st.tab), flexShrink: 0 }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* BINGO view — main dashboard */}
            {view === 'bingo' && (
              <div style={{ width: '100%' }}>
                {/* Quick Guide Banner */}
                <div style={{ ...st.glass, padding: '14px 18px', marginBottom: '12px', borderColor: `${C.yes}33`, background: `linear-gradient(135deg, ${C.surface}EE, ${C.bg}EE)` }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', textAlign: 'center' }}>
                    <div>
                      <div style={{ color: C.yes, fontSize: '18px', fontWeight: '700', marginBottom: '2px' }}>1</div>
                      <div style={{ color: C.text1, fontSize: '11px', fontWeight: '600' }}>CREATE or PICK</div>
                      <div style={{ color: C.text2, fontSize: '10px' }}>Choose a keyword market</div>
                    </div>
                    <div>
                      <div style={{ color: C.warn, fontSize: '18px', fontWeight: '700', marginBottom: '2px' }}>2</div>
                      <div style={{ color: C.text1, fontSize: '11px', fontWeight: '600' }}>BET YES or NO</div>
                      <div style={{ color: C.text2, fontSize: '10px' }}>Stake ETH + REP</div>
                    </div>
                    <div>
                      <div style={{ color: C.info, fontSize: '18px', fontWeight: '700', marginBottom: '2px' }}>3</div>
                      <div style={{ color: C.text1, fontSize: '11px', fontWeight: '600' }}>ORACLE RESOLVES</div>
                      <div style={{ color: C.text2, fontSize: '10px' }}>Winners take the pool</div>
                    </div>
                  </div>
                </div>

                {/* Round header + countdown + timeline */}
                <div style={{ ...st.glass, padding: '16px 18px', marginBottom: '16px', borderColor: round.remaining < 120 ? `${C.warn}44` : `${C.yes}33` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: round.remaining > 0 ? C.yes : C.no, boxShadow: `0 0 12px ${round.remaining > 0 ? C.yes : C.no}`, animation: 'pulse 2s infinite' }} />
                      <span style={{ color: C.text1, fontSize: '16px', fontWeight: '700' }}>ROUND #{round.roundNum}</span>
                      <span style={{ color: C.text3, fontSize: '11px', padding: '2px 8px', background: `${C.info}22`, borderRadius: '4px', border: `1px solid ${C.info}33` }}>30 MIN</span>
                    </div>
                    <div style={{
                      color: round.remaining < 60 ? C.no : round.remaining < 120 ? C.warn : C.yes,
                      fontSize: '28px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace",
                      animation: round.remaining < 60 ? 'countdownGlow 1s ease infinite' : 'none',
                      textShadow: `0 0 15px ${round.remaining < 60 ? C.no : round.remaining < 120 ? C.warn : C.yes}66`,
                    }}>
                      {fmtCountdown(round.remaining)}
                    </div>
                  </div>

                  {/* Visual timeline bar */}
                  <div style={{ position: 'relative', height: '8px', background: C.bg, borderRadius: '4px', overflow: 'hidden', border: `1px solid ${C.border}` }}>
                    <div style={{
                      height: '100%', borderRadius: '4px', transition: 'width 1s linear',
                      width: `${((1800 - round.remaining) / 1800) * 100}%`,
                      background: round.remaining < 60 ? `linear-gradient(90deg, ${C.no}88, ${C.no})` :
                                  round.remaining < 120 ? `linear-gradient(90deg, ${C.warn}88, ${C.warn})` :
                                  `linear-gradient(90deg, ${C.yes}44, ${C.yes})`,
                      boxShadow: `0 0 8px ${round.remaining < 60 ? C.no : round.remaining < 120 ? C.warn : C.yes}66`,
                    }} />
                    {/* Scan indicator */}
                    <div style={{
                      position: 'absolute', top: 0, width: '2px', height: '100%',
                      background: C.info, boxShadow: `0 0 6px ${C.info}`,
                      left: `${(scanProgress / 15) * 100}%`, transition: 'left 1s linear', opacity: 0.8,
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '9px' }}>
                    <span style={{ color: C.text3 }}>START</span>
                    <span style={{ color: C.info, display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: C.info, animation: 'pulse 1.5s infinite' }} />
                      ORACLE SCANNING
                    </span>
                    <span style={{ color: C.text3 }}>END</span>
                  </div>
                </div>

                {/* Live word ticker — news pulse */}
                <div style={{ ...st.glass, padding: '10px 16px', marginBottom: '16px', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: C.yes, animation: 'pulse 2s infinite', boxShadow: `0 0 8px ${C.yes}` }} />
                    <span style={{ color: C.text2, fontSize: '10px', letterSpacing: '1px', fontWeight: '600' }}>WORD PULSE — LIVE FEED ACTIVITY</span>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
                    {round.main.concat(round.quick).map((item, i) => {
                      const q = findBingoQuest(item.hash);
                      const isHot = q && (parseFloat(q.totalYesEth) + parseFloat(q.totalNoEth)) > 0;
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                          <span style={{ color: isHot ? C.yes : C.text2, fontSize: '11px', fontWeight: isHot ? '700' : '500', textTransform: 'uppercase', textShadow: isHot ? `0 0 8px ${C.yes}44` : 'none' }}>{item.keyword}</span>
                          {isHot && <span style={{ color: C.warn, fontSize: '9px', fontWeight: '700' }}>{fmtEth(parseFloat(q.totalYesEth) + parseFloat(q.totalNoEth))}</span>}
                          {i < 8 && <span style={{ color: C.text3, fontSize: '10px' }}>|</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Stake selector for bingo */}
                <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', alignItems: 'center' }}>
                  <span style={{ color: C.text3, fontSize: '10px', marginRight: '4px' }}>STAKE:</span>
                  {STAKE_PRESETS.map(amt => (
                    <button key={amt} onClick={() => setStakeAmount(amt)}
                      style={{ ...st.chip, fontSize: '10px', padding: '3px 8px', ...(stakeAmount === amt ? { background: C.info, color: C.bg, borderColor: C.info } : {}) }}>
                      {amt}
                    </button>
                  ))}
                </div>

                {/* REP warning */}
                {parseFloat(userRep || 0) < 1 && (
                  <div style={{ padding: '10px 14px', marginBottom: '12px', background: `${C.warn}11`, border: `1px solid ${C.warn}33`, borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '14px' }}>!</span>
                    <span style={{ color: C.warn, fontSize: '11px' }}>Need <b>1 REP</b> to create markets (you have {parseFloat(userRep || 0).toFixed(0)}). Bet on existing markets to earn REP from wins!</span>
                  </div>
                )}

                {/* 6-word bingo grid */}
                <h3 style={{ color: C.text2, fontSize: '11px', letterSpacing: '1px', marginBottom: '8px' }}>MAIN ROUND — 6 KEYWORDS</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginBottom: '20px' }}>
                  {round.main.map((item, i) => {
                    const q = findBingoQuest(item.hash);
                    const pos = q ? userPositions[q.id] : null;
                    const pool = q ? (parseFloat(q.totalYesEth || 0) + parseFloat(q.totalNoEth || 0)) : 0;
                    return (
                      <div key={i} style={{ background: C.surface, border: `1px solid ${pos ? (pos.position === 1 ? C.yes : C.no) + '44' : q ? C.yes + '22' : C.border}`, borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                        <div style={{ color: C.text1, fontSize: '15px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '2px', letterSpacing: '1px' }}>"{item.keyword}"</div>
                        <div style={{ color: C.text3, fontSize: '9px', marginBottom: '8px' }}>{item.feed.name} [{item.feed.tier}]</div>
                        {q ? (
                          <>
                            <div style={{ height: '4px', borderRadius: '2px', background: C.no, overflow: 'hidden', marginBottom: '4px' }}>
                              <div style={{ height: '100%', width: `${q.yesOdds || 50}%`, background: C.yes }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', marginBottom: '4px' }}>
                              <span style={{ color: C.yes }}>Y {q.yesOdds || 50}%</span>
                              <span style={{ color: C.no }}>N {q.noOdds || 50}%</span>
                            </div>
                            <div style={{ color: C.warn, fontSize: '13px', fontWeight: '700', marginBottom: '6px' }}>{fmtEth(pool)}</div>
                            {pos ? (
                              <div style={{ color: pos.position === 1 ? C.yes : C.no, fontSize: '10px', fontWeight: '700', padding: '3px 8px', background: `${pos.position === 1 ? C.yes : C.no}11`, borderRadius: '4px' }}>
                                {pos.position === 1 ? 'YES' : 'NO'} — {fmtEth(parseFloat(pos.ethStake))}
                              </div>
                            ) : (
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button onClick={() => handleBet(q.id, 1)} disabled={loading} style={{ flex: 1, padding: '5px', background: C.yes, border: 'none', color: C.bg, fontSize: '10px', fontWeight: '700', borderRadius: '4px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>YES</button>
                                <button onClick={() => handleBet(q.id, 2)} disabled={loading} style={{ flex: 1, padding: '5px', background: 'transparent', border: `1px solid ${C.no}`, color: C.no, fontSize: '10px', fontWeight: '700', borderRadius: '4px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>NO</button>
                              </div>
                            )}
                          </>
                        ) : (
                          <button onClick={() => handleBingoCreate(item.keyword, item.feed.url)} disabled={loading}
                            style={{ width: '100%', padding: '8px', background: 'transparent', border: `1px dashed ${C.border}`, color: C.text2, fontSize: '10px', fontWeight: '600', borderRadius: '4px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>
                            CREATE MARKET
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* 3-word quick grid */}
                <h3 style={{ color: C.text2, fontSize: '11px', letterSpacing: '1px', marginBottom: '8px' }}>QUICK ROUND — 3 KEYWORDS</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginBottom: '20px' }}>
                  {round.quick.map((item, i) => {
                    const q = findBingoQuest(item.hash);
                    const pos = q ? userPositions[q.id] : null;
                    const pool = q ? (parseFloat(q.totalYesEth || 0) + parseFloat(q.totalNoEth || 0)) : 0;
                    return (
                      <div key={i} style={{ background: C.surface, border: `1px solid ${pos ? (pos.position === 1 ? C.yes : C.no) + '44' : q ? C.info + '22' : C.border}`, borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                        <div style={{ color: C.text1, fontSize: '15px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '2px' }}>"{item.keyword}"</div>
                        <div style={{ color: C.text3, fontSize: '9px', marginBottom: '8px' }}>{item.feed.name} [{item.feed.tier}]</div>
                        {q ? (
                          <>
                            <div style={{ color: C.warn, fontSize: '13px', fontWeight: '700', marginBottom: '4px' }}>{fmtEth(pool)}</div>
                            {pos ? (
                              <div style={{ color: pos.position === 1 ? C.yes : C.no, fontSize: '10px', fontWeight: '700' }}>{pos.position === 1 ? 'YES' : 'NO'}</div>
                            ) : (
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button onClick={() => handleBet(q.id, 1)} disabled={loading} style={{ flex: 1, padding: '5px', background: C.yes, border: 'none', color: C.bg, fontSize: '10px', fontWeight: '700', borderRadius: '4px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>YES</button>
                                <button onClick={() => handleBet(q.id, 2)} disabled={loading} style={{ flex: 1, padding: '5px', background: 'transparent', border: `1px solid ${C.no}`, color: C.no, fontSize: '10px', fontWeight: '700', borderRadius: '4px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>NO</button>
                              </div>
                            )}
                          </>
                        ) : (
                          <button onClick={() => handleBingoCreate(item.keyword, item.feed.url)} disabled={loading}
                            style={{ width: '100%', padding: '8px', background: 'transparent', border: `1px dashed ${C.border}`, color: C.text2, fontSize: '10px', fontWeight: '600', borderRadius: '4px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>
                            CREATE
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Custom keyword — REP gated */}
                {maxCustom > 0 ? (
                  <div style={{ ...st.glass, padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ color: C.text2, fontSize: '11px' }}>CUSTOM KEYWORD ({maxCustom} slot{maxCustom > 1 ? 's' : ''})</span>
                      <span style={{ color: C.yes, fontSize: '10px' }}>{userRepNum.toFixed(0)} REP</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input type="text" placeholder="your keyword..." value={newQuest.keyword}
                        onChange={e => setNewQuest({ ...newQuest, keyword: e.target.value })}
                        style={{ ...st.input, marginBottom: 0, flex: 1 }} />
                      <button onClick={() => { if (newQuest.keyword) handleBingoCreate(newQuest.keyword, RSS_FEEDS[0].url); }}
                        disabled={loading || !newQuest.keyword}
                        style={{ ...st.primaryBtn, width: 'auto', padding: '10px 20px' }}>CREATE</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: C.text3, fontSize: '11px', textAlign: 'center', padding: '12px' }}>
                    Custom keywords unlocked at 200+ REP (you have {userRepNum.toFixed(0)})
                  </div>
                )}
              </div>
            )}

            {/* PULSE — Live Word Order Book */}
            {view === 'pulse' && (
              <div style={{ width: '100%' }}>
                {/* Scrolling ticker tape */}
                <div style={{ ...st.glass, padding: '0', overflow: 'hidden', marginBottom: '16px' }}>
                  <div style={{ padding: '8px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: C.yes, boxShadow: `0 0 6px ${C.yes}`, animation: 'pulse 2s infinite' }} />
                    <span style={{ color: C.text3, fontSize: '10px', letterSpacing: '1px' }}>WORD PULSE — LIVE MARKET TICKER</span>
                    <span style={{ color: C.text3, fontSize: '10px', marginLeft: 'auto' }}>{listedWords.length} LISTED</span>
                  </div>
                  <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', padding: '10px 16px' }}>
                    <div style={{ display: 'inline-flex', gap: '24px', animation: 'ticker 40s linear infinite' }}>
                      {[...pulseData, ...pulseData].map((d, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                          <span style={{ color: d.listed ? (d.sentiment >= 50 ? C.yes : C.no) : C.text3, fontSize: '11px', fontWeight: d.listed ? '700' : '400', textTransform: 'uppercase' }}>
                            {d.keyword}
                          </span>
                          {d.listed && (
                            <>
                              <span style={{ color: d.sentiment >= 50 ? C.yes : C.no, fontSize: '10px' }}>
                                {d.sentiment >= 50 ? '\u25B2' : '\u25BC'}
                              </span>
                              <span style={{ color: C.warn, fontSize: '10px' }}>{fmtEth(d.total)}</span>
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Order Book */}
                <div style={{ ...st.glass, padding: '0', marginBottom: '16px' }}>
                  <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
                    <h3 style={{ color: C.text1, fontSize: '14px', margin: 0, letterSpacing: '1px' }}>ORDER BOOK — WORD MARKETS</h3>
                    <p style={{ color: C.text3, fontSize: '10px', margin: '4px 0 0' }}>BID = YES pool (keyword will appear) | ASK = NO pool (keyword won't appear)</p>
                  </div>

                  {/* Column headers */}
                  <div className="pulse-header" style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px 70px 1fr', padding: '8px 16px', borderBottom: `1px solid ${C.border}`, fontSize: '9px', color: C.text3, letterSpacing: '1px' }}>
                    <span className="pulse-depth" style={{ textAlign: 'right' }}>BID DEPTH</span>
                    <span style={{ textAlign: 'right' }}>BID (YES)</span>
                    <span style={{ textAlign: 'center' }}>KEYWORD</span>
                    <span>ASK (NO)</span>
                    <span className="pulse-depth" style={{}}>ASK DEPTH</span>
                  </div>

                  {/* Listed markets */}
                  {listedWords.length > 0 ? listedWords.map((d, i) => (
                    <div key={d.keyword} className="pulse-row" style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px 70px 1fr', padding: '7px 16px', borderBottom: `1px solid ${C.border}22`, alignItems: 'center', background: i % 2 === 0 ? 'transparent' : `${C.bg}44` }}>
                      <div className="pulse-depth" style={{ display: 'flex', justifyContent: 'flex-end', paddingRight: '8px' }}>
                        <div style={{ height: '14px', background: `${C.yes}44`, borderRadius: '2px 0 0 2px', width: `${Math.max(4, (d.yesPool / maxPool) * 100)}%`, minWidth: '4px' }} />
                      </div>
                      <span style={{ color: C.yes, fontSize: '12px', fontWeight: '600', textAlign: 'right', paddingRight: '12px' }}>{fmtEth(d.yesPool)}</span>
                      <div style={{ textAlign: 'center' }}>
                        <span style={{ color: C.text1, fontSize: '13px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px' }}>{d.keyword}</span>
                        <div style={{ fontSize: '9px', color: d.sentiment >= 50 ? C.yes : C.no, marginTop: '1px' }}>
                          {d.sentiment >= 50 ? '\u25B2' : '\u25BC'} {d.sentiment}%
                        </div>
                      </div>
                      <span style={{ color: C.no, fontSize: '12px', fontWeight: '600', paddingLeft: '12px' }}>{fmtEth(d.noPool)}</span>
                      <div className="pulse-depth" style={{ display: 'flex', paddingLeft: '8px' }}>
                        <div style={{ height: '14px', background: `${C.no}44`, borderRadius: '0 2px 2px 0', width: `${Math.max(4, (d.noPool / maxPool) * 100)}%`, minWidth: '4px' }} />
                      </div>
                    </div>
                  )) : (
                    <div style={{ padding: '24px', textAlign: 'center', color: C.text3, fontSize: '12px' }}>
                      No active markets. Go to BINGO to create the first one.
                    </div>
                  )}

                  {/* Summary row */}
                  {listedWords.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px 70px 1fr', padding: '10px 16px', borderTop: `1px solid ${C.border}`, fontSize: '10px', color: C.warn }}>
                      <span />
                      <span style={{ textAlign: 'right', paddingRight: '12px', fontWeight: '700' }}>{fmtEth(listedWords.reduce((s, d) => s + d.yesPool, 0))}</span>
                      <span style={{ textAlign: 'center', letterSpacing: '1px' }}>TOTAL</span>
                      <span style={{ paddingLeft: '12px', fontWeight: '700' }}>{fmtEth(listedWords.reduce((s, d) => s + d.noPool, 0))}</span>
                      <span />
                    </div>
                  )}
                </div>

                {/* Unlisted keywords — clickable to create */}
                <div style={st.glass}>
                  <h4 style={{ color: C.text3, fontSize: '11px', margin: '0 0 10px', letterSpacing: '1px' }}>UNLISTED — {unlistedWords.length} KEYWORDS AVAILABLE</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {unlistedWords.slice(0, 30).map(d => (
                      <span key={d.keyword} onClick={() => { setNewQuest({ ...newQuest, keyword: d.keyword }); setView('create'); }}
                        style={{ color: C.text3, fontSize: '10px', padding: '3px 10px', background: C.bg, borderRadius: '4px', border: `1px solid ${C.border}`, textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.2s' }}>
                        {d.keyword}
                      </span>
                    ))}
                  </div>
                  <p style={{ color: C.text3, fontSize: '10px', marginTop: '10px', marginBottom: 0 }}>Click any keyword to create a market for it.</p>
                </div>
              </div>
            )}

            {/* Dashboard / Quests view */}
            {view === 'dashboard' && (
              <div style={{ width: '100%' }}>
                {quests.length === 0 ? (
                  <div style={{ color: C.text3, textAlign: 'center', padding: '60px 20px', fontSize: '14px' }}>
                    No quests yet. <span style={{ color: C.yes, cursor: 'pointer' }} onClick={() => setView('create')}>Create the first one.</span>
                  </div>
                ) : (
                  <>
                    {activeQuests.length > 0 && (
                      <>
                        <h3 style={st.sectionTitle}>ACTIVE <span style={{ color: C.yes }}>({activeQuests.length})</span></h3>
                        {activeQuests.map(q => (
                          <QuestCard key={q.id} quest={q} fmtTime={fmtTime} fmtFeed={fmtFeed}
                            onBet={handleBet} stakeAmount={stakeAmount} setStakeAmount={setStakeAmount}
                            loading={loading} userPosition={userPositions[q.id]} keywordMap={keywordMap} />
                        ))}
                      </>
                    )}
                    {resolvedQuests.length > 0 && (
                      <>
                        <h3 style={{ ...st.sectionTitle, marginTop: '32px' }}>RESOLVED <span style={{ color: C.text3 }}>({resolvedQuests.length})</span></h3>
                        {resolvedQuests.slice(0, 5).map(q => (
                          <QuestCard key={q.id} quest={q} fmtTime={fmtTime} fmtFeed={fmtFeed} onClaim={handleClaim} onShare={handleShare} loading={loading} keywordMap={keywordMap} userPosition={userPositions[q.id]} />
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Create Quest view */}
            {view === 'create' && (
              <div style={{ ...st.glass, maxWidth: '500px' }}>
                <h2 style={{ color: C.text1, fontSize: '16px', margin: '0 0 20px', letterSpacing: '1px' }}>NEW QUEST</h2>

                <label style={st.label}>KEYWORD</label>
                <input type="text" placeholder="bitcoin, ethereum, trump, deepseek..."
                  value={newQuest.keyword} onChange={e => setNewQuest({ ...newQuest, keyword: e.target.value })}
                  style={st.input} />

                <label style={st.label}>RSS FEED SOURCE</label>
                <select value={newQuest.sourceUrl} onChange={e => setNewQuest({ ...newQuest, sourceUrl: e.target.value })} style={st.input}>
                  {RSS_FEEDS.map(f => <option key={f.url} value={f.url}>{f.name} [{f.tier}]</option>)}
                </select>

                <label style={st.label}>TIME WINDOW</label>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', flexWrap: 'wrap' }}>
                  {DURATION_PRESETS.map(p => (
                    <button key={p.value} onClick={() => setNewQuest({ ...newQuest, duration: p.value })}
                      style={{ ...st.chip, ...(newQuest.duration === p.value ? { background: C.info, color: C.bg, borderColor: C.info } : {}) }}>
                      {p.label}
                    </button>
                  ))}
                </div>

                {/* Preview */}
                {newQuest.keyword && (
                  <div style={{ background: 'rgba(0,255,136,0.05)', border: `1px solid ${C.yes}33`, borderRadius: '8px', padding: '12px', marginBottom: '20px' }}>
                    <div style={{ color: C.text2, fontSize: '11px', marginBottom: '4px' }}>PREVIEW</div>
                    <div style={{ color: C.text1, fontSize: '14px' }}>
                      Will "<span style={{ color: C.yes }}>{newQuest.keyword}</span>" appear in {fmtFeed(newQuest.sourceUrl)} within {DURATION_PRESETS.find(p => p.value === newQuest.duration)?.label}?
                    </div>
                  </div>
                )}

                <button onClick={handleCreateQuest} disabled={loading || !newQuest.keyword} style={st.primaryBtn}>
                  {loading ? 'CREATING...' : 'CREATE QUEST'}
                </button>
              </div>
            )}

            {/* My Bets view */}
            {view === 'portfolio' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 16px' }}>YOUR POSITIONS</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '16px', marginBottom: '20px' }}>
                    <div><div style={{ color: C.yes, fontSize: '24px', fontWeight: '700' }}>{parseFloat(userRep || 0).toFixed(0)}</div><div style={{ color: C.text3, fontSize: '11px' }}>REP Balance</div></div>
                    <div><div style={{ color: C.text1, fontSize: '24px', fontWeight: '700' }}>{quests.filter(q => q.creator === activeWallet?.address).length}</div><div style={{ color: C.text3, fontSize: '11px' }}>Quests Created</div></div>
                    <div><div style={{ color: C.info, fontSize: '24px', fontWeight: '700' }}>{Object.keys(userPositions).length}</div><div style={{ color: C.text3, fontSize: '11px' }}>Active Bets</div></div>
                    <div><div style={{ color: C.warn, fontSize: '24px', fontWeight: '700' }}>{fmtEth(Object.values(userPositions).reduce((s, p) => s + parseFloat(p.ethStake), 0))}</div><div style={{ color: C.text3, fontSize: '11px' }}>ETH at Risk</div></div>
                  </div>
                  {Object.keys(userPositions).length > 0 ? (
                    <div style={{ display: 'grid', gap: '10px' }}>
                      {Object.entries(userPositions).map(([qId, pos]) => {
                        const q = quests.find(x => x.id === Number(qId));
                        if (!q) return null;
                        const keyword = keywordMap[q.keywordHash];
                        const myPool = pos.position === 1 ? parseFloat(q.totalYesEth || 0) : parseFloat(q.totalNoEth || 0);
                        const oppPool = pos.position === 1 ? parseFloat(q.totalNoEth || 0) : parseFloat(q.totalYesEth || 0);
                        const myStake = parseFloat(pos.ethStake);
                        const potentialWin = myPool > 0 ? (oppPool * 0.9 * (myStake / myPool)) + myStake : myStake;
                        const roi = myStake > 0 ? ((potentialWin - myStake) / myStake * 100).toFixed(0) : '0';
                        const isWinning = q.status === 2 && ((q.outcome === 1 && pos.position === 1) || (q.outcome === 2 && pos.position === 2));
                        const isLosing = q.status === 2 && ((q.outcome === 1 && pos.position === 2) || (q.outcome === 2 && pos.position === 1));
                        return (
                          <div key={qId} style={{ padding: '14px', background: C.bg, borderRadius: '10px', border: `1px solid ${isWinning ? C.yes + '44' : isLosing ? C.no + '44' : C.border}` }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {keyword ? (
                                  <span style={{ color: C.text1, fontSize: '16px', fontWeight: '700', textTransform: 'uppercase' }}>"{keyword}"</span>
                                ) : (
                                  <span style={{ color: C.text3, fontSize: '12px', fontFamily: 'monospace' }}>#{qId}</span>
                                )}
                                <span style={{ color: pos.position === 1 ? C.yes : C.no, fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px', background: `${pos.position === 1 ? C.yes : C.no}11`, border: `1px solid ${pos.position === 1 ? C.yes : C.no}33` }}>
                                  {pos.position === 1 ? 'YES' : 'NO'}
                                </span>
                              </div>
                              <span style={{ color: q.status === 0 ? C.warn : C.text3, fontSize: '11px', fontWeight: '600' }}>
                                {q.status === 0 ? fmtTime(q.windowEnd) : QuestStatus[q.status]}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ color: C.text3, marginBottom: '2px' }}>STAKED</div>
                                <div style={{ color: C.text1, fontWeight: '600' }}>{fmtEth(myStake)}</div>
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ color: C.text3, marginBottom: '2px' }}>IF YOU WIN</div>
                                <div style={{ color: C.yes, fontWeight: '600' }}>{fmtEth(potentialWin)}</div>
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ color: C.text3, marginBottom: '2px' }}>ROI</div>
                                <div style={{ color: parseInt(roi) > 0 ? C.yes : C.text2, fontWeight: '600' }}>+{roi}%</div>
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ color: C.text3, marginBottom: '2px' }}>FEED</div>
                                <div style={{ color: C.info }}>{fmtFeed(q.sourceUrl)}</div>
                              </div>
                            </div>
                            {isWinning && (
                              <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: `${pos.claimed ? C.yes + '08' : C.yes + '11'}`, borderRadius: '6px', border: `1px solid ${C.yes}33` }}>
                                <span style={{ color: C.yes, fontSize: '11px', fontWeight: '700' }}>
                                  {pos.claimed ? `CLAIMED — ${fmtEth(potentialWin)}` : `WON — ${fmtEth(potentialWin)}`}
                                </span>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  {!pos.claimed ? (
                                    <button onClick={() => handleClaim(Number(qId))} disabled={loading}
                                      style={{ padding: '5px 14px', background: C.yes, border: 'none', color: C.bg, fontFamily: "'JetBrains Mono', monospace", fontWeight: '600', cursor: 'pointer', borderRadius: '4px', fontSize: '11px' }}>CLAIM</button>
                                  ) : (
                                    <span style={{ padding: '5px 14px', background: `${C.yes}22`, color: C.yes, fontFamily: "'JetBrains Mono', monospace", fontWeight: '600', borderRadius: '4px', fontSize: '11px' }}>COLLECTED</span>
                                  )}
                                  <button onClick={() => handleShare(`Won ${fmtEth(potentialWin)} on "${keyword || '#' + qId}" in MentionFi!`)}
                                    style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, color: C.text2, fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', cursor: 'pointer', borderRadius: '4px' }}>&gt;</button>
                                </div>
                              </div>
                            )}
                            {isLosing && (
                              <div style={{ marginTop: '10px', padding: '6px 12px', background: `${C.no}11`, borderRadius: '6px', border: `1px solid ${C.no}33`, textAlign: 'center' }}>
                                <span style={{ color: C.no, fontSize: '11px' }}>LOST — {fmtEth(myStake)} forfeited</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p style={{ color: C.text3, fontSize: '12px', textAlign: 'center', margin: '12px 0 0' }}>No active bets yet. Go to BINGO and place your first bet.</p>
                  )}
                </div>
              </div>
            )}

            {/* ACTIONS view — claim rewards, see results */}
            {view === 'actions' && (() => {
              const items = Object.entries(userPositions).map(([qId, pos]) => {
                const q = quests.find(x => x.id === Number(qId));
                if (!q) return null;
                const keyword = keywordMap[q.keywordHash] || `#${qId}`;
                const isWin = q.status === 2 && ((q.outcome === 1 && pos.position === 1) || (q.outcome === 2 && pos.position === 2));
                const isLoss = q.status === 2 && ((q.outcome === 1 && pos.position === 2) || (q.outcome === 2 && pos.position === 1));
                const myPool = pos.position === 1 ? parseFloat(q.totalYesEth || 0) : parseFloat(q.totalNoEth || 0);
                const oppPool = pos.position === 1 ? parseFloat(q.totalNoEth || 0) : parseFloat(q.totalYesEth || 0);
                const myStake = parseFloat(pos.ethStake);
                const potentialWin = myPool > 0 ? (oppPool * 0.9 * (myStake / myPool)) + myStake : myStake;
                let status = 'active';
                if (isWin && !pos.claimed) status = 'claimable';
                else if (isWin && pos.claimed) status = 'claimed';
                else if (isLoss) status = 'lost';
                return { qId: Number(qId), q, pos, keyword, isWin, isLoss, myStake, potentialWin, status };
              }).filter(Boolean);
              const claimable = items.filter(i => i.status === 'claimable');
              const active = items.filter(i => i.status === 'active');
              const claimed = items.filter(i => i.status === 'claimed');
              const lost = items.filter(i => i.status === 'lost');
              return (
                <div style={{ width: '100%' }}>
                  {/* Claimable rewards */}
                  {claimable.length > 0 && (
                    <div style={{ ...st.glass, borderColor: `${C.yes}44`, background: `linear-gradient(135deg, ${C.surface}EE, ${C.yes}08)` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h3 style={{ color: C.yes, fontSize: '14px', margin: 0, letterSpacing: '1px' }}>CLAIM REWARDS ({claimable.length})</h3>
                        <span style={{ color: C.yes, fontSize: '10px', padding: '3px 8px', background: `${C.yes}22`, borderRadius: '4px', fontWeight: '700' }}>ACTION NEEDED</span>
                      </div>
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {claimable.map(i => (
                          <div key={i.qId} style={{ padding: '14px', background: C.bg, borderRadius: '10px', border: `1px solid ${C.yes}33`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                <span style={{ color: C.text1, fontSize: '16px', fontWeight: '700', textTransform: 'uppercase' }}>"{i.keyword}"</span>
                                <span style={{ color: i.pos.position === 1 ? C.yes : C.no, fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px', background: `${i.pos.position === 1 ? C.yes : C.no}15` }}>
                                  {i.pos.position === 1 ? 'YES' : 'NO'}
                                </span>
                                <span style={{ color: C.yes, fontSize: '10px', fontWeight: '700' }}>WON</span>
                              </div>
                              <div style={{ color: C.text3, fontSize: '11px' }}>Staked {fmtEth(i.myStake)} — Win {fmtEth(i.potentialWin)} + REP returned</div>
                            </div>
                            <button onClick={() => handleClaim(i.qId)} disabled={loading}
                              style={{ padding: '10px 24px', background: C.yes, border: 'none', color: C.bg, fontSize: '13px', fontWeight: '700', borderRadius: '6px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                              CLAIM
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Active bets — waiting for resolution */}
                  {active.length > 0 && (
                    <div style={{ ...st.glass, marginTop: claimable.length > 0 ? '12px' : 0 }}>
                      <h3 style={{ color: C.warn, fontSize: '14px', margin: '0 0 12px', letterSpacing: '1px' }}>WAITING FOR ORACLE ({active.length})</h3>
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {active.map(i => (
                          <div key={i.qId} style={{ padding: '12px', background: C.bg, borderRadius: '10px', border: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                <span style={{ color: C.text1, fontSize: '14px', fontWeight: '700', textTransform: 'uppercase' }}>"{i.keyword}"</span>
                                <span style={{ color: i.pos.position === 1 ? C.yes : C.no, fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px', background: `${i.pos.position === 1 ? C.yes : C.no}15` }}>
                                  {i.pos.position === 1 ? 'YES' : 'NO'}
                                </span>
                              </div>
                              <div style={{ color: C.text3, fontSize: '11px' }}>{fmtEth(i.myStake)} staked — {fmtTime(i.q.windowEnd)} remaining</div>
                            </div>
                            <div style={{ color: C.warn, fontSize: '11px', fontWeight: '600', padding: '4px 10px', background: `${C.warn}11`, borderRadius: '4px', border: `1px solid ${C.warn}33` }}>PENDING</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Claimed wins */}
                  {claimed.length > 0 && (
                    <div style={{ ...st.glass, marginTop: '12px' }}>
                      <h3 style={{ color: C.text3, fontSize: '14px', margin: '0 0 12px', letterSpacing: '1px' }}>COLLECTED ({claimed.length})</h3>
                      <div style={{ display: 'grid', gap: '6px' }}>
                        {claimed.map(i => (
                          <div key={i.qId} style={{ padding: '10px 12px', background: C.bg, borderRadius: '8px', border: `1px solid ${C.yes}22`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: C.text2, fontSize: '12px' }}>"{i.keyword}" — <span style={{ color: C.yes }}>WON {fmtEth(i.potentialWin)}</span></span>
                            <span style={{ color: C.yes, fontSize: '10px', fontWeight: '600' }}>COLLECTED</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Losses */}
                  {lost.length > 0 && (
                    <div style={{ ...st.glass, marginTop: '12px' }}>
                      <h3 style={{ color: C.text3, fontSize: '14px', margin: '0 0 12px', letterSpacing: '1px' }}>LOSSES ({lost.length})</h3>
                      <div style={{ display: 'grid', gap: '6px' }}>
                        {lost.map(i => (
                          <div key={i.qId} style={{ padding: '10px 12px', background: C.bg, borderRadius: '8px', border: `1px solid ${C.no}22`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: C.text3, fontSize: '12px' }}>"{i.keyword}" — {fmtEth(i.myStake)} lost</span>
                            <span style={{ color: C.no, fontSize: '10px', fontWeight: '600' }}>LOST</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {items.length === 0 && (
                    <div style={st.glass}>
                      <p style={{ color: C.text3, fontSize: '12px', textAlign: 'center', margin: 0 }}>No positions yet. Go to BINGO and place your first bet!</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* How to Play view */}
            {view === 'howto' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.yes, fontSize: '16px', margin: '0 0 16px', letterSpacing: '1px' }}>MENTION MARKETS — HOW IT WORKS</h3>
                  <p style={st.guidePara}>MentionFi is a <span style={{ color: C.text1 }}>real-time information prediction market</span>. Players bet YES/NO on whether keywords will appear in live RSS news feeds within short time windows. An autonomous oracle resolves outcomes on-chain every 15 seconds. No human intervention. No disputes.</p>

                  <div style={st.asciiBlock}>{`
 ┌─────────────────────────────────────────────────────┐
 │              MENTIONFI ARCHITECTURE                  │
 │                                                     │
 │  PLAYERS          MEGAETH          ORACLE (24/7)    │
 │  ═══════          ═══════          ════════════     │
 │    │                 │                  │            │
 │    ├─create quest───▶│                  │            │
 │    │ "bitcoin"       │                  │            │
 │    │ CoinDesk, 30min │                  │            │
 │    │                 │                  │            │
 │    ├─bet YES 0.01───▶│                  │            │
 │    │ + 10 REP        │                  │            │
 │    │                 │                  │            │
 │    │                 │◀──scan feeds─────┤            │
 │    │                 │  every 15 sec    │            │
 │    │                 │                  │            │
 │    │                 │ "bitcoin" found  │            │
 │    │                 │ in CoinDesk RSS  │            │
 │    │                 │                  │            │
 │    │                 │◀─resolve(YES)────┤            │
 │    │                 │                  │            │
 │    ├─claimReward()──▶│                  │            │
 │    │◀── ETH + REP ──┤                  │            │
 └─────────────────────────────────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>1. REGISTER — GET 100 REP</h4>
                  <p style={st.guidePara}>Connect wallet, register on-chain, receive <span style={{ color: C.yes }}>100 REP tokens</span>. REP is your soulbound reputation. Staked on every bet. High REP = proven forecaster.</p>

                  <h4 style={st.guideHeading}>2. CREATE OR JOIN A MARKET</h4>
                  <p style={st.guidePara}>Pick a keyword + RSS feed + time window (10 min / 30 min / 1 hour). The question: <span style={{ color: C.text1 }}>Will this word appear in that feed before time runs out?</span></p>
                  <div style={st.asciiBlock}>{`
 Keyword:  "tariff"
 Feed:     CNBC (Tier B, updates every 5-30 min)
 Window:   30 minutes

 ┌──────────────────────────────────────┐
 │ Will "tariff" appear in CNBC's RSS  │
 │ feed within the next 30 minutes?    │
 │                                     │
 │          [ YES ]    [ NO ]          │
 └──────────────────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>3. PLACE YOUR BET</h4>
                  <p style={st.guidePara}>Choose <span style={{ color: C.yes }}>YES</span> or <span style={{ color: C.no }}>NO</span>. Stake ETH (min 0.001) + 10 REP. <span style={{ color: C.warn }}>One side per quest — no hedging.</span> Forces conviction betting. Odds form from the ratio of YES/NO stakes.</p>

                  <h4 style={st.guideHeading}>4. ORACLE RESOLVES AUTOMATICALLY</h4>
                  <p style={st.guidePara}>The oracle is a 24/7 autonomous process. No human. No disputes. Pure data.</p>
                  <div style={st.asciiBlock}>{`
 ┌────────────────────────────────────┐
 │      ORACLE RESOLUTION LOGIC      │
 │                                   │
 │  Every 30 seconds:                │
 │  ┌──────────────────────────┐     │
 │  │ 1. Fetch RSS XML         │     │
 │  │ 2. Parse titles + body   │     │
 │  │ 3. Case-insensitive scan │     │
 │  │ 4. Match → resolve YES   │     │
 │  │ 5. Expired → resolve NO  │     │
 │  │ 6. Else → wait, rescan   │     │
 │  └──────────────────────────┘     │
 │                                   │
 │  Resolution = blockchain TX       │
 │  Immutable. Verifiable. On-chain. │
 └────────────────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>5. CLAIM WINNINGS</h4>
                  <p style={st.guidePara}>Winners split the losing side's ETH pool proportionally. Go to <span style={{ color: C.text1 }}>MY BETS</span> tab, click CLAIM on resolved quests. Original stake + share of losers' pool returned.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.warn, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>GAME THEORY & STRATEGY</h3>
                  <p style={st.guidePara}>MentionFi uses a <span style={{ color: C.text1 }}>parimutuel betting system</span> — all bets pool together, winners split losers' stakes proportionally. This creates natural price discovery and direct PvP dynamics. Research on prediction markets (Polymarket: $44B volume 2025) validates this design for information aggregation.</p>

                  <div style={st.asciiBlock}>{`
 YOUR EDGE = (Your Info) - (Market Consensus)

 ┌────────────────────────────────────────┐
 │       INFORMATION HIERARCHY            │
 │                                       │
 │ Tier 1: Monitor the RSS feed yourself │
 │         See mentions before others    │
 │                                       │
 │ Tier 2: Know the news cycle           │
 │         Fed meeting → "inflation"     │
 │         will hit CNBC within 1h       │
 │                                       │
 │ Tier 3: Understand feed update speeds │
 │         S-tier: every 2-5 min         │
 │         B-tier: every 15-30 min       │
 │         Calibrate YES/NO accordingly  │
 │                                       │
 │ Tier 4: Read the market itself        │
 │         Heavy YES → cheap NO bets     │
 │         Contrarian plays pay 10x+     │
 └────────────────────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>DOMINANT STRATEGIES</h4>
                  <div style={st.asciiBlock}>{`
 ┌──────────────┬─────────────────────────┐
 │ STRATEGY     │ WHEN TO USE             │
 ├──────────────┼─────────────────────────┤
 │ News Surfer  │ Breaking event live     │
 │  bet YES on  │ Keywords flood feeds    │
 │  trending    │ within minutes          │
 ├──────────────┼─────────────────────────┤
 │ Silent Night │ Weekend / slow news     │
 │  bet NO on   │ Obscure words won't     │
 │  obscure     │ appear in 10-30 min     │
 ├──────────────┼─────────────────────────┤
 │ Feed Sniper  │ Check the actual feed   │
 │  monitor RSS │ See mention before the  │
 │  yourself    │ oracle's next 30s scan  │
 ├──────────────┼─────────────────────────┤
 │ Contrarian   │ Market is one-sided     │
 │  bet against │ 95/5 odds = huge payout │
 │  the crowd   │ if you're right         │
 ├──────────────┼─────────────────────────┤
 │ Creator      │ Topic knowledge edge    │
 │  make quests │ Earn 5% of losing pool  │
 │  on edge     │ regardless of outcome   │
 └──────────────┴─────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>WHY SHORT WINDOWS MATTER</h4>
                  <p style={st.guidePara}>Prediction market research (Hanson, 2003; Polymarket data) shows the dominant strategy is to <span style={{ color: C.yes }}>bet your true belief early</span>. In 10-60 min windows, there's no value in waiting for smarter traders — the oracle resolves before late info changes outcomes.</p>
                  <p style={st.guidePara}><span style={{ color: C.warn }}>MentionFi's speed creates urgency.</span> Contrarian windows are narrow. Once a keyword trends, the market adjusts within minutes. The alpha is in the first few bets.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.info, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>FEED INTELLIGENCE</h3>
                  <p style={st.guidePara}>Feed update frequency directly impacts YES probability. Faster feeds = more content = higher chance of keyword match in short windows.</p>
                  <div style={st.asciiBlock}>{`
 FEED TIER SYSTEM
 ════════════════

 S-TIER │ 2-5 min updates  │ HIGH YES prob
 ───────┼──────────────────┼──────────────
 CoinDesk, Cointelegraph   │ Crypto, fast
 CNBC Markets, Hacker News │ Markets+Tech

 A-TIER │ 5-15 min updates │ MODERATE
 ───────┼──────────────────┼──────────────
 CryptoSlate, The Defiant  │ Crypto/DeFi
 TechCrunch, Yahoo News    │ Tech/General

 B-TIER │ 5-30 min updates │ LOWER
 ───────┼──────────────────┼──────────────
 CryptoPotato, CryptoNews  │ Niche crypto

 TIP: "bitcoin" on S-tier 30min → likely YES
      "obscure" on C-tier 10min → likely NO
`}</div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.yes, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>EXAMPLE: A COMPLETE ROUND</h3>
                  <div style={st.asciiBlock}>{`
 MARKET: "bitcoin" on CoinDesk — 30 min
 ═══════════════════════════════════════

 BETTING PHASE
 ─────────────
 YES side            NO side
 ┌───────────┐      ┌───────────┐
 │ Alice 0.10│      │ Carol 0.30│
 │ Bob   0.20│      │ Dave  0.50│
 ├───────────┤      ├───────────┤
 │ Total 0.30│      │ Total 0.80│
 └───────────┘      └───────────┘

 Odds: YES 27% / NO 73%
 Total pool: 1.10 ETH

 RESOLUTION
 ──────────
 T+14 min: Oracle scans CoinDesk RSS
 → "Bitcoin ETF sees record inflows..."
 → Keyword "bitcoin" FOUND → YES WINS

 PAYOUT
 ──────
 Losing pool:            0.80 ETH
 Protocol fee (5%):     -0.04 ETH
 Creator reward (5%):   -0.04 ETH
 ────────────────────────────────
 To winners:             0.72 ETH

 Alice: 0.72 x (0.1/0.3) = 0.24
        + her 0.10 back   = 0.34
        PROFIT: +0.24 ETH (+240%)

 Bob:   0.72 x (0.2/0.3) = 0.48
        + his 0.20 back   = 0.68
        PROFIT: +0.48 ETH (+240%)

 Carol & Dave: stakes forfeited.
`}</div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.yes, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>REP: REPUTATION SYSTEM</h3>
                  <p style={st.guidePara}>REP is MentionFi's <span style={{ color: C.text1 }}>soulbound reputation token</span> (EIP-6909 multi-token). Non-transferable — you can't buy reputation, only earn it through correct predictions.</p>
                  <div style={st.asciiBlock}>{`
 REP LIFECYCLE
 ═════════════
 Register   → +100 REP (starting balance)
 Place bet  → -10 REP  (staked per bet)
 Win bet    → +10 REP  (stake returned)
             → +bonus  (from losing pool)
 Lose bet   → -10 REP  (forfeited)

 ┌──────────────┬──────────────────────┐
 │ REP LEVEL    │ MEANING              │
 ├──────────────┼──────────────────────┤
 │ 100 REP      │ New player           │
 │ 200+ REP     │ Consistent winner    │
 │ 500+ REP     │ Expert forecaster    │
 │ < 50 REP     │ Losing streak        │
 │ 0 REP        │ Cannot bet           │
 └──────────────┴──────────────────────┘

 WHY SOULBOUND?
 Can't buy credibility. REP reflects
 actual prediction accuracy. High REP
 = skin in the game + proven record.
`}</div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.info, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>AI AGENT INTEGRATION</h3>
                  <p style={st.guidePara}>MentionFi is built for both humans and <span style={{ color: C.text1 }}>AI agents</span>. Agents discover the protocol via standard files, query the oracle API, and interact with contracts directly.</p>
                  <div style={st.asciiBlock}>{`
 ┌──────────┐   ┌────────────┐   ┌──────────┐
 │ AI Agent │──▶│ Oracle API │──▶│ On-Chain │
 │          │   │ /api/v1/.. │   │ Contract │
 │ Reads:   │   │            │   │          │
 │ - feeds  │   │ GET /quests│   │ bet()    │
 │ - odds   │   │ GET /feeds │   │ create() │
 │ - stats  │   │ GET /stats │   │ claim()  │
 └──────────┘   └────────────┘   └──────────┘

 Discovery files:
 • /.well-known/agent-card.json (A2A)
 • /openclaw-skills.json (tools)
 • /AGENTS.md (integration guide)
 • /llms.txt (LLM-readable)

 Agents compete alongside humans.
 Speed + pattern recognition
 vs. contextual understanding.
 The market discovers who's better.
`}</div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>ECONOMICS & FEES</h3>
                  <div style={st.asciiBlock}>{`
 FEE STRUCTURE
 ═════════════
 ┌──────────────────────────────────┐
 │    TOTAL LOSING POOL = 100%     │
 │                                 │
 │ ┌────────┐ ┌───────┐ ┌───────┐ │
 │ │Protocol│ │Creator│ │Winners│ │
 │ │  5%    │ │  5%   │ │  90%  │ │
 │ │        │ │       │ │       │ │
 │ │Treasury│ │Quest  │ │Split  │ │
 │ │        │ │maker  │ │by     │ │
 │ │        │ │reward │ │stake  │ │
 │ └────────┘ └───────┘ └───────┘ │
 └──────────────────────────────────┘

 MINIMUM STAKES
 • ETH: 0.001 per bet
 • REP: 10 per bet

 Winners: original stake + loser share
 Losers:  ETH + REP forfeited
 Creators: 5% always (win or lose)
`}</div>
                </div>
              </div>
            )}

            {/* ABOUT view */}
            {view === 'about' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.yes, fontSize: '16px', margin: '0 0 16px', letterSpacing: '1px' }}>WHAT IS MENTIONFI</h3>
                  <p style={st.guidePara}>MentionFi is a <span style={{ color: C.text1 }}>forward-looking information prediction market</span> on MegaETH. Players bet on whether specific keywords will appear in <span style={{ color: C.text1 }}>NEW articles</span> published on RSS news feeds within short time windows — 5 minutes to 1 hour. An autonomous oracle scans feeds every 15 seconds, resolves outcomes on-chain, and distributes winnings automatically. No human intervention. No disputes. Pure information markets.</p>
                  <p style={st.guidePara}>Not "will Bitcoin hit $100k" — but <span style={{ color: C.yes }}>"will a NEW article mentioning 'bitcoin' be published on Cointelegraph in the next 30 minutes?"</span> Forward-looking. Verifiable. Binary. Fast.</p>
                  <p style={st.guidePara}>The key insight: <span style={{ color: C.text1 }}>only articles published AFTER the market opens count</span>. You can't check the feed beforehand — you're predicting future news events. Each article can only resolve one quest (no double-dipping). Difficulty = keyword frequency × feed coverage × window length.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.warn, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>WHY NOW</h3>
                  <p style={st.guidePara}>Prediction markets just had their breakout moment. <span style={{ color: C.text1 }}>Polymarket + Kalshi combined for $44B+ trading volume in 2025</span> — up from $9B on Polymarket alone in 2024. Kalshi won its CFTC court battle in 2024, legitimizing event contracts in the US. The regulatory ice is thawing.</p>
                  <p style={st.guidePara}><span style={{ color: C.text1 }}>AI agents are already here.</span> Automated trading bots extracted $40M+ in arbitrage profits from prediction markets between April 2024 and April 2025. Market makers on Polymarket earned $20M+ in 2024. The next wave isn't humans vs humans — it's agents alongside humans, competing on information speed.</p>
                  <p style={st.guidePara}><span style={{ color: C.text1 }}>MegaETH launched mainnet February 9, 2026</span> — 10ms blocks, 100K+ TPS. For the first time, an EVM chain is fast enough for real-time prediction markets. No more waiting 12 seconds per block. Create a market, place a bet, and see it confirmed in milliseconds.</p>
                  <p style={st.guidePara}>RSS feeds as oracle data: <span style={{ color: C.text1 }}>public, verifiable, machine-readable, and updated every 2-30 minutes</span>. No opaque data sources. Anyone can check the feed. The oracle's resolution logic is deterministic — scan the XML, match the keyword, resolve on-chain.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.info, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>WHY LIKE THIS</h3>
                  <h4 style={st.guideHeading}>PARIMUTUEL SYSTEM</h4>
                  <p style={st.guidePara}>MentionFi uses a <span style={{ color: C.text1 }}>dynamic parimutuel mechanism</span> (Pennock, 2004). All bets pool together. Winners split losers' stakes proportionally. No market maker needed. No order book to maintain. The system is always liquid from the first bet — infinite buy-in, zero institutional risk.</p>
                  <p style={st.guidePara}>Unlike LMSR (Hanson, 2003) which requires a subsidized market maker, parimutuel markets are <span style={{ color: C.text1 }}>self-funding</span>. The house doesn't take a position. Players bet against each other. Natural price discovery emerges from the ratio of YES/NO stakes.</p>

                  <h4 style={st.guideHeading}>SHORT TIME WINDOWS</h4>
                  <p style={st.guidePara}>10 to 60 minute windows aren't arbitrary. Ottaviani & Sorensen's timing theory shows that in short-duration markets, <span style={{ color: C.text1 }}>the dominant strategy is to bet your true belief early</span>. There's no value in waiting for smarter traders — the oracle resolves before late information changes outcomes. This creates honest, fast-moving markets.</p>

                  <h4 style={st.guideHeading}>SOULBOUND REP</h4>
                  <p style={st.guidePara}>REP is an EIP-6909 multi-token — <span style={{ color: C.text1 }}>non-transferable</span>. You can't buy reputation, only earn it through correct predictions. This is Sybil resistance through skin in the game. Creating a fresh wallet doesn't give you the credibility that 500+ REP signals.</p>

                  <h4 style={st.guideHeading}>RSS ORACLE</h4>
                  <p style={st.guidePara}>The oracle scans public RSS feeds — the same XML that every news reader, aggregator, and bot can access. <span style={{ color: C.text1 }}>No proprietary data. No API keys. No trust assumptions beyond "does the feed exist."</span> Anyone can independently verify resolution by checking the same feed the oracle checked.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.yes, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>GAME THEORY</h3>
                  <p style={st.guidePara}>In parimutuel markets, the Nash equilibrium converges on <span style={{ color: C.text1 }}>truthful revelation</span> (Watanabe, 1997). When you can only bet one side and the payout is proportional to your stake relative to the winning pool, misrepresenting your beliefs strictly reduces your expected return.</p>
                  <div style={st.asciiBlock}>{`
 NASH EQUILIBRIUM IN MENTIONFI
 ══════════════════════════════

 Given: You believe P(YES) = 70%

 Strategy A: Bet YES (truthful)
 → Expected value = 0.7 × (your share of YES pool)
   Maximized when pool reflects true odds

 Strategy B: Bet NO (bluff)
 → Expected value = 0.3 × (your share of NO pool)
   Strictly worse unless you can move the market
   AND bet again — but one-bet-per-quest prevents this

 Strategy C: Don't bet
 → Expected value = 0

 Dominant strategy: BET YOUR TRUE BELIEF EARLY
 The one-bet constraint + short windows + proportional
 payout = truthful revelation is strictly optimal.
`}</div>
                  <p style={st.guidePara}><span style={{ color: C.text1 }}>Hayek's information hierarchy (1945)</span> explains why this works: dispersed knowledge that exists nowhere in totality can be aggregated through price signals. Each bettor contributes a fragment — their read on news cycles, feed update speeds, keyword likelihood — and the market price synthesizes it all.</p>
                  <p style={st.guidePara}><span style={{ color: C.text1 }}>Surowiecki's "Wisdom of Crowds" (2004)</span> identifies four conditions for accurate crowd predictions: diversity of opinion, independence, decentralization, and aggregation. MentionFi satisfies all four — diverse players, independent wallets, decentralized blockchain, parimutuel aggregation.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.warn, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>ACADEMIC FOUNDATIONS</h3>
                  <p style={st.guidePara}>MentionFi's design draws from 20+ years of prediction market research. Key papers:</p>
                  <div style={st.asciiBlock}>{`
 CORE LITERATURE
 ═══════════════

 Arrow et al. (2008)
 "The Promise of Prediction Markets"
 Science, Vol 320, Issue 5878, pp. 877-878
 → Prediction markets as research tools
 → Should be freed of regulatory barriers

 Wolfers & Zitzewitz (2004)
 "Prediction Markets"
 Journal of Economic Perspectives, 18(2): 107-126
 → Market-generated forecasts outperform
   moderately sophisticated benchmarks
 → Contract design shapes information extraction

 Berg, Nelson & Rietz (2008)
 "Prediction Market Accuracy in the Long Run"
 International Journal of Forecasting, 24(2): 285-300
 → Iowa Electronic Markets beat polls 74% of time
 → Long-run accuracy validates the mechanism

 Pennock (2004)
 "A Dynamic Pari-Mutuel Market for Hedging,
  Wagering, and Information Aggregation"
 ACM Conference on Electronic Commerce (EC '04)
 → Hybrid parimutuel-CDA mechanism
 → Infinite liquidity + dynamic pricing

 Hanson (2003, 2007)
 "Logarithmic Market Scoring Rules for Modular
  Combinatorial Information Aggregation"
 Journal of Prediction Markets, 1(1): 3-15
 → LMSR — the dominant AMM for prediction markets
 → MentionFi uses parimutuel instead (self-funding)

 Fama (1970)
 "Efficient Capital Markets: A Review of Theory
  and Empirical Work"
 Journal of Finance, 25(2): 383-417
 → Efficient Market Hypothesis
 → Prices reflect available information
 → MentionFi tests this at 10-60 min resolution
`}</div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.info, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>METHODOLOGY</h3>
                  <div style={st.asciiBlock}>{`
 ┌─────────────────────────────────────────────────────┐
 │              MENTIONFI ARCHITECTURE                  │
 │                                                     │
 │  PLAYERS          MEGAETH          ORACLE (24/7)    │
 │  ═══════          ═══════          ════════════     │
 │    │                 │                  │            │
 │    ├─create quest───▶│                  │            │
 │    │ keyword+feed    │                  │            │
 │    │ + time window   │                  │            │
 │    │                 │                  │            │
 │    ├─bet YES/NO─────▶│                  │            │
 │    │ ETH + 10 REP    │                  │            │
 │    │                 │                  │            │
 │    │                 │◀──scan feeds─────┤            │
 │    │                 │  every 15 sec    │            │
 │    │                 │                  │            │
 │    │                 │  NEW article?    │            │
 │    │                 │  + keyword found │            │
 │    │                 │  YES → resolve   │            │
 │    │                 │  expired → NO    │            │
 │    │                 │                  │            │
 │    ├─claimReward()──▶│                  │            │
 │    │◀── ETH + REP ──┤                  │            │
 └─────────────────────────────────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>FEE STRUCTURE</h4>
                  <div style={st.asciiBlock}>{`
 LOSING POOL DISTRIBUTION
 ════════════════════════

 ┌───────────────────────────────────┐
 │   5%  Protocol    (treasury)     │
 │   5%  Creator     (quest maker)  │
 │  90%  Winners     (proportional) │
 └───────────────────────────────────┘

 Winners: original stake returned + 90% of losers' pool
 Creator: 5% regardless of outcome (incentivizes markets)
 Protocol: 5% sustains infrastructure + oracle gas
`}</div>

                  <h4 style={st.guideHeading}>REP LIFECYCLE</h4>
                  <div style={st.asciiBlock}>{`
 ┌────────────────────────────────────┐
 │ Register  → +100 REP (starting)   │
 │ Bet       → -10 REP  (staked)     │
 │ Win       → +10 REP  (returned)   │
 │           → +bonus   (from pool)  │
 │ Lose      → -10 REP  (forfeited)  │
 │                                    │
 │ REP GATES                          │
 │ ─────────                          │
 │ 0 REP    → cannot bet             │
 │ 100 REP  → standard player        │
 │ 200+ REP → 1 custom keyword slot  │
 │ 300+ REP → 2 custom keyword slots │
 │ 500+ REP → 5 custom keyword slots │
 └────────────────────────────────────┘
`}</div>

                  <h4 style={st.guideHeading}>ORACLE RESOLUTION FLOW</h4>
                  <div style={st.asciiBlock}>{`
 Every 15 seconds, for each open quest:
 ┌─────────────────────────────────────────┐
 │ 1. Fetch RSS feed from source URL      │
 │    Parse all <item> with pubDate       │
 │                                         │
 │ 2. Filter articles:                    │
 │    ✗ pubDate < windowStart → too old   │
 │    ✗ No pubDate → skip (unverifiable)  │
 │    ✗ Already used by another quest     │
 │    ✓ Published during window → check   │
 │                                         │
 │ 3. Case-insensitive keyword search     │
 │    in title + content + description    │
 │                                         │
 │ 4. DURING active window:              │
 │    Found → cache result, wait for end  │
 │    Not found → rescan next cycle       │
 │                                         │
 │ 5. AFTER window expires:              │
 │    Cached YES → resolve YES on-chain   │
 │    Final scan → resolve YES or NO      │
 │    Article marked as "used"            │
 └─────────────────────────────────────────┘

 Key rules:
 • Only NEW articles count (pubDate >= windowStart)
 • One article = one quest (no double-dipping)
 • Resolution = immutable on-chain transaction
`}</div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>RULES</h3>

                  <h4 style={st.guideHeading}>REGISTRATION</h4>
                  <p style={st.guidePara}>Connect a wallet. Call <span style={{ color: C.yes }}>register()</span> on the ReputationToken contract. Receive 100 REP. One registration per wallet address. REP is soulbound (EIP-6909) — non-transferable.</p>

                  <h4 style={st.guideHeading}>QUEST CREATION</h4>
                  <p style={st.guidePara}>Any registered player can create a quest by specifying: <span style={{ color: C.text1 }}>keyword</span> (any string), <span style={{ color: C.text1 }}>RSS feed source</span> (from the approved feed list), and <span style={{ color: C.text1 }}>time window</span> (5 / 10 / 30 min / 1 hour). The keyword is hashed on-chain (keccak256). Shorter windows = harder prediction = higher risk. The Bingo tab generates round-aligned quests with 30-min windows automatically.</p>

                  <h4 style={st.guideHeading}>BETTING</h4>
                  <p style={st.guidePara}><span style={{ color: C.text1 }}>One position per quest.</span> Choose YES or NO. Stake minimum 0.001 ETH + 10 REP. No hedging — you pick a side and commit. Odds display as the ratio of YES/NO ETH pools. You can bet any time before the quest window expires or is resolved.</p>

                  <h4 style={st.guideHeading}>RESOLUTION</h4>
                  <p style={st.guidePara}>The oracle runs 24/7. Every 15 seconds it checks all open quests. It only counts articles <span style={{ color: C.text1 }}>published after the quest's window opened</span> (pubDate ≥ windowStart). Each article can only resolve one quest — no double-dipping. If a NEW matching article is found → <span style={{ color: C.yes }}>resolved YES</span>. If the time window expires with no match → <span style={{ color: C.no }}>resolved NO</span>. Resolution is an immutable on-chain transaction.</p>

                  <h4 style={st.guideHeading}>CLAIMING REWARDS</h4>
                  <p style={st.guidePara}>After resolution, winning side calls <span style={{ color: C.yes }}>claimReward()</span>. You receive: your original ETH stake back + your proportional share of 90% of the losing pool + your REP stake returned + bonus REP from the losing pool. Losers forfeit their ETH and REP stakes.</p>

                  <h4 style={st.guideHeading}>CUSTOM KEYWORDS</h4>
                  <p style={st.guidePara}>Custom keyword creation is gated by REP to prevent spam. <span style={{ color: C.text1 }}>200+ REP: 1 slot. 300+ REP: 2 slots. 500+ REP: 5 slots.</span> The Bingo grid keywords rotate every 30-minute round and are available to all players.</p>

                  <h4 style={st.guideHeading}>DISQUALIFICATION CONDITIONS</h4>
                  <p style={st.guidePara}>None. There is no disqualification. The system is permissionless. If you have REP and ETH, you can play. If your REP hits 0, you can't bet until you earn more (there is no mechanism to earn REP without betting — you'd need a new wallet).</p>
                </div>

                <div style={{ ...st.glass, background: `${C.surface}88` }}>
                  <p style={{ color: C.text3, fontSize: '10px', lineHeight: '1.6', margin: 0 }}>
                    MentionFi is experimental software on MegaETH testnet. Not financial advice. No real value at risk (testnet ETH). Built by <span style={{ color: C.text2 }}>Exhuman</span> as an exploration of information markets, attention economics, and AI-native prediction protocols.
                  </p>
                </div>
              </div>
            )}

            {/* Oracle Status view */}
            {view === 'oracle' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 16px' }}>ORACLE STATUS</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                    <div>
                      <div style={{ color: oracleHealth?.status === 'healthy' ? C.yes : C.warn, fontSize: '14px', fontWeight: '600' }}>{oracleHealth?.status === 'healthy' ? 'ONLINE' : 'CHECKING...'}</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Status</div>
                    </div>
                    <div>
                      <div style={{ color: C.text1, fontSize: '14px', fontWeight: '600' }}>{oracleHealth?.uptime || '...'}</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Uptime</div>
                    </div>
                    <div>
                      <div style={{ color: C.text1, fontSize: '14px', fontWeight: '600' }}>{oracleHealth?.questsResolved ?? resolvedQuests.length}</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Quests Resolved</div>
                    </div>
                    <div>
                      <div style={{ color: C.text1, fontSize: '14px', fontWeight: '600' }}>{oracleBalance ? fmtEth(parseFloat(oracleBalance)) : '...'}</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Oracle Fund (Gas)</div>
                    </div>
                  </div>
                  {/* Scan cycle progress */}
                  <div style={{ marginBottom: '4px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: C.text3 }}>
                    <span>NEXT SCAN</span>
                    <span>{15 - scanProgress}s</span>
                  </div>
                  <div style={{ height: '3px', borderRadius: '2px', background: C.border, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(scanProgress / 15) * 100}%`, background: C.yes, borderRadius: '2px', transition: 'width 1s linear' }} />
                  </div>
                </div>

                <div style={{ ...st.glass, marginTop: '16px' }}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 16px' }}>RSS FEEDS ({RSS_FEEDS.length})</h3>
                  <div style={{ display: 'grid', gap: '8px' }}>
                    {RSS_FEEDS.map(f => (
                      <div key={f.url} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: C.bg, borderRadius: '6px', border: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: C.yes, boxShadow: `0 0 4px ${C.yes}` }} />
                          <span style={{ color: C.text1, fontSize: '13px' }}>{f.name}</span>
                        </div>
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
                          background: f.tier === 'S' ? `${C.yes}22` : f.tier === 'A' ? `${C.info}22` : `${C.text3}22`,
                          color: f.tier === 'S' ? C.yes : f.tier === 'A' ? C.info : C.text2,
                          border: `1px solid ${f.tier === 'S' ? C.yes : f.tier === 'A' ? C.info : C.text3}44`
                        }}>Tier {f.tier}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ ...st.glass, marginTop: '16px' }}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 12px' }}>CONTRACT INFO</h3>
                  <InfoRow label="Chain" value="MegaETH Testnet (6343)" />
                  <InfoRow label="MentionQuest" value={QUEST_ADDRESS} mono />
                  <InfoRow label="ReputationToken" value={REP_TOKEN_ADDRESS} mono />
                  <InfoRow label="Oracle Wallet" value="0x3058...6A4A" />
                  <InfoRow label="Protocol Fee" value="5% of winnings" />
                  <InfoRow label="Creator Reward" value="5% of winnings" />
                </div>
              </div>
            )}
          </>
        )}

        {/* Legacy error display (kept for backward compat) */}
        {error && !error.startsWith('CLAIMED!') && (
          <div style={{ color: C.no, fontSize: '13px', marginTop: '16px', padding: '12px', background: `${C.no}11`, borderRadius: '8px', border: `1px solid ${C.no}33`, maxWidth: '700px', width: '100%', textAlign: 'center' }}>
            {error.length > 200 ? error.slice(0, 200) + '...' : error}
          </div>
        )}
      </div>

      {/* Toast notifications — floating overlay */}
      <div style={{ position: 'fixed', top: '16px', right: '16px', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '380px', width: '100%', pointerEvents: 'none' }}>
        {toasts.map((toast, i) => {
          const colors = { success: C.yes, error: C.no, warning: C.warn, info: C.info };
          const icons = { success: '\u2713', error: '\u2717', warning: '\u26A0', info: '\u2139' };
          const tc = colors[toast.type] || C.info;
          return (
            <div key={toast.id} className="toast-slide-in" style={{
              background: C.surface, border: `1px solid ${tc}66`, borderLeft: `4px solid ${tc}`,
              borderRadius: '8px', padding: '12px 16px', backdropFilter: 'blur(12px)',
              boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 20px ${tc}22`,
              pointerEvents: 'auto', cursor: 'pointer',
              animation: 'toastSlideIn 0.3s ease-out',
            }} onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: toast.message ? '4px' : 0 }}>
                <span style={{ color: tc, fontSize: '16px', fontWeight: '700' }}>{icons[toast.type]}</span>
                <span style={{ color: tc, fontSize: '13px', fontWeight: '700', letterSpacing: '0.5px' }}>{toast.title}</span>
              </div>
              {toast.message && (
                <div style={{ color: C.text2, fontSize: '11px', lineHeight: '1.5', paddingLeft: '24px' }}>
                  {toast.message.length > 200 ? toast.message.slice(0, 200) + '...' : toast.message}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Quest Card Component
function QuestCard({ quest, fmtTime, fmtFeed, onBet, onClaim, onShare, stakeAmount, setStakeAmount, loading, userPosition, keywordMap }) {
  const isActive = quest.status === 0;
  const isResolved = quest.status === 2;
  const yesPercent = quest.yesOdds + quest.noOdds > 0 ? quest.yesOdds : 50;
  const noPercent = quest.yesOdds + quest.noOdds > 0 ? quest.noOdds : 50;
  const hasBet = !!userPosition;
  const keyword = keywordMap?.[quest.keywordHash] || null;
  const totalPool = parseFloat(quest.totalYesEth || 0) + parseFloat(quest.totalNoEth || 0);

  return (
    <div style={{ background: C.surface, border: `1px solid ${hasBet ? (userPosition.position === 1 ? C.yes : C.no) + '44' : C.border}`, borderRadius: '12px', padding: '16px', marginBottom: '10px', position: 'relative', zIndex: 2, backdropFilter: 'blur(8px)' }}>
      {/* Keyword + Status header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            {keyword ? (
              <span style={{ color: C.text1, fontSize: '20px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px' }}>"{keyword}"</span>
            ) : (
              <span style={{ color: C.text3, fontSize: '13px', fontFamily: 'monospace' }}>{quest.keywordHash.slice(0, 10)}...</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: `${C.info}22`, color: C.info, border: `1px solid ${C.info}33` }}>
              {fmtFeed(quest.sourceUrl)}
            </span>
            <span style={{ color: C.text3, fontSize: '10px' }}>#{quest.id}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
            background: isActive ? `${C.yes}22` : isResolved ? `${C.text3}22` : `${C.warn}22`,
            color: isActive ? C.yes : isResolved ? C.text2 : C.warn,
            border: `1px solid ${isActive ? C.yes : isResolved ? C.text3 : C.warn}44`
          }}>
            {QuestStatus[quest.status]}
          </span>
          <span style={{ color: isActive ? C.warn : C.text3, fontSize: '11px', fontWeight: '600' }}>{fmtTime(quest.windowEnd)}</span>
        </div>
      </div>

      {/* Pool display — prominent */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <div style={{ flex: 1, padding: '10px 12px', background: `${C.yes}0A`, borderRadius: '8px', border: `1px solid ${C.yes}22`, textAlign: 'center' }}>
          <div style={{ color: C.yes, fontSize: '16px', fontWeight: '700' }}>{fmtEth(parseFloat(quest.totalYesEth || 0))}</div>
          <div style={{ color: C.yes, fontSize: '10px', opacity: 0.7 }}>ETH on YES</div>
        </div>
        <div style={{ flex: 1, padding: '10px 12px', background: `${C.no}0A`, borderRadius: '8px', border: `1px solid ${C.no}22`, textAlign: 'center' }}>
          <div style={{ color: C.no, fontSize: '16px', fontWeight: '700' }}>{fmtEth(parseFloat(quest.totalNoEth || 0))}</div>
          <div style={{ color: C.no, fontSize: '10px', opacity: 0.7 }}>ETH on NO</div>
        </div>
        <div style={{ flex: 1, padding: '10px 12px', background: `${C.warn}0A`, borderRadius: '8px', border: `1px solid ${C.warn}22`, textAlign: 'center' }}>
          <div style={{ color: C.warn, fontSize: '16px', fontWeight: '700' }}>{fmtEth(totalPool)}</div>
          <div style={{ color: C.warn, fontSize: '10px', opacity: 0.7 }}>TOTAL POOL</div>
        </div>
      </div>

      {/* Probability bar */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
          <span style={{ color: C.yes }}>YES {yesPercent}%</span>
          <span style={{ color: C.no }}>NO {noPercent}%</span>
        </div>
        <div style={{ height: '6px', borderRadius: '3px', background: C.no, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${yesPercent}%`, background: C.yes, borderRadius: '3px', transition: 'width 0.3s ease' }} />
        </div>
      </div>

      {/* Your position badge */}
      {hasBet && (
        <div style={{ padding: '6px 10px', marginBottom: '10px', background: `${userPosition.position === 1 ? C.yes : C.no}11`, borderRadius: '6px', border: `1px solid ${userPosition.position === 1 ? C.yes : C.no}33`, textAlign: 'center' }}>
          <span style={{ color: userPosition.position === 1 ? C.yes : C.no, fontSize: '11px', fontWeight: '700' }}>
            YOUR BET: {userPosition.position === 1 ? 'YES' : 'NO'} — {fmtEth(parseFloat(userPosition.ethStake))} + {parseFloat(userPosition.repStake).toFixed(0)} REP
          </span>
        </div>
      )}

      {/* Bet buttons */}
      {onBet && isActive && !hasBet && (
        <div>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '8px', flexWrap: 'wrap' }}>
            {STAKE_PRESETS.map(amt => (
              <button key={amt} onClick={() => setStakeAmount(amt)}
                style={{ ...st.chip, fontSize: '10px', padding: '3px 8px', ...(stakeAmount === amt ? { background: C.info, color: C.bg, borderColor: C.info } : {}) }}>
                {amt} ETH
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => onBet(quest.id, 1)} disabled={loading}
              style={{ flex: 1, padding: '10px', background: C.yes, border: 'none', color: C.bg, fontFamily: "'JetBrains Mono', monospace", fontWeight: '700', cursor: 'pointer', borderRadius: '6px', fontSize: '12px' }}>
              YES
            </button>
            <button onClick={() => onBet(quest.id, 2)} disabled={loading}
              style={{ flex: 1, padding: '10px', background: 'transparent', border: `1px solid ${C.no}`, color: C.no, fontFamily: "'JetBrains Mono', monospace", fontWeight: '700', cursor: 'pointer', borderRadius: '6px', fontSize: '12px' }}>
              NO
            </button>
          </div>
        </div>
      )}

      {/* Resolution result */}
      {isResolved && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: quest.outcome === 1 ? `${C.yes}11` : `${C.no}11`, borderRadius: '6px', marginTop: '8px', border: `1px solid ${quest.outcome === 1 ? C.yes : C.no}33` }}>
          <span style={{ color: quest.outcome === 1 ? C.yes : C.no, fontSize: '13px', fontWeight: '600' }}>
            Result: {Position[quest.outcome]}
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            {onClaim && hasBet && !userPosition?.claimed && (
              <button onClick={() => onClaim(quest.id)} disabled={loading}
                style={{ padding: '6px 14px', background: C.yes, border: 'none', color: C.bg, fontFamily: "'JetBrains Mono', monospace", fontWeight: '600', cursor: 'pointer', borderRadius: '4px', fontSize: '11px' }}>
                CLAIM
              </button>
            )}
            {onShare && (
              <button onClick={() => onShare(`Quest #${quest.id}${keyword ? ` "${keyword}"` : ''} resolved ${Position[quest.outcome]} on MentionFi. Pool: ${fmtEth(totalPool)}`)}
                style={{ padding: '6px 10px', background: 'transparent', border: `1px solid ${C.border}`, color: C.text2, fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', cursor: 'pointer', borderRadius: '4px' }}>&gt;</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '12px 16px', minWidth: '90px', position: 'relative', zIndex: 2 }}>
      <div style={{ color: color || C.text1, fontSize: '18px', fontWeight: '700' }}>{value}</div>
      <div style={{ color: C.text3, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
    </div>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}`, fontSize: '12px' }}>
      <span style={{ color: C.text2 }}>{label}</span>
      <span style={{ color: C.text1, fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit', fontSize: mono ? '11px' : '12px', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}

function App() {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <MentionFiDashboard />
    </PrivyProvider>
  );
}

// Styles
const st = {
  container: {
    minHeight: '100vh', background: C.bg, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", color: C.text1, position: 'relative',
  },
  content: {
    position: 'relative', zIndex: 1, maxWidth: '800px', margin: '0 auto', padding: 'clamp(12px, 3vw, 24px)',
  },
  badge: {
    background: `${C.surface}`, border: `1px solid ${C.border}`, borderRadius: '4px', padding: '4px 10px', fontSize: '10px', color: C.text2, textTransform: 'uppercase', letterSpacing: '0.5px',
  },
  primaryBtn: {
    background: C.yes, border: 'none', color: C.bg, padding: '14px 40px', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace", fontWeight: '700', cursor: 'pointer', borderRadius: '8px', letterSpacing: '0.5px', transition: 'all 0.2s', position: 'relative', zIndex: 2, boxShadow: `0 0 30px ${C.yes}33`, width: '100%',
  },
  outlineBtn: {
    background: 'transparent', border: `1px solid ${C.border}`, color: C.text2, padding: '6px 12px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', borderRadius: '4px',
  },
  glass: {
    background: `${C.surface}DD`, backdropFilter: 'blur(12px)', border: `1px solid ${C.border}`, borderRadius: '12px', padding: '20px', width: '100%', position: 'relative', zIndex: 2, marginBottom: '16px',
  },
  tab: {
    background: C.surface, border: `1px solid ${C.border}`, color: C.text2, padding: '8px 18px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', borderRadius: '6px', transition: 'all 0.2s',
  },
  tabActive: {
    background: C.yes, border: `1px solid ${C.yes}`, color: C.bg, padding: '8px 18px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: '700', borderRadius: '6px',
  },
  sectionTitle: {
    color: C.text2, fontSize: '12px', letterSpacing: '1px', marginBottom: '12px', margin: '0 0 12px',
  },
  label: {
    display: 'block', color: C.text2, marginBottom: '6px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px',
  },
  input: {
    width: '100%', padding: '12px', marginBottom: '16px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.text1, fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', boxSizing: 'border-box',
  },
  chip: {
    background: 'transparent', border: `1px solid ${C.border}`, color: C.text2, padding: '5px 12px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', borderRadius: '20px', transition: 'all 0.2s',
  },
  asciiBlock: {
    background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 16px',
    fontSize: '10px', lineHeight: '1.4', whiteSpace: 'pre', fontFamily: "'JetBrains Mono', monospace",
    color: C.text2, overflowX: 'auto', margin: '8px 0 16px',
  },
  guideHeading: {
    color: C.text1, fontSize: '12px', letterSpacing: '1px', margin: '0 0 6px', textTransform: 'uppercase',
  },
  guidePara: {
    color: C.text2, fontSize: '12px', lineHeight: '1.7', margin: '0 0 12px',
  },
  tierRow: {
    display: 'flex', gap: '12px', alignItems: 'center', padding: '8px 12px', background: C.bg, borderRadius: '6px', border: `1px solid ${C.border}`, fontSize: '11px',
  },
};

// Global styles
const globalStyles = document.createElement('style');
globalStyles.textContent = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; background: ${C.bg}; }
  @keyframes ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  @keyframes flashIn { 0% { background: rgba(0,255,136,0.15); } 100% { background: transparent; } }
  @keyframes toastSlideIn { 0% { transform: translateX(100%); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
  @keyframes glowPulse { 0%, 100% { box-shadow: 0 0 8px rgba(0,255,136,0.3); } 50% { box-shadow: 0 0 20px rgba(0,255,136,0.6); } }
  @keyframes scanLine { 0% { left: 0%; } 100% { left: 100%; } }
  @keyframes urgentPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes countdownGlow { 0%, 100% { text-shadow: 0 0 10px currentColor; } 50% { text-shadow: 0 0 30px currentColor, 0 0 60px currentColor; } }
  @media (max-width: 600px) {
    .pulse-depth { display: none !important; }
    .pulse-header, .pulse-row { grid-template-columns: 70px 1fr 70px !important; }
  }
  button:hover { opacity: 0.85; transform: scale(1.02); }
  button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  button { transition: all 0.15s ease; }
  select { appearance: none; }
  input::placeholder { color: ${C.text3}; }
  input:focus, select:focus { outline: none; border-color: ${C.info}; box-shadow: 0 0 12px ${C.info}44; }
  @keyframes borderBlink { 0%, 100% { border-right-color: ${C.yes}; } 50% { border-right-color: transparent; } }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: ${C.bg}; }
  ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
`;
document.head.appendChild(globalStyles);

export default App;
