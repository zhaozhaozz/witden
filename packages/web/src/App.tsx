import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, DirectoryProvider, useAuth } from "./lib/session";
import { FeedbackProvider } from "./ui/feedback";
import { Loading } from "./ui/kit";
import Layout, { RequirePerm } from "./Layout";
import LoginPage from "./pages/LoginPage";
import TopicsPage from "./pages/topics/TopicsPage";
import TasksPage from "./pages/tasks/TasksPage";
import TaskDetailPage from "./pages/tasks/TaskDetailPage";
import ApprovalsPage from "./pages/ApprovalsPage";
import InstancesPage from "./pages/computers/InstancesPage";
import InstanceDetailPage from "./pages/computers/InstanceDetailPage";
import TemplatesPage from "./pages/computers/TemplatesPage";
import RolesPage from "./pages/roles/RolesPage";
import RoleEditorPage from "./pages/roles/RoleEditorPage";
import ModelsPage from "./pages/ModelsPage";
import RulesPage from "./pages/RulesPage";
import ConnectionsPage from "./pages/ConnectionsPage";
import AdminPage from "./pages/admin/AdminPage";
import MePage from "./pages/MePage";
import { ADMIN_PERMS, COMPUTER_PERMS } from "./lib/perms";

function Gate() {
  const { status } = useAuth();
  if (status === "loading") return <Loading label="正在恢复登录状态" />;
  if (status === "anon") {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <DirectoryProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/topics" replace />} />
          <Route path="login" element={<Navigate to="/topics" replace />} />
          <Route path="topics" element={<TopicsPage />} />
          <Route path="topics/:topicId" element={<TopicsPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route element={<RequirePerm any={COMPUTER_PERMS} />}>
            <Route path="computers" element={<InstancesPage />} />
            <Route path="computers/templates" element={<TemplatesPage />} />
            <Route path="computers/:instanceId" element={<InstanceDetailPage />} />
          </Route>
          <Route element={<RequirePerm any={["role.manage"]} />}>
            <Route path="roles" element={<RolesPage />} />
            <Route path="roles/new" element={<RoleEditorPage />} />
            <Route path="roles/:roleId" element={<RoleEditorPage />} />
          </Route>
          <Route element={<RequirePerm any={["secrets.manage"]} />}>
            <Route path="models" element={<ModelsPage />} />
          </Route>
          <Route element={<RequirePerm any={["rules.manage"]} />}>
            <Route path="rules" element={<RulesPage />} />
          </Route>
          <Route element={<RequirePerm any={["connection.manage"]} />}>
            <Route path="connections" element={<ConnectionsPage />} />
          </Route>
          <Route element={<RequirePerm any={ADMIN_PERMS} />}>
            <Route path="admin" element={<AdminPage />} />
          </Route>
          <Route path="me" element={<MePage />} />
          <Route path="*" element={<Navigate to="/topics" replace />} />
        </Route>
      </Routes>
    </DirectoryProvider>
  );
}

export default function App() {
  return (
    <FeedbackProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </FeedbackProvider>
  );
}
