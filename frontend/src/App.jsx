import React, { useEffect, useState, useCallback } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { privyConfig, megaethTestnet } from './privy-config';
import { ethers } from 'ethers';
import RogueASCIIBg from './RogueASCIIBg';

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
];

const QuestStatus = ['Open', 'Closed', 'Resolved', 'Cancelled'];
const Position = ['None', 'Yes', 'No'];

// Expanded feed list from feeds audit
const RSS_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml', tier: 'A' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', tier: 'S' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', tier: 'A' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml', tier: 'A' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', tier: 'A' },
  { name: 'Blockworks', url: 'https://blockworks.co/feed/', tier: 'B' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', tier: 'B' },
  { name: 'Hacker News', url: 'https://hnrss.org/newest?q=bitcoin+OR+ethereum+OR+crypto&points=5', tier: 'S' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', tier: 'A' },
  { name: 'The Defiant', url: 'https://thedefiant.substack.com/feed', tier: 'B' },
  { name: 'Yahoo News', url: 'https://news.yahoo.com/rss/', tier: 'C' },
  { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', tier: 'B' },
];

const DURATION_PRESETS = [
  { label: '10 min', value: 600 },
  { label: '30 min', value: 1800 },
  { label: '1 hour', value: 3600 },
];

const STAKE_PRESETS = ['0.001', '0.01', '0.05', '0.1'];

// Known keywords — compute hashes client-side for display (no oracle dependency)
const KNOWN_KEYWORDS = [
  'bitcoin', 'ethereum', 'solana', 'xrp', 'defi', 'nft', 'stablecoin', 'binance', 'coinbase', 'sec', 'etf',
  'deepseek', 'openai', 'anthropic', 'chatgpt', 'claude', 'ai', 'llm', 'gpt',
  'fed', 'inflation', 'nasdaq', 'recession', 'tariff',
  'trump', 'musk', 'china', 'russia', 'ukraine',
  'apple', 'google', 'microsoft', 'meta', 'nvidia', 'megaeth', 'mega',
  'war', 'hack', 'exploit', 'regulation', 'bull', 'bear', 'crash', 'pump', 'dump',
  'tesla', 'amazon', 'tiktok', 'spacex', 'blackrock', 'vitalik', 'saylor',
];

// Build hash→keyword lookup at module load (pure client-side, no API needed)
const KEYWORD_HASH_MAP = {};
for (const kw of KNOWN_KEYWORDS) {
  KEYWORD_HASH_MAP[ethers.keccak256(ethers.toUtf8Bytes(kw))] = kw;
}

// Colors from UX research
const C = {
  bg: '#0A0A0F',
  surface: '#12121A',
  surfaceHover: '#1A1A2E',
  border: '#2A2A3E',
  yes: '#00FF88',
  no: '#FF3366',
  info: '#00BBFF',
  warn: '#FFB800',
  text1: '#E8E8F0',
  text2: '#8888AA',
  text3: '#44445A',
};

function MentionFiDashboard() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [quests, setQuests] = useState([]);
  const [userRep, setUserRep] = useState(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('dashboard');
  const [newQuest, setNewQuest] = useState({ keyword: '', sourceUrl: RSS_FEEDS[0].url, duration: 3600 });
  const [stakeAmount, setStakeAmount] = useState('0.001');
  const [oracleBalance, setOracleBalance] = useState(null);
  const [userPositions, setUserPositions] = useState({});
  const [keywordMap, setKeywordMap] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mentionfi_keywords') || '{}');
      return { ...KEYWORD_HASH_MAP, ...stored };
    } catch { return { ...KEYWORD_HASH_MAP }; }
  });

  const activeWallet = wallets?.[0];

  const fetchData = useCallback(async () => {
    try {
      // Supplement keyword map from oracle (catches custom keywords from other users)
      try {
        const kwRes = await fetch(`${ORACLE_API}/api/v1/keywords`);
        if (kwRes.ok) {
          const kwJson = await kwRes.json();
          if (kwJson.success && kwJson.data) {
            setKeywordMap(prev => {
              const merged = { ...prev, ...kwJson.data };
              localStorage.setItem('mentionfi_keywords', JSON.stringify(merged));
              return merged;
            });
          }
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
              positions[q.id] = { position: Number(claim.position), repStake: ethers.formatEther(claim.repStake), ethStake: ethers.formatEther(claim.ethStake) };
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

  const getSigner = async () => {
    await activeWallet.switchChain(megaethTestnet.id);
    const eip1193 = await activeWallet.getEthereumProvider();
    const provider = new ethers.BrowserProvider(eip1193);
    return provider.getSigner();
  };

  const handleRegister = async () => {
    if (!activeWallet) return;
    setLoading(true); setError(null);
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const repContract = new ethers.Contract(REP_TOKEN_ADDRESS, REP_TOKEN_ABI, provider);
      const alreadyReg = await repContract.isRegistered(activeWallet.address);
      if (alreadyReg) { setIsRegistered(true); fetchData(); setLoading(false); return; }
      const signer = await getSigner();
      const tx = await new ethers.Contract(REP_TOKEN_ADDRESS, REP_TOKEN_ABI, signer).register();
      await tx.wait();
      setIsRegistered(true);
      fetchData();
    } catch (e) {
      if (e.message?.includes('AlreadyRegistered') || e.message?.includes('revert')) {
        setIsRegistered(true); fetchData();
      } else { setError('Registration failed: ' + (e.shortMessage || e.message?.slice(0, 100))); }
    }
    finally { setLoading(false); }
  };

  const handleCreateQuest = async () => {
    if (!activeWallet || !newQuest.keyword) return;
    setLoading(true); setError(null);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const now = Math.floor(Date.now() / 1000);
      const tx = await contract.createQuest(newQuest.keyword, newQuest.sourceUrl, now + 10, now + newQuest.duration);
      await tx.wait();
      // Store keyword hash mapping for display (works even if oracle is down)
      const hash = ethers.keccak256(ethers.toUtf8Bytes(newQuest.keyword));
      const updated = { ...keywordMap, [hash]: newQuest.keyword.toLowerCase() };
      setKeywordMap(updated);
      localStorage.setItem('mentionfi_keywords', JSON.stringify(updated));
      setNewQuest({ keyword: '', sourceUrl: RSS_FEEDS[0].url, duration: 3600 });
      setView('dashboard');
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleBet = async (questId, position) => {
    if (!activeWallet) return;
    if (userPositions[questId]) { setError('You already have a position on this quest. One bet per quest.'); return; }
    setLoading(true); setError(null);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const repStake = ethers.parseEther('10');
      const ethStake = ethers.parseEther(stakeAmount);
      const tx = await contract.submitClaim(questId, position, repStake, 70, { value: ethStake });
      await tx.wait();
      fetchData();
    } catch (e) {
      if (e.message?.includes('AlreadyClaimed')) setError('You already bet on this quest. One position per quest — no hedging.');
      else if (e.message?.includes('insufficient')) setError('Not enough ETH or REP for this bet.');
      else setError('Bet failed: ' + (e.shortMessage || e.message?.slice(0, 120)));
    }
    finally { setLoading(false); }
  };

  const handleClaim = async (questId) => {
    if (!activeWallet) return;
    setLoading(true); setError(null);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      // Check quest status first
      const q = await contract.quests(questId);
      if (Number(q.status) !== 2) { setError('Quest not resolved yet. The oracle resolves quests automatically — wait for the time window to end.'); setLoading(false); return; }
      const claim = await contract.claims(questId, activeWallet.address);
      if (Number(claim.position) === 0) { setError('You have no position on this quest.'); setLoading(false); return; }
      if (claim.claimed) { setError('Already claimed rewards for this quest.'); setLoading(false); return; }
      const tx = await contract.claimReward(questId);
      await tx.wait();
      fetchData();
    } catch (e) {
      if (e.message?.includes('NoClaim')) setError('No position to claim on this quest.');
      else if (e.message?.includes('QuestNotResolved')) setError('Quest not resolved yet — wait for the oracle.');
      else if (e.message?.includes('AlreadyClaimed')) setError('Already claimed.');
      else setError('Claim failed: ' + (e.shortMessage || e.message?.slice(0, 120)));
    }
    finally { setLoading(false); }
  };

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

  if (!ready) return <div style={{ color: C.text3, fontFamily: "'JetBrains Mono', monospace", padding: '50px', background: C.bg, minHeight: '100vh' }}>Loading...</div>;

  // Landing page (not authenticated)
  if (!authenticated) {
    return (
      <div style={st.container}>
        <RogueASCIIBg />
        <div style={st.content}>
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            <h1 style={{ color: C.text1, fontSize: '42px', fontWeight: '700', margin: 0, letterSpacing: '-2px' }}>MENTIONFI</h1>
            <div style={{ color: C.yes, fontSize: '13px', letterSpacing: '3px', marginTop: '4px', fontWeight: '600' }}>MENTION MARKETS</div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '10px' }}>
              <span style={st.badge}>MegaETH</span>
              <span style={{ ...st.badge, borderColor: C.yes, color: C.yes }}>LIVE</span>
              <span style={{ ...st.badge, borderColor: C.warn, color: C.warn }}>10-60 MIN</span>
            </div>
            <p style={{ color: C.text2, marginTop: '16px', fontSize: '14px', maxWidth: '480px', margin: '16px auto 0', lineHeight: '1.6' }}>
              Fast prediction markets on news mentions. Pick a keyword. Choose a feed. Bet if it gets mentioned. Oracle scans every 30s. Winners take the pool.
            </p>
            <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '16px', flexWrap: 'wrap' }}>
              <span style={{ color: C.text3, fontSize: '11px' }}>10 REP + 0.001 ETH min</span>
              <span style={{ color: C.text3, fontSize: '11px' }}>|</span>
              <span style={{ color: C.text3, fontSize: '11px' }}>90% to winners</span>
              <span style={{ color: C.text3, fontSize: '11px' }}>|</span>
              <span style={{ color: C.text3, fontSize: '11px' }}>Auto-resolved by oracle</span>
            </div>
          </div>

          {/* Stats preview */}
          <div style={{ display: 'flex', gap: '24px', justifyContent: 'center', marginBottom: '32px', flexWrap: 'wrap' }}>
            <StatBox label="Live Markets" value={activeQuests.length} color={C.yes} />
            <StatBox label="Resolved" value={resolvedQuests.length} />
            <StatBox label="Total Pool" value={`${totalEthStaked.toFixed(3)} ETH`} color={C.warn} />
          </div>

          <div style={{ textAlign: 'center' }}>
            <button onClick={login} style={st.primaryBtn}>ENTER MENTION MARKETS</button>
            <p style={{ color: C.text3, fontSize: '11px', marginTop: '8px' }}>Connect wallet. Register. Get 100 REP. Start betting.</p>
          </div>

          {/* Show active quests preview */}
          {activeQuests.length > 0 && (
            <div style={{ marginTop: '32px', width: '100%', maxWidth: '700px' }}>
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
            <h1 style={{ color: C.text1, fontSize: '24px', fontWeight: '700', margin: 0, letterSpacing: '-1px' }}>MENTIONFI</h1>
            <span style={st.badge}>MegaETH</span>
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
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
              <StatBox label="Your REP" value={parseFloat(userRep || 0).toFixed(0)} color={C.yes} />
              <StatBox label="Live Quests" value={activeQuests.length} color={C.info} />
              <StatBox label="Resolved" value={resolvedQuests.length} />
              <StatBox label="Total Pool" value={`${totalEthStaked.toFixed(3)} ETH`} color={C.warn} />
              <StatBox label="Oracle Fund" value={oracleBalance ? `${oracleBalance} ETH` : '...'} color={C.text2} />
            </div>

            {/* Navigation tabs */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', flexWrap: 'wrap' }}>
              {[
                { key: 'dashboard', label: 'QUESTS' },
                { key: 'create', label: '+ CREATE' },
                { key: 'portfolio', label: 'MY BETS' },
                { key: 'howto', label: 'HOW TO PLAY' },
                { key: 'oracle', label: 'ORACLE' },
              ].map(t => (
                <button key={t.key} onClick={() => setView(t.key)} style={view === t.key ? st.tabActive : st.tab}>
                  {t.label}
                </button>
              ))}
            </div>

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
                          <QuestCard key={q.id} quest={q} fmtTime={fmtTime} fmtFeed={fmtFeed} onClaim={handleClaim} loading={loading} keywordMap={keywordMap} userPosition={userPositions[q.id]} />
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
                    <div><div style={{ color: C.warn, fontSize: '24px', fontWeight: '700' }}>{Object.values(userPositions).reduce((s, p) => s + parseFloat(p.ethStake), 0).toFixed(3)}</div><div style={{ color: C.text3, fontSize: '11px' }}>ETH at Risk</div></div>
                  </div>
                  {Object.keys(userPositions).length > 0 ? (
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {Object.entries(userPositions).map(([qId, pos]) => {
                        const q = quests.find(x => x.id === Number(qId));
                        if (!q) return null;
                        return (
                          <div key={qId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: C.bg, borderRadius: '8px', border: `1px solid ${C.border}` }}>
                            <div>
                              <span style={{ color: C.text1, fontSize: '13px', fontWeight: '600' }}>Quest #{qId}</span>
                              <span style={{ color: C.text3, fontSize: '11px', marginLeft: '8px' }}>{fmtFeed(q.sourceUrl)}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <span style={{ color: pos.position === 1 ? C.yes : C.no, fontSize: '12px', fontWeight: '700' }}>
                                {pos.position === 1 ? 'YES' : 'NO'}
                              </span>
                              <span style={{ color: C.text2, fontSize: '11px' }}>{parseFloat(pos.ethStake).toFixed(3)} ETH</span>
                              <span style={{ color: C.text3, fontSize: '11px' }}>{fmtTime(q.windowEnd)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p style={{ color: C.text3, fontSize: '12px', textAlign: 'center', margin: '12px 0 0' }}>No active bets yet. Go to Quests and place your first bet.</p>
                  )}
                </div>
              </div>
            )}

            {/* How to Play view */}
            {view === 'howto' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.yes, fontSize: '16px', margin: '0 0 16px', letterSpacing: '1px' }}>HOW TO PLAY</h3>
                  <p style={{ color: C.text2, fontSize: '13px', lineHeight: '1.6', margin: '0 0 20px' }}>
                    MentionFi is a <span style={{ color: C.text1 }}>keyword prediction market</span>. You bet on whether a specific word will appear in RSS news feeds within a time window. The oracle checks feeds every 30 seconds and resolves quests automatically.
                  </p>

                  <h4 style={st.guideHeading}>1. REGISTER</h4>
                  <p style={st.guidePara}>Connect your wallet and register to receive <span style={{ color: C.yes }}>100 REP tokens</span>. REP is your reputation — you stake it alongside ETH on every bet. Lose and your REP decreases. Win and it grows.</p>

                  <h4 style={st.guideHeading}>2. CREATE A QUEST</h4>
                  <p style={st.guidePara}>Pick any keyword (e.g. "bitcoin", "trump", "deepseek") + an RSS feed source + a time window (1 hour to 7 days). The question becomes: <em>will this keyword appear in that feed before time runs out?</em></p>

                  <h4 style={st.guideHeading}>3. PLACE YOUR BET</h4>
                  <p style={st.guidePara}>Choose <span style={{ color: C.yes }}>YES</span> (keyword will appear) or <span style={{ color: C.no }}>NO</span> (it won't). Stake ETH (min 0.001) + 10 REP. <span style={{ color: C.warn }}>You can only bet one side per quest</span> — no hedging allowed.</p>

                  <h4 style={st.guideHeading}>4. ORACLE RESOLVES</h4>
                  <p style={st.guidePara}>The oracle scans all RSS feeds every 30 seconds. If the keyword appears before the window closes → YES wins. If the window ends with no mention → NO wins. Fully automated, no human intervention.</p>

                  <h4 style={st.guideHeading}>5. COLLECT WINNINGS</h4>
                  <p style={st.guidePara}>Winners split the losing side's ETH pool proportionally. Go to My Bets → click CLAIM on resolved quests.</p>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.warn, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>GAME THEORY</h3>

                  <div style={{ marginBottom: '16px' }}>
                    <h4 style={st.guideHeading}>Fee Structure</h4>
                    <p style={st.guidePara}><span style={{ color: C.text1 }}>5%</span> protocol fee + <span style={{ color: C.text1 }}>5%</span> quest creator reward from the losing pool. The remaining 90% goes to winners.</p>
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <h4 style={st.guideHeading}>Odds & Payouts</h4>
                    <p style={st.guidePara}>Odds are set by the market — the ratio of YES vs NO stakes. If 0.1 ETH is on YES and 0.9 ETH is on NO, YES bettors get 10:1 payout if they win. Early contrarian bets pay the most.</p>
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <h4 style={st.guideHeading}>Strategy Tips</h4>
                    <ul style={{ color: C.text2, fontSize: '12px', lineHeight: '1.8', paddingLeft: '16px', margin: '4px 0' }}>
                      <li>Bet YES on trending topics about to break into mainstream news</li>
                      <li>Bet NO on obscure keywords with short time windows</li>
                      <li>Check feed tiers — S-tier feeds (CoinDesk, HN) update every 2-5 min</li>
                      <li>Create quests on topics you have information edge on</li>
                      <li>Quest creators earn 5% of the losing pool — create popular quests</li>
                    </ul>
                  </div>

                  <div>
                    <h4 style={st.guideHeading}>REP System (EIP-6909)</h4>
                    <p style={st.guidePara}>REP is a multi-token reputation score. You start with 100. Every bet costs 10 REP. Win → you get more back. Lose → you lose it. High REP = proven track record. REP is non-transferable and soulbound.</p>
                  </div>
                </div>

                <div style={st.glass}>
                  <h3 style={{ color: C.info, fontSize: '14px', margin: '0 0 14px', letterSpacing: '1px' }}>FEED TIERS</h3>
                  <p style={st.guidePara}>Not all feeds are equal. Higher tier = faster updates = more likely to trigger YES outcomes quickly.</p>
                  <div style={{ display: 'grid', gap: '6px', marginTop: '12px' }}>
                    <div style={st.tierRow}><span style={{ color: C.yes, fontWeight: '700' }}>S-TIER</span><span style={{ color: C.text2 }}>CoinDesk, Cointelegraph, CNBC, HN — updates every 2-5 min</span></div>
                    <div style={st.tierRow}><span style={{ color: C.info, fontWeight: '700' }}>A-TIER</span><span style={{ color: C.text2 }}>TechCrunch, CryptoSlate, Yahoo — updates every 5-15 min</span></div>
                    <div style={st.tierRow}><span style={{ color: C.text2, fontWeight: '700' }}>B-TIER</span><span style={{ color: C.text3 }}>CryptoPotato, CryptoNews — updates every 5-30 min</span></div>
                  </div>
                </div>
              </div>
            )}

            {/* Oracle Status view */}
            {view === 'oracle' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 16px' }}>ORACLE STATUS</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px' }}>
                    <div>
                      <div style={{ color: C.yes, fontSize: '14px', fontWeight: '600' }}>ONLINE</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Status</div>
                    </div>
                    <div>
                      <div style={{ color: C.text1, fontSize: '14px', fontWeight: '600' }}>{oracleBalance || '...'} ETH</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Oracle Fund (Gas)</div>
                    </div>
                    <div>
                      <div style={{ color: C.text1, fontSize: '14px', fontWeight: '600' }}>{resolvedQuests.length}</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Quests Resolved</div>
                    </div>
                    <div>
                      <div style={{ color: C.text1, fontSize: '14px', fontWeight: '600' }}>30s</div>
                      <div style={{ color: C.text3, fontSize: '11px' }}>Poll Interval</div>
                    </div>
                  </div>
                </div>

                <div style={{ ...st.glass, marginTop: '16px' }}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 16px' }}>RSS FEEDS ({RSS_FEEDS.length})</h3>
                  <div style={{ display: 'grid', gap: '8px' }}>
                    {RSS_FEEDS.map(f => (
                      <div key={f.url} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: C.bg, borderRadius: '6px', border: `1px solid ${C.border}` }}>
                        <span style={{ color: C.text1, fontSize: '13px' }}>{f.name}</span>
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
                  <InfoRow label="Protocol Fee" value="5% of losing ETH pool" />
                  <InfoRow label="Creator Reward" value="5% of losing pool" />
                </div>
              </div>
            )}
          </>
        )}

        {error && (
          <div style={{ color: C.no, fontSize: '13px', marginTop: '16px', padding: '12px', background: `${C.no}11`, borderRadius: '8px', border: `1px solid ${C.no}33`, maxWidth: '700px', width: '100%', textAlign: 'center' }}>
            {error.length > 200 ? error.slice(0, 200) + '...' : error}
          </div>
        )}
      </div>
    </div>
  );
}

