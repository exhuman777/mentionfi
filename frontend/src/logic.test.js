import { describe, it, expect } from 'vitest';
import {
  KNOWN_KEYWORDS,
  RSS_FEEDS,
  buildKeywordHashMap,
  seededRandom,
  getBingoRound,
  fmtCountdown,
  calculatePayout,
  calculateROI,
  fmtAddr,
  fmtFeed,
  fmtEth,
} from './logic.js';
import { ethers } from 'ethers';

// ─── KNOWN_KEYWORDS ─────────────────────────────────────────

describe('KNOWN_KEYWORDS', () => {
  it('has at least 40 keywords', () => {
    expect(KNOWN_KEYWORDS.length).toBeGreaterThanOrEqual(40);
  });

  it('contains critical crypto keywords', () => {
    for (const kw of ['bitcoin', 'ethereum', 'solana', 'defi', 'nft']) {
      expect(KNOWN_KEYWORDS).toContain(kw);
    }
  });

  it('contains AI keywords', () => {
    for (const kw of ['openai', 'anthropic', 'ai', 'deepseek']) {
      expect(KNOWN_KEYWORDS).toContain(kw);
    }
  });

  it('contains MegaETH keywords', () => {
    expect(KNOWN_KEYWORDS).toContain('megaeth');
    expect(KNOWN_KEYWORDS).toContain('mega');
  });

  it('has no duplicates', () => {
    const unique = new Set(KNOWN_KEYWORDS);
    expect(unique.size).toBe(KNOWN_KEYWORDS.length);
  });

  it('all keywords are lowercase', () => {
    for (const kw of KNOWN_KEYWORDS) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });
});

// ─── RSS_FEEDS ──────────────────────────────────────────────

