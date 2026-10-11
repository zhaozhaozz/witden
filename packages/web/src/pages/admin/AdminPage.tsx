import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/session";
import { PageHeader, Tabs } from "../../ui/kit";
import { AuditTab, UsageTab } from "./auditTabs";
import { EmergencyTab } from "./EmergencyTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { GrantsTab, MembersTab } from "./membersTabs";

export default function AdminPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: "members", label: "成员", hidden: !can("user.manage") },
    { key: "grants", label: "授权", hidden: !can("user.manage") },
    { key: "knowledge", label: "知识空间", hidden: !can("role.manage") },
    { key: "audit", label: "审计", hidden: !can("audit.view") },
    { key: "usage", label: "用量", hidden: !can("audit.view") },
    { key: "emergency", label: "紧急停止", hidden: !can("emergency.stop") },
  ];
  const visible = tabs.filter((t) => !t.hidden);
  const requested = params.get("tab");
  const tab = visible.some((t) => t.key === requested) ? requested! : (visible[0]?.key ?? "");

  return (
    <div className="page">
      <PageHeader
        title="管理"
        sub="成员与授权、团队知识、审计记录、模型用量和紧急停止。所有权限默认不授予，按需逐项开放。"
      />
      <Tabs tabs={tabs} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} />
      {tab === "members" ? <MembersTab /> : null}
      {tab === "grants" ? <GrantsTab /> : null}
      {tab === "knowledge" ? <KnowledgeTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "usage" ? <UsageTab /> : null}
      {tab === "emergency" ? <EmergencyTab /> : null}
    </div>
  );
}
