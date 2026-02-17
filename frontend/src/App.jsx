import React, { useEffect, useState, useCallback } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { privyConfig, megaethTestnet } from './privy-config';
import { ethers } from 'ethers';

// ─── Config ─────────────────────────────────────────────────────────────────
const PRIVY_APP_ID = 'cmlcigd1f01b9jm0du28i2jpx';
const QUEST_ADDRESS = '0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c';
const REP_TOKEN_ADDRESS = '0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b';
const RPC_URL = 'https://carrot.megaeth.com/rpc';
const ORACLE_API = 'https://oracle-production-aa8f.up.railway.app';
const BET_AMOUNT = '0.01'; // Fixed MVP bet
const REP_STAKE = '10';    // Fixed REP per bet
const ROUND_DURATION = 1800; // 30 min

// Flip to false once oracle /api/v1/current-round is live
const MOCK_MODE = false;

const QUEST_ABI = [
  'function questCount() view returns (uint256)',
  'function quests(uint256) view returns (uint256 id, address creator, bytes32 keywordHash, string sourceUrl, uint64 windowStart, uint64 windowEnd, uint64 createdAt, uint8 status, uint8 outcome)',
  'function questStakes(uint256) view returns (uint256 totalYesRepStake, uint256 totalNoRepStake, uint256 totalYesEthStake, uint256 totalNoEthStake)',
  'function claims(uint256, address) view returns (address agent, uint8 position, uint256 repStake, uint256 ethStake, uint256 confidence, bool claimed)',
  'function submitClaim(uint256 questId, uint8 position, uint256 repStake, uint256 confidence) external payable',
  'function claimReward(uint256 questId) external',
  'function getOdds(uint256) view returns (uint256 yesOdds, uint256 noOdds)',
];

const REP_ABI = [
  'function register() external',
  'function balanceOf(address, uint256) view returns (uint256)',
  'function isRegistered(address) view returns (bool)',
  'function setOperator(address, bool) external',
];

// ─── Mock Data ──────────────────────────────────────────────────────────────
// Shape must match /api/v1/current-round → response.data
const MOCK_ROUND = {
  questId: 42,
  word: 'bitcoin',
  category: 'crypto',
  difficulty: 'easy',
  sources: ['CoinDesk', 'Cointelegraph'],
  roundStart: Math.floor(Date.now() / 1000) - 757, // started ~12 min ago
  roundEnd: Math.floor(Date.now() / 1000) + 2843,  // ~47 min left
  timeRemaining: 2843,
  txHash: null,
  pool: { totalEth: 0.5, bets: 23, yesEth: 0.32, noEth: 0.18 },
};

// Shape must match /api/v1/rounds → response.data[]
const MOCK_HISTORY = [
  { questId: 41, word: 'ethereum', category: 'crypto', difficulty: 'easy', startTime: 1739796400, endTime: 1739800000, createdAt: 1739796390, txHash: '0x1234' },
  { questId: 40, word: 'tesla', category: 'markets', difficulty: 'medium', startTime: 1739792800, endTime: 1739796400, createdAt: 1739792790, txHash: '0x5678' },
  { questId: 39, word: 'solana', category: 'crypto', difficulty: 'easy', startTime: 1739789200, endTime: 1739792800, createdAt: 1739789190, txHash: '0x9abc' },
  { questId: 38, word: 'openai', category: 'tech', difficulty: 'medium', startTime: 1739785600, endTime: 1739789200, createdAt: 1739785590, txHash: '0xdef0' },
  { questId: 37, word: 'tariff', category: 'markets', difficulty: 'hard', startTime: 1739782000, endTime: 1739785600, createdAt: 1739781990, txHash: '0x1111' },
];

// ─── Colors ─────────────────────────────────────────────────────────────────
const C = {
  bg: '#0a0a0a',
  surface: '#111111',
  border: '#222222',
  yes: '#00ff88',
  yesDim: '#00ff8818',
  yesGlow: '#00ff8833',
  no: '#ff4444',
  noDim: '#ff444418',
  noGlow: '#ff444433',
  accent: '#00bbff',
  text1: '#ffffff',
  text2: '#b0b0cc',
  text3: '#555577',
};

