// Formats a number the same way the salary slip PDF does: ₹ symbol, Indian
// digit grouping (last 3 digits, then groups of 2) — e.g. 1234567.5 -> ₹12,34,567.50
export function formatINR(amount) {
  const n = Number(amount) || 0;
  const isNegative = n < 0;
  const fixed = Math.abs(n).toFixed(2);
  const [whole, decimals] = fixed.split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${isNegative ? '-' : ''}\u20B9${grouped}.${decimals}`;
}