describe('RSS_FEEDS', () => {
  it('has at least 8 feeds', () => {
    expect(RSS_FEEDS.length).toBeGreaterThanOrEqual(8);
  });

  it('all feeds have name, url, tier', () => {
    for (const feed of RSS_FEEDS) {
      expect(feed.name).toBeTruthy();
      expect(feed.url).toMatch(/^https?:\/\//);
      expect(['S', 'A', 'B', 'C']).toContain(feed.tier);
    }
  });

  it('has at least 2 S-tier feeds', () => {
    const sTier = RSS_FEEDS.filter(f => f.tier === 'S');
    expect(sTier.length).toBeGreaterThanOrEqual(2);
  });

  it('has no duplicate URLs', () => {
    const urls = RSS_FEEDS.map(f => f.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

// ─── buildKeywordHashMap ────────────────────────────────────

describe('buildKeywordHashMap', () => {
  const map = buildKeywordHashMap();

  it('maps all known keywords', () => {
    expect(Object.keys(map).length).toBe(KNOWN_KEYWORDS.length);
  });

  it('all keys are valid keccak256 hashes (0x + 64 hex)', () => {
    for (const hash of Object.keys(map)) {
      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    }
  });

  it('all values are known keywords', () => {
    for (const kw of Object.values(map)) {
      expect(KNOWN_KEYWORDS).toContain(kw);
    }
  });

  it('hash→keyword→hash roundtrips correctly', () => {
    for (const [hash, kw] of Object.entries(map)) {
      const reHash = ethers.keccak256(ethers.toUtf8Bytes(kw));
      expect(reHash).toBe(hash);
    }
  });

  it('different keywords produce different hashes', () => {
    const hashes = Object.keys(map);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

// ─── seededRandom ───────────────────────────────────────────

describe('seededRandom', () => {
  it('returns number between 0 and 1', () => {
    for (let i = 0; i < 100; i++) {
      const r = seededRandom(i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('is deterministic (same seed = same output)', () => {
    expect(seededRandom(42)).toBe(seededRandom(42));
    expect(seededRandom(0)).toBe(seededRandom(0));
    expect(seededRandom(999999)).toBe(seededRandom(999999));
  });

  it('different seeds produce different outputs', () => {
    const results = new Set();
    for (let i = 0; i < 50; i++) {
      results.add(seededRandom(i));
    }
    // At least 45 unique values out of 50 (allows for rare collisions)
    expect(results.size).toBeGreaterThanOrEqual(45);
  });

  it('handles negative seeds', () => {
    const r = seededRandom(-1);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it('handles very large seeds', () => {
    const r = seededRandom(2147483647);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
});

// ─── getBingoRound ──────────────────────────────────────────

describe('getBingoRound', () => {
  const now = 1739000000; // some fixed timestamp
  const round = getBingoRound(now);

  it('returns 6 main keywords', () => {
    expect(round.main).toHaveLength(6);
  });

  it('returns 3 quick keywords', () => {
    expect(round.quick).toHaveLength(3);
  });

  it('main keywords have keyword, feed, hash', () => {
    for (const item of round.main) {
      expect(item.keyword).toBeTruthy();
      expect(item.feed).toBeTruthy();
      expect(item.feed.name).toBeTruthy();
      expect(item.hash).toMatch(/^0x[a-f0-9]{64}$/);
    }
  });

  it('quick keywords have keyword, feed, hash', () => {
    for (const item of round.quick) {
      expect(item.keyword).toBeTruthy();
      expect(item.feed).toBeTruthy();
      expect(item.hash).toMatch(/^0x[a-f0-9]{64}$/);
    }
  });

  it('all keywords are from KNOWN_KEYWORDS', () => {
    const allKws = [...round.main, ...round.quick].map(i => i.keyword);
    for (const kw of allKws) {
      expect(KNOWN_KEYWORDS).toContain(kw);
    }
  });

  it('no duplicate keywords in same round', () => {
    const allKws = [...round.main, ...round.quick].map(i => i.keyword);
    expect(new Set(allKws).size).toBe(allKws.length);
  });

  it('is deterministic (same time = same round)', () => {
    const r1 = getBingoRound(now);
    const r2 = getBingoRound(now);
    expect(r1.main.map(i => i.keyword)).toEqual(r2.main.map(i => i.keyword));
    expect(r1.quick.map(i => i.keyword)).toEqual(r2.quick.map(i => i.keyword));
  });

  it('same slot = same round (within 30 min window)', () => {
    const r1 = getBingoRound(now);
    const r2 = getBingoRound(now + 100); // 100 seconds later, same slot
    expect(r1.main.map(i => i.keyword)).toEqual(r2.main.map(i => i.keyword));
  });

  it('different slots produce different rounds', () => {
    const r1 = getBingoRound(now);
    const r2 = getBingoRound(now + 1800); // next 30-min slot
    const kws1 = r1.main.map(i => i.keyword).join(',');
    const kws2 = r2.main.map(i => i.keyword).join(',');
    expect(kws1).not.toBe(kws2);
  });

  it('countdown is between 0 and 1800', () => {
    expect(round.remaining).toBeGreaterThanOrEqual(0);
    expect(round.remaining).toBeLessThanOrEqual(1800);
  });

  it('roundEnd - roundStart = 1800', () => {
    expect(round.roundEnd - round.roundStart).toBe(1800);
  });

  it('feeds are not C-tier', () => {
    for (const item of [...round.main, ...round.quick]) {
      expect(item.feed.tier).not.toBe('C');
    }
  });
});

// ─── fmtCountdown ───────────────────────────────────────────

describe('fmtCountdown', () => {
  it('formats 0 as "0:00"', () => {
    expect(fmtCountdown(0)).toBe('0:00');
  });

  it('formats 90 as "1:30"', () => {
    expect(fmtCountdown(90)).toBe('1:30');
  });

  it('formats 600 as "10:00"', () => {
    expect(fmtCountdown(600)).toBe('10:00');
  });

  it('formats 1800 as "30:00"', () => {
    expect(fmtCountdown(1800)).toBe('30:00');
  });

  it('pads single-digit seconds', () => {
    expect(fmtCountdown(61)).toBe('1:01');
    expect(fmtCountdown(5)).toBe('0:05');
  });
});

// ─── calculatePayout ────────────────────────────────────────

describe('calculatePayout', () => {
  it('returns stake when pools are empty', () => {
    expect(calculatePayout(0.01, 0, 0)).toBe(0.01);
  });

  it('returns stake when opposite pool is 0', () => {
    expect(calculatePayout(0.01, 0.01, 0)).toBe(0.01);
  });

  it('calculates correctly for equal pools', () => {
    // myStake=0.1, myPool=0.1, oppPool=0.1
    // (0.1 * 0.9 * (0.1/0.1)) + 0.1 = 0.09 + 0.1 = 0.19
    const payout = calculatePayout(0.1, 0.1, 0.1);
    expect(payout).toBeCloseTo(0.19, 4);
  });

  it('higher payout when opposite pool is larger', () => {
    // myStake=0.1, myPool=0.1, oppPool=0.5
    // (0.5 * 0.9 * (0.1/0.1)) + 0.1 = 0.45 + 0.1 = 0.55
    const payout = calculatePayout(0.1, 0.1, 0.5);
    expect(payout).toBeCloseTo(0.55, 4);
  });

  it('lower payout when many on same side', () => {
    // myStake=0.1, myPool=0.5, oppPool=0.1
    // (0.1 * 0.9 * (0.1/0.5)) + 0.1 = 0.018 + 0.1 = 0.118
    const payout = calculatePayout(0.1, 0.5, 0.1);
    expect(payout).toBeCloseTo(0.118, 4);
  });

  it('matches the Alice example from How to Play', () => {
    // Alice: 0.10 on YES, total YES pool 0.30, NO pool 0.80
    // (0.80 * 0.9 * (0.10/0.30)) + 0.10 = 0.24 + 0.10 = 0.34
    const payout = calculatePayout(0.10, 0.30, 0.80);
    expect(payout).toBeCloseTo(0.34, 4);
  });

  it('matches the Bob example from How to Play', () => {
    // Bob: 0.20 on YES, total YES pool 0.30, NO pool 0.80
    // (0.80 * 0.9 * (0.20/0.30)) + 0.20 = 0.48 + 0.20 = 0.68
    const payout = calculatePayout(0.20, 0.30, 0.80);
    expect(payout).toBeCloseTo(0.68, 4);
  });

  it('5% protocol fee is accounted for (0.9 multiplier)', () => {
    // With 1.0 ETH opposite pool: winner gets 0.9 * 1.0 = 0.9 (not 1.0)
    const payout = calculatePayout(0.5, 0.5, 1.0);
    // (1.0 * 0.9 * (0.5/0.5)) + 0.5 = 0.9 + 0.5 = 1.4
    expect(payout).toBeCloseTo(1.4, 4);
  });
});

// ─── calculateROI ───────────────────────────────────────────

describe('calculateROI', () => {
  it('returns 0 for zero stake', () => {
    expect(calculateROI(0, 0)).toBe(0);
  });

  it('returns 0% when payout equals stake', () => {
    expect(calculateROI(0.1, 0.1)).toBeCloseTo(0, 4);
  });

  it('returns 240% for the Alice example', () => {
    // Alice staked 0.10, gets 0.34 back
    expect(calculateROI(0.10, 0.34)).toBeCloseTo(240, 0);
  });

  it('returns 240% for the Bob example', () => {
    // Bob staked 0.20, gets 0.68 back
    expect(calculateROI(0.20, 0.68)).toBeCloseTo(240, 0);
  });

  it('returns 90% for equal pool all-in', () => {
    // stake=0.1, payout=0.19 → ROI = 90%
    expect(calculateROI(0.1, 0.19)).toBeCloseTo(90, 0);
  });
});

// ─── fmtAddr ────────────────────────────────────────────────

describe('fmtAddr', () => {
  it('formats normal address', () => {
    expect(fmtAddr('0x3058ff5B62E67a27460904783aFd670fF70c6A4A')).toBe('0x3058...6A4A');
  });

  it('returns None for null', () => {
    expect(fmtAddr(null)).toBe('None');
  });

  it('returns None for undefined', () => {
    expect(fmtAddr(undefined)).toBe('None');
  });

  it('returns None for zero address', () => {
    expect(fmtAddr('0x0000000000000000000000000000000000000000')).toBe('None');
  });
});

// ─── fmtFeed ────────────────────────────────────────────────

describe('fmtFeed', () => {
  it('returns name for known feed', () => {
    expect(fmtFeed('https://cointelegraph.com/rss')).toBe('Cointelegraph');
    expect(fmtFeed('https://cryptoslate.com/feed/')).toBe('CryptoSlate');
  });

  it('extracts domain for unknown feed', () => {
    expect(fmtFeed('https://example.com/feed')).toBe('example.com');
  });

  it('strips www from unknown feeds', () => {
    expect(fmtFeed('https://www.example.com/feed')).toBe('example.com');
  });
});

// ─── fmtEth ────────────────────────────────────────────────

describe('fmtEth', () => {
  it('formats zero as "0 ETH"', () => {
    expect(fmtEth(0)).toBe('0 ETH');
  });

  it('formats sub-cent values with cent symbol', () => {
    expect(fmtEth(0.005)).toBe('0.5¢');
  });

  it('formats 0.1 as "10¢"', () => {
    expect(fmtEth(0.1)).toBe('10¢');
  });

  it('formats values >= 1 with ETH suffix', () => {
    expect(fmtEth(1.5)).toBe('1.500 ETH');
  });

  it('handles string input', () => {
    expect(fmtEth('0.005')).toBe('0.5¢');
  });

  it('handles NaN as "0 ETH"', () => {
    expect(fmtEth(NaN)).toBe('0 ETH');
  });

  it('handles undefined as "0 ETH"', () => {
    expect(fmtEth(undefined)).toBe('0 ETH');
  });

  it('formats 0.001 correctly', () => {
    expect(fmtEth(0.001)).toBe('0.1¢');
  });

  it('formats 0.01 as "1¢"', () => {
    expect(fmtEth(0.01)).toBe('1¢');
  });

  it('formats 0.99 as "99¢"', () => {
    expect(fmtEth(0.99)).toBe('99¢');
  });
});
