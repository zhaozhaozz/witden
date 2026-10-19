import { CronExpressionParser } from "cron-parser";
import { BadRequest } from "../errors.js";

/** Five fields, at most once a minute. UTC instants are persisted; the expression uses an IANA timezone. */
export function nextTriggerTime(cron: string, timezone: string, after = new Date()): Date {
  if (cron.trim().split(/\s+/).length !== 5) throw new BadRequest("Cron 必须包含五段：分 时 日 月 周");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
  } catch {
    throw new BadRequest("Cron 或时区无效，或者该计划没有下一次执行时间");
  }
}
