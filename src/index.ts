import 'dotenv/config';
import { getDb } from './db/schema';
import { startWebServer } from './web/server';

getDb();       // 스키마 초기화를 부팅 시점에 즉시 수행 (요청 시점 지연 방지)
startWebServer();

// Gateway(Client.login) 없음 — 디스코드 상호작용은 /discord/interactions 웹훅으로만 받는다.
// 그래야 fly.io가 유휴 시 이 프로세스를 완전히 재울 수 있다(scale-to-zero).
