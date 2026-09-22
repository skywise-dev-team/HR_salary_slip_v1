import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import api from '../api/axios.js';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Dashboard() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.get('/api/dashboard/summary').then(({ data }) => setSummary(data));
  }, []);

  return (
    <Layout>
      <h1 className="page-title">Dashboard</h1>

      <div className="stat-grid">
        <StatCard label="Establishments" value={summary?.establishments} />
        <StatCard label="Active Employees" value={summary?.activeEmployees} />
        <StatCard label="Active Users" value={summary?.activeUsers} />
        <StatCard label="Slips Generated" value={summary?.slipsGenerated} />
      </div>

      <div className="card" style={{ marginTop: 24 }}>
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

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value ?? '-'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
