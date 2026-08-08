"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { user, ready, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("analyst@demo.local");
  const [password, setPassword] = useState("demo");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && user) router.replace("/");
  }, [ready, user, router]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = login(email, password);
    if (!result.ok) {
      setError(result.error ?? "Login failed");
      return;
    }
    router.replace("/");
  }

  return (
    <div className="login-page">
      <div className="login-atmosphere" aria-hidden />
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <span className="brand-mark lg">R</span>
          <h1>Research</h1>
          <p>Demo sign-in for Theme Scanner</p>
        </div>

        <label className="login-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error ? <div className="login-error">{error}</div> : null}

        <button type="submit" className="login-submit">
          Continue
        </button>

        <p className="login-hint">
          Demo password: <code>demo</code> · any email works
        </p>
      </form>
    </div>
  );
}