// ─── CSS Keyframes (injected once) ──────────────────────────────────────────
const STYLE_ID = 'mentionfi-animations';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.85; }
    }
    @keyframes slideIn {
      from { transform: translate(-50%, -20px); opacity: 0; }
      to { transform: translate(-50%, 0); opacity: 1; }
    }
    @keyframes flash {
      0% { box-shadow: 0 0 0px rgba(0,255,136,0); }
      50% { box-shadow: 0 0 30px rgba(0,255,136,0.4); }
      100% { box-shadow: 0 0 0px rgba(0,255,136,0); }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtCountdown(sec) {
  if (sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtEth(n) {
  if (n === 0) return '0';
  if (Math.abs(n) < 0.001) return n.toFixed(4);
  if (Math.abs(n) < 1) return n.toFixed(3);
  return n.toFixed(2);
}

// ─── Game Screen ────────────────────────────────────────────────────────────
function GameScreen() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = wallets?.[0];

  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [round, setRound] = useState(MOCK_MODE ? MOCK_ROUND : null);
  const [history, setHistory] = useState(MOCK_MODE ? MOCK_HISTORY : []);
  const [betting, setBetting] = useState(false);
  const [userBet, setUserBet] = useState(null); // 'yes' | 'no' | null
  const [toast, setToast] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [betFlash, setBetFlash] = useState(false);

  // 1-second tick for countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Fetch current round from oracle
  const fetchRound = useCallback(async () => {
    if (MOCK_MODE) return;
    try {
      const res = await fetch(`${ORACLE_API}/api/v1/current-round`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          const d = json.data;
          // Normalize: oracle may use startTime/endTime or roundStart/roundEnd
          setRound({
            ...d,
            roundStart: d.roundStart ?? d.startTime,
            roundEnd: d.roundEnd ?? d.endTime,
            pool: d.pool || { totalEth: 0, bets: 0, yesEth: 0, noEth: 0 },
          });
        }
      }
    } catch { /* oracle down */ }
  }, []);

  const fetchHistory = useCallback(async () => {
    if (MOCK_MODE) return;
    try {
      const res = await fetch(`${ORACLE_API}/api/v1/rounds`);
      if (res.ok) {
        const json = await res.json();
        if (json.success) setHistory(json.data || []);
      }
    } catch { /* ignore */ }
  }, []);

  // Poll every 10s for live odds
  useEffect(() => {
    fetchRound();
    fetchHistory();
    const t = setInterval(() => { fetchRound(); fetchHistory(); }, 10000);
    return () => clearInterval(t);
  }, [fetchRound, fetchHistory]);

  // Check if user already bet on current round
  useEffect(() => {
    if (!round?.questId || !activeWallet?.address) return;
    const checkPosition = async () => {
      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, provider);
        const claim = await contract.claims(round.questId, activeWallet.address);
        const pos = Number(claim.position);
        if (pos === 1) setUserBet('yes');
        else if (pos === 2) setUserBet('no');
        else setUserBet(null);
      } catch { setUserBet(null); }
    };
    checkPosition();
  }, [round?.questId, activeWallet?.address]);

  const showToast = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const getSigner = async () => {
    await activeWallet.switchChain(megaethTestnet.id);
    const eip1193 = await activeWallet.getEthereumProvider();
    const provider = new ethers.BrowserProvider(eip1193);
    return provider.getSigner();
  };

  const handleRegister = async () => {
    if (!activeWallet) return;
    setRegistering(true);
    try {
      const signer = await getSigner();
      const rep = new ethers.Contract(REP_TOKEN_ADDRESS, REP_ABI, signer);
      const tx = await rep.register();
      await tx.wait();
      const tx2 = await rep.setOperator(QUEST_ADDRESS, true);
      await tx2.wait();
      showToast('Registered! 100 REP received', 'success');
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('AlreadyRegistered') || msg.includes('revert')) {
        showToast('Already registered!', 'success');
      } else {
        showToast('Registration failed', 'error');
      }
    }
    setRegistering(false);
  };

  const handleBet = async (position) => {
    if (!authenticated) { login(); return; }
    if (!activeWallet) { showToast('Wallet loading...'); return; }
    if (userBet) { showToast('Already bet this round!', 'error'); return; }
    if (!round?.questId) return;

    const posLabel = position === 1 ? 'YES' : 'NO';
    setBetting(true);
    showToast(`Placing ${posLabel} bet...`);
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const repContract = new ethers.Contract(REP_TOKEN_ADDRESS, REP_ABI, provider);
      const isReg = await repContract.isRegistered(activeWallet.address);
      if (!isReg) {
        showToast('Register first to get REP!', 'error');
        setBetting(false);
        return;
      }

      const signer = await getSigner();
      const contract = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, signer);
      const tx = await contract.submitClaim(
        round.questId,
        position,
        ethers.parseEther(REP_STAKE),
        0,
        { value: ethers.parseEther(BET_AMOUNT) }
      );
      await tx.wait();
      setUserBet(position === 1 ? 'yes' : 'no');
      setBetFlash(true);
      setTimeout(() => setBetFlash(false), 1000);
      showToast(`${posLabel} bet placed! ${BET_AMOUNT} ETH`, 'success');
      fetchRound();
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('AlreadyClaimed')) { showToast('Already bet!', 'error'); setUserBet('yes'); }
      else if (msg.includes('WindowEnded')) showToast('Round ended!', 'error');
      else if (msg.includes('user rejected') || msg.includes('denied')) showToast('Cancelled', 'error');
      else if (msg.includes('insufficient')) showToast('Need more ETH or REP', 'error');
      else showToast('Bet failed', 'error');
    }
    setBetting(false);
  };

  // Derived values
  const remaining = round ? Math.max(0, round.roundEnd - now) : 0;
  const elapsed = round ? Math.max(0, now - round.roundStart) : 0;
  const duration = round ? (round.roundEnd - round.roundStart) : ROUND_DURATION;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;
  const yesEth = Number(round?.pool?.yesEth) || 0;
  const noEth = Number(round?.pool?.noEth) || 0;
  const totalPool = yesEth + noEth || Number(round?.pool?.totalEth) || 0;
  const yesPercent = totalPool > 0 ? Math.round((yesEth / totalPool) * 100) : 50;
  const noPercent = 100 - yesPercent;
  const isExpired = remaining <= 0;
  const isUrgent = remaining > 0 && remaining < 300;

  return (
    <div style={S.container}>
      {/* Toast notification */}
      {toast && (
        <div style={{
          ...S.toast,
          borderColor: toast.type === 'success' ? C.yes : toast.type === 'error' ? C.no : C.accent,
          animation: 'slideIn 0.25s ease',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <header style={S.header}>
        <div style={S.logo}>MENTIONFI</div>
        {authenticated ? (
          <button onClick={logout} style={S.walletBtn}>
            {activeWallet?.address?.slice(0, 6)}...{activeWallet?.address?.slice(-4)}
          </button>
        ) : (
          <button onClick={login} style={S.connectBtn}>
            Connect Wallet
          </button>
        )}
      </header>

      {/* Game */}
      <main style={S.main}>
        {/* Question */}
        <p style={S.prompt}>
          Will this word appear in<br />
          {(round?.sources || ['CoinDesk', 'Cointelegraph']).map((src, i, arr) => (
            <React.Fragment key={src}>
              <span style={{ color: C.accent }}>{src}</span>
              {i < arr.length - 1 ? ' or ' : ''}
            </React.Fragment>
          ))}
          <br />
          in the next hour?
        </p>

        {/* The Word */}
        <div style={{
          ...S.wordBox,
          animation: betFlash ? 'flash 0.6s ease' : 'pulse 3s ease-in-out infinite',
        }}>
          <div style={S.word}>{round?.word || '...'}</div>
          {round?.category && (
            <div style={S.wordMeta}>
              {round.category}{round.difficulty ? ` \u00b7 ${round.difficulty}` : ''}
            </div>
          )}
        </div>

        {/* Timer + Progress */}
        <div style={S.timerBlock}>
          <div style={S.timerRow}>
            <span style={{
              ...S.timerText,
              color: isUrgent ? C.no : C.text1,
            }}>
              {isExpired ? 'RESOLVING...' : fmtCountdown(remaining) + ' remaining'}
            </span>
          </div>
          <div style={S.progressTrack}>
            <div style={{
              ...S.progressFill,
              width: `${progress * 100}%`,
              background: isUrgent
                ? `linear-gradient(90deg, ${C.no}88, ${C.no})`
                : `linear-gradient(90deg, ${C.yes}44, ${C.yes}aa)`,
            }} />
          </div>
        </div>

        {/* Bet Buttons */}
        <div style={S.betRow}>
          <button
            onClick={() => handleBet(1)}
            disabled={betting || isExpired || !!userBet}
            style={{
              ...S.betBtn,
              background: userBet === 'yes' ? C.yesGlow : C.yesDim,
              borderColor: userBet === 'yes' ? C.yes : C.yes + '33',
              color: C.yes,
              opacity: (betting || isExpired) && !userBet ? 0.4 : 1,
            }}
          >
            <div style={S.betLabel}>
              {!authenticated ? 'Connect to bet' : userBet === 'yes' ? '\u2713 YES' : 'YES'}
            </div>
            <div style={S.betPercent}>{yesPercent}%</div>
            <div style={S.betCost}>{BET_AMOUNT} ETH</div>
          </button>

          <button
            onClick={() => handleBet(2)}
            disabled={betting || isExpired || !!userBet}
            style={{
              ...S.betBtn,
              background: userBet === 'no' ? C.noGlow : C.noDim,
              borderColor: userBet === 'no' ? C.no : C.no + '33',
              color: C.no,
              opacity: (betting || isExpired) && !userBet ? 0.4 : 1,
            }}
          >
            <div style={S.betLabel}>
              {!authenticated ? 'Connect to bet' : userBet === 'no' ? '\u2713 NO' : 'NO'}
            </div>
            <div style={S.betPercent}>{noPercent}%</div>
            <div style={S.betCost}>{BET_AMOUNT} ETH</div>
          </button>
        </div>

        {/* Bet confirmation */}
        {userBet && (
          <p style={S.betStatus}>
            You bet{' '}
            <span style={{ color: userBet === 'yes' ? C.yes : C.no, fontWeight: 700 }}>
              {userBet.toUpperCase()}
            </span>{' '}
            this round
          </p>
        )}

        {/* Registration nudge */}
        {authenticated && !userBet && (
          <button onClick={handleRegister} disabled={registering} style={S.registerBtn}>
            {registering ? 'Registering...' : 'New? Register for 100 free REP'}
          </button>
        )}

        {/* Pool stats */}
        <div style={S.poolStats}>
          Pool: <b style={{ color: C.text1 }}>{fmtEth(totalPool)} ETH</b>
          <span style={S.dot}>{'\u00b7'}</span>
          {round?.pool?.bets ?? round?.pool?.playerCount ?? 0} bets
        </div>

        {/* Recent Rounds */}
        <div style={S.historySection}>
          <div style={S.historyTitle}>Recent Rounds</div>
          {history.length === 0 && <p style={S.empty}>No rounds yet</p>}
          {history.map((h, i) => (
            <div key={i} style={S.historyRow}>
              <span style={S.hWord}>"{h.word}"</span>
              <span style={{ ...S.hCategory, color: C.text3 }}>
                {h.category || ''}
              </span>
              <span style={S.hQuestId}>
                #{h.questId}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          <span>MegaETH Testnet</span>
          <span style={S.footerDot} />
          <span>Oracle scanning every 15s</span>
        </div>
      </main>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const S = {
  container: {
    minHeight: '100vh',
    background: C.bg,
    color: C.text1,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif",
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },

  // Toast
  toast: {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: C.surface,
    border: '1px solid',
    borderRadius: 10,
    padding: '10px 24px',
    fontSize: 14,
    color: C.text1,
    zIndex: 1000,
    whiteSpace: 'nowrap',
  },

  // Header
  header: {
    width: '100%',
    maxWidth: 480,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px 8px',
  },
  logo: {
    fontSize: 16,
    fontWeight: 800,
    letterSpacing: 3,
    color: C.text1,
  },
  connectBtn: {
    background: C.yes,
    color: '#000',
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  walletBtn: {
    background: C.surface,
    color: C.text2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '7px 12px',
    fontSize: 12,
    fontFamily: 'monospace',
    cursor: 'pointer',
  },

  // Main
  main: {
    width: '100%',
    maxWidth: 480,
    padding: '0 20px 40px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },

  // Question prompt
  prompt: {
    fontSize: 16,
    color: C.text2,
    textAlign: 'center',
    lineHeight: 1.5,
    margin: '16px 0 24px',
  },

  // Word card
  wordBox: {
    background: C.surface,
    border: `2px solid ${C.border}`,
    borderRadius: 16,
    padding: '32px 20px 24px',
    marginBottom: 24,
    textAlign: 'center',
    width: '100%',
  },
  word: {
    fontSize: 44,
    fontWeight: 900,
    letterSpacing: 4,
    fontFamily: "'SF Mono', 'Fira Code', 'Courier New', monospace",
    color: C.text1,
    textTransform: 'uppercase',
  },
  wordMeta: {
    fontSize: 13,
    color: C.text3,
    marginTop: 8,
  },

  // Timer
  timerBlock: {
    width: '100%',
    marginBottom: 24,
  },
  timerRow: {
    textAlign: 'center',
    marginBottom: 8,
  },
  timerText: {
    fontSize: 20,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
  },
  progressTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    background: C.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 1s linear',
  },

  // Bet buttons
  betRow: {
    display: 'flex',
    gap: 14,
    width: '100%',
    marginBottom: 16,
  },
  betBtn: {
    flex: 1,
    borderRadius: 16,
    padding: '20px 12px 16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    border: '2px solid',
    transition: 'all 0.2s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  betLabel: {
    fontSize: 24,
    fontWeight: 900,
    letterSpacing: 1,
  },
  betPercent: {
    fontSize: 20,
    fontWeight: 700,
  },
  betCost: {
    fontSize: 12,
    opacity: 0.6,
    marginTop: 2,
  },

  // Status
  betStatus: {
    fontSize: 14,
    color: C.text2,
    marginBottom: 12,
    textAlign: 'center',
  },
  registerBtn: {
    background: 'transparent',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '8px 16px',
    color: C.text3,
    fontSize: 13,
    cursor: 'pointer',
    marginBottom: 12,
  },

  // Pool
  poolStats: {
    fontSize: 15,
    color: C.text2,
    marginBottom: 32,
    textAlign: 'center',
  },
  dot: {
    margin: '0 6px',
    color: C.text3,
  },

  // History
  historySection: {
    width: '100%',
    borderTop: `1px solid ${C.border}`,
    paddingTop: 20,
  },
  historyTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: C.text3,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 12,
    textAlign: 'center',
  },
  empty: {
    fontSize: 13,
    color: C.text3,
    textAlign: 'center',
  },
  historyRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 0',
    borderBottom: `1px solid ${C.border}22`,
  },
  hWord: {
    flex: 1,
    fontSize: 15,
    fontWeight: 600,
  },
  hCategory: {
    fontSize: 12,
    fontWeight: 600,
    width: 60,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  hQuestId: {
    fontSize: 13,
    fontWeight: 600,
    width: 50,
    textAlign: 'right',
    color: C.text3,
    fontVariantNumeric: 'tabular-nums',
  },

  // Footer
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 32,
    fontSize: 12,
    color: C.text3,
  },
  footerDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    background: C.yes,
    display: 'inline-block',
  },
};

// ─── App (Privy Provider wrapper) ───────────────────────────────────────────
export default function App() {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <GameScreen />
    </PrivyProvider>
  );
}
