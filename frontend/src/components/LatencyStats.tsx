import type { LatencyStats as Stats } from "../hooks/useLatencyMeasurement";
import type { CommitState } from "../hooks/useSocket";
import "./LatencyStats.css";

interface LatencyStatsProps {
  stats: Stats;
  onClear: () => void;
  commitState: CommitState;
  onCommitStateChange: (state: CommitState) => void;
}

export function LatencyStats({ stats, onClear, commitState, onCommitStateChange }: LatencyStatsProps) {
  const { measurements, min, max, avg, count } = stats;

  // Get recent measurements (last 10)
  const recentMeasurements = measurements.slice(-10).reverse();

  return (
    <div className="latency-stats">
      <div className="latency-header">
        <h3>Latency Measurement</h3>
        <div className="header-controls">
          <select
            value={commitState}
            onChange={(e) => onCommitStateChange(e.target.value as CommitState)}
            className="commit-state-select"
          >
            <option value="Proposed">Proposed (fastest)</option>
            <option value="Voted">Voted</option>
            <option value="Finalized">Finalized (slowest)</option>
          </select>
          <button onClick={onClear} className="clear-btn">
            Clear
          </button>
        </div>
      </div>

      <div className="latency-summary">
        <div className="stat">
          <span className="stat-label">Count</span>
          <span className="stat-value">{count}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Min</span>
          <span className="stat-value">
            {min !== null ? `${min.toFixed(0)}ms` : "-"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Avg</span>
          <span className="stat-value avg">
            {avg !== null ? `${avg.toFixed(0)}ms` : "-"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Max</span>
          <span className="stat-value">
            {max !== null ? `${max.toFixed(0)}ms` : "-"}
          </span>
        </div>
      </div>

      {recentMeasurements.length > 0 && (
        <div className="latency-list">
          <h4>Recent ({recentMeasurements.length})</h4>
          <ul>
            {recentMeasurements.map((m, i) => (
              <li key={i} className={getLatencyClass(m.latencyMs)}>
                <span className="action">{m.action}</span>
                <span className="latency">{m.latencyMs.toFixed(0)}ms</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {count === 0 && (
        <p className="no-data">
          Click vote buttons to measure end-to-end latency
          <br />
          <small>(click → blockchain → WebSocket → UI)</small>
        </p>
      )}
    </div>
  );
}

function getLatencyClass(latencyMs: number): string {
  if (latencyMs < 500) return "fast";
  if (latencyMs < 1000) return "medium";
  if (latencyMs < 2000) return "slow";
  return "very-slow";
}
