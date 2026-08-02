// 디스코드 인터랙션 감사 — 실제로 서명한 요청을 보내 응답 형태와 DB 반영을 확인한다.
//
// 특히 버튼 클릭 응답이 "답글이 아닌지"를 본다. 응답으로 메시지를 만들면 디스코드가 그걸
// 버튼 메시지의 답글로 붙이는데, 우리는 버튼을 맨 아래로 내리려고 그 원본을 지우므로
// 남은 로그마다 "원본 메시지가 삭제되었어요"가 달린다. 그래서 응답은 조용한 ACK여야 한다.

// 감사는 항상 일회용 DB에서 돈다.
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
}

import http from 'node:http';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

const PORT = Number(process.env.AUDIT_PORT ?? 8215);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

// 우리 서버가 검증에 쓸 공개키를 여기서 만든 키쌍으로 맞춘다 (첫 import 전에 설정해야 한다)
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.DISCORD_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('hex');
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? 'invalid-token-for-audit';

interface Res { status: number; body: any }
function send(payload: unknown, opts: { sign?: boolean } = {}): Promise<Res> {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  if (opts.sign !== false) {
    headers['x-signature-timestamp'] = ts;
    headers['x-signature-ed25519'] = edSign(null, Buffer.from(ts + body), privateKey).toString('hex');
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/discord/interactions', method: 'POST', headers }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        let parsed: any = null; try { parsed = JSON.parse(t); } catch { /* 빈 응답 */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    r.write(body); r.end();
  });
}

const CHANNEL = '111111111111111111';
function button(customId: string, userId: string, username: string) {
  return {
    type: 3, // MESSAGE_COMPONENT
    channel_id: CHANNEL,
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: userId, username, global_name: username, avatar: null } },
  };
}

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  const { getWebUser, adjustBalance, upsertUser } = require('../src/db/queries') as typeof import('../src/db/queries');
  process.env.PORT = String(PORT);
  startWebServer();
  await new Promise(r => setTimeout(r, 600));

  /* ── 서명 검증 ─────────────────────────────────────────────── */
  section('[1] 서명 검증 (fail-closed)');
  {
    ck('서명 없으면 401', (await send({ type: 1 }, { sign: false })).status === 401);
    const pong = await send({ type: 1 });
    ck('올바른 서명 + PING → PONG', pong.status === 200 && pong.body?.type === 1, JSON.stringify(pong.body));
  }

  /* ── 출석 버튼 ─────────────────────────────────────────────── */
  section('[2] 출석 버튼 — 응답이 답글을 만들지 않는가');
  {
    const r = await send(button('attendance_checkin', '900000000000000001', '감사테스터'));
    ck('응답 200', r.status === 200, String(r.status));
    // type 6 = DEFERRED_UPDATE_MESSAGE — 아무 메시지도 만들지 않는 조용한 ACK
    ck('응답 타입이 6 (조용한 ACK)', r.body?.type === 6, JSON.stringify(r.body));
    ck('응답에 메시지 본문이 없음 (답글이 안 생긴다)',
      r.body?.data?.content == null, JSON.stringify(r.body?.data));

    const u = getWebUser('900000000000000001');
    ck('출석 포인트가 실제로 지급됨', (u?.balance ?? 0) > 0, String(u?.balance));
    ck('연속 출석 1일로 기록', u?.current_streak === 1, String(u?.current_streak));

    // 같은 날 두 번째 클릭 → 본인에게만 보이는 안내(ephemeral)로 끝나야 한다
    const again = await send(button('attendance_checkin', '900000000000000001', '감사테스터'));
    ck('두 번째 클릭은 ephemeral 안내', again.body?.type === 4 && again.body?.data?.flags === 64,
      JSON.stringify(again.body));
    ck('두 번째 클릭으로 추가 지급 없음',
      getWebUser('900000000000000001')!.balance === u!.balance, String(getWebUser('900000000000000001')!.balance));
  }

  /* ── 지원금 버튼 ───────────────────────────────────────────── */
  section('[3] 지원금 버튼');
  {
    upsertUser('900000000000000002', '파산테스터', null);
    const r = await send(button('relief_claim', '900000000000000002', '파산테스터'));
    ck('0P 유저 → 조용한 ACK (답글 없음)', r.body?.type === 6, JSON.stringify(r.body));
    ck('지원금 200P 지급', getWebUser('900000000000000002')?.balance === 200,
      String(getWebUser('900000000000000002')?.balance));

    const again = await send(button('relief_claim', '900000000000000002', '파산테스터'));
    ck('잔액 남은 상태 재신청 → ephemeral 거절', again.body?.type === 4 && again.body?.data?.flags === 64,
      JSON.stringify(again.body));
    ck('거절 시 추가 지급 없음', getWebUser('900000000000000002')?.balance === 200,
      String(getWebUser('900000000000000002')?.balance));

    // 잔액을 0으로 만들어도 쿨다운이면 거절
    adjustBalance('900000000000000002', -200, 'audit:burn');
    const cooled = await send(button('relief_claim', '900000000000000002', '파산테스터'));
    ck('쿨다운 중 재신청 → ephemeral 거절', cooled.body?.type === 4 && cooled.body?.data?.flags === 64,
      JSON.stringify(cooled.body));
    ck('쿨다운 거절 시 잔액 0 유지', getWebUser('900000000000000002')?.balance === 0,
      String(getWebUser('900000000000000002')?.balance));
  }

  /* ── 알 수 없는 버튼 ───────────────────────────────────────── */
  section('[4] 알 수 없는 입력');
  {
    const r = await send(button('nope_button', '900000000000000003', '이상한사람'));
    ck('모르는 버튼은 ephemeral 안내', r.body?.type === 4 && r.body?.data?.flags === 64, JSON.stringify(r.body));
    const cmd = await send({
      type: 2, channel_id: CHANNEL, data: { name: '없는커맨드' },
      member: { user: { id: '900000000000000003', username: '이상한사람', avatar: null } },
    });
    ck('모르는 커맨드도 ephemeral 안내', cmd.body?.type === 4 && cmd.body?.data?.flags === 64, JSON.stringify(cmd.body));
  }

  /* ── 관리자 전용 커맨드 ────────────────────────────────────── */
  section('[5] 관리자 전용 커맨드 권한');
  {
    for (const name of ['출석판생성', '지원금판생성', '카지노판생성']) {
      const r = await send({
        type: 2, channel_id: CHANNEL, data: { name },
        member: { user: { id: '900000000000000003', username: '이상한사람', avatar: null } },
      });
      const msg = String(r.body?.data?.content ?? '');
      ck(`/${name} — 일반 유저 거절`, r.body?.data?.flags === 64 && msg.includes('관리자'), msg);
    }
  }

  /* ── 응답 시간 ─────────────────────────────────────────────── */
  section('[6] 3초 제한');
  {
    const t0 = Date.now();
    await send(button('attendance_checkin', '900000000000000004', '속도테스터'));
    const ms = Date.now() - t0;
    ck(`응답이 3초 안에 돌아옴 (${ms}ms)`, ms < 3000, `${ms}ms`);
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
