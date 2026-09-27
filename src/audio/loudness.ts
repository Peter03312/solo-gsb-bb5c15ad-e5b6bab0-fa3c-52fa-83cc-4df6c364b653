import type { PcmBuffer } from './types';

/**
 * 循环目标响度归一化。
 *
 * 对可无缝循环的 PCM 以环形窗（默认 400 ms 窗、100 ms 步长，越过循环末尾
 * 回绕到头部）逐窗计算全声道平均能量，再做两级门控（BS.1770 式门控思路，
 * 基于 RMS 能量而非 K 加权）：
 *   1. 绝对门控：排除低于 −70 dBFS 的窗；
 *   2. 相对门控：以剩余窗能量均值作为初估响度，再排除低于其 10 dB 的窗；
 * 门控响度 = 最终剩余窗能量均值的 dB 值（10·log₁₀）。
 *
 * 按目标响度求增益后，若全声道采样峰值会超过 −1 dBFS，则统一减小增益
 * 使峰值恰好不超过 −1 dBFS（所有声道施加同一增益，保持声道间平衡）。
 * 门控后无有效窗（循环接近静音）时不施加任何增益，保留原声。
 */

export interface LoudnessOptions {
  /** 检查窗长（秒），默认 0.4（400 ms） */
  windowSec?: number;
  /** 步长（秒），默认 0.1（100 ms） */
  hopSec?: number;
  /** 绝对门限（dBFS），低于该能量的窗被排除，默认 −70 */
  absoluteGateDbfs?: number;
  /** 相对门限（dB）：低于初估响度该值的窗被排除，默认 10 */
  relativeGateDb?: number;
  /** 全声道采样峰值上限（dBFS），默认 −1 */
  peakCeilingDbfs?: number;
}

export interface GatedLoudness {
  /** 门控响度（dBFS）；门控后无有效窗（静音）时为 null */
  loudnessDbfs: number | null;
  /** 环形窗总数 */
  totalWindows: number;
  /** 绝对门控后剩余的窗数 */
  gatedWindowsAbs: number;
  /** 相对门控后剩余的窗数（参与门控响度的窗数） */
  gatedWindowsRel: number;
}

export interface LoudnessNormalizationResult extends GatedLoudness {
  /** 处理后的 PCM（静音时为原 PCM，未施加增益） */
  pcm: PcmBuffer;
  /** 目标响度（dBFS） */
  targetDbfs: number;
  /** 实际施加的统一增益（dB）；静音时为 0 */
  appliedGainDb: number;
  /** 处理后的门控响度（dBFS）；静音时为 null */
  actualDbfs: number | null;
  /** 处理前 / 处理后全声道采样峰值（dBFS）；完全无声时为 null */
  peakBeforeDbfs: number | null;
  peakAfterDbfs: number | null;
  /** 是否因峰值上限而减小了增益 */
  peakLimited: boolean;
  /** 峰值限幅原因（未限幅时为 null） */
  limitReason: string | null;
  /** 是否判定为静音（门控后无有效窗，保留原声） */
  silent: boolean;
}

/** 带符号的 dB 文本（正数补 +，负号沿用 toFixed 输出） */
const fmtSignedDb = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

/**
 * 门控响度测量：环形窗（越过循环末尾回绕到头部）逐窗计算全声道平均能量，
 * 两级门控后取剩余窗能量均值的 dB 值。
 */
