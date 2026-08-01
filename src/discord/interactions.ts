// 디스코드 인터랙션(버튼/슬래시커맨드) 수신 엔드포인트.
// Gateway(웹소켓) 상시 연결 없이 Discord가 직접 HTTPS로 요청을 쏘는 방식 → fly.io scale-to-zero와 호환된다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { REST, Routes, ComponentType, ButtonStyle } from 'discord.js';
import { checkIn, rewardSummary } from '../services/economy';
import { upsertUser, ensureSeedAdmin, getWebUser, getLeaderboard } from '../db/queries';
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

async function postAttendanceBoard(channelId: string): Promise<void> {
  await rest.post(Routes.channelMessages(channelId), {
    body: {
      content:
        '**오늘도 출석하고 포인트 받아가세요!**\n' +
        rewardSummary() + '\n' +
        '(KST 자정에 초기화됩니다)',
      components: [{
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: '출석체크',
          custom_id: 'attendance_checkin',
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
    await postAttendanceBoard(interaction.channel_id)
      .catch(e => console.error('출석판 게시 실패:', e));
    return;
  }

  return ephemeral(res, '알 수 없는 명령어입니다.');
}

async function handleComponent(interaction: any, res: ServerResponse): Promise<void> {
  const customId = interaction.data?.custom_id;
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
  return publicReply(
    res,
    [
      `**${esc(caller.username)}**님 출석 완료 ${dailyGrant ? signedPts(dailyGrant.delta) : ''} · 연속 **${result.streak}일**`,
      ...bonusLines,
      `잔액 ${pts(result.balance)}`,
    ].join('\n')
  );
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
