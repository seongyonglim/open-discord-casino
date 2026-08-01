import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandModules } from './commands';

const commands = commandModules.map(m => m.data.toJSON());

// CLIENT_ID는 웹 OAuth의 DISCORD_CLIENT_ID와, GUILD_ID는 DISCORD_GUILD_ID와 같은 값이다.
// 이름만 둘인 탓에 한쪽만 채우고 배포하는 실수가 잦으므로 서로 대체할 수 있게 둔다.
const { DISCORD_TOKEN } = process.env;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  const missing = [
    !DISCORD_TOKEN && 'DISCORD_TOKEN',
    !CLIENT_ID && 'CLIENT_ID(또는 DISCORD_CLIENT_ID)',
    !GUILD_ID && 'GUILD_ID(또는 DISCORD_GUILD_ID)',
  ].filter(Boolean).join(', ');
  console.error(`환경변수가 비어 있습니다: ${missing}`);
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  console.log(`슬래시 커맨드 ${commands.length}개 등록 중...`);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('등록 완료');
})().catch(console.error);