export function measureGatedLoudness(pcm: PcmBuffer, options: LoudnessOptions = {}): GatedLoudness {
  const sr = pcm.sampleRate;
  const win = Math.max(1, Math.round((options.windowSec ?? 0.4) * sr));
  const hop = Math.max(1, Math.round((options.hopSec ?? 0.1) * sr));
  const absGate = 10 ** ((options.absoluteGateDbfs ?? -70) / 10);
  const relGateDb = options.relativeGateDb ?? 10;

  const frames = pcm.channels[0]?.length ?? 0;
  const numCh = pcm.channels.length;
  if (frames === 0 || numCh === 0) {
    return { loudnessDbfs: null, totalWindows: 0, gatedWindowsAbs: 0, gatedWindowsRel: 0 };
  }

  // 环形窗：窗起点均匀分布在 [0, frames)，窗内采样越过末尾时回绕到头部
  const numWindows = Math.max(1, Math.round(frames / hop));
  const energies = new Float64Array(numWindows);
  for (let k = 0; k < numWindows; k++) {
    const start = Math.round((k * frames) / numWindows);
    let e = 0;
    for (let ch = 0; ch < numCh; ch++) {
      const d = pcm.channels[ch];
      let idx = start;
      let remaining = win;
      // 循环可能短于一个窗：环绕多圈累加（能量按窗长平均，口径不变）
      while (remaining > 0) {
        const seg = Math.min(remaining, frames - idx);
        for (let i = 0; i < seg; i++) {
          const x = d[idx + i];
          e += x * x;
        }
        remaining -= seg;
        idx = 0;
      }
    }
    energies[k] = e / (win * numCh);
  }

  // 第一级：绝对门控（排除低于 −70 dBFS 的窗）
  let sumAbs = 0;
  let countAbs = 0;
  for (let k = 0; k < numWindows; k++) {
    if (energies[k] >= absGate) {
      sumAbs += energies[k];
      countAbs++;
    }
  }
  if (countAbs === 0) {
    return { loudnessDbfs: null, totalWindows: numWindows, gatedWindowsAbs: 0, gatedWindowsRel: 0 };
  }

  // 第二级：相对门控（排除低于初估响度 10 dB 的窗）
  const estimated = sumAbs / countAbs;
  const relGate = estimated * 10 ** (-relGateDb / 10);
  let sumRel = 0;
  let countRel = 0;
  for (let k = 0; k < numWindows; k++) {
    if (energies[k] >= absGate && energies[k] >= relGate) {
      sumRel += energies[k];
      countRel++;
    }
  }
  // 均值本身不小于相对门限，至少有一个窗通过；此处仅为防御
  if (countRel === 0) {
    return {
      loudnessDbfs: 10 * Math.log10(estimated),
      totalWindows: numWindows,
      gatedWindowsAbs: countAbs,
      gatedWindowsRel: 0,
    };
  }
  return {
    loudnessDbfs: 10 * Math.log10(sumRel / countRel),
    totalWindows: numWindows,
    gatedWindowsAbs: countAbs,
    gatedWindowsRel: countRel,
  };
}

/**
 * 按目标响度归一化循环 PCM：
 * 增益 = 目标 − 门控响度；若全声道采样峰值因此超过 −1 dBFS，
 * 则统一减小增益使峰值恰好等于 −1 dBFS（所有声道同一增益）。
 * 静音（门控后无有效窗）时不施加增益，返回原 PCM。
 */
export function normalizeLoopLoudness(
  pcm: PcmBuffer,
  targetDbfs: number,
  options: LoudnessOptions = {},
): LoudnessNormalizationResult {
  const peakCeilingDbfs = options.peakCeilingDbfs ?? -1;
  const measured = measureGatedLoudness(pcm, options);

  // 全声道采样峰值
  let peak = 0;
  for (const d of pcm.channels) {
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  const peakBeforeDbfs = peak > 0 ? 20 * Math.log10(peak) : null;

  if (measured.loudnessDbfs === null) {
    return {
      ...measured,
      pcm,
      targetDbfs,
      appliedGainDb: 0,
      actualDbfs: null,
      peakBeforeDbfs,
      peakAfterDbfs: peakBeforeDbfs,
      peakLimited: false,
      limitReason: null,
      silent: true,
    };
  }

  const ceiling = 10 ** (peakCeilingDbfs / 20);
  const wantedGainDb = targetDbfs - measured.loudnessDbfs;
  let g = 10 ** (wantedGainDb / 20);
  let peakLimited = false;
  let limitReason: string | null = null;
  if (peak > 0 && peak * g > ceiling) {
    g = ceiling / peak;
    peakLimited = true;
    const limitedGainDb = 20 * Math.log10(g);
    const wouldPeakDbfs = 20 * Math.log10(peak) + wantedGainDb;
    limitReason =
      `峰值限幅：目标增益 ${fmtSignedDb(wantedGainDb)} dB 会使采样峰值达到 ` +
      `${fmtSignedDb(wouldPeakDbfs)} dBFS，超过 ${peakCeilingDbfs} dBFS 上限；` +
      `已统一限幅为 ${fmtSignedDb(limitedGainDb)} dB（所有声道同一增益，实际响度低于目标）。`;
  }
  const appliedGainDb = 20 * Math.log10(g);
  const out: Float32Array[] = pcm.channels.map((d) => {
    const o = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) o[i] = d[i] * g;
    return o;
  });
  return {
    ...measured,
    pcm: { sampleRate: pcm.sampleRate, channels: out },
    targetDbfs,
    appliedGainDb,
    actualDbfs: measured.loudnessDbfs + appliedGainDb,
    peakBeforeDbfs,
    peakAfterDbfs: peak > 0 ? 20 * Math.log10(peak * g) : null,
    peakLimited,
    limitReason,
    silent: false,
  };
}
