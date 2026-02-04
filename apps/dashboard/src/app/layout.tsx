"use client";

import "@/styles/globals.css";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { DesktopShell } from "@/components/shell/DesktopShell";
import { Component, type ErrorInfo, type ReactNode } from "react";

/** Global error boundary to prevent white-screen crashes */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AgentKernel] Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-ctp-base p-8">
          <div className="max-w-lg w-full bg-ctp-mantle border border-ctp-red/30 rounded-window p-8">
            <h2 className="text-lg font-mono font-bold text-ctp-red mb-2">
              Kernel Panic
            </h2>
            <p className="text-sm text-ctp-subtext0 mb-4">
              The dashboard encountered a fatal error. Try restarting.
            </p>
            <pre className="text-xs text-ctp-red/70 bg-ctp-crust rounded-panel p-3 overflow-auto max-h-40 mb-4 font-mono">
              {this.state.error?.message}
            </pre>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="px-4 py-2 text-sm font-mono font-medium bg-ctp-blue/20 text-ctp-blue rounded-input hover:bg-ctp-blue/30 transition-colors"
            >
              Reboot
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <title>AgentKernel</title>
        <meta
          name="description"
          content="AgentKernel — Run any AI agent safely"
        />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>
        <ErrorBoundary>
          <WebSocketProvider>
            <DesktopShell>{children}</DesktopShell>
          </WebSocketProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
