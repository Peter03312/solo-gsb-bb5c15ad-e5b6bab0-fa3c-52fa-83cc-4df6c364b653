import type { PcmBuffer } from './types';

/**
 * 循环 PCM 目标响度归一化。
 *
 * 响度测量（环形窗两级门控）：
 *   对循环 PCM 按 **400 ms 环形窗、100 ms 步长**取窗（窗跨过循环首尾时回绕，
 *   与无缝循环的实际重放口径一致），每窗能量取所有声道采样的均方值
 *   （10·log₁₀ 得 dBFS，满刻度正弦波为 −3.01 dBFS）：
 *     1. **绝对门限**：先排除窗响度低于 −70 dBFS 的静音窗；一窗不剩视为整段静音；
 *     2. **初估响度**：对通过绝对门限的窗按线性能量求均值后取对数；
 *     3. **相对门限**：再排除低于「初估响度 − 10 dB」的窗；
 *     4. **门控响度**：对剩余窗同样按线性能量均值取对数。
 *
 * 增益处理：
 *   目标增益 = 10^((目标响度 − 门控响度)/20)，所有声道共用同一增益；
 *   应用前先扫描所有声道的采样峰值，若「峰值 × 目标增益」超过 −1 dBFS
 *   （线性 10^(−1/20)），则把增益统一压低到恰好不超限（峰值限制，非压缩器：
 *   仅按峰值确定一个更小的静态增益）。实际响度 = 门控响度 + 20·log₁₀(实际增益)。
 *
 * 静音处理：
 *   全部窗低于绝对门限时不施加任何增益（原样返回同一缓冲），由界面提示
 *   「已保留原声」，避免对底噪无意义地放大。
 */

/** 响度测量窗（秒） */
export const LOUDNESS_WINDOW_SEC = 0.4;
/** 窗步长（秒） */
export const LOUDNESS_HOP_SEC = 0.1;
/** 绝对门限（dBFS）：低于此电平的窗先被排除 */
export const LOUDNESS_ABS_GATE_DBFS = -70;
/** 相对门限（dB）：再排除低于初估响度该差值的窗 */
export const LOUDNESS_REL_GATE_DB = -10;
/** 采样峰值上限（dBFS） */
export const LOUDNESS_PEAK_CEIL_DBFS = -1;

export interface LoudnessOptions {
  windowSec?: number;
  hopSec?: number;
  absGateDbfs?: number;
  relGateDb?: number;
  peakCeilDbfs?: number;
}

export interface LoudnessResult {
  /** 是否整段静音（所有窗均未过绝对门限）；此时不施加增益、保留原声 */
  silent: boolean;
  /** 门控响度（dBFS，两级门控后）；静音时为 null */
  originalLoudnessDbfs: number | null;
  /** 初估响度（dBFS，仅绝对门控后）；静音时为 null */
  preliminaryLoudnessDbfs: number | null;
  /** 目标响度（dBFS） */
  targetDbfs: number;
  /** 按目标响度求得的增益（dB，未做峰值限制前） */
  requestedGainDb: number;
  /** 采样峰值上限（dBFS） */
  peakCeilDbfs: number;
  /** 峰值限制是否生效（目标增益会把采样峰值推过上限） */
  peakLimiterActive: boolean;
  /** 峰值限幅原因说明（未限幅时为 null） */
  peakLimiterReason: string | null;
  /** 处理前所有声道的统一采样峰值（dBFS） */
  originalPeakDbfs: number;
  /** 实际施加的增益（dB，已含峰值限制） */
  actualGainDb: number;
  /** 实际施加的增益（线性） */
  actualGainLinear: number;
  /** 处理后实际门控响度（dBFS，= 原门控响度 + 实际增益）；静音时为 null */
  actualLoudnessDbfs: number | null;
  /** 处理后所有声道的统一采样峰值（dBFS） */
  actualPeakDbfs: number;
  /** 测量窗长度（采样点） */
  windowSamples: number;
  /** 窗步长（采样点） */
  hopSamples: number;
  /** 环形窗总数 */
  windowCount: number;
  /** 通过绝对门限的窗数 */
  passedAbsoluteGate: number;
  /** 通过相对门限的窗数（参与门控响度平均） */
  passedRelativeGate: number;
}

