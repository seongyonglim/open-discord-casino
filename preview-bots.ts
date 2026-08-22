// 로컬 테스트용 더미 플레이어 봇.
// "다른 사람이 같이 플레이하는 화면"을 만들어 보기 위한 도구로, 실서버와 무관하다.
// 계정·세션·잔액을 스스로 준비하므로 DB를 지우고 다시 시작해도 그냥 돌아간다.
//
//   npm run bots                       # 포커 플립에서 2명이 베팅 (기본 20분)
//   BOT_GAME=ladder npm run bots       # 사다리게임
//   BOT_GAME=crash  npm run bots       # 그래프게임
//   BOT_GAME=mines  npm run bots       # 지뢰찾기
//   BOT_GAME=baccarat npm run bots     # 바카라
//   BOT_MINUTES=60 BOT_GAME=poker npm run bots
//
// 새 게임을 붙일 때는 아래 GAMES에 { wait, act } 한 벌만 추가하면 된다.
import { upsertUser, createSession, getWebUser, adjustBalance } from './src/db/queries';
import { getDb } from './src/db/schema';

const BASE = process.env.BOT_BASE ?? 'http://localhost:8080';
const GAME = (process.env.BOT_GAME ?? 'poker').toLowerCase();
const RUN_MIN = Number(process.env.BOT_MINUTES ?? 20);
const REFILL_AT = 500_000;   // 이 아래로 떨어지면 채워 준다
const REFILL_TO = 5_000_000;

interface Bot { id: string; name: string; token: string; cookie: string; style: 'whale' | 'spread' }

/* 다섯이다. 둘일 때는 «한 구역에 여러 사람이 겹쳐 걸었을 때» 가 잘 안 나와서,
   칩 목록이 사람마다 어떻게 섞이는지·상한을 넘겼을 때 어떻게 되는지가 안 드러났다.
   whale 은 크게 몰아서 걸고 spread 는 여러 구역에 잘게 뿌린다 — 둘을 섞어야
   «큰 칩 몇 장» 과 «잔칩 수십 장» 이 한 판에 같이 올라온다. */
const BOTS: Bot[] = [
  { id: 'preview-bot-2', name: '두번째유저', token: 'previewbottoken2', cookie: '', style: 'whale' },
  { id: 'preview-bot-3', name: '타짜김씨', token: 'previewbottoken3', cookie: '', style: 'spread' },
  { id: 'preview-bot-4', name: '박올인', token: 'previewbottoken4', cookie: '', style: 'whale' },
  { id: 'preview-bot-5', name: '이잔챙이', token: 'previewbottoken5', cookie: '', style: 'spread' },
  { id: 'preview-bot-6', name: '최한방', token: 'previewbottoken6', cookie: '', style: 'spread' },
];
BOTS.forEach(b => { b.cookie = `sid=${b.token}`; });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const rand = (n: number) => Math.floor(Math.random() * n);

// ── 계정 준비 ────────────────────────────────────────────────
// 예전 실행에서 쓰던 계정이 있어도 이름/세션/잔액을 다시 맞춰 준다.
function seedBots(): void {
  const db = getDb();
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  for (const b of BOTS) {
    upsertUser(b.id, b.name, null);
    db.prepare(`DELETE FROM web_sessions WHERE token = ?`).run(b.token);
    createSession(b.token, b.id, exp);
    const bal = getWebUser(b.id)?.balance ?? 0;
    if (bal < REFILL_TO) adjustBalance(b.id, REFILL_TO - bal, 'preview_bot_seed');
  }
  console.log(`봇 계정 준비: ${BOTS.map(b => `${b.name}(${b.id})`).join(', ')}`);
}

function refill(): void {
  for (const b of BOTS) {
    const bal = getWebUser(b.id)?.balance ?? 0;
    if (bal < REFILL_AT) adjustBalance(b.id, REFILL_TO - bal, 'preview_bot_refill');
  }
}

