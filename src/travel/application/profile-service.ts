/**
 * 画像服务门面（第 3 段「解析管线」的对外出口）
 *
 * 移植自 `apps/lesson9-12-travel/src/application/profile-service.ts`（附录 A 第 6 项）。
 *
 * 把解析细节收在门面里，向编排层只暴露两种状态：
 *  - ready：必填齐备，可进入三子链；
 *  - pending-clarification：缺必填，附 missing 清单供一次性追问（不消耗后续算力）。
 */
import type { ProfileParseResult } from '../shared/trip-profile';
import { ProfileParser } from '../domain/profile/profile-parser';

/** 待澄清结果（缺 destination/days/budget） */
export interface PendingClarification {
  status: 'pending-clarification';
  result: ProfileParseResult;
}

/** 画像就绪，可直接进入 Route/Itinerary/Budget 三执行者 */
export interface ProfileReady {
  status: 'ready';
  result: ProfileParseResult;
}

export type ProfileOutcome = ProfileReady | PendingClarification;

export class ProfileService {
  private readonly parser: ProfileParser;

  constructor(parser: ProfileParser) {
    this.parser = parser;
  }

  /**
   * 解析一句话需求。
   * @returns ready 或 pending-clarification。missing 非空即表示需向用户澄清。
   */
  async resolve(rawInput: string, opts: { forceRule?: boolean } = {}): Promise<ProfileOutcome> {
    const result = await this.parser.parse(rawInput, opts);
    if (!result.ok) {
      return { status: 'pending-clarification', result };
    }
    return { status: 'ready', result };
  }
}