// Quest Card Component
function QuestCard({ quest, fmtTime, fmtFeed, onBet, onClaim, stakeAmount, setStakeAmount, loading, userPosition, keywordMap }) {
  const isActive = quest.status === 0;
  const isResolved = quest.status === 2;
  const yesPercent = quest.yesOdds + quest.noOdds > 0 ? quest.yesOdds : 50;
  const noPercent = quest.yesOdds + quest.noOdds > 0 ? quest.noOdds : 50;
  const hasBet = !!userPosition;
  const keyword = keywordMap?.[quest.keywordHash] || null;
  const totalPool = (parseFloat(quest.totalYesEth || 0) + parseFloat(quest.totalNoEth || 0)).toFixed(3);

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
          <div style={{ color: C.yes, fontSize: '16px', fontWeight: '700' }}>{parseFloat(quest.totalYesEth || 0).toFixed(3)}</div>
          <div style={{ color: C.yes, fontSize: '10px', opacity: 0.7 }}>ETH on YES</div>
        </div>
        <div style={{ flex: 1, padding: '10px 12px', background: `${C.no}0A`, borderRadius: '8px', border: `1px solid ${C.no}22`, textAlign: 'center' }}>
          <div style={{ color: C.no, fontSize: '16px', fontWeight: '700' }}>{parseFloat(quest.totalNoEth || 0).toFixed(3)}</div>
          <div style={{ color: C.no, fontSize: '10px', opacity: 0.7 }}>ETH on NO</div>
        </div>
        <div style={{ flex: 1, padding: '10px 12px', background: `${C.warn}0A`, borderRadius: '8px', border: `1px solid ${C.warn}22`, textAlign: 'center' }}>
          <div style={{ color: C.warn, fontSize: '16px', fontWeight: '700' }}>{totalPool}</div>
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
            YOUR BET: {userPosition.position === 1 ? 'YES' : 'NO'} — {parseFloat(userPosition.ethStake).toFixed(3)} ETH + {parseFloat(userPosition.repStake).toFixed(0)} REP
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
          {onClaim && hasBet && !userPosition?.claimed && (
            <button onClick={() => onClaim(quest.id)} disabled={loading}
              style={{ padding: '6px 14px', background: C.yes, border: 'none', color: C.bg, fontFamily: "'JetBrains Mono', monospace", fontWeight: '600', cursor: 'pointer', borderRadius: '4px', fontSize: '11px' }}>
              CLAIM
            </button>
          )}
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
    position: 'relative', zIndex: 1, maxWidth: '800px', margin: '0 auto', padding: '24px 20px',
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
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  select { appearance: none; }
  input::placeholder { color: ${C.text3}; }
  input:focus, select:focus { outline: none; border-color: ${C.info}; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: ${C.bg}; }
  ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
`;
document.head.appendChild(globalStyles);

export default App;
