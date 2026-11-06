import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import api from '../api/axios.js';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COLORS = { green: '#2f6f4f', blue: '#3b6ea5', gray: '#c3c9d3' };

const fmtMoney = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtShort = (n) => {
  n = Number(n || 0);
  if (n >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
};

export default function Dashboard() {
  const [summary, setSummary] = useState(null);

  // Loads on open, then re-fetches every 60 seconds (skipped while the tab is hidden).
  useEffect(() => {
    const load = () => api.get('/api/dashboard/summary').then(({ data }) => setSummary(data)).catch(() => {});
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const trend = summary?.trend || [];
  const byEst = summary?.employeesByEstablishment || [];
  const status = summary?.employeeStatus;

  return (
    <Layout>
      <h1 className="page-title">Dashboard</h1>

      <div className="chart-grid">
        <div className="card chart-card">
          <h3>Active Employees by Establishment</h3>
          <div className="chart-total">{summary?.establishments ?? '-'} establishments · {summary?.activeEmployees ?? '-'} active employees</div>
          <HBars data={byEst.map((x) => ({ label: x.name, value: x.employees }))} color={COLORS.green} />
        </div>

        <div className="card chart-card">
          <h3>Slips per Pay Period</h3>
          <div className="chart-total">{summary?.slipsGenerated ?? '-'} slips generated</div>
          <BarChart
            data={trend.map((t) => ({ label: `${MONTHS[t.period_month]} ${String(t.period_year).slice(2)}`, value: t.records }))}
            color={COLORS.blue}
            formatValue={(v) => String(v)}
            formatAxis={fmtShort}
          />
        </div>

        <div className="card chart-card">
          <h3>Active Users by Role</h3>
          <div className="chart-total">{summary?.activeUsers ?? '-'} active users</div>
          <HBars data={(summary?.usersByRole || []).map((x) => ({ label: x.name, value: x.users }))} color={COLORS.blue} />
        </div>

        <div className="card chart-card">
          <h3>Employee Status</h3>
          <Donut
            parts={[
              { label: 'Active', value: status?.active || 0, color: COLORS.green },
              { label: 'Inactive', value: status?.inactive || 0, color: COLORS.gray }
            ]}
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: 4 }}>
        <h3>Recent Pay Periods</h3>
        <table className="table">
          <thead>
            <tr><th>Period</th><th>Records</th></tr>
          </thead>
          <tbody>
            {summary?.recentPeriods?.map((p) => (
              <tr key={`${p.period_year}-${p.period_month}`}>
                <td>{MONTHS[p.period_month]} {p.period_year}</td>
                <td>{p.records}</td>
              </tr>
            ))}
            {!summary?.recentPeriods?.length && (
              <tr><td colSpan={2} className="muted">No salary data uploaded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

function Empty() {
  return <div className="muted chart-empty">No data yet.</div>;
}

// Vertical bar chart (pure SVG).
function BarChart({ data, color, formatValue, formatAxis }) {
  if (!data.length) return <Empty />;
  const W = 400, H = 230, L = 46, R = 6, T = 18, B = 38;
  const max = Math.max(...data.map((d) => d.value), 1);
  const step = (W - L - R) / data.length;
  const bw = Math.min(34, step * 0.62);
  const ticks = [0, 0.5, 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
      {ticks.map((t) => {
        const y = T + (H - T - B) * (1 - t);
        return (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y} y2={y} stroke="#e8ebf0" />
            <text x={L - 6} y={y + 5} textAnchor="end" fontSize="15" fill="#374151">{formatAxis(max * t)}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (H - T - B) * (d.value / max);
        const x = L + step * i + (step - bw) / 2;
        const y = H - B - h;
        return (
          <g key={`${d.label}-${i}`}>
            <title>{`${d.label}: ${formatValue(d.value)}${d.sub ? ` (${d.sub})` : ''}`}</title>
            <rect x={x} y={y} width={bw} height={Math.max(h, 1)} rx="3" fill={color} />
            <text x={x + bw / 2} y={H - B + 20} textAnchor="middle" fontSize={data.length > 8 ? 12 : 15} fill="#374151">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Horizontal bars for label/value lists (HTML so long names wrap/ellipsis).
function HBars({ data, color }) {
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="hbars">
      {data.map((d) => (
        <div key={d.label} className="hbar-row" title={`${d.label}: ${d.value}`}>
          <div className="hbar-label">{d.label}</div>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%`, background: color }} /></div>
          <div className="hbar-value">{d.value}</div>
        </div>
      ))}
    </div>
  );
}

function Donut({ parts }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <Empty />;
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut-svg" role="img">
        <g transform="rotate(-90 70 70)">
          {parts.map((p) => {
            const len = (p.value / total) * C;
            const el = (
              <circle key={p.label} cx="70" cy="70" r={R} fill="none" stroke={p.color} strokeWidth="20"
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}>
                <title>{`${p.label}: ${p.value}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </g>
        <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" fill="#1c2230">{total}</text>
        <text x="70" y="86" textAnchor="middle" fontSize="12" fill="#6b7280">Employees</text>
      </svg>
      <div className="donut-legend">
        {parts.map((p) => (
          <div key={p.label} className="donut-legend-row">
            <span className="donut-dot" style={{ background: p.color }} />
            {p.label}
            <strong>{p.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
