import type { AssistantIntent } from "./types.ts";

const devices =
  /(?:空调|红外|电视|灯|窗帘|风扇|插座|开关|扫地机|净化器|加湿器|热水器|米家|场景|门锁|冰箱|洗衣机|浴霸|投影|取暖器)/u;
const action =
  /(?:打开|开启|关掉|关闭|关上|关一下|开一下|启动|执行|切换|调到|调成|调为|调高|调低|设置|设为|设成|开|关|升高|降低|制冷|制热|解锁|上锁)/u;

export function nativeIntent(text: string): AssistantIntent | null {
  const query = text
    .trim()
    .replace(/^(?:小爱同学|小爱|嘿小爱)[，,：:\s]*/u, "");
  // Explicit media titles may contain appliance names.
  if (
    /^(?:请|帮我|给我)?(?:播放|放|来点|来一首|我想听|想听|我要听|听)/u.test(
      query,
    )
  )
    return null;
  if (
    /(?:为什么|为何|怎么|如何|什么是|是什么|多少钱|怎么样|好不好|推荐|区别|原理|故障|不制冷|不制热)/u.test(
      query,
    )
  )
    return null;
  if (
    (devices.test(query) && action.test(query)) ||
    /(?:闹钟|倒计时|计时器|提醒我|叫我起床|叫醒我)/u.test(query)
  ) {
    return {
      action: "native",
      reason: "保留小爱原生家电、红外、场景或提醒处理；平台不重复控制或播报。",
      confidence: 0.99,
      source: "rules",
    };
  }
  if (
    /^(?:请|帮我|给我)?(?:打开|开启|关闭|关掉|启动|执行|解锁|上锁)/u.test(
      query,
    ) &&
    !/(?:音乐|歌曲|播放|音量)/u.test(query)
  ) {
    return {
      action: "native",
      reason: "设备控制归属不明确，保留原生处理，未确认原生执行结果。",
      confidence: 0.8,
      source: "rules",
    };
  }
  return null;
}
