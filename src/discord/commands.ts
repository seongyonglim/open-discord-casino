// 슬래시 커맨드 정의 (Client/Gateway 없이 SlashCommandBuilder만 재사용). deploy-commands.ts와 interactions.ts가 공유.
import { SlashCommandBuilder } from 'discord.js';

export interface CommandModule {
  data: SlashCommandBuilder;
}

export const commandModules: CommandModule[] = [
  {
    data: new SlashCommandBuilder()
      .setName('내점수')
      .setDescription('내 포인트 잔액과 연속 출석일수를 확인합니다'),
  },
  {
    data: new SlashCommandBuilder()
      .setName('랭킹')
      .setDescription('포인트 랭킹 TOP 10을 보여줍니다'),
  },
  {
    data: new SlashCommandBuilder()
      .setName('출석판생성')
      .setDescription('[관리자] 이 채널에 출석체크 버튼 메시지를 게시합니다'),
  },
  {
    data: new SlashCommandBuilder()
      .setName('지원금판생성')
      .setDescription('[관리자] 이 채널에 개인회생 지원금 신청 버튼 메시지를 게시합니다'),
  },
  {
    data: new SlashCommandBuilder()
      .setName('카지노판생성')
      .setDescription('[관리자] 이 채널에 카지노 입장 버튼 메시지를 게시합니다'),
  },
];
