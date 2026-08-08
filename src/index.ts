import 'dotenv/config';
import { getDb } from './db/schema';
import { startWebServer } from './web/server';

/* ── 마지막 그물 ────────────────────────────────────────────────────
   요청 처리는 server.ts 가 통째로 try/catch 로 감싸지만, 그 바깥에서 나는 예외 —
   소켓 오류, 라이브러리 내부의 비동기 던짐 — 는 여기까지 온다. 기본 동작은 프로세스
   종료이고, 그러면 한 사람의 요청 때문에 판에 앉아 있던 모두가 끊긴다.

   그래서 적고 계속 돈다. 이 서버는 그렇게 해도 되는 모양이다:
     · 게임 상태는 전부 SQLite 에 있고 매 요청마다 다시 계산한다(지연 진행 구조).
       메모리에 들고 있다가 망가질 판이 없다.
     · 트랜잭션은 동기이고, 던지면 tx() 의 catch 가 ROLLBACK 하고 finally 가 깊이를
       되돌린다. 예외가 여기 닿을 때는 이미 열린 트랜잭션이 없다.
   조용히 죽는 것보다 로그를 남기고 사는 쪽이 낫다 — 죽으면 무엇 때문이었는지도 남지 않는다. */
process.on('unhandledRejection', (reason) => {
  console.error('미처리 거부:', reason);
});

/* 다만 삼키기만 하면 정말로 망가진 프로세스가 영영 남는다. fly.toml 은 헬스체크를
   일부러 안 넣었으므로(절전을 깨뜨릴지가 확인되지 않았다) 밖에서 알아채고 되살려 줄
   장치가 없다 — 그래서 스스로 판단해야 한다.
   요청 하나가 이상해서 나는 예외는 드문드문 온다. 짧은 사이에 몰려서 온다면 그건
   "어떤 요청이 이상하다"가 아니라 "이 프로세스가 이상하다"는 뜻이므로, 그때는 나가서
   새로 뜨는 쪽이 낫다(fly 가 다시 띄운다). */
const EXC_BURST = 20;          // 이만큼이
const EXC_WINDOW_MS = 60_000;  // 이 시간 안에 몰리면 프로세스가 망가진 것으로 본다
let excTimes: number[] = [];
process.on('uncaughtException', (err) => {
  console.error('미처리 예외:', err);
  const now = Date.now();
  excTimes = excTimes.filter(t => now - t < EXC_WINDOW_MS);
  excTimes.push(now);
  if (excTimes.length >= EXC_BURST) {
    console.error(`미처리 예외가 ${EXC_WINDOW_MS / 1000}초 안에 ${excTimes.length}번 —`
      + ' 프로세스가 망가진 것으로 보고 종료한다');
    process.exit(1);
  }
});

getDb();       // 스키마 초기화를 부팅 시점에 즉시 수행 (요청 시점 지연 방지)
startWebServer();

// Gateway(Client.login) 없음 — 디스코드 상호작용은 /discord/interactions 웹훅으로만 받는다.
// 그래야 fly.io가 유휴 시 이 프로세스를 완전히 재울 수 있다(scale-to-zero).