// ── HTTP 도우미 ──────────────────────────────────────────────
async function get(path: string, cookie: string): Promise<any> {
  const r = await fetch(BASE + path, { headers: { cookie } });
  return r.json();
}
async function post(path: string, cookie: string, body: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── 게임별 동작 ──────────────────────────────────────────────
// wait: 이번에 참여할 라운드가 열렸는지 (열렸으면 라운드 식별자 반환, 아니면 null)
// act : 봇 한 명이 그 라운드에 실제로 베팅하는 방식
interface GameBot {
  label: string;
  wait(): Promise<{ id: number | string; seconds: number } | null>;
  act(bot: Bot, seconds: number): Promise<void>;
}

const POKER_MARKETS = ['master', 'shark', 'b0', 'b1', 'b2', 'b3', 'b4'] as const;
const POKER_COINS = [100, 1000, 5000, 10000] as const;
const BACC_MARKETS = ['player', 'banker', 'tie', 'ppair', 'bpair'] as const;

const GAMES: Record<string, GameBot> = {
  poker: {
    label: '포커 플립',
    async wait() {
      const s = await get('/api/games/poker/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 4)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      const picks = bot.style === 'whale'
        ? Array.from({ length: 2 + rand(2) }, () => pick(POKER_MARKETS))
        : Array.from({ length: 4 + rand(3) }, () => pick(POKER_MARKETS));
      const window = Math.max(2000, (seconds - 2) * 1000);
      for (const market of picks) {
        const amount = bot.style === 'whale' ? pick([5000, 10000, 10000]) : pick(POKER_COINS);
        for (let i = 0, n = 1 + rand(bot.style === 'whale' ? 3 : 2); i < n; i++) {
          const r = await post('/api/games/poker/bet', bot.cookie, { market, amount });
          if (!r?.ok) return;                       // 마감되면 조용히 종료
          await sleep(120 + Math.random() * 260);   // 칩을 하나씩 얹는 느낌
        }
        await sleep(Math.random() * (window / picks.length));
      }
    },
  },

  /* 블랙잭. 다른 둘과 달리 «자리» 가 있다 — 마켓이 아니라 좌석 번호에 건다.
     자리를 따로 잡는 API 는 없다. 칩을 얹는 것이 곧 앉는 것이다(blackjack.ts 의
     handleBet 이 waiting 단계에서도 받는다 — 거기 앉는 것이 라운드 시작이다).
     봇마다 제 자리를 하나씩 맡는다: 다섯 자리에 다섯 봇이 한 명씩 앉는다. */
  blackjack: {
    label: '블랙잭',
    async wait() {
      const s = await get('/api/games/blackjack/state', BOTS[0].cookie);
      const ph = s?.round?.phase;
      if (ph !== 'betting' && ph !== 'waiting') return null;
      // waiting 은 아직 아무도 안 앉은 상태다 — 남은 시간이 없으므로 넉넉히 잡아 준다
      const secs = ph === 'waiting' ? 10 : (s.round.secondsLeft ?? 0);
      return secs >= 3 ? { id: s.round.id, seconds: secs } : null;
    },
    async act(bot, seconds) {
      const seat = BOTS.indexOf(bot) % 5;
      const window = Math.max(1500, (seconds - 2) * 1000);
      const n = bot.style === 'whale' ? 2 + rand(3) : 3 + rand(5);
      for (let i = 0; i < n; i++) {
        const amount = bot.style === 'whale' ? pick([5000, 10000]) : pick(POKER_COINS);
        const r = await post('/api/games/blackjack/bet', bot.cookie, { seat, amount });
        if (!r?.ok) return;                       // 마감되면 조용히 종료
        await sleep(120 + Math.random() * 260);   // 칩을 하나씩 얹는 느낌
      }
      await sleep(Math.random() * (window / 2));
    },
  },

  /* 바카라. 포커 플립과 같은 «마켓에 칩을 얹는» 게임이라 거는 방식도 같다.
     이걸 붙인 이유: 남이 걸 때 칩이 날아오는 연출을 로컬에서 확인할 방법이 없었다.
     바카라 화면을 열어 두고 아무리 기다려도 참가자가 나 혼자라 애니메이션이 돌 일이
     없었고, 그래서 "확인 못 했다" 를 두 번 보고했다. 볼 수 없는 것은 고칠 수도 없다. */
  baccarat: {
    label: '바카라',
    async wait() {
      const s = await get('/api/games/baccarat/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 3)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      const picks = bot.style === 'whale'
        ? Array.from({ length: 1 + rand(2) }, () => pick(BACC_MARKETS))
        : Array.from({ length: 2 + rand(3) }, () => pick(BACC_MARKETS));
      const window = Math.max(1500, (seconds - 2) * 1000);
      for (const market of picks) {
        const amount = bot.style === 'whale' ? pick([5000, 10000]) : pick(POKER_COINS);
        for (let i = 0, n = 1 + rand(bot.style === 'whale' ? 3 : 2); i < n; i++) {
          const r = await post('/api/games/baccarat/bet', bot.cookie, { market, amount });
          if (!r?.ok) return;                       // 마감되면 조용히 종료
          await sleep(120 + Math.random() * 260);   // 칩을 하나씩 얹는 느낌
        }
        await sleep(Math.random() * (window / picks.length));
      }
    },
  },
  ladder: {
    label: '사다리게임',
    async wait() {
      const s = await get('/api/games/ladder/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 3)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      await sleep(Math.random() * Math.max(500, (seconds - 2) * 700));
      const both = Math.random() < 0.35;            // 가끔 출발·홀짝 둘 다 예측
      await post('/api/games/ladder/bet', bot.cookie, {
        betAmount: bot.style === 'whale' ? pick([5000, 10000]) : pick([100, 1000]),
        startGuess: both || Math.random() < 0.5 ? pick(['L', 'R']) : null,
        parityGuess: both || Math.random() < 0.5 ? pick(['ODD', 'EVEN']) : null,
      });
    },
  },

  crash: {
    label: '그래프게임',
    async wait() {
      const s = await get('/api/games/crash/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 2)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      await sleep(Math.random() * Math.max(400, (seconds - 1) * 600));
      await post('/api/games/crash/bet', bot.cookie, {
        betAmount: bot.style === 'whale' ? pick([5000, 10000]) : pick([100, 1000]),
        // 자동 캐시아웃을 걸어두면 봇이 알아서 정산돼 캐시아웃 목록도 채워진다
        autoCashout: (1.2 + Math.random() * 3).toFixed(2),
      });
    },
  },

  mines: {
    label: '지뢰찾기',
    // 지뢰찾기는 1인 게임이라 공유 라운드가 없다 — 각자 계속 새 판을 돌린다
    async wait() { return { id: Date.now(), seconds: 0 }; },
    async act(bot) {
      const start = await post('/api/games/mines/start', bot.cookie, {
        betAmount: bot.style === 'whale' ? pick([5000, 10000]) : pick([100, 1000]),
        mineCount: pick([1, 3, 5, 10]),
      });
      if (!start?.ok) return;
      const opens = 1 + rand(4);
      for (let i = 0; i < opens; i++) {
        await sleep(400 + Math.random() * 600);
        const r = await post('/api/games/mines/reveal', bot.cookie, { tile: rand(25) });
        if (!r?.ok || r?.round?.status !== 'active') return;   // 지뢰를 밟았으면 끝
      }
      await sleep(400);
      await post('/api/games/mines/cashout', bot.cookie, {});
    },
  },
};

// ── 실행 ────────────────────────────────────────────────────
(async () => {
  const game = GAMES[GAME];
  if (!game) {
    console.error(`알 수 없는 게임: ${GAME} (가능: ${Object.keys(GAMES).join(', ')})`);
    process.exit(1);
  }
  seedBots();

  const until = Date.now() + RUN_MIN * 60 * 1000;
  let lastId: number | string | null = null;
  console.log(`${game.label} — 봇 ${BOTS.length}명 가동, ${RUN_MIN}분간`);
  console.log(`브라우저에서 ${BASE} 를 열어두면 실시간으로 보입니다.`);

  while (Date.now() < until) {
    try {
      const round = await game.wait();
      if (round && round.id !== lastId) {
        lastId = round.id;
        refill();
        console.log(`라운드 ${round.id} 참가${round.seconds ? ` (${round.seconds}초)` : ''}`);
        await Promise.all(BOTS.map(b => game.act(b, round.seconds)));
      }
    } catch {
      // 서버 재시작 등은 무시하고 계속 시도
    }
    await sleep(GAME === 'mines' ? 1500 : 600);
  }
  console.log('봇 종료');
})();
