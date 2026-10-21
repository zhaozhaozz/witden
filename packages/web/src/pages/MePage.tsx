import { Link } from "react-router-dom";
import { useAuth } from "../lib/session";
import { Avatar, KV, PageHeader, Section, Tag } from "../ui/kit";

export default function MePage() {
  const { me } = useAuth();

  if (!me) return null;

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="title-with-avatar">
            <Avatar id={me.id} name={me.name} kind="user" size={30} src={me.avatar_url} />
            {me.name}
          </span>
        }
        sub="你的账号，以及你目前拥有的权限。"
      />
      <div className="grid-2">
        <div>
          <Section title="账号">
            <KV
              items={[
                ["邮箱", me.email ?? "—"],
                [
                  "身份",
                  <Tag key="r" tone="accent">
                    管理员
                  </Tag>,
                ],
                ["我发起的任务", <Link to="/tasks">在任务页勾选「我发起的」查看</Link>],
              ]}
            />
          </Section>
        </div>
        <div>
          <Section title="我的权限">
            <p className="small">
              控制台账号都是管理员：可以配置 AI 员工、虚拟电脑和通讯接入，查看所有会话。外部成员（来自 Slack /
              飞书）不登录控制台。
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
