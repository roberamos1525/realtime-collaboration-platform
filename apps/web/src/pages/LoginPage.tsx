import { registerSchema } from "@rcp/shared";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { navigate } from "../lib/router";
import { useApp } from "../state/app";

type Mode = "login" | "register";

export function LoginPage() {
  const { api } = useApp();
  const [mode, setMode] = useState<Mode>("login");
  const [form, setForm] = useState({ login: "", email: "", username: "", displayName: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "register") {
      // Validate with the same schema the server uses for instant feedback.
      const parsed = registerSchema.safeParse({
        email: form.email,
        username: form.username,
        displayName: form.displayName,
        password: form.password,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        setError(issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid input");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "login") await api.login(form.login.trim(), form.password);
      else await api.register({ email: form.email, username: form.username, displayName: form.displayName, password: form.password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)} noValidate>
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Collab Space</h1>
        </div>
        <p className="muted">Write together in realtime, discuss in context and track the work.</p>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Create account
          </button>
        </div>
        {mode === "login" ? (
          <label>
            Username or e-mail
            <input autoComplete="username" value={form.login} onChange={update("login")} required />
          </label>
        ) : (
          <>
            <label>
              E-mail
              <input type="email" autoComplete="email" value={form.email} onChange={update("email")} required />
            </label>
            <div className="row">
              <label>
                Username
                <input autoComplete="username" value={form.username} onChange={update("username")} required />
              </label>
              <label>
                Display name
                <input autoComplete="name" value={form.displayName} onChange={update("displayName")} required />
              </label>
            </div>
          </>
        )}
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={form.password}
            onChange={update("password")}
            required
          />
        </label>
        {mode === "register" && <p className="hint">At least 10 characters.</p>}
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
