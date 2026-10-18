import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/session";
import { PageHeader, Tabs } from "../../ui/kit";
import { AuditTab, UsageTab } from "./auditTabs";
import { DispatcherTab } from "./DispatcherTab";
import { EmergencyTab } from "./EmergencyTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { MembersTab } from "./membersTabs";
import { PublicAddressTab } from "./PublicAddressTab";

export default function AdminPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: "members", label: "账号", hidden: !can("user.manage") },
    { key: "knowledge", label: "知识空间", hidden: !can("role.manage") },
    { key: "audit", label: "审计", hidden: !can("audit.view") },
    { key: "usage", label: "用量", hidden: !can("audit.view") },
    { key: "emergency", label: "紧急停止", hidden: !can("emergency.stop") },
    { key: "dispatcher", label: "话题调度", hidden: !can("secrets.manage") },
    { key: "public-url", label: "公网地址", hidden: !can("connection.manage") },
  ];
  const visible = tabs.filter((t) => !t.hidden);
  const requested = params.get("tab");
  const tab = visible.some((t) => t.key === requested) ? requested! : (visible[0]?.key ?? "");

  return (
    <div className="page">
      <PageHeader
        title="管理"
        sub="管理员账号与外部成员、知识空间、审计记录、模型用量、紧急停止、话题调度和公网事件地址。"
      />
      <Tabs tabs={tabs} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} />
      {tab === "members" ? <MembersTab /> : null}
      {tab === "knowledge" ? <KnowledgeTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "usage" ? <UsageTab /> : null}
      {tab === "emergency" ? <EmergencyTab /> : null}
      {tab === "dispatcher" ? <DispatcherTab /> : null}
      {tab === "public-url" ? <PublicAddressTab /> : null}
    </div>
  );
}
