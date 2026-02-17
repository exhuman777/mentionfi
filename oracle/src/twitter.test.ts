// Tests for twitter.ts — uses Node built-in test runner + mocked fetch
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  fetchElonTweets,
  checkWordInTweets,
  clearCache,
  type Tweet,
} from "./twitter.js";

// Store original fetch so we can restore it
const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>
) {
  globalThis.fetch = handler as typeof fetch;
}

function makeResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  });
}

const MOCK_TWEETS = {
  data: [
    {
      id: "1001",
      text: "Dogecoin to the moon! 🚀",
      created_at: new Date().toISOString(),
    },
    {
      id: "1002",
      text: "Tesla production update coming soon",
      created_at: new Date().toISOString(),
    },
    {
      id: "1003",
      text: "Free speech is essential for democracy",
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    },
  ],
  meta: { result_count: 3, newest_id: "1001", oldest_id: "1003" },
};

describe("twitter module", () => {
  beforeEach(() => {
    clearCache();
    process.env.X_BEARER_TOKEN = "test-bearer-token-123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.X_BEARER_TOKEN;
  });

  describe("fetchElonTweets", () => {
    it("fetches tweets and returns them", async () => {
      mockFetch(async (url) => {
        assert.ok(url.includes("/2/users/44196397/tweets"));
        assert.ok(url.includes("tweet.fields=created_at"));
        assert.ok(url.includes("max_results=100"));
        return makeResponse(MOCK_TWEETS);
      });

      const tweets = await fetchElonTweets();
      assert.equal(tweets.length, 3);
      assert.equal(tweets[0].id, "1001");
      assert.equal(tweets[0].text, "Dogecoin to the moon! 🚀");
    });

    it("passes Authorization header with bearer token", async () => {
      mockFetch(async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer test-bearer-token-123");
        return makeResponse(MOCK_TWEETS);
      });

      await fetchElonTweets();
    });

    it("filters by since date", async () => {
      const oneHourAgo = new Date(Date.now() - 3600_000);
      mockFetch(async (url) => {
        assert.ok(url.includes("start_time="));
        return makeResponse(MOCK_TWEETS);
      });

      // Two tweets are "now", one is 1h ago — since = 30 min ago should return 2
      const since = new Date(Date.now() - 30 * 60_000);
      const tweets = await fetchElonTweets(since);
      assert.equal(tweets.length, 2);
    });

    it("throws on missing bearer token", async () => {
      delete process.env.X_BEARER_TOKEN;
      await assert.rejects(fetchElonTweets, /X_BEARER_TOKEN/);
    });

    it("throws on rate limit (429)", async () => {
      mockFetch(async () =>
        makeResponse({}, 429, { "x-rate-limit-reset": "1700000000" })
      );
      await assert.rejects(fetchElonTweets, /rate limited/);
    });

    it("throws on auth failure (401)", async () => {
      mockFetch(async () => makeResponse({}, 401));
      await assert.rejects(fetchElonTweets, /auth failed/);
    });

    it("throws on auth failure (403)", async () => {
      mockFetch(async () => makeResponse({}, 403));
      await assert.rejects(fetchElonTweets, /auth failed/);
    });

    it("handles empty response (no tweets)", async () => {
      mockFetch(async () =>
        makeResponse({ data: [], meta: { result_count: 0 } })
      );
      const tweets = await fetchElonTweets();
      assert.equal(tweets.length, 0);
    });

    it("handles API-level errors in body", async () => {
      mockFetch(async () =>
        makeResponse({
          errors: [{ message: "User not found", type: "not_found" }],
        })
      );
      await assert.rejects(fetchElonTweets, /User not found/);
    });

    it("uses cache on rapid successive calls", async () => {
      let fetchCount = 0;
      mockFetch(async () => {
        fetchCount++;
        return makeResponse(MOCK_TWEETS);
      });

      await fetchElonTweets();
      await fetchElonTweets();
      assert.equal(fetchCount, 1, "should only fetch once due to cache");
    });
  });

  describe("checkWordInTweets", () => {
    beforeEach(() => {
      mockFetch(async () => makeResponse(MOCK_TWEETS));
    });

    it("finds word in tweet text (case insensitive)", async () => {
      const result = await checkWordInTweets(
        "dogecoin",
        new Date(Date.now() - 86400_000)
      );
      assert.equal(result.found, true);
      assert.ok(result.tweet);
      assert.equal(result.tweet.id, "1001");
    });

    it("returns found=false when word not present", async () => {
      const result = await checkWordInTweets(
        "ethereum",
        new Date(Date.now() - 86400_000)
      );
      assert.equal(result.found, false);
      assert.equal(result.tweet, undefined);
    });

    it("matches partial words (same as RSS oracle)", async () => {
      // "production" contains "product"
      const result = await checkWordInTweets(
        "production",
        new Date(Date.now() - 86400_000)
      );
      assert.equal(result.found, true);
      assert.equal(result.tweet!.id, "1002");
    });

    it("trims and lowercases the search word", async () => {
      const result = await checkWordInTweets(
        "  DOGECOIN  ",
        new Date(Date.now() - 86400_000)
      );
      assert.equal(result.found, true);
    });
  });
});
