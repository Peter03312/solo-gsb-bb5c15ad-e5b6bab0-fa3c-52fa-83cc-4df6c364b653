import type { LoudnessNormalizationResult } from '../audio/loudness';

interface LoudnessPanelProps {
  /** 当前选中候选循环 PCM 的归一化结果（无候选时为 null） */
  result: LoudnessNormalizationResult | null;
  /** 候选标签，如 "候选 #2" */
  candidateLabel: string;
  /** 目标响度（dBFS，−40 ~ 0） */
  targetDbfs: number;
  onTargetDbfsChange: (v: number) => void;
}

export const MIN_TARGET_DBFS = -40;
export const MAX_TARGET_DBFS = 0;

const fmtDbfs = (v: number | null): string => (v === null ? '—' : `${v.toFixed(2)} dBFS`);
const fmtSignedDb = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

/**
 * 目标响度归一化面板：对选中接缝与交叉淡化形成的循环 PCM 做门控响度测量，
 * 按目标响度施加统一增益（峰值限制 −1 dBFS），显示原响度、实际响度与
 * 峰值限幅原因；循环试听与 WAV 下载均使用处理后的 PCM。
 */
export function LoudnessPanel({ result, candidateLabel, targetDbfs, onTargetDbfsChange }: LoudnessPanelProps) {
  return (
    <section className="panel loudness">
      <h2>目标响度归一化（{candidateLabel}）</h2>
      <p className="loudness-desc">
        对选中接缝与交叉淡化形成的循环 PCM，以环形 400 ms 窗、100 ms 步长计算全声道平均能量，
        先排除低于 −70 dBFS 的窗，再排除低于初估响度 10 dB 的窗，得到门控响度；
        按目标响度施加统一增益，全声道采样峰值不超过 −1 dBFS（超限时自动减小增益）。
        「试听选中候选」与「下载 WAV」使用同一份处理后 PCM；切换候选、选区或淡化参数时自动重算。
      </p>

      <label className="loudness-slider">
        <span>
          目标响度：<b>{targetDbfs.toFixed(1)} dBFS</b>
        </span>
        <input
          type="range"
          min={MIN_TARGET_DBFS}
          max={MAX_TARGET_DBFS}
          step={0.5}
          value={targetDbfs}
          onChange={(e) => onTargetDbfsChange(Number(e.target.value))}
        />
      </label>

      {result ? (
        result.silent ? (
          <p className="clamp-note">
            循环接近静音：{result.totalWindows} 个检查窗能量均低于 −70 dBFS，门控后无有效窗，
            已保留原声、不施加增益（试听与导出均为未处理的循环 PCM）。
          </p>
        ) : (
          <>
            {result.peakLimited && result.limitReason && (
              <p className="clamp-note">{result.limitReason}</p>
            )}
            <table>
              <tbody>
                <tr>
                  <td>原响度（门控）</td>
                  <td>{fmtDbfs(result.loudnessDbfs)}</td>
                </tr>
                <tr>
                  <td>应用增益</td>
                  <td>
                    {fmtSignedDb(result.appliedGainDb)} dB
                    {result.peakLimited ? '（已被峰值限幅）' : ''}
                  </td>
                </tr>
                <tr>
                  <td>实际响度</td>
                  <td>
                    {fmtDbfs(result.actualDbfs)}
                    {result.peakLimited ? `（目标 ${targetDbfs.toFixed(1)} dBFS 受峰值限制未达到）` : ''}
                  </td>
                </tr>
                <tr>
                  <td>采样峰值</td>
                  <td>
                    {fmtDbfs(result.peakBeforeDbfs)} → {fmtDbfs(result.peakAfterDbfs)}
                  </td>
                </tr>
                <tr>
                  <td>门控窗</td>
                  <td>
                    参与 {result.gatedWindowsRel} / {result.totalWindows} 窗
                    （绝对门控后 {result.gatedWindowsAbs} 窗）
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )
      ) : (
        <p className="clamp-note">无有效循环区间，无法计算响度。</p>
      )}
    </section>
  );
}
