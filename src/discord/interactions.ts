// 디스코드 인터랙션(버튼/슬래시커맨드) 수신 엔드포인트.
// Gateway(웹소켓) 상시 연결 없이 Discord가 직접 HTTPS로 요청을 쏘는 방식 → fly.io scale-to-zero와 호환된다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { REST, Routes, ComponentType, ButtonStyle } from 'discord.js';
import { checkIn, rewardSummary } from '../services/economy';
import { claim as claimRelief, RELIEF_AMOUNT, RELIEF_COOLDOWN_SEC } from '../services/relief';
import {
  upsertUser, ensureSeedAdmin, getWebUser, getLeaderboard,
  getBoard, setBoard, clearBoard, type BoardKind,
} from '../db/queries';
import { pts, signedPts, reasonLabel, esc } from '../web/views';
import { env } from '../env';

const PUBLIC_KEY = env('DISCORD_PUBLIC_KEY');
const SEED_ADMIN = env('SEED_ADMIN_DISCORD_ID');

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function json(res: ServerResponse, obj: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function ephemeral(res: ServerResponse, content: string): void {
  json(res, { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: 64 } });
}

function publicReply(res: ServerResponse, content: string): void {
  json(res, { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content } });
}

// 버튼을 눌렀다는 사실만 조용히 인정하고 아무 메시지도 만들지 않는다.
//
// 버튼 클릭에 대한 응답 메시지는 디스코드가 "버튼이 달린 메시지에 대한 답글"로 붙인다.
// 그런데 우리는 버튼을 맨 아래로 내리려고 그 원본 메시지를 지운다 → 남아 있는 로그마다
// "원본 메시지가 삭제되었어요"가 달려 지저분해진다.
// 그래서 응답으로는 아무것도 만들지 않고, 로그는 postChannelMessage로 독립 메시지로 찍는다.
function ackSilently(res: ServerResponse): void {
  json(res, { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
}

// 답글이 아닌 독립 메시지로 채널에 남긴다 (버튼 메시지를 지워도 영향받지 않는다)
async function postChannelMessage(channelId: string, content: string): Promise<void> {
  await rest.post(Routes.channelMessages(channelId), { body: { content } });
}

// 인터랙션 페이로드에서 호출자 식별 (길드 채널: interaction.member.user, DM: interaction.user)
function identifyCaller(interaction: any): { id: string; username: string; avatar: string | null } {
  const u = interaction.member?.user ?? interaction.user;
  const id: string = u.id;
  const username: string = u.global_name || u.username || id;
  const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png?size=64` : null;
  return { id, username, avatar };
}

function registerUser(id: string, username: string, avatar: string | null): void {
  upsertUser(id, username, avatar);
  if (SEED_ADMIN && id === SEED_ADMIN) ensureSeedAdmin(id);
}

const rest = new REST().setToken(env('DISCORD_TOKEN'));

/* ── 고정(스티키) 버튼 메시지 ──────────────────────────────────────────
   신청 로그가 하나씩 쌓이면 버튼 메시지가 위로 밀려 올라가 결국 스크롤해야 찾게 된다.
   그래서 로그를 남길 때마다 이전 버튼 메시지를 지우고 맨 아래에 새로 올려 항상 최신으로 둔다.
   (디스코드에는 메시지를 아래로 옮기는 기능이 없어서 지우고 다시 올리는 방법뿐이다) */
interface BoardSpec { content: string; label: string; customId: string; style: number; image?: string | null }

// 파산한 표정의 이미지를 지원금판에 같이 띄운다. 파일이 없으면 조용히 생략한다
// (존재하지 않는 URL을 넣으면 임베드가 깨진 채로 보인다).
function reliefImageUrl(): string | null {
  try {
    if (!existsSync(join(process.cwd(), 'public', 'img', 'broke.jpg'))) return null;
  } catch { return null; }
  const base = (env('CASINO_URL') || 'https://odcasino.kro.kr').replace(/\/+$/, '');
  return `${base}/img/broke.jpg`;
}

function boardSpec(kind: BoardKind): BoardSpec {
  if (kind === 'attendance') {
    return {
      content: '**오늘도 출석하고 포인트 받아가세요!**\n' + rewardSummary() + '\n(KST 자정에 초기화됩니다)',
      label: '출석체크', customId: 'attendance_checkin', style: ButtonStyle.Success,
    };
  }
  // 웹에 있던 지원금 페이지를 없앴으므로 안내 문구를 여기로 옮겨 왔다
  const hours = Math.round(RELIEF_COOLDOWN_SEC / 3600);
  return {
    content: '**개인회생 지원금**\n'
      + '포인트를 전부 잃었을 때 다시 시작할 수 있도록 드리는 지원금입니다.\n\n'
      + `· 지급액 **${RELIEF_AMOUNT.toLocaleString('ko-KR')}P**\n`
      + '· 보유 포인트가 **정확히 0P**일 때만 신청할 수 있습니다\n'
      + `· 한 번 받으면 **${hours}시간** 뒤에 다시 신청할 수 있습니다`,
    label: '지원금 신청', customId: 'relief_claim', style: ButtonStyle.Primary,
    image: reliefImageUrl(),
  };
}

async function postBoard(kind: BoardKind, channelId: string): Promise<void> {
  const spec = boardSpec(kind);
  const body: Record<string, unknown> = {
    components: [{
      type: ComponentType.ActionRow,
      components: [{ type: ComponentType.Button, style: spec.style, label: spec.label, custom_id: spec.customId }],
    }],
  };
  // 이미지는 임베드에만 붙일 수 있어서, 이미지가 있을 때는 본문을 임베드 설명으로 옮긴다
  if (spec.image) body.embeds = [{ description: spec.content, image: { url: spec.image }, color: 0xd4af37 }];
  else body.content = spec.content;
  const msg = await rest.post(Routes.channelMessages(channelId), { body }) as { id?: string };
  if (msg?.id) setBoard(kind, channelId, msg.id);
}

// 버튼을 다시 맨 아래로 내린다. 이전 메시지는 이미 지워졌을 수도 있으므로 실패해도 계속 진행한다.
async function bumpBoard(kind: BoardKind, channelId: string): Promise<void> {
  const prev = getBoard(kind);
  if (prev) {
    await rest.delete(Routes.channelMessage(prev.channel_id, prev.message_id))
      .catch(() => { /* 이미 지워졌거나 권한이 없으면 그냥 새로 올린다 */ });
    clearBoard(kind);
  }
  await postBoard(kind, channelId);
}

// 카지노 사이트로 보내는 링크 버튼.
// 링크 버튼(style 5)은 URL만 열고 신원을 담지 못하므로 로그인은 사이트의 OAuth가 처리한다.
// /go 로 보내는 이유: 세션이 있으면 로비로 직행하고, 없으면 OAuth로 넘겨
// 이미 앱을 승인한 사용자는 확인 화면 없이 되돌아온다(클릭 한 번으로 입장이 끝난다).
async function postCasinoBoard(channelId: string): Promise<void> {
  const url = (env('CASINO_URL') || 'https://odcasino.kro.kr').replace(/\/+$/, '') + '/go';
  await rest.post(Routes.channelMessages(channelId), {
    body: {
      embeds: [{
        title: 'OD CASINO',
        description: '출석으로 모은 포인트로 즐기는 오픈디코 전용 카지노.\n'
          + '지뢰찾기 · 사다리게임 · 그래프게임 · 포커 플립\n\n'
          + '아래 버튼을 누르면 바로 입장합니다. (오픈디코 서버 멤버만 입장 가능)',
        color: 0xd4af37,
      }],
      components: [{
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: '카지노 입장',
          url,
        }],
      }],
    },
  });
}

async function handleCommand(interaction: any, res: ServerResponse): Promise<void> {
  const name = interaction.data?.name;
  const caller = identifyCaller(interaction);
  registerUser(caller.id, caller.username, caller.avatar);

  if (name === '내점수') {
    const u = getWebUser(caller.id)!;
    return ephemeral(res, `잔액 **${pts(u.balance)}** · 연속 출석 **${u.current_streak}일**`);
  }

  if (name === '랭킹') {
    const rows = getLeaderboard(10);
    const lines = rows.map((r, i) => `**${i + 1}.** ${esc(r.username)} — ${pts(r.balance)}`).join('\n');
    return publicReply(res, `**포인트 랭킹 TOP 10**\n${lines || '아직 데이터가 없습니다'}`);
  }

  if (name === '출석판생성') {
    const u = getWebUser(caller.id);
    if (u?.role !== 'admin') return ephemeral(res, '관리자만 사용할 수 있는 명령어입니다.');
    if (!interaction.channel_id) return ephemeral(res, '채널 정보를 확인할 수 없습니다.');
    // 디스코드 인터랙션은 3초 안에 응답해야 한다. 채널에 메시지를 올리는 REST 호출을
    // 먼저 await하면 그 왕복(+절전에서 깨어난 직후라면 기동 시간)이 3초 예산을 잡아먹어
    // 게시는 성공했는데도 "애플리케이션이 응답하지 않았어요"가 뜬다.
    // 그래서 응답을 먼저 돌려주고 게시는 그 뒤에 이어서 한다.
    ephemeral(res, '이 채널에 출석체크 메시지를 게시합니다.');
    await bumpBoard('attendance', interaction.channel_id)
      .catch((e: unknown) => console.error('출석판 게시 실패:', e));
    return;
  }

  if (name === '지원금판생성') {
    const u = getWebUser(caller.id);
    if (u?.role !== 'admin') return ephemeral(res, '관리자만 사용할 수 있는 명령어입니다.');
    if (!interaction.channel_id) return ephemeral(res, '채널 정보를 확인할 수 없습니다.');
    // 출석판과 같은 이유로 응답을 먼저 보내고 게시는 그 뒤에 한다 (3초 제한)
    ephemeral(res, '이 채널에 개인회생 지원금 메시지를 게시합니다.');
    await bumpBoard('relief', interaction.channel_id)
      .catch((e: unknown) => console.error('지원금판 게시 실패:', e));
    return;
  }

  if (name === '카지노판생성') {
    const u = getWebUser(caller.id);
    if (u?.role !== 'admin') return ephemeral(res, '관리자만 사용할 수 있는 명령어입니다.');
    if (!interaction.channel_id) return ephemeral(res, '채널 정보를 확인할 수 없습니다.');
    // 출석판과 같은 이유로 응답을 먼저 보내고 게시는 그 뒤에 한다 (3초 제한)
    ephemeral(res, '이 채널에 카지노 입장 메시지를 게시합니다.');
    await postCasinoBoard(interaction.channel_id)
      .catch(e => console.error('카지노판 게시 실패:', e));
    return;
  }

  return ephemeral(res, '알 수 없는 명령어입니다.');
}

async function handleComponent(interaction: any, res: ServerResponse): Promise<void> {
  const customId = interaction.data?.custom_id;
  if (customId === 'relief_claim') return await handleReliefClaim(interaction, res);
  if (customId !== 'attendance_checkin') return ephemeral(res, '알 수 없는 버튼입니다.');

  const caller = identifyCaller(interaction);
  const result = checkIn(caller.id, caller.username, caller.avatar);

  if (result.alreadyCheckedIn) {
    return ephemeral(
      res,
      `이미 오늘 출석했습니다. KST 자정이 지나면 다시 출석할 수 있어요!\n` +
      `연속 출석 **${result.streak}일** · 잔액 **${pts(result.balance)}**`
    );
  }

  const bonusLines = result.breakdown
    .filter(g => g.reason !== 'attendance')
    .map(g => `${reasonLabel(g.reason)} ${signedPts(g.delta)}`);
  const dailyGrant = result.breakdown.find(g => g.reason === 'attendance');

  // 출석 성공은 채널에 공개로 남긴다 — 누가 며칠째 나오는지 서로 보이는 게
  // 출석체크 채널의 존재 이유이고, 랭킹이 이미 공개라 잔액도 비밀이 아니다.
  // (이미 출석한 경우는 위에서 ephemeral로 끝낸다 — 그건 채널에 남길 가치가 없다)
  ackSilently(res);
  const log = [
    `**${esc(caller.username)}**님 출석 완료 ${dailyGrant ? signedPts(dailyGrant.delta) : ''} · 연속 **${result.streak}일**`,
    ...bonusLines,
    `잔액 ${pts(result.balance)}`,
  ].join('\n');
  // 응답을 이미 보냈으므로 아래 REST 호출이 길어져도 3초 제한과 무관하다.
  // 로그를 먼저 찍고 버튼을 그 아래로 내려야 버튼이 항상 맨 밑에 남는다.
  await postChannelMessage(interaction.channel_id, log)
    .catch((e: unknown) => console.error('출석 로그 게시 실패:', e));
  await bumpBoard('attendance', interaction.channel_id)
    .catch((e: unknown) => console.error('출석판 재게시 실패:', e));
}

async function handleReliefClaim(interaction: any, res: ServerResponse): Promise<void> {
  const caller = identifyCaller(interaction);
  upsertUser(caller.id, caller.username, caller.avatar);
  const r = claimRelief(caller.id);

  if (!r.ok) {
    if (r.error === 'not_broke') {
      return ephemeral(res, `아직 포인트가 남아 있습니다. 보유 포인트가 **정확히 0P**일 때만 신청할 수 있어요.`);
    }
    if (r.error === 'cooldown') {
      // 다음 신청 가능 시각을 디스코드 상대 타임스탬프로 보여준다 (각자의 시간대로 표시된다)
      return ephemeral(res, `이미 지원금을 받았습니다. <t:${r.nextAvailableAt}:R>에 다시 신청할 수 있어요.`);
    }
    return ephemeral(res, '신청 처리 중 문제가 발생했습니다.');
  }

  // 출석과 마찬가지로 누가 신청했는지 채널에 공개로 남긴다
  ackSilently(res);
  const log = `**${esc(caller.username)}**님 개인회생 지원금 수령 ${signedPts(RELIEF_AMOUNT)}\n`
    + `잔액 ${pts(r.balance)} · 다음 신청 <t:${r.nextAvailableAt}:R>`;
  await postChannelMessage(interaction.channel_id, log)
    .catch((e: unknown) => console.error('지원금 로그 게시 실패:', e));
  await bumpBoard('relief', interaction.channel_id)
    .catch((e: unknown) => console.error('지원금판 재게시 실패:', e));
}

export async function handleInteractions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const raw = await readRawBody(req);

  const valid = typeof signature === 'string' && typeof timestamp === 'string' && PUBLIC_KEY
    && await verifyKey(raw, signature, timestamp, PUBLIC_KEY);
  if (!valid) { res.writeHead(401); res.end('invalid request signature'); return; }

  let interaction: any;
  try { interaction = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }

  // 3초 제한을 넘겼는지 나중에 확인할 수 있어야 한다. 응답을 실제로 내보낸 시점까지의
  // 시간을 남긴다(res.end 이후의 후속 작업은 제한과 무관하므로 포함하지 않는다).
  const label = interaction.type === InteractionType.APPLICATION_COMMAND
    ? `/${interaction.data?.name}`
    : interaction.type === InteractionType.MESSAGE_COMPONENT
      ? `button:${interaction.data?.custom_id}`
      : `type:${interaction.type}`;
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    console.log(`인터랙션 ${label} 응답 ${ms}ms${ms > 2500 ? ' ← 3초 제한에 위험하게 근접' : ''}`);
  });

  try {
    if (interaction.type === InteractionType.PING) {
      return json(res, { type: InteractionResponseType.PONG });
    }
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      return await handleCommand(interaction, res);
    }
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      return await handleComponent(interaction, res);
    }
    res.writeHead(400); res.end();
  } catch (e) {
    console.error('인터랙션 처리 오류:', e);
    ephemeral(res, '일시적인 오류가 발생했습니다. 잠시 후 다시 시도하세요.');
  }
}
