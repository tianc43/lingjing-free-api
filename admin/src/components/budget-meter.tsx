export function BudgetMeter({ label, used, reserved, limit }: { label: string; used: number; reserved: number; limit: number }) {
  const total = used + reserved;
  const percent = limit === 0 ? 0 : Math.min(100, Math.round(total / limit * 100));
  const exhausted = limit !== 0 && total >= limit;
  return <div className={`budget-meter${exhausted ? " budget-exhausted" : ""}`}><span>{label}</span><strong>{limit === 0 ? "Unlimited" : `Limit ${limit}`}</strong><small>Charged {used} · Reserved {reserved}</small>{exhausted && <em>Exhausted</em>}<div aria-label={`${label} budget ${percent}% used`} className="meter-track"><span style={{ width: `${percent}%` }} /></div></div>;
}
