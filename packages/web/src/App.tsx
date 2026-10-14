import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout, { RequirePerm } from "./Layout";
import { ADMIN_PERMS, COMPUTER_PERMS } from "./lib/perms";
import { AuthProvider, DirectoryProvider, useAuth } from "./lib/session";
import { TopicsProvider } from "./lib/topics";
import ApprovalsPage from "./pages/ApprovalsPage";
import InstanceDetailPage from "./pages/computers/InstanceDetailPage";
import InstancesPage from "./pages/computers/InstancesPage";
import LoginPage from "./pages/LoginPage";
import MePage from "./pages/MePage";
import TaskDetailPage from "./pages/tasks/TaskDetailPage";
import TasksPage from "./pages/tasks/TasksPage";
import TopicsPage from "./pages/topics/TopicsPage";
import { FeedbackProvider } from "./ui/feedback";
import { Loading } from "./ui/kit";

// Management pages are loaded on first use, keeping the everyday console small.
const AdminPage = lazy(() => import("./pages/admin/AdminPage"));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage"));
const ModelsPage = lazy(() => import("./pages/ModelsPage"));
const RoleEditorPage = lazy(() => import("./pages/roles/RoleEditorPage"));
const RolesPage = lazy(() => import("./pages/roles/RolesPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const TemplatesPage = lazy(() => import("./pages/computers/TemplatesPage"));

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
      <TopicsProvider>
        <Routes>
          <Route
            path="setup"
            element={
              <Suspense fallback={<Loading />}>
                <SetupPage />
              </Suspense>
            }
          />
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
      </TopicsProvider>
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
