import React, { useEffect, useState, useCallback, useRef } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { privyConfig, megaethTestnet } from './privy-config';
import { ethers } from 'ethers';

// ─── Config ─────────────────────────────────────────────────────────────────
const PRIVY_APP_ID = 'cmlcigd1f01b9jm0du28i2jpx';
const QUEST_ADDRESS = '0x4e5c8a5B099260d7c7858eE62E55D03a9015e39c';
const REP_TOKEN_ADDRESS = '0x1665f75aD523803E4F17dB5D4DEa4a5F72C8B53b';
const RPC_URL = 'https://carrot.megaeth.com/rpc';
const ORACLE_API = 'https://oracle-production-aa8f.up.railway.app';
const BET_AMOUNT = '0';
const REP_STAKE = '10';
const ROUND_DURATION = 1800;

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

// ─── Inject Fonts + Global Styles ───────────────────────────────────────────
const STYLE_ID = 'mentionfi-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  // Google Fonts
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap';
  document.head.appendChild(link);

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :root {
      --bg-0: #000000; --bg-1: #0a0a0a; --bg-2: #111111; --bg-3: #1a1a1a; --bg-4: #222222; --bg-5: #2a2a2a;
      --border: #333333; --border-light: #444444;
      --text-0: #ffffff; --text-1: #f5f5f5; --text-2: #a0a0a0; --text-3: #666666;
      --yes: #00d26a; --yes-dark: #00b359; --no: #ff4757; --no-dark: #e63946;
      --accent: #8b5cf6; --gold: #fbbf24;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg-1);
      color: var(--text-1);
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.85; } }
    @keyframes slideIn { from { transform: translate(-50%, -20px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
    @keyframes flash { 0% { box-shadow: 0 0 0 rgba(0,210,106,0); } 50% { box-shadow: 0 0 40px rgba(0,210,106,0.35); } 100% { box-shadow: 0 0 0 rgba(0,210,106,0); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes modalEnter { 0% { opacity: 0; transform: scale(0.92) translateY(20px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
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
function fmtAddr(a) { return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : ''; }
function fmtRep(v) { if (v == null) return '0'; const n = parseFloat(v); return isNaN(n) ? '0' : Math.floor(n).toString(); }

// ─── Modal ──────────────────────────────────────────────────────────────────
const Modal = ({ open, onClose, title, children }) => {
  if (!open) return null;
  return (
    <div className="mfi-overlay" style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <span style={S.modalTitle}>{title}</span>
          <button style={S.modalClose} onClick={onClose}>&#x2715;</button>
        </div>
        {children}
      </div>
    </div>
  );
};

// ─── Game Screen ────────────────────────────────────────────────────────────
function GameScreen() {
  const { authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = wallets?.[0];

  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [round, setRound] = useState(null);
  const [history, setHistory] = useState([]);
  const [betting, setBetting] = useState(false);
  const [userBet, setUserBet] = useState(null);
  const [toast, setToast] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [betFlash, setBetFlash] = useState(false);
  const [nextRoundIn, setNextRoundIn] = useState(null);
  const [pendingBet, setPendingBet] = useState(null);
  const [resolvedRound, setResolvedRound] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [repBalance, setRepBalance] = useState(null);
  const [isRegistered, setIsRegistered] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [claiming, setClaiming] = useState(false);
  const [claimSuccess, setClaimSuccess] = useState(false);
  const [userClaim, setUserClaim] = useState(null);
  const prevRoundStatus = useRef(null);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      setNextRoundIn(prev => prev !== null && prev > 0 ? prev - 1 : prev);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ─── Data fetching (unchanged logic) ──────────────────────────────────
  const fetchRound = useCallback(async () => {
    try {
      const res = await fetch(`${ORACLE_API}/api/v1/current-round`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          const d = json.data;
          setNextRoundIn(null);
          const newRound = { ...d, roundStart: d.roundStart ?? d.startTime, roundEnd: d.roundEnd ?? d.endTime, pool: d.pool || {} };
          if (prevRoundStatus.current && prevRoundStatus.current !== 'resolved' && d.status === 'resolved') setResolvedRound(newRound);
          prevRoundStatus.current = d.status;
          if (d.status === 'resolved') { setRound(null); setUserBet(null); } else setRound(newRound);
        } else {
          setRound(null); prevRoundStatus.current = null;
          try { const gm = await fetch(`${ORACLE_API}/api/v1/gamemaster/status`); if (gm.ok) { const g = await gm.json(); if (g.success && g.data?.nextRoundIn) setNextRoundIn(g.data.nextRoundIn); } } catch {}
        }
      }
    } catch {}
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${ORACLE_API}/api/v1/quests`);
      if (res.ok) {
        const j = await res.json();
        if (j.success && j.data) {
          // Map quests to round-like objects, most recent first
          const rounds = j.data.slice(0, 12).map(q => ({
            word: q.keyword || '???',
            questId: q.id,
            status: q.status === 'open' ? 'betting' : q.status === 'resolved' ? 'resolved' : q.status,
            outcome: q.outcome === 'yes' ? 'yes' : q.outcome === 'no' ? 'no' : null,
          }));
          setHistory(rounds);
        }
      }
    } catch {}
  }, []);

  const fetchRepBalance = useCallback(async () => {
    if (!activeWallet?.address) { setRepBalance(null); return; }
    try { const p = new ethers.JsonRpcProvider(RPC_URL); const r = new ethers.Contract(REP_TOKEN_ADDRESS, REP_ABI, p); setRepBalance(ethers.formatEther(await r.balanceOf(activeWallet.address, 0))); } catch { setRepBalance(null); }
  }, [activeWallet?.address]);

  const checkRegistration = useCallback(async () => {
    if (!activeWallet?.address) { setIsRegistered(null); return; }
    try { const p = new ethers.JsonRpcProvider(RPC_URL); const r = new ethers.Contract(REP_TOKEN_ADDRESS, REP_ABI, p); const reg = await r.isRegistered(activeWallet.address); setIsRegistered(reg); if (reg) fetchRepBalance(); } catch { setIsRegistered(null); }
  }, [activeWallet?.address, fetchRepBalance]);

  const fetchLeaderboard = useCallback(async () => {
    try { const res = await fetch(`${ORACLE_API}/api/v1/leaderboard`); if (res.ok) { const j = await res.json(); if (j.success) setLeaderboard(j.data || []); } } catch {}
  }, []);

  useEffect(() => { fetchRound(); fetchHistory(); fetchLeaderboard(); const t = setInterval(() => { fetchRound(); fetchHistory(); }, 10000); const t2 = setInterval(fetchLeaderboard, 30000); return () => { clearInterval(t); clearInterval(t2); }; }, [fetchRound, fetchHistory, fetchLeaderboard]);
  useEffect(() => { if (authenticated && activeWallet?.address) checkRegistration(); else { setIsRegistered(null); setRepBalance(null); } }, [authenticated, activeWallet?.address, checkRegistration]);
  useEffect(() => { if (!round?.questId || !activeWallet?.address) return; (async () => { try { const p = new ethers.JsonRpcProvider(RPC_URL); const c = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, p); const cl = await c.claims(round.questId, activeWallet.address); const pos = Number(cl.position); setUserBet(pos === 1 ? 'yes' : pos === 2 ? 'no' : null); } catch { setUserBet(null); } })(); }, [round?.questId, activeWallet?.address]);
  useEffect(() => { if (!resolvedRound?.questId || !activeWallet?.address) { setUserClaim(null); return; } (async () => { try { const p = new ethers.JsonRpcProvider(RPC_URL); const c = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, p); const cl = await c.claims(resolvedRound.questId, activeWallet.address); const pos = Number(cl.position); if (pos === 0) { setUserClaim(null); return; } setUserClaim({ position: pos === 1 ? 'yes' : 'no', repStake: ethers.formatEther(cl.repStake), claimed: cl.claimed }); } catch { setUserClaim(null); } })(); }, [resolvedRound?.questId, activeWallet?.address]);

  // ─── Actions ──────────────────────────────────────────────────────────
  const showToast = (msg, type = 'info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 4000); };
  const getSigner = async () => { await activeWallet.switchChain(megaethTestnet.id); const eip = await activeWallet.getEthereumProvider(); return new ethers.BrowserProvider(eip).getSigner(); };

  const handleRegister = async () => {
    if (!activeWallet) return; setRegistering(true);
    try { const s = await getSigner(); const r = new ethers.Contract(REP_TOKEN_ADDRESS, REP_ABI, s); await (await r.register()).wait(); await (await r.setOperator(QUEST_ADDRESS, true)).wait(); setIsRegistered(true); showToast('Welcome! 100 REP received', 'success'); fetchRepBalance();
    } catch (e) { const m = e.shortMessage || e.message || ''; if (m.includes('AlreadyRegistered') || m.includes('revert')) { setIsRegistered(true); showToast('Already registered!', 'success'); fetchRepBalance(); } else showToast('Registration failed', 'error'); }
    setRegistering(false);
  };

  const handleBetClick = (position) => {
    if (!authenticated) { login(); return; } if (!activeWallet) { showToast('Wallet loading...'); return; }
    if (userBet) { showToast('Already bet this round!', 'error'); return; } if (!round?.questId) return;
    if (isRegistered === false) { showToast('Register first!', 'error'); return; }
    setPendingBet({ position, label: position === 1 ? 'YES' : 'NO' });
  };

  const confirmBet = async () => {
    if (!pendingBet || !round?.questId) return; const { position, label } = pendingBet; setPendingBet(null); setBetting(true); showToast(`Placing ${label} bet...`);
    try { const s = await getSigner(); const c = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, s); await (await c.submitClaim(round.questId, position, ethers.parseEther(REP_STAKE), 50, { value: ethers.parseEther(BET_AMOUNT) })).wait(); setUserBet(position === 1 ? 'yes' : 'no'); setBetFlash(true); setTimeout(() => setBetFlash(false), 1000); showToast(`Bet placed! ${REP_STAKE} REP on ${label}`, 'success'); fetchRound(); fetchRepBalance();
    } catch (e) { const m = e.shortMessage || e.message || ''; if (m.includes('AlreadyClaimed')) { showToast('Already bet!', 'error'); setUserBet('yes'); } else if (m.includes('WindowEnded')) showToast('Round ended!', 'error'); else if (m.includes('user rejected') || m.includes('denied')) showToast('Cancelled', 'error'); else if (m.includes('insufficient')) showToast('Need more REP', 'error'); else showToast(`Bet failed: ${m.slice(0, 80)}`, 'error'); }
    setBetting(false);
  };

  const handleClaim = async () => {
    if (!resolvedRound?.questId || !activeWallet) return; setClaiming(true);
    try { const s = await getSigner(); const c = new ethers.Contract(QUEST_ADDRESS, QUEST_ABI, s); await (await c.claimReward(resolvedRound.questId)).wait(); setClaimSuccess(true); showToast('REP claimed!', 'success'); fetchRepBalance();
    } catch (e) { const m = e.shortMessage || e.message || ''; if (m.includes('user rejected') || m.includes('denied')) showToast('Cancelled', 'error'); else showToast(`Claim failed: ${m.slice(0, 80)}`, 'error'); }
    setClaiming(false);
  };

  // ─── Derived ──────────────────────────────────────────────────────────
  const remaining = round ? Math.max(0, round.roundEnd - now) : 0;
  const elapsed = round ? Math.max(0, now - round.roundStart) : 0;
  const duration = round ? (round.roundEnd - round.roundStart) : ROUND_DURATION;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;
  const yesRep = Number(round?.pool?.yesRep) || 0;
  const noRep = Number(round?.pool?.noRep) || 0;
  const totalRep = yesRep + noRep;
  const yesPercent = totalRep > 0 ? Math.round((yesRep / totalRep) * 100) : 50;
  const noPercent = 100 - yesPercent;
  const isExpired = round ? remaining <= 0 : false;
  const isUrgent = remaining > 0 && remaining < 300;
  const userWon = resolvedRound && userClaim ? (resolvedRound.outcome === userClaim.position) : false;
  const betsDisabled = betting || isExpired || !!userBet || !round || (authenticated && isRegistered === false);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div style={S.wrapper}>
      {/* Toast */}
      {toast && <div style={{ ...S.toast, borderColor: toast.type === 'success' ? 'var(--yes)' : toast.type === 'error' ? 'var(--no)' : 'var(--accent)', animation: 'slideIn 0.25s ease' }}>{toast.msg}</div>}

      {/* ── Bet Confirmation Modal ─────────────────────────── */}
      <Modal open={!!pendingBet} onClose={() => setPendingBet(null)} title="Confirm Bet">
        {pendingBet && (<div>
          <p style={{ fontSize: '0.95rem', color: 'var(--text-2)', marginBottom: 20, textAlign: 'center', lineHeight: 1.5 }}>
            Bet <span style={{ color: pendingBet.label === 'YES' ? 'var(--yes)' : 'var(--no)', fontWeight: 700 }}>{pendingBet.label}</span> on <span style={{ color: 'var(--text-0)', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{round?.word?.toUpperCase()}</span>?
          </p>
          <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: '18px 16px', marginBottom: 16, textAlign: 'center', border: '1px solid var(--border)' }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1.6rem', fontWeight: 800, color: 'var(--gold)' }}>{REP_STAKE} REP</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 4 }}>stake amount</div>
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', textAlign: 'center', marginBottom: 20, fontFamily: "'JetBrains Mono', monospace" }}>
            {fmtCountdown(remaining)} remaining
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setPendingBet(null)} style={S.btnSecondary}>Cancel</button>
            <button onClick={confirmBet} style={{ ...S.btnPrimary, background: pendingBet.label === 'YES' ? 'var(--yes)' : 'var(--no)' }}>Confirm Bet</button>
          </div>
        </div>)}
      </Modal>

      {/* ── Round Result Modal ─────────────────────────────── */}
      <Modal open={!!resolvedRound} onClose={() => { setResolvedRound(null); setClaimSuccess(false); setUserClaim(null); }} title="Round Result">
        {resolvedRound && (<div>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '2rem', fontWeight: 800, color: 'var(--text-0)', letterSpacing: 3, marginBottom: 10 }}>{resolvedRound.word?.toUpperCase()}</div>
            <span style={{ display: 'inline-block', padding: '5px 16px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 700, background: resolvedRound.outcome === 'yes' ? 'rgba(0,210,106,0.1)' : 'rgba(255,71,87,0.1)', color: resolvedRound.outcome === 'yes' ? 'var(--yes)' : 'var(--no)', border: `1px solid ${resolvedRound.outcome === 'yes' ? 'rgba(0,210,106,0.25)' : 'rgba(255,71,87,0.25)'}` }}>
              {resolvedRound.outcome === 'yes' ? 'MENTIONED' : 'NOT MENTIONED'}
            </span>
          </div>
          {userClaim ? (
            <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: 18, marginBottom: 16, textAlign: 'center', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Your bet: <span style={{ color: userClaim.position === 'yes' ? 'var(--yes)' : 'var(--no)', fontWeight: 700 }}>{userClaim.position.toUpperCase()}</span>
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1.4rem', fontWeight: 800, color: userWon ? 'var(--yes)' : 'var(--no)' }}>
                {userWon ? '+15 REP' : '-10 REP'}
              </div>
              {!userWon && <div style={{ fontSize: '0.8rem', color: 'var(--text-3)', marginTop: 8 }}>Better luck next round!</div>}
            </div>
          ) : (
            <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: 18, marginBottom: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: '0.85rem', border: '1px solid var(--border)' }}>You didn't bet this round</div>
          )}
          {userWon && userClaim && !userClaim.claimed && !claimSuccess && <button onClick={handleClaim} disabled={claiming} style={{ ...S.btnPrimary, background: 'var(--yes)', width: '100%', marginBottom: 10 }}>{claiming ? 'Claiming...' : 'Claim Reward'}</button>}
          {claimSuccess && <div style={{ textAlign: 'center', color: 'var(--yes)', fontWeight: 700, fontSize: '0.9rem', marginBottom: 10 }}>REP claimed!</div>}
          <button onClick={() => { setResolvedRound(null); setClaimSuccess(false); setUserClaim(null); }} style={{ ...S.btnSecondary, width: '100%' }}>Close</button>
        </div>)}
      </Modal>

      {/* ── How to Play Modal ──────────────────────────────── */}
      <Modal open={showHelp} onClose={() => setShowHelp(false)} title="How to Play">
        <div style={{ fontSize: '0.85rem', lineHeight: 1.7, color: 'var(--text-2)' }}>
          {[
            ['1', 'REGISTER', 'Get 100 free REP (soulbound, untransferable)'],
            ['2', 'PREDICT', 'Will this word appear in crypto news in the next 30 min?'],
            ['3', 'STAKE', 'Bet 10 REP on YES or NO'],
            ['4', 'WAIT', 'Oracle scans CoinDesk & Cointelegraph every 15 seconds'],
          ].map(([n, title, desc]) => (
            <div key={n} style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start' }}>
              <span style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--bg-4)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 800, color: 'var(--accent)', flexShrink: 0, fontFamily: "'JetBrains Mono', monospace" }}>{n}</span>
              <div><b style={{ color: 'var(--text-0)' }}>{title}</b> — {desc}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start' }}>
            <span style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--bg-4)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 800, color: 'var(--accent)', flexShrink: 0, fontFamily: "'JetBrains Mono', monospace" }}>5</span>
            <div><b style={{ color: 'var(--text-0)' }}>WIN/LOSE</b><br />Correct? REP back + share of losers' REP<br />Wrong? Staked REP is burned</div>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '18px 0', paddingTop: 18 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>What is REP?</div>
            <ul style={{ paddingLeft: 18 }}>
              <li>Soulbound reputation token — can't transfer or sell</li>
              <li>Earned by correct predictions</li>
              <li>Tracks your skill on the leaderboard</li>
              <li>Start with 100 REP, earn more by being right</li>
            </ul>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, color: 'var(--text-3)', fontSize: '0.78rem' }}>
            New round every 30 minutes. Words chosen by GameMaster AI from trending topics.
          </div>
        </div>
      </Modal>

      {/* ── Header ─────────────────────────────────────────── */}
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={S.logo}>
            <span style={{ color: 'var(--yes)' }}>MENTION</span>
            <span style={{ color: 'var(--text-3)' }}>FI</span>
          </span>
          <button onClick={() => setShowHelp(true)} style={S.helpBtn}>?</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {authenticated && repBalance !== null && (
            <span style={S.repBadge}>
              <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{fmtRep(repBalance)}</span>
              <span style={{ color: 'var(--text-3)', marginLeft: 4 }}>REP</span>
            </span>
          )}
          {authenticated ? (
            <button onClick={logout} style={S.walletBtn}>{fmtAddr(activeWallet?.address)}</button>
          ) : (
            <button onClick={login} style={S.connectBtn}>Connect Wallet</button>
          )}
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────── */}
      <main style={S.main}>

        {/* Welcome card */}
        {authenticated && isRegistered === false && (
          <div style={S.welcomeCard}>
            <div style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: 6, color: 'var(--text-0)' }}>Welcome to MentionFi</div>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.5 }}>
              Register to start playing — you'll receive <span style={{ color: 'var(--gold)', fontWeight: 600 }}>100 free REP</span>
            </p>
            <button onClick={handleRegister} disabled={registering} style={{ ...S.btnPrimary, background: 'var(--yes)', width: '100%', padding: '14px 20px', fontSize: '0.95rem' }}>
              {registering ? 'Registering...' : 'Register Now'}
            </button>
          </div>
        )}

        {!authenticated && <p style={{ color: 'var(--text-3)', fontSize: '0.82rem', marginBottom: 8 }}>Connect your wallet to start predicting</p>}

        {/* Question */}
        <p style={S.question}>
          Will this word appear in{' '}
          <span style={{ color: 'var(--accent)' }}>CoinDesk</span> or{' '}
          <span style={{ color: 'var(--accent)' }}>Cointelegraph</span>
          <br />in the next 30 minutes?
        </p>

        {/* Word Card */}
        <div style={{
          ...S.wordCard,
          animation: betFlash ? 'flash 0.6s ease' : round ? 'pulse 3s ease-in-out infinite' : 'pulse 3s ease-in-out infinite',
          borderColor: userBet === 'yes' ? 'rgba(0,210,106,0.4)' : userBet === 'no' ? 'rgba(255,71,87,0.4)' : 'var(--border)',
          boxShadow: userBet ? `0 4px 30px ${userBet === 'yes' ? 'rgba(0,210,106,0.15)' : 'rgba(255,71,87,0.15)'}` : '0 4px 20px rgba(0,0,0,0.3)',
        }}>
          {round ? (<>
            <div style={S.wordText}>{round.word}</div>
            {round.category && <div style={S.wordMeta}>
              <span style={S.catPill}>{round.category}</span>
              {round.difficulty && <span style={{ color: 'var(--text-3)', fontSize: '0.72rem' }}>{round.difficulty}</span>}
            </div>}
          </>) : (
            <div style={{ ...S.wordText, fontSize: '1.3rem', opacity: 0.5 }}>
              {nextRoundIn ? `Next word in ${fmtCountdown(nextRoundIn)}` : 'Waiting for next round...'}
            </div>
          )}
        </div>

        {/* Timer */}
        <div style={S.timerBlock}>
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1.1rem', fontWeight: 600, color: !round ? 'var(--text-2)' : isExpired ? 'var(--no)' : isUrgent ? 'var(--no)' : 'var(--text-0)' }}>
              {!round ? (nextRoundIn ? `Starts at :${new Date(Date.now() + nextRoundIn * 1000).getMinutes().toString().padStart(2, '0')}` : 'Waiting...') : isExpired ? 'RESOLVING...' : fmtCountdown(remaining) + ' remaining'}
            </span>
          </div>
          <div style={S.progressTrack}>
            <div style={{ height: '100%', borderRadius: 4, transition: 'width 1s linear', width: `${progress * 100}%`, background: isUrgent ? 'linear-gradient(90deg, var(--no-dark), var(--no))' : 'linear-gradient(90deg, var(--yes-dark), var(--yes))' }} />
          </div>
        </div>

        {/* Odds + Bet Buttons */}
        <div style={S.oddsRow}>
          <button onClick={() => handleBetClick(1)} disabled={betsDisabled} style={{ ...S.oddsBox, borderColor: userBet === 'yes' ? 'var(--yes)' : 'rgba(0,210,106,0.25)', background: userBet === 'yes' ? 'rgba(0,210,106,0.15)' : 'rgba(0,210,106,0.06)', opacity: betsDisabled && !userBet ? 0.4 : 1 }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7, marginBottom: 2, color: 'var(--yes)' }}>Yes</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--yes)', fontFamily: "'JetBrains Mono', monospace" }}>
              {!authenticated ? '—' : userBet === 'yes' ? '\u2713' : `${yesPercent}%`}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-3)', marginTop: 4 }}>{REP_STAKE} REP</div>
          </button>
          <button onClick={() => handleBetClick(2)} disabled={betsDisabled} style={{ ...S.oddsBox, borderColor: userBet === 'no' ? 'var(--no)' : 'rgba(255,71,87,0.25)', background: userBet === 'no' ? 'rgba(255,71,87,0.15)' : 'rgba(255,71,87,0.06)', opacity: betsDisabled && !userBet ? 0.4 : 1 }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7, marginBottom: 2, color: 'var(--no)' }}>No</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--no)', fontFamily: "'JetBrains Mono', monospace" }}>
              {!authenticated ? '—' : userBet === 'no' ? '\u2713' : `${noPercent}%`}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-3)', marginTop: 4 }}>{REP_STAKE} REP</div>
          </button>
        </div>

        {userBet && <p style={{ fontSize: '0.82rem', color: 'var(--text-2)', marginBottom: 8, textAlign: 'center' }}>You bet <span style={{ color: userBet === 'yes' ? 'var(--yes)' : 'var(--no)', fontWeight: 700 }}>{userBet.toUpperCase()}</span> this round</p>}

        {/* Pool */}
        <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: 32, textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
          Pool: <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{round?.pool?.totalRep ? fmtRep(round.pool.totalRep) : '0'} REP</span>
        </div>

        {/* Recent Rounds */}
        <div style={S.section}>
          <h3 style={S.sectionTitle}>Recent Rounds</h3>
          {history.length === 0 && <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', textAlign: 'center', padding: '12px 0' }}>No rounds yet</p>}
          {history.slice(0, 8).map((h, i) => (
            <div key={i} style={S.historyRow}>
              <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-1)' }}>"{h.word}"</span>
              <span style={{ width: 95, textAlign: 'center' }}>
                {h.status === 'resolved' ? (
                  <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: '0.68rem', fontWeight: 700, background: h.outcome === 'yes' ? 'rgba(0,210,106,0.1)' : 'rgba(255,71,87,0.1)', color: h.outcome === 'yes' ? 'var(--yes)' : 'var(--no)', border: `1px solid ${h.outcome === 'yes' ? 'rgba(0,210,106,0.2)' : 'rgba(255,71,87,0.2)'}` }}>
                    {h.outcome === 'yes' ? 'FOUND' : 'NOT FOUND'}
                  </span>
                ) : <span style={{ color: 'var(--text-3)', fontSize: '0.72rem', fontWeight: 600 }}>{h.status === 'betting' ? 'LIVE' : h.status?.toUpperCase()}</span>}
              </span>
              <span style={{ width: 44, textAlign: 'right', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-3)', fontFamily: "'JetBrains Mono', monospace" }}>#{h.questId}</span>
            </div>
          ))}
        </div>

        {/* Leaderboard */}
        {leaderboard.length > 0 && (
          <div style={S.section}>
            <h3 style={S.sectionTitle}>Leaderboard</h3>
            <table style={S.lbTable}>
              <thead>
                <tr>
                  <th style={{ ...S.lbTh, width: 36 }}>#</th>
                  <th style={S.lbTh}>Player</th>
                  <th style={{ ...S.lbTh, textAlign: 'right' }}>REP</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.slice(0, 10).map((entry, i) => {
                  const isMe = activeWallet?.address?.toLowerCase() === entry.address?.toLowerCase();
                  return (
                    <tr key={i} style={{ background: isMe ? 'var(--bg-3)' : 'transparent' }}>
                      <td style={{ ...S.lbTd, fontWeight: 600, color: i < 3 ? 'var(--gold)' : 'var(--text-3)' }}>{entry.rank}</td>
                      <td style={{ ...S.lbTd, fontFamily: "'JetBrains Mono', monospace", fontSize: '0.78rem', color: isMe ? 'var(--text-0)' : 'var(--text-2)' }}>
                        {fmtAddr(entry.address)}
                        {isMe && <span style={{ color: 'var(--accent)', fontSize: '0.68rem', marginLeft: 6, fontWeight: 600 }}>YOU</span>}
                      </td>
                      <td style={{ ...S.lbTd, textAlign: 'right', fontWeight: 700, color: 'var(--yes)', fontFamily: "'JetBrains Mono', monospace" }}>{fmtRep(entry.rep)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        <div style={S.footer}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--yes)', display: 'inline-block' }} />
          <span>MegaETH Testnet</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>Oracle scanning every 15s</span>
        </div>
      </main>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const S = {
  wrapper: { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center' },

  // Toast
  toast: { position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-2)', border: '1px solid', borderRadius: 10, padding: '10px 24px', fontSize: '0.85rem', color: 'var(--text-1)', zIndex: 1000, whiteSpace: 'nowrap', backdropFilter: 'blur(12px)' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.15s ease', padding: 20 },
  modal: { maxWidth: 420, width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 20, padding: 24, animation: 'modalEnter 0.3s ease', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid var(--border)' },
  modalTitle: { fontSize: '1rem', fontWeight: 700, color: 'var(--text-0)' },
  modalClose: { background: 'var(--bg-4)', border: '1px solid var(--border)', color: 'var(--text-2)', width: 32, height: 32, borderRadius: '50%', fontSize: '0.9rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },

  // Buttons
  btnPrimary: { flex: 1, padding: '12px 20px', borderRadius: 10, border: 'none', fontSize: '0.88rem', fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },
  btnSecondary: { flex: 1, padding: '12px 20px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', fontSize: '0.88rem', fontWeight: 500, color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },

  // Header
  header: { width: '100%', maxWidth: 540, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 100, background: 'rgba(10,10,10,0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' },
  logo: { fontFamily: "'JetBrains Mono', monospace", fontSize: '0.95rem', fontWeight: 800, letterSpacing: 1 },
  helpBtn: { width: 28, height: 28, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-3)', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.2s' },
  repBadge: { background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 10px', fontSize: '0.78rem', fontFamily: "'JetBrains Mono', monospace" },
  connectBtn: { background: 'var(--yes)', color: '#000', border: 'none', borderRadius: 10, padding: '8px 18px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },
  walletBtn: { background: 'var(--bg-3)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer', transition: 'all 0.2s' },

  // Welcome
  welcomeCard: { width: '100%', background: 'var(--bg-2)', border: '1px solid rgba(0,210,106,0.2)', borderRadius: 20, padding: 28, textAlign: 'center', marginBottom: 20, boxShadow: '0 4px 20px rgba(0,210,106,0.05)' },

  // Main
  main: { width: '100%', maxWidth: 540, padding: '20px 20px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center' },

  // Question
  question: { fontSize: '0.95rem', color: 'var(--text-2)', textAlign: 'center', lineHeight: 1.6, margin: '0 0 24px' },

  // Word card
  wordCard: { width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 20, padding: '36px 20px 28px', marginBottom: 20, textAlign: 'center', transition: 'all 0.3s ease' },
  wordText: { fontFamily: "'JetBrains Mono', monospace", fontSize: '2.5rem', fontWeight: 800, letterSpacing: 4, color: 'var(--text-0)', textTransform: 'uppercase' },
  wordMeta: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
  catPill: { display: 'inline-block', padding: '4px 10px', borderRadius: 20, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', background: 'var(--bg-4)', color: 'var(--text-2)' },

  // Timer
  timerBlock: { width: '100%', marginBottom: 20 },
  progressTrack: { width: '100%', height: 6, borderRadius: 3, background: 'var(--bg-4)', overflow: 'hidden' },

  // Odds
  oddsRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, width: '100%', marginBottom: 16 },
  oddsBox: { padding: '16px 12px', borderRadius: 14, textAlign: 'center', cursor: 'pointer', border: '1px solid', transition: 'all 0.2s', background: 'transparent', fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent' },

  // Sections
  section: { width: '100%', borderTop: '1px solid var(--border)', paddingTop: 20, marginBottom: 12 },
  sectionTitle: { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12, textAlign: 'center' },

  // History
  historyRow: { display: 'flex', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' },

  // Leaderboard
  lbTable: { width: '100%', borderCollapse: 'collapse' },
  lbTh: { textAlign: 'left', padding: '6px 10px', fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-3)', borderBottom: '1px solid var(--border)' },
  lbTd: { padding: '9px 10px', fontSize: '0.82rem', borderBottom: '1px solid rgba(255,255,255,0.04)' },

  // Footer
  footer: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 32, fontSize: '0.72rem', color: 'var(--text-3)' },
};

// ─── App ────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <GameScreen />
    </PrivyProvider>
  );
}
