import { useEffect, useRef } from "react";

const KEYWORDS = [
  "bitcoin", "ethereum", "trump", "deepseek", "openai", "nvidia", "claude",
  "megaeth", "fed", "inflation", "ai", "llm", "gpt", "musk", "apple",
  "google", "war", "china", "sec", "etf", "binance", "coinbase", "meta",
  "microsoft", "anthropic", "chatgpt", "solana", "defi", "nft", "dao",
  "crypto", "mention", "quest", "stake", "oracle", "feed", "rss", "bet",
  "yes", "no", "claim", "resolve", "rep", "pool", "odds", "market",
];

const FEEDS = ["CoinDesk", "HackerNews", "CNBC", "Cointelegraph", "TechCrunch", "Yahoo"];

export default function MentionBg() {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let words = [];
    let tickers = [];
    let pulses = [];
    let time = 0;

    const spawnWord = (cols, rows, cellW, cellH) => {
      const word = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
      const isHighlight = Math.random() < 0.15;
      const isFeed = Math.random() < 0.1;
      const text = isFeed ? FEEDS[Math.floor(Math.random() * FEEDS.length)] : word;
      return {
        text,
        x: Math.random() * (cols - text.length) * cellW,
        y: Math.random() * rows * cellH,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -0.1 - Math.random() * 0.2,
        life: 1,
        decay: 0.001 + Math.random() * 0.003,
        highlight: isHighlight,
        isFeed,
        size: isFeed ? 14 : (10 + Math.random() * 4),
        glow: Math.random() < 0.08,
      };
    };

    const spawnTicker = (canvasW) => ({
      texts: Array.from({ length: 8 }, () => {
        const kw = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
        const matched = Math.random() < 0.3;
        return { text: kw, matched };
      }),
      y: 30 + Math.random() * (canvas.height - 60),
      x: canvasW + 100,
      speed: 0.4 + Math.random() * 0.6,
      alpha: 0.06 + Math.random() * 0.08,
    });

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      words = [];
      tickers = [];
      for (let i = 0; i < 40; i++) words.push(spawnWord(80, 50, 10, 16));
      for (let i = 0; i < 4; i++) tickers.push(spawnTicker(canvas.width));
    };

    resize();
    window.addEventListener("resize", resize);

    const animate = () => {
      time += 0.016;
      ctx.fillStyle = "rgba(10,10,15,0.92)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid lines (subtle)
      ctx.strokeStyle = "rgba(0,255,136,0.015)";
      ctx.lineWidth = 0.5;
      for (let x = 0; x < canvas.width; x += 60) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 60) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      }

      // Floating keywords
      for (let i = words.length - 1; i >= 0; i--) {
        const w = words[i];
        w.x += w.vx;
        w.y += w.vy;
        w.life -= w.decay;

        if (w.life <= 0) {
          words[i] = spawnWord(80, 50, 10, 16);
          continue;
        }

        const alpha = w.life * (w.highlight ? 0.25 : 0.08);
        ctx.font = `${w.size}px "JetBrains Mono", "Courier New", monospace`;

        if (w.glow) {
          ctx.shadowColor = w.isFeed ? "rgba(0,187,255,0.4)" : "rgba(0,255,136,0.3)";
          ctx.shadowBlur = 12;
        }

        if (w.isFeed) {
          ctx.fillStyle = `rgba(0,187,255,${alpha * 1.5})`;
        } else if (w.highlight) {
          ctx.fillStyle = `rgba(0,255,136,${alpha})`;
        } else {
          ctx.fillStyle = `rgba(100,100,150,${alpha})`;
        }

        ctx.fillText(w.text, w.x, w.y);
        ctx.shadowBlur = 0;
      }

      // Ticker streams (horizontal scrolling keyword feeds)
      for (const t of tickers) {
        t.x -= t.speed;
        let offsetX = t.x;
        ctx.font = '11px "JetBrains Mono", monospace';
        for (const item of t.texts) {
          const color = item.matched
            ? `rgba(0,255,136,${t.alpha * 2})`
            : `rgba(68,68,90,${t.alpha})`;
          ctx.fillStyle = color;
          ctx.fillText(item.text, offsetX, t.y);
          offsetX += ctx.measureText(item.text).width + 30;
        }
        if (offsetX < -100) {
          Object.assign(t, spawnTicker(canvas.width));
        }
      }

      // Occasional pulse rings (mention detected!)
      if (Math.random() < 0.008) {
        pulses.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          r: 0, maxR: 60 + Math.random() * 80,
          life: 1,
        });
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.r += 1.5;
        p.life -= 0.015;
        if (p.life <= 0) { pulses.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,255,136,${p.life * 0.15})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Scanlines
      ctx.fillStyle = "rgba(0,0,0,0.04)";
      for (let y = 0; y < canvas.height; y += 3) ctx.fillRect(0, y, canvas.width, 1);

      // Vignette
      const vg = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, canvas.height * 0.3,
        canvas.width / 2, canvas.height / 2, canvas.height * 0.8
      );
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.4)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      frameRef.current = requestAnimationFrame(animate);
    };

    animate();
    return () => {
      window.removeEventListener("resize", resize);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        top: 0, left: 0,
        width: "100%", height: "100%",
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
}
