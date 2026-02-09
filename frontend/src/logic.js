/**
 * MentionFi Pure Logic — extracted for testability
 * Used by App.jsx and logic.test.js
 */
import { ethers } from 'ethers';

// Known keywords — same list as App.jsx
export const KNOWN_KEYWORDS = [
  'bitcoin', 'ethereum', 'solana', 'xrp', 'defi', 'nft', 'stablecoin', 'binance', 'coinbase', 'sec', 'etf',
  'deepseek', 'openai', 'anthropic', 'chatgpt', 'claude', 'ai', 'llm', 'gpt',
  'fed', 'inflation', 'nasdaq', 'recession', 'tariff',
  'trump', 'musk', 'china', 'russia', 'ukraine',
  'apple', 'google', 'microsoft', 'meta', 'nvidia', 'megaeth', 'mega',
  'war', 'hack', 'exploit', 'regulation', 'bull', 'bear', 'crash', 'pump', 'dump',
  'tesla', 'amazon', 'tiktok', 'spacex', 'blackrock', 'vitalik', 'saylor',
];

// RSS Feeds — synced with oracle/src/feeds.ts (oracle = source of truth)
export const RSS_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml', tier: 'S' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', tier: 'S' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', tier: 'A' },
  { name: 'CryptoPotato', url: 'https://cryptopotato.com/feed/', tier: 'B' },
  { name: 'The Defiant', url: 'https://thedefiant.io/feed/', tier: 'A' },
  { name: 'CryptoNews', url: 'https://cryptonews.com/news/feed/', tier: 'B' },
  { name: 'CNBC Markets', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', tier: 'S' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', tier: 'S' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', tier: 'A' },
  { name: 'Yahoo News', url: 'https://news.yahoo.com/rss/', tier: 'A' },
];

// Build hash→keyword lookup
export function buildKeywordHashMap(keywords = KNOWN_KEYWORDS) {
  const map = {};
  for (const kw of keywords) {
    map[ethers.keccak256(ethers.toUtf8Bytes(kw))] = kw;
  }
  return map;
}

// Deterministic pseudo-random
export function seededRandom(seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Bingo round generator
export function getBingoRound(nowSec, keywords = KNOWN_KEYWORDS, feeds = RSS_FEEDS) {
  const SLOT = 1800; // 30 min
  const slot = Math.floor(nowSec / SLOT);
  const roundStart = slot * SLOT;
  const roundEnd = roundStart + SLOT;
  const remaining = Math.max(0, roundEnd - nowSec);
  // Deterministic Fisher-Yates shuffle
  const idx = keywords.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom(slot * 10000 + i) * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const shuffled = idx.map(i => keywords[i]);
  const validFeeds = feeds.filter(f => f.tier !== 'C');
  const pickFeed = (n) => validFeeds[Math.floor(seededRandom(slot * 50000 + n) * validFeeds.length)];
  return {
    slot, roundStart, roundEnd, remaining,
    roundNum: slot % 10000,
    main: shuffled.slice(0, 6).map((kw, i) => ({ keyword: kw, feed: pickFeed(i), hash: ethers.keccak256(ethers.toUtf8Bytes(kw)) })),
    quick: shuffled.slice(6, 9).map((kw, i) => ({ keyword: kw, feed: pickFeed(i + 6), hash: ethers.keccak256(ethers.toUtf8Bytes(kw)) })),
  };
}

// Countdown formatter
export function fmtCountdown(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Payout calculator
export function calculatePayout(myStake, myPool, oppPool) {
  if (myPool <= 0 || myStake <= 0) return myStake;
  return (oppPool * 0.9 * (myStake / myPool)) + myStake;
}

// ROI calculator
export function calculateROI(myStake, potentialWin) {
  if (myStake <= 0) return 0;
  return ((potentialWin - myStake) / myStake) * 100;
}

// Format address
export function fmtAddr(a) {
  if (!a || a === ethers.ZeroAddress) return 'None';
  return a.slice(0, 6) + '...' + a.slice(-4);
}

// Format time remaining
export function fmtTime(end) {
  const rem = end - Math.floor(Date.now() / 1000);
  if (rem <= 0) return 'Ended';
  const d = Math.floor(rem / 86400);
  const h = Math.floor((rem % 86400) / 3600);
  const m = Math.floor((rem % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Format ETH values with cent-based display for small amounts
export function fmtEth(val) {
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n) || n === 0) return '0 ETH';
  if (n < 0.01) return `${(n * 100).toFixed(1)}¢`;
  if (n < 1) return `${(n * 100).toFixed(0)}¢`;
  return `${n.toFixed(3)} ETH`;
}

// Format feed name from URL
export function fmtFeed(url) {
  const f = RSS_FEEDS.find(f => f.url === url);
  return f ? f.name : (url.split('/')[2] || url).replace('www.', '');
}