export interface NormalizedLoop {
  /** 处理后的循环 PCM（静音或增益恰为 1 时与输入为同一引用） */
  pcm: PcmBuffer;
  loudness: LoudnessResult;
}

const toDb = (linearPower: number): number => 10 * Math.log10(linearPower);
const toDbPeak = (linearAmp: number): number => 20 * Math.log10(linearAmp);
/** 无信号峰值（全静音）时以 −∞ 的数值下限显示 */
const PEAK_FLOOR_DB = -200;

/**
 * 对（已含接缝交叉淡化的）循环 PCM 做目标响度归一化。
 *
 * @param targetDbfs 目标门控响度（dBFS）
 */
export function normalizeLoopLoudness(
  pcm: PcmBuffer,
  targetDbfs: number,
  options: LoudnessOptions = {},
): NormalizedLoop {
  const windowSec = options.windowSec ?? LOUDNESS_WINDOW_SEC;
  const hopSec = options.hopSec ?? LOUDNESS_HOP_SEC;
  const absGateDbfs = options.absGateDbfs ?? LOUDNESS_ABS_GATE_DBFS;
  const relGateDb = options.relGateDb ?? LOUDNESS_REL_GATE_DB;
  const peakCeilDbfs = options.peakCeilDbfs ?? LOUDNESS_PEAK_CEIL_DBFS;

  const sr = pcm.sampleRate;
  const nCh = pcm.channels.length;
  const L = pcm.channels[0]?.length ?? 0;

  const base: LoudnessResult = {
    silent: false,
    originalLoudnessDbfs: null,
    preliminaryLoudnessDbfs: null,
    targetDbfs,
    requestedGainDb: 0,
    peakCeilDbfs,
    peakLimiterActive: false,
    peakLimiterReason: null,
    originalPeakDbfs: PEAK_FLOOR_DB,
    actualGainDb: 0,
    actualGainLinear: 1,
    actualLoudnessDbfs: null,
    actualPeakDbfs: PEAK_FLOOR_DB,
    windowSamples: Math.max(1, Math.round(windowSec * sr)),
    hopSamples: Math.max(1, Math.round(hopSec * sr)),
    windowCount: 0,
    passedAbsoluteGate: 0,
    passedRelativeGate: 0,
  };

  if (nCh === 0 || L < 2 || !Number.isFinite(sr) || sr <= 0) {
    return { pcm, loudness: { ...base, silent: true } };
  }

  // 环形窗不超过一个完整循环：循环短于 400 ms 时窗长夹取到 L
  // （否则同一采样在窗内被重复计入，能量 / 峰值口径失真）
  const win = Math.min(base.windowSamples, L);
  // 步长不超过窗长：极短循环（< 100 ms）下仍保持逐窗重叠覆盖
  const hop = Math.min(base.hopSamples, win);
  base.windowSamples = win;
  base.hopSamples = hop;
  // 环形覆盖整个循环：起点 0、hop、2·hop …，最后一个起点 < L（窗尾部回绕）
  const windowCount = Math.max(1, Math.ceil(L / hop));
  base.windowCount = windowCount;

  // ---- 各环形窗的均方能量（所有声道合并平均），同时扫描统一采样峰值 ----
  const windowMsq = new Float64Array(windowCount);
  let peak = 0;
  for (let ch = 0; ch < nCh; ch++) {
    const data = pcm.channels[ch];
    for (let i = 0; i < L; i++) {
      const x = data[i];
      if (Number.isFinite(x) && Math.abs(x) > peak) peak = Math.abs(x);
    }
  }
  for (let w = 0; w < windowCount; w++) {
    const start = w * hop;
    let sumSq = 0;
    for (let ch = 0; ch < nCh; ch++) {
      const data = pcm.channels[ch];
      for (let i = 0; i < win; i++) {
        const x = data[(start + i) % L];
        if (Number.isFinite(x)) sumSq += x * x;
      }
    }
    windowMsq[w] = sumSq / (nCh * win);
  }

  // ---- 第一级：绝对门限 −70 dBFS ----
  const absGatePower = 10 ** (absGateDbfs / 10);
  let prelimSum = 0;
  let prelimCount = 0;
  for (let w = 0; w < windowCount; w++) {
    if (windowMsq[w] >= absGatePower) {
      prelimSum += windowMsq[w];
      prelimCount++;
    }
  }
  base.passedAbsoluteGate = prelimCount;

  const makeSilent = (): NormalizedLoop => ({
    pcm, // 静音：保留原声，不施加增益
    loudness: {
      ...base,
      silent: true,
      originalPeakDbfs: peak > 0 ? toDbPeak(peak) : PEAK_FLOOR_DB,
      actualPeakDbfs: peak > 0 ? toDbPeak(peak) : PEAK_FLOOR_DB,
    },
  });

  if (prelimCount === 0) return makeSilent();

  // ---- 初估响度（仅绝对门控后，线性能量均值）----
  const preliminaryPower = prelimSum / prelimCount;
  const preliminaryDb = toDb(preliminaryPower);
  base.preliminaryLoudnessDbfs = preliminaryDb;

  // ---- 第二级：相对门限（初估响度 − 10 dB）----
  const relGatePower = preliminaryPower * 10 ** (relGateDb / 10);
  let gatedSum = 0;
  let gatedCount = 0;
  for (let w = 0; w < windowCount; w++) {
    if (windowMsq[w] >= absGatePower && windowMsq[w] >= relGatePower) {
      gatedSum += windowMsq[w];
      gatedCount++;
    }
  }
  base.passedRelativeGate = gatedCount;
  const gatedPower = gatedSum / gatedCount;
  const gatedDb = toDb(gatedPower);
  base.originalLoudnessDbfs = gatedDb;

  // ---- 目标增益（所有声道统一）----
  const requestedGain = 10 ** ((targetDbfs - gatedDb) / 20);
  base.requestedGainDb = toDbPeak(requestedGain);

  // ---- 采样峰值统一限制到 −1 dBFS ----
  const peakCeil = 10 ** (peakCeilDbfs / 20);
  let gain = requestedGain;
  if (peak > 0 && peak * requestedGain > peakCeil) {
    gain = peakCeil / peak;
    base.peakLimiterActive = true;
    base.peakLimiterReason =
      `按目标增益（${base.requestedGainDb >= 0 ? '+' : ''}${base.requestedGainDb.toFixed(2)} dB）后，` +
      `所有声道的统一采样峰值将达到 ${toDbPeak(peak * requestedGain).toFixed(2)} dBFS，` +
      `超过 ${peakCeilDbfs} dBFS 上限；为避免 16-bit 导出削波，已把所有声道的统一增益压低到 ` +
      `${toDbPeak(gain).toFixed(2)} dB（硬峰值上限，非动态压缩），实际响度随之低于目标值。`;
  }

  base.actualGainLinear = gain;
  base.actualGainDb = toDbPeak(gain);
  base.actualLoudnessDbfs = gatedDb + toDbPeak(gain);
  base.originalPeakDbfs = peak > 0 ? toDbPeak(peak) : PEAK_FLOOR_DB;
  base.actualPeakDbfs = peak > 0 ? toDbPeak(peak * gain) : PEAK_FLOOR_DB;

  // 增益为 1 时不复制数据，直接复用原缓冲
  if (gain === 1) return { pcm, loudness: base };

  const channels = pcm.channels.map((data) => {
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const x = data[i];
      out[i] = Number.isFinite(x) ? x * gain : 0;
    }
    return out;
  });
  return { pcm: { sampleRate: sr, channels }, loudness: base };
}
