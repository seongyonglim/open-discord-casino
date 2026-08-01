// 디스코드 인터랙션(버튼/슬래시커맨드) 수신 엔드포인트.
// Gateway(웹소켓) 상시 연결 없이 Discord가 직접 HTTPS로 요청을 쏘는 방식 → fly.io scale-to-zero와 호환된다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { REST, Routes, ComponentType, ButtonStyle } from 'discord.js';
import { checkIn } from '../services/economy';
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
        '평일 100P · 주말 200P · 7일 연속 +500P · 30일 연속 +1,000P\n' +
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
    await postAttendanceBoard(interaction.channel_id);
    return ephemeral(res, '이 채널에 출석체크 메시지를 게시했습니다.');
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

  return ephemeral(
    res,
    [
      `출석 완료! ${dailyGrant ? signedPts(dailyGrant.delta) : ''}`,
      ...bonusLines,
      `연속 출석 **${result.streak}일** · 잔액 **${pts(result.balance)}**`,
    ].join('\n')
  );
}

export async function handleInteractions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const raw = await readRawBody(req);

  const valid = typeof signature === 'string' && typeof timestamp === 'string' && PUBLIC_KEY
    && await verifyKey(raw, signature, timestamp, PUBLIC_KEY);
  if (!valid) { res.writeHead(401); res.end('invalid request signature'); return; }

  let interaction: any;
  try { interaction = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }

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
