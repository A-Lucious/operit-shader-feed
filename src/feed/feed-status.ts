/**
 * 把 feed 的内部状态翻译成**给用户看的那一句话**。
 *
 * 为什么值得单独一个模块：
 *   「缓冲空了」「源刷完了」「真的卡住了」这三种情况的正确措辞完全不同，
 *   而它们都能从 snapshot 算出来。写在 UI 里就没法离线测（UI 只能在真机跑），
 *   写成纯函数就能用断言把每一条措辞锁住。
 *
 * 这个区分是 README 里点名的：「`waiting()` 表示真的卡住，不是缓冲为空」。
 * 混为一谈的后果有两个方向，都很糟：
 *   - 缓冲一空就喊「卡住了」→ 在最需要耐心的时刻吓用户
 *   - 该说话时什么都不说 → 界面静默冻结，用户上滑没反应也不知道为什么
 */

export interface FeedStatusInput {
  /** 前方待播条数（= snapshot.ahead）。 */
  ahead: number;
  /** 真的卡住：当前这条已播满，但前方没有下一条（= snapshot.waiting）。 */
  waiting: boolean;
  /** 数据源已耗尽，不会再有「更多」了（= snapshot.exhausted）。 */
  exhausted: boolean;
  /**
   * 已暂停（= snapshot.paused）。
   * 注意：当前界面还没有暂停按钮，所以这条分支今天不可达 ——
   * 留着是因为 `feed.pause()` 是真实存在的 API，它属于这个纯函数的输入域。
   * 措辞里**不引用任何按钮**，所以以后加上按钮也不用改这里。
   */
  paused: boolean;
  /** 已取走的条数（= snapshot.index），用于「共 N 条」这种交代规模的措辞。 */
  index: number;
  /** 数据源是本地缓存（true）还是在线（false）——决定耗尽时该建议什么。 */
  offline: boolean;
}

const DWELL_HINT = "每条约 30 秒自动上滑";

export function describeFeedStatus(input: FeedStatusInput): string {
  const { ahead, waiting, exhausted, paused, index, offline } = input;

  if (paused) {
    return "已暂停（前方 " + ahead + " 条待播）";
  }

  if (waiting) {
    // 到这里才是「真的卡住」：当前这条已经播满，前方确实没有下一条。
    // 还要再分两种：源已耗尽（有终点的正常结束）vs 只是暂时没拿到（多半是网络）。
    if (exhausted) {
      return offline
        ? "缓存刷完了（共 " + index + " 条）。连网拉到新内容后会继续，也可以先去「缓存」看看。"
        : "暂时没有更多内容了（已播 " + index + " 条）。";
    }
    return "卡住了：没有拿到下一条（已播 " + index + " 条）。检查一下网络？";
  }

  if (ahead === 0) {
    // 缓冲为空，但当前这条还在正常播 —— 这不是卡住，是补货中。
    // 这正是 README 点名的那个区分：这里绝不能喊「卡住了」。
    return "前方暂时没有待播的，正在补货…";
  }

  return "前方 " + ahead + " 条待播（" + DWELL_HINT + "）";
}
