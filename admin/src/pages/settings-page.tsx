import type { Settings } from "../types";

export function SettingsPage({ settings }: { settings: Settings }) {
  return <><header className="page-heading"><div><p className="eyebrow">服务配置</p><h1>设置</h1></div></header><section className="settings-grid"><article className="data-region"><h2>共享 API 状态</h2><dl><div><dt>共享 API 密钥</dt><dd>{settings.shared_api_key_configured ? "已配置（已隐藏）" : "未配置"}</dd></div><div><dt>管理员会话</dt><dd>已认证 / Cookie 保护</dd></div><div><dt>并发数</dt><dd>{settings.max_concurrency}</dd></div><div><dt>队列上限</dt><dd>{settings.max_queued_requests}</dd></div><div><dt>输出保留时间</dt><dd>{Math.round(settings.output_retention_ms / 86_400_000)} 天</dd></div></dl></article><article className="data-region"><h2>账号凭据</h2><p className="notice">请在“订阅账号”点击“重新登录”。管理台会在你的本地浏览器打开灵境，并显示 Cookie 回填窗口；服务器不会尝试启动桌面浏览器。</p><a href="/admin/accounts">打开订阅账号</a></article></section></>;
}
