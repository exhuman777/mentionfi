import React, { useEffect, useState, useCallback } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { privyConfig, megaethTestnet } from './privy-config';
import { ethers } from 'ethers';
import RogueASCIIBg from './RogueASCIIBg';

const PRIVY_APP_ID = 'cml9c6av801zil40dnl2gqnhj';

const REP_TOKEN_ADDRESS = '0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b';
const QUEST_ADDRESS = '0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c';
const RPC_URL = 'https://carrot.megaeth.com/rpc';

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
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '24 hours', value: 86400 },
  { label: '3 days', value: 259200 },
  { label: '7 days', value: 604800 },
];

const STAKE_PRESETS = ['0.001', '0.01', '0.05', '0.1'];

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

  const activeWallet = wallets?.[0];

  const fetchData = useCallback(async () => {
    try {
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
      const signer = await getSigner();
      const tx = await new ethers.Contract(REP_TOKEN_ADDRESS, REP_TOKEN_ABI, signer).register();
      await tx.wait();
      setIsRegistered(true);
      fetchData();
    } catch (e) { setError(e.message); }
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
      setNewQuest({ keyword: '', sourceUrl: RSS_FEEDS[0].url, duration: 3600 });
      setView('dashboard');
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleBet = async (questId, position) => {
    if (!activeWallet) return;
    setLoading(true); setError(null);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const repStake = ethers.parseEther('10');
      const ethStake = ethers.parseEther(stakeAmount);
      const tx = await contract.submitClaim(questId, position, repStake, 70, { value: ethStake });
      await tx.wait();
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleClaim = async (questId) => {
    if (!activeWallet) return;
    setLoading(true); setError(null);
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const tx = await contract.claimReward(questId);
      await tx.wait();
      fetchData();
    } catch (e) { setError(e.message); }
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
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '8px' }}>
              <span style={st.badge}>MegaETH</span>
              <span style={{ ...st.badge, borderColor: C.yes, color: C.yes }}>TESTNET</span>
            </div>
            <p style={{ color: C.text2, marginTop: '16px', fontSize: '15px', maxWidth: '500px', margin: '16px auto 0' }}>
              Bet on what gets mentioned next. Pick a keyword. Choose an RSS feed. Stake REP + ETH on whether it appears. Oracle resolves. Winners take the pool.
            </p>
          </div>

          {/* Stats preview */}
          <div style={{ display: 'flex', gap: '24px', justifyContent: 'center', marginBottom: '32px', flexWrap: 'wrap' }}>
            <StatBox label="Quests" value={quests.length} />
            <StatBox label="Active" value={activeQuests.length} color={C.yes} />
            <StatBox label="Resolved" value={resolvedQuests.length} />
            <StatBox label="ETH Staked" value={totalEthStaked.toFixed(3)} />
          </div>

          <div style={{ textAlign: 'center' }}>
            <button onClick={login} style={st.primaryBtn}>SIGN IN TO PLAY</button>
            <p style={{ color: C.text3, fontSize: '12px', marginTop: '8px' }}>10 REP + 0.001 ETH min stake</p>
          </div>

          {/* Show active quests preview */}
          {activeQuests.length > 0 && (
            <div style={{ marginTop: '32px', width: '100%', maxWidth: '700px' }}>
              <h3 style={{ color: C.text2, fontSize: '12px', letterSpacing: '1px', marginBottom: '12px' }}>LIVE QUESTS</h3>
              {activeQuests.slice(0, 3).map(q => <QuestCard key={q.id} quest={q} fmtTime={fmtTime} fmtFeed={fmtFeed} />)}
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
            <h2 style={{ color: C.text1, fontSize: '18px', margin: '0 0 8px' }}>Register Agent</h2>
            <p style={{ color: C.text2, fontSize: '13px', marginBottom: '16px' }}>Get 100 REP to start predicting keyword mentions</p>
            <button onClick={handleRegister} disabled={loading} style={st.primaryBtn}>
              {loading ? 'REGISTERING...' : 'REGISTER & GET 100 REP'}
            </button>
          </div>
        ) : (
          <>
            {/* Stats row */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
              <StatBox label="Your REP" value={parseFloat(userRep || 0).toFixed(0)} color={C.yes} />
              <StatBox label="Active" value={activeQuests.length} color={C.info} />
              <StatBox label="Resolved" value={resolvedQuests.length} />
              <StatBox label="Total Quests" value={quests.length} />
              <StatBox label="ETH Staked" value={totalEthStaked.toFixed(3)} color={C.warn} />
              <StatBox label="Oracle" value={oracleBalance ? `${oracleBalance} ETH` : '...'} color={C.info} />
            </div>

            {/* Navigation tabs */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', flexWrap: 'wrap' }}>
              {['dashboard', 'create', 'portfolio', 'oracle'].map(t => (
                <button key={t} onClick={() => setView(t)} style={view === t ? st.tabActive : st.tab}>
                  {t === 'dashboard' ? 'QUESTS' : t === 'create' ? '+ CREATE' : t === 'portfolio' ? 'PORTFOLIO' : 'ORACLE'}
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
                            loading={loading} />
                        ))}
                      </>
                    )}
                    {resolvedQuests.length > 0 && (
                      <>
                        <h3 style={{ ...st.sectionTitle, marginTop: '32px' }}>RESOLVED <span style={{ color: C.text3 }}>({resolvedQuests.length})</span></h3>
                        {resolvedQuests.slice(0, 5).map(q => (
                          <QuestCard key={q.id} quest={q} fmtTime={fmtTime} fmtFeed={fmtFeed} onClaim={handleClaim} loading={loading} />
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

            {/* Portfolio view */}
            {view === 'portfolio' && (
              <div style={{ width: '100%' }}>
                <div style={st.glass}>
                  <h3 style={{ color: C.text1, fontSize: '14px', margin: '0 0 16px' }}>YOUR STATS</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '16px' }}>
                    <div><div style={{ color: C.yes, fontSize: '24px', fontWeight: '700' }}>{parseFloat(userRep || 0).toFixed(0)}</div><div style={{ color: C.text3, fontSize: '11px' }}>REP Balance</div></div>
                    <div><div style={{ color: C.text1, fontSize: '24px', fontWeight: '700' }}>{quests.filter(q => q.creator === activeWallet?.address).length}</div><div style={{ color: C.text3, fontSize: '11px' }}>Quests Created</div></div>
                    <div><div style={{ color: C.info, fontSize: '24px', fontWeight: '700' }}>--</div><div style={{ color: C.text3, fontSize: '11px' }}>Bets Placed</div></div>
                    <div><div style={{ color: C.warn, fontSize: '24px', fontWeight: '700' }}>--</div><div style={{ color: C.text3, fontSize: '11px' }}>Win Rate</div></div>
                  </div>
                </div>
                <p style={{ color: C.text3, fontSize: '12px', textAlign: 'center', marginTop: '24px' }}>
                  Detailed position tracking coming soon. Create quests and place bets to build your track record.
                </p>
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
                      <div style={{ color: C.text3, fontSize: '11px' }}>Oracle Wallet</div>
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
function QuestCard({ quest, fmtTime, fmtFeed, onBet, onClaim, stakeAmount, setStakeAmount, loading }) {
  const isActive = quest.status === 0;
  const isResolved = quest.status === 2;
  const yesPercent = quest.yesOdds + quest.noOdds > 0 ? quest.yesOdds : 50;
  const noPercent = quest.yesOdds + quest.noOdds > 0 ? quest.noOdds : 50;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', marginBottom: '10px', position: 'relative', zIndex: 2, backdropFilter: 'blur(8px)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: C.text1, fontSize: '13px', fontWeight: '600' }}>Quest #{quest.id}</span>
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: `${C.info}22`, color: C.info, border: `1px solid ${C.info}33` }}>
            {fmtFeed(quest.sourceUrl)}
          </span>
        </div>
        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
          background: isActive ? `${C.yes}22` : isResolved ? `${C.text3}22` : `${C.warn}22`,
          color: isActive ? C.yes : isResolved ? C.text2 : C.warn,
          border: `1px solid ${isActive ? C.yes : isResolved ? C.text3 : C.warn}44`
        }}>
          {QuestStatus[quest.status]}
        </span>
      </div>

      {/* Probability bar */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
          <span style={{ color: C.yes }}>YES {yesPercent}%</span>
          <span style={{ color: C.no }}>NO {noPercent}%</span>
        </div>
        <div style={{ height: '6px', borderRadius: '3px', background: C.no, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${yesPercent}%`, background: C.yes, borderRadius: '3px', transition: 'width 0.3s ease' }} />
        </div>
      </div>

      {/* Stakes + Time */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: C.text2, marginBottom: '10px' }}>
        <span>{parseFloat(quest.totalYesEth).toFixed(3)} ETH yes / {parseFloat(quest.totalNoEth).toFixed(3)} ETH no</span>
        <span style={{ color: isActive ? C.warn : C.text3 }}>{fmtTime(quest.windowEnd)}</span>
      </div>

      {/* Bet buttons */}
      {onBet && isActive && (
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
          {onClaim && (
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
