// High-frequency RSS feeds for MentionFi
// These update every 2-5 minutes

export interface FeedInfo {
  url: string;
  name: string;
  tier: "S" | "A" | "B" | "C";
  category: string;
  updateFrequency: string;
}

export const RSS_FEEDS_META: Record<string, FeedInfo> = {
  // General news
  yahooNews: {
    url: "https://news.yahoo.com/rss/",
    name: "Yahoo News",
    tier: "A",
    category: "general",
    updateFrequency: "2-5min",
  },

  // Crypto news (high frequency)
  coindesk: {
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    name: "CoinDesk",
    tier: "S",
    category: "crypto",
    updateFrequency: "2-5min",
  },
  cointelegraph: {
    url: "https://cointelegraph.com/rss",
    name: "Cointelegraph",
    tier: "S",
    category: "crypto",
    updateFrequency: "2-5min",
  },
  cryptoslate: {
    url: "https://cryptoslate.com/feed/",
    name: "CryptoSlate",
    tier: "A",
    category: "crypto",
    updateFrequency: "5-10min",
  },
  cryptopotato: {
    url: "https://cryptopotato.com/feed/",
    name: "CryptoPotato",
    tier: "B",
    category: "crypto",
    updateFrequency: "5-10min",
  },
  thedefiant: {
    url: "https://thedefiant.io/feed/",
    name: "The Defiant",
    tier: "A",
    category: "defi",
    updateFrequency: "10-30min",
  },
  cryptonews: {
    url: "https://cryptonews.com/news/feed/",
    name: "CryptoNews",
    tier: "B",
    category: "crypto",
    updateFrequency: "5-10min",
  },

  // Markets
  cnbc: {
    url: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    name: "CNBC Markets",
    tier: "S",
    category: "markets",
    updateFrequency: "2-5min",
  },

  // Tech
  hackernews: {
    url: "https://news.ycombinator.com/rss",
    name: "Hacker News",
    tier: "S",
    category: "tech",
    updateFrequency: "continuous",
  },
  techcrunch: {
    url: "https://techcrunch.com/feed/",
    name: "TechCrunch",
    tier: "A",
    category: "tech",
    updateFrequency: "5-15min",
  },
};

// Backwards-compatible URL-only export
export const RSS_FEEDS: Record<string, string> = Object.fromEntries(
  Object.entries(RSS_FEEDS_META).map(([k, v]) => [k, v.url])
);

// Keywords that frequently appear in these feeds
export const HOT_KEYWORDS = [
  // Crypto
  "bitcoin",
  "ethereum",
  "solana",
  "xrp",
  "defi",
  "nft",
  "stablecoin",
  "sec",
  "binance",
  "coinbase",

  // AI
  "deepseek",
  "openai",
  "anthropic",
  "chatgpt",
  "ai",
  "llm",

  // Markets
  "fed",
  "inflation",
  "nasdaq",
  "s&p",

  // Politics
  "trump",
  "musk",
  "china",
  "tariff",

  // Trending entities
  "mega",
  "megaeth",
  "polymarket",
];

export default RSS_FEEDS;
