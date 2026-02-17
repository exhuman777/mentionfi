// Twitter/X polling module for MentionFi oracle
// Standalone — zero dependencies on other oracle modules
// Uses X API v2 with native fetch (Node 20+)

export interface Tweet {
  id: string;
  text: string;
  created_at: string;
}

interface XApiResponse {
  data?: Array<{
    id: string;
    text: string;
    created_at: string;
  }>;
  meta?: {
    result_count: number;
    newest_id?: string;
    oldest_id?: string;
  };
  errors?: Array<{ message: string; type: string }>;
}

// Elon Musk's X user ID
const ELON_USER_ID = "44196397";

// Cache: tweets keyed by hour-bucket to dedup within 1-hour windows
// Key format: "YYYY-MM-DDTHH" → Tweet[]
const tweetCache = new Map<string, Tweet[]>();
let lastFetchTime = 0;
const MIN_FETCH_INTERVAL_MS = 5_000; // Don't hit API more than once per 5s

function getHourBucket(date: Date): string {
  return date.toISOString().slice(0, 13); // "2026-02-17T14"
}

function getBearerToken(): string {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    throw new Error("X_BEARER_TOKEN env var is required");
  }
  return token;
}

/**
 * Fetch recent tweets from @elonmusk via X API v2.
 * Returns up to 100 tweets, optionally filtered by `since` date.
 * Caches results by hour-bucket to minimize API calls.
 */
export async function fetchElonTweets(since?: Date): Promise<Tweet[]> {
  const now = Date.now();
  const currentBucket = getHourBucket(new Date());

  // Return cached tweets if we fetched recently and have data for this hour
  if (
    now - lastFetchTime < MIN_FETCH_INTERVAL_MS &&
    tweetCache.has(currentBucket)
  ) {
    const cached = tweetCache.get(currentBucket)!;
    if (since) {
      const sinceMs = since.getTime();
      return cached.filter((t) => new Date(t.created_at).getTime() >= sinceMs);
    }
    return cached;
  }

  const token = getBearerToken();

  // Build URL with query params
  const params = new URLSearchParams({
    "tweet.fields": "created_at",
    max_results: "100",
  });

  if (since) {
    // X API v2 wants ISO 8601 with seconds precision, no ms
    params.set("start_time", since.toISOString().replace(/\.\d{3}Z$/, "Z"));
  }

  const url = `https://api.x.com/2/users/${ELON_USER_ID}/tweets?${params}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  // Handle rate limits
  if (response.status === 429) {
    const resetHeader = response.headers.get("x-rate-limit-reset");
    const resetAt = resetHeader
      ? new Date(parseInt(resetHeader) * 1000).toISOString()
      : "unknown";
    throw new Error(`X API rate limited. Resets at: ${resetAt}`);
  }

  // Handle auth failures
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `X API auth failed (${response.status}): check X_BEARER_TOKEN`
    );
  }

  // Handle other HTTP errors
  if (!response.ok) {
    throw new Error(`X API error: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as XApiResponse;

  // Handle API-level errors
  if (body.errors && body.errors.length > 0 && !body.data) {
    throw new Error(`X API error: ${body.errors[0].message}`);
  }

  const tweets: Tweet[] = (body.data || []).map((t) => ({
    id: t.id,
    text: t.text,
    created_at: t.created_at,
  }));

  // Cache by hour bucket
  lastFetchTime = now;
  const bucket = getHourBucket(new Date());
  const existing = tweetCache.get(bucket) || [];
  const existingIds = new Set(existing.map((t) => t.id));
  const merged = [
    ...existing,
    ...tweets.filter((t) => !existingIds.has(t.id)),
  ];
  tweetCache.set(bucket, merged);

  // Prune old buckets (keep last 2 hours)
  const twoBucketsAgo = getHourBucket(
    new Date(Date.now() - 2 * 60 * 60 * 1000)
  );
  for (const key of tweetCache.keys()) {
    if (key < twoBucketsAgo) {
      tweetCache.delete(key);
    }
  }

  if (since) {
    const sinceMs = since.getTime();
    return tweets.filter((t) => new Date(t.created_at).getTime() >= sinceMs);
  }

  return tweets;
}

/**
 * Check if a word appears in @elonmusk's tweets since a given date.
 * Returns the first matching tweet if found.
 * Case-insensitive, whole-text search (same as RSS oracle).
 */
export async function checkWordInTweets(
  word: string,
  since: Date
): Promise<{ found: boolean; tweet?: Tweet }> {
  const tweets = await fetchElonTweets(since);
  const target = word.toLowerCase().trim();

  for (const tweet of tweets) {
    if (tweet.text.toLowerCase().includes(target)) {
      return { found: true, tweet };
    }
  }

  return { found: false };
}

/**
 * Clear the tweet cache. Useful for testing.
 */
export function clearCache(): void {
  tweetCache.clear();
  lastFetchTime = 0;
}
