import type { LoudnessResult } from '../audio/loudness';

interface LoudnessPanelProps {
  /** 当前候选循环 PCM 的响度测量与归一化结果 */
  result: LoudnessResult | null;
  /** 目标响度（dBFS） */
  targetDbfs: number;
  onTargetChange: (v: number) => void;
}

/** 目标响度调节范围 / 步长 */
export const MIN_TARGET_DBFS = -36;
export const MAX_TARGET_DBFS = -6;
export const TARGET_STEP_DBFS = 0.5;

const fmtDb = (v: number | null, digits = 2): string =>
  v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)} dB`;

/**
 * 目标响度面板：以环形 400 ms 窗、100 ms 步长做两级门控（−70 dBFS 绝对门限、
 * 初估响度 −10 dB 相对门限）测量门控响度，按目标求增益并以所有声道的采样峰值
 * 统一限制到 −1 dBFS；试听与 WAV 导出共用同一处理后 PCM。
 */
export function LoudnessPanel({ result, targetDbfs, onTargetChange }: LoudnessPanelProps) {
  const silent = result?.silent ?? false;

  return (
    <section className="panel loudness">
      <h2>目标响度归一化（试听与 WAV 导出共用同一处理后 PCM）</h2>
      <p className="loudness-desc">
        对交叉淡化后的循环 PCM 按环形 400 ms 窗、100 ms 步长计算能量：先排除低于 −70 dBFS 的窗，
        再排除低于初估响度 10 dB 的窗得到门控响度；按目标响度求统一增益，
        并以所有声道的采样峰值统一限制到 −1 dBFS（硬上限，非动态压缩）。
      </p>

      <label className="loudness-slider">
        <span>
          目标响度：<b>{targetDbfs.toFixed(1)} dBFS</b>
        </span>
        <input
          type="range"
          min={MIN_TARGET_DBFS}
          max={MAX_TARGET_DBFS}
          step={TARGET_STEP_DBFS}
          value={targetDbfs}
          onChange={(e) => onTargetChange(Number(e.target.value))}
        />
      </label>

      {result ? (
        <>
          {silent ? (
            <p className="clamp-note">
              循环整体静音：全部 {result.windowCount} 个环形窗均低于 −70 dBFS 绝对门限，
              无法估计门控响度，已保留原声（不施加增益），试听与导出均为原 PCM。
            </p>
          ) : (
            <>
              <table className="loudness-readout">
                <tbody>
                  <tr>
                    <th>原响度（门控）</th>
                    <td className="lo-original">{fmtDb(result.originalLoudnessDbfs)}</td>
                    <th>实际响度</th>
                    <td className="lo-actual">
                      <b>{fmtDb(result.actualLoudnessDbfs)}</b>
                    </td>
                  </tr>
                  <tr>
                    <th>初估响度（绝对门控后）</th>
                    <td>{fmtDb(result.preliminaryLoudnessDbfs)}</td>
                    <th>目标响度</th>
                    <td>{fmtDb(result.targetDbfs, 1)}</td>
                  </tr>
                  <tr>
                    <th>原采样峰值</th>
                    <td>{fmtDb(result.originalPeakDbfs)}</td>
                    <th>处理后峰值</th>
                    <td>{fmtDb(result.actualPeakDbfs)}</td>
                  </tr>
                  <tr>
                    <th>目标增益</th>
                    <td>
                      {fmtDb(result.requestedGainDb)}
                      {result.peakLimiterActive && <em className="stale">（已被限幅改写）</em>}
                    </td>
                    <th>实际增益</th>
                    <td>{fmtDb(result.actualGainDb)}</td>
                  </tr>
                  <tr>
                    <th>参与门控的窗</th>
                    <td colSpan={3}>
                      {result.passedRelativeGate} / {result.windowCount} 窗
                      （绝对门限通过 {result.passedAbsoluteGate} 窗，
                      再经初估响度 −10 dB 相对门限保留 {result.passedRelativeGate} 窗）
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="loudness-note">
                {result.peakLimiterActive ? (
                  <span className="limiter-active">峰值限幅：{result.peakLimiterReason}</span>
                ) : (
                  <span className="limiter-ok">
                    峰值未触限：目标增益下处理后峰值为 {fmtDb(result.actualPeakDbfs)}，
                    在 {result.peakCeilDbfs} dBFS 上限以内，实际增益即目标增益，实际响度已达到目标值。
                  </span>
                )}
              </p>
            </>
          )}
        </>
      ) : (
        <p className="loudness-note">请先查找并选中一个候选接缝，面板将显示该循环的原响度、实际响度与峰值限幅原因。</p>
      )}
    </section>
  );
}
