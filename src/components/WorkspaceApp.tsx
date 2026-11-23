"use client";

/**
 * Thin re-export so the home workspace shares one shell.
 * Avoid dynamic() here — its loading fallback wiped the chrome on every HMR remount.
 */
export { AppShell as WorkspaceApp } from "@/components/AppShell";
