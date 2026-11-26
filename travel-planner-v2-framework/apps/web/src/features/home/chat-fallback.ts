import type { Place } from '@travel/shared';

/**
 * 模型不可用时的本地兜底。
 *
 * 这里只是把目录里已有的信息念出来，**不是 AI**：界面上必须标明「AI 助手暂不可用」，
 * 不能像改造前那样把关键词匹配的结果冒充成模型回答。
 */
export const FALLBACK_NOTE = 'AI 助手暂不可用，以下是从本地景点目录整理的提示。';

export function fallbackReply(input: string, cityName: string | null, places: Place[]): string {
  const question = input.trim();
  if (/景点|玩|去哪|旅游|推荐.*地方|有什么好/.test(question)) {
    if (!cityName) return '先在首页点「定位当前位置」或选一座城市，才能看当地的景点目录。';
    if (places.length === 0) return `${cityName} 暂时还没有录入景点，等数据补齐就能查看了。`;
    return `${cityName} 目录里的 ${places.length} 个景点：\n${places
      .map((place) => `· ${place.name}`)
      .join('\n')}`;
  }
  if (/美食|吃|餐厅|小吃|特产/.test(question))
    return '美食数据还没有接入目录，暂时无法回答；可以先看看上面列出的景点。';
  if (/天气|行李|带什么/.test(question))
    return '天气和行李清单在「行程」页的行程详情里，出发提醒与行李清单都在那里。';
  return 'AI 助手暂时连不上，只能回答景点目录相关的问题。可以试试问「有什么景点推荐？」';
}
