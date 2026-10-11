import { useState, type FormEvent } from "react";
import { errorMessage } from "../api/client";
import { useAuth } from "../lib/session";

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-panel">
        <div className="login-brand">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <div>
            <h1>witden</h1>
            <p>团队的 AI 员工与它们的电脑</p>
          </div>
        </div>
        <form className="form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">邮箱</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error ? (
            <div className="error-note" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
        </form>
        <p className="login-foot">账号由团队管理员在「管理 → 成员」中创建。</p>
      </div>
    </div>
  );
}
