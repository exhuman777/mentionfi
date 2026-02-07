// High-frequency RSS feeds for MentionFi testing
// These update every 2-5 minutes

export const RSS_FEEDS = {
  // General news
  yahooNews: "https://news.yahoo.com/rss/",

  // Crypto news (high frequency)
  coindesk: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
  cointelegraph: "https://cointelegraph.com/rss",
  cryptoslate: "https://cryptoslate.com/feed/",
  cryptopotato: "https://cryptopotato.com/feed/",
  thedefiant: "https://thedefiant.io/feed/",
  cryptonews: "https://cryptonews.com/news/feed/",

  // Markets
  cnbc: "https://www.cnbc.com/id/10000664/device/rss/rss.html",

  // Tech
  hackernews: "https://news.ycombinator.com/rss",
  techcrunch: "https://techcrunch.com/feed/",
};

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
