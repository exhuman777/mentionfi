#!/usr/bin/env node
/**
 * MentionFi E2E Smoke Tests
 * Tests all live endpoints, deployments, contracts, and consistency.
 * Run: node test/e2e-smoke.mjs
 */

const ORACLE_API = 'https://oracle-production-aa8f.up.railway.app';
const FRONTEND_URL = 'https://mentionfi.vercel.app';
const RPC_URL = 'https://carrot.megaeth.com/rpc';
const QUEST_ADDRESS = '0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c';
const REP_ADDRESS = '0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b';
const ORACLE_WALLET = '0x3058ff5B62E67a27460904783aFd670fF70c6A4A';
const CHAIN_ID = 6343;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.log(`  \x1b[31m✗\x1b[0m ${name}: ${reason}`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function rpcCall(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

// ─── Oracle API Tests ───────────────────────────────────────

async function testOracleAPI() {
  console.log('\n\x1b[1m═══ ORACLE API ═══\x1b[0m');

  await test('GET /health — 200, healthy', async () => {
    const res = await fetch(`${ORACLE_API}/health`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.status === 'healthy', `Expected healthy, got ${json.status}`);
    assert(typeof json.uptime === 'string', 'Missing uptime');
    assert(typeof json.questsResolved === 'number', 'Missing questsResolved');
    assert(typeof json.pendingQuests === 'number', 'Missing pendingQuests');
  });

  await test('GET /api/v1/quests — 200, JSON-LD, array', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/quests`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json['@context'], 'Missing @context (JSON-LD)');
    assert(json.success === true, 'success should be true');
    assert(Array.isArray(json.data), 'data should be array');
    assert(json.meta?.source === 'mentionfi-oracle', 'Wrong source');
    assert(json.meta?.chainId === CHAIN_ID, `Wrong chainId: ${json.meta?.chainId}`);
    if (json.data.length > 0) {
      const q = json.data[0];
      assert(typeof q.id === 'number', 'Quest missing id');
      assert(typeof q.keywordHash === 'string', 'Quest missing keywordHash');
      assert(typeof q.status === 'string', 'Quest missing status');
      assert(q.stakes, 'Quest missing stakes');
      assert(q.odds, 'Quest missing odds');
    }
  });

  await test('GET /api/v1/quests?limit=5 — respects limit', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/quests?limit=5`);
    const json = await res.json();
    assert(json.success === true, 'success should be true');
    assert(json.data.length <= 5, `Expected <=5 quests, got ${json.data.length}`);
  });

  await test('GET /api/v1/feeds — 200, feed list', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/feeds`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.success === true, 'success should be true');
    assert(Array.isArray(json.data), 'data should be array');
    assert(json.data.length >= 10, `Expected >=10 feeds, got ${json.data.length}`);
    const feed = json.data[0];
    assert(feed.name || feed.url, 'Feed missing name/url');
    assert(feed.tier, 'Feed missing tier');
  });

  await test('GET /api/v1/stats — 200, protocol stats', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/stats`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.success === true, 'success should be true');
    assert(typeof json.data.totalQuests === 'number', 'Missing totalQuests');
    assert(typeof json.data.openQuests === 'number', 'Missing openQuests');
    assert(typeof json.data.totalFeeds === 'number', 'Missing totalFeeds');
    assert(typeof json.data.totalEthStaked === 'string', 'Missing totalEthStaked');
  });

  await test('GET /api/v1/keywords — 200, keyword map', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/keywords`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.success === true, 'success should be true');
    assert(typeof json.data === 'object', 'data should be object');
    const keywords = Object.values(json.data);
    assert(keywords.length >= 30, `Expected >=30 keywords, got ${keywords.length}`);
    assert(keywords.includes('bitcoin'), 'Missing bitcoin');
    assert(keywords.includes('ethereum'), 'Missing ethereum');
    assert(keywords.includes('megaeth'), 'Missing megaeth');
    // Verify all keys are valid hex hashes
    for (const hash of Object.keys(json.data)) {
      assert(hash.startsWith('0x') && hash.length === 66, `Invalid hash format: ${hash.slice(0, 20)}`);
    }
  });

  await test('GET /api/v1/agent/:address — 200, agent profile', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/agent/${ORACLE_WALLET}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.success === true, 'success should be true');
    assert(json.data.address === ORACLE_WALLET, 'Wrong address returned');
    assert(typeof json.data.registered === 'boolean', 'Missing registered field');
    assert(typeof json.data.repBalance === 'string', 'Missing repBalance');
  });

  await test('GET /api/v1/agent/invalid — 404', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/agent/invalid`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test('GET /nonexistent — 404 with helpful message', async () => {
    const res = await fetch(`${ORACLE_API}/nonexistent`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
    const json = await res.json();
    assert(json.success === false, 'success should be false');
    assert(json.error.includes('/api/v1/quests'), 'Missing helpful routes in error');
  });

  await test('CORS headers present', async () => {
    const res = await fetch(`${ORACLE_API}/health`);
    const cors = res.headers.get('access-control-allow-origin');
    assert(cors === '*', `Expected CORS *, got ${cors}`);
  });
}

// ─── Frontend Deployment Tests ──────────────────────────────

async function testFrontend() {
  console.log('\n\x1b[1m═══ FRONTEND DEPLOYMENT ═══\x1b[0m');

  await test('mentionfi.vercel.app — 200, HTML', async () => {
    const res = await fetch(FRONTEND_URL);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes('<!DOCTYPE html>') || text.includes('<html'), 'Not HTML');
    assert(text.includes('mentionfi') || text.includes('MentionFi') || text.includes('MENTIONFI'), 'Missing MentionFi reference');
  });

  await test('agent-card.json — 200, valid A2A', async () => {
    const res = await fetch(`${FRONTEND_URL}/.well-known/agent-card.json`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.name, 'Missing agent name');
    assert(json.provider?.url || json.url || json.endpoint, 'Missing agent url/endpoint');
  });

  await test('openclaw-skills.json — 200, valid JSON', async () => {
    const res = await fetch(`${FRONTEND_URL}/openclaw-skills.json`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(Array.isArray(json.skills) || typeof json === 'object', 'Invalid skills format');
  });

  await test('AGENTS.md — 200, markdown', async () => {
    const res = await fetch(`${FRONTEND_URL}/AGENTS.md`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes('MentionFi') || text.includes('#'), 'Not valid markdown');
  });

  await test('llms.txt — 200, text', async () => {
    const res = await fetch(`${FRONTEND_URL}/llms.txt`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.length > 50, 'llms.txt too short');
  });
}

// ─── Contract Read Tests (via RPC) ─────────────────────────

async function testContracts() {
  console.log('\n\x1b[1m═══ CONTRACT READS ═══\x1b[0m');

  await test('Chain ID is 6343 (MegaETH Testnet)', async () => {
    const chainId = await rpcCall('eth_chainId');
    const id = parseInt(chainId, 16);
    assert(id === CHAIN_ID, `Expected ${CHAIN_ID}, got ${id}`);
  });

  await test('MentionQuest.questCount() returns number > 0', async () => {
    // function selector for questCount(): 0x3970ab43 (keccak256("questCount()")[0:4])
    const result = await rpcCall('eth_call', [
      { to: QUEST_ADDRESS, data: '0x3970ab43' }, 'latest'
    ]);
    const count = parseInt(result, 16);
    assert(count > 0, `Expected questCount > 0, got ${count}`);
    assert(count < 100000, `questCount suspiciously high: ${count}`);
  });

  await test('MentionQuest contract has code', async () => {
    const code = await rpcCall('eth_getCode', [QUEST_ADDRESS, 'latest']);
    assert(code && code !== '0x' && code.length > 10, 'No contract code at QUEST_ADDRESS');
  });

  await test('ReputationToken contract has code', async () => {
    const code = await rpcCall('eth_getCode', [REP_ADDRESS, 'latest']);
    assert(code && code !== '0x' && code.length > 10, 'No contract code at REP_ADDRESS');
  });

  await test('Oracle wallet has ETH balance', async () => {
    const balance = await rpcCall('eth_getBalance', [ORACLE_WALLET, 'latest']);
    const wei = BigInt(balance);
    assert(wei > 0n, 'Oracle wallet has 0 balance — needs gas');
  });
}

// ─── Consistency Tests ──────────────────────────────────────

async function testConsistency() {
  console.log('\n\x1b[1m═══ CONSISTENCY ═══\x1b[0m');

  // Known keywords that must exist in both frontend and oracle
  const MUST_HAVE = [
    'bitcoin', 'ethereum', 'solana', 'xrp', 'defi', 'nft',
    'deepseek', 'openai', 'anthropic', 'ai',
    'trump', 'musk', 'megaeth',
  ];

  await test('Oracle keywords include all critical keywords', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/keywords`);
    const json = await res.json();
    const oracleKws = Object.values(json.data);
    for (const kw of MUST_HAVE) {
      assert(oracleKws.includes(kw), `Oracle missing keyword: ${kw}`);
    }
  });

  await test('Oracle feeds match expected count (10+)', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/feeds`);
    const json = await res.json();
    assert(json.data.length >= 10, `Expected >=10 feeds, got ${json.data.length}`);
    // Check tier values are valid
    for (const feed of json.data) {
      assert(['S', 'A', 'B', 'C'].includes(feed.tier), `Invalid tier: ${feed.tier}`);
    }
  });

  await test('Quest data has valid structure', async () => {
    const res = await fetch(`${ORACLE_API}/api/v1/quests`);
    const json = await res.json();
    for (const q of json.data) {
      assert(['open', 'closed', 'resolved', 'cancelled'].includes(q.status), `Invalid status: ${q.status}`);
      assert(['none', 'yes', 'no'].includes(q.outcome), `Invalid outcome: ${q.outcome}`);
      assert(q.windowStart < q.windowEnd, `Invalid window: ${q.windowStart} >= ${q.windowEnd}`);
      assert(q.odds.yes >= 0 && q.odds.yes <= 100, `Invalid YES odds: ${q.odds.yes}`);
      assert(q.odds.no >= 0 && q.odds.no <= 100, `Invalid NO odds: ${q.odds.no}`);
    }
  });

  await test('Oracle stats are internally consistent', async () => {
    const statsRes = await fetch(`${ORACLE_API}/api/v1/stats`);
    const stats = (await statsRes.json()).data;
    const questsRes = await fetch(`${ORACLE_API}/api/v1/quests?limit=100`);
    const quests = (await questsRes.json()).data;
    assert(stats.totalQuests === quests.length, `Stats totalQuests (${stats.totalQuests}) != quest list length (${quests.length})`);
    const openFromList = quests.filter(q => q.status === 'open').length;
    assert(stats.openQuests === openFromList, `Stats openQuests (${stats.openQuests}) != filtered count (${openFromList})`);
  });
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║     MENTIONFI E2E SMOKE TESTS            ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');

  const start = Date.now();

  await testOracleAPI();
  await testFrontend();
  await testContracts();
  await testConsistency();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n\x1b[1m═══ RESULTS ═══\x1b[0m`);
  console.log(`  Passed: \x1b[32m${passed}\x1b[0m`);
  console.log(`  Failed: \x1b[${failed > 0 ? '31' : '32'}m${failed}\x1b[0m`);
  console.log(`  Time:   ${elapsed}s`);

  if (failures.length > 0) {
    console.log(`\n\x1b[31m═══ FAILURES ═══\x1b[0m`);
    for (const f of failures) {
      console.log(`  \x1b[31m✗\x1b[0m ${f.name}`);
      console.log(`    ${f.reason}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
