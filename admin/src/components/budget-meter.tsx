export function BudgetMeter({ label, used, reserved, limit }: { label: string; used: number; reserved: number; limit: number }) {
  const total = used + reserved;
  const percent = limit === 0 ? 0 : Math.min(100, Math.round(total / limit * 100));
  return <div className="budget-meter"><span>{label}</span><strong>{limit === 0 ? `${total} / ∞` : `${total} / ${limit}`}</strong><div aria-label={`${label} budget ${percent}% used`} className="meter-track"><span style={{ width: `${percent}%` }} /></div></div>;
}
