export function BudgetMeter({ label, used, reserved, limit }: { label: string; used: number; reserved: number; limit: number }) {
  const total = used + reserved;
  const percent = limit === 0 ? 0 : Math.min(100, Math.round(total / limit * 100));
  const exhausted = limit !== 0 && total >= limit;
  return <div className={`budget-meter${exhausted ? " budget-exhausted" : ""}`}><span>{label}</span><strong>{limit === 0 ? "不限额" : `上限 ${limit}`}</strong><small>已扣除 {used} · 已预留 {reserved}</small>{exhausted && <em>额度已用尽</em>}<div aria-label={`${label}预算`} aria-valuemax={limit || undefined} aria-valuemin={0} aria-valuenow={limit ? Math.min(total, limit) : undefined} aria-valuetext={limit ? `已扣除 ${used}，已预留 ${reserved}，上限 ${limit}` : `已扣除 ${used}，已预留 ${reserved}，不限额`} className="meter-track" role="progressbar"><span style={{ width: `${percent}%` }} /></div></div>;
}
