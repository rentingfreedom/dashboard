"use client";

import { useEffect, useState } from "react";
import { RefreshCw, CheckCircle, XCircle, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Automation {
  key: string;
  label: string;
  description: string;
  webhookUrl: string;
  workflowUrl: string;
  source: string;
}

interface DiagnosticsResult {
  connected: boolean;
  spreadsheetId: string;
  credentialsConfigured: { serviceAccountEmail: boolean; privateKey: boolean };
  tabs: string[];
  columnStatus: Record<string, { found: number; missing: string[] }>;
  automations: Automation[];
  appEnv: string;
  checkedAt: string;
  error: string | null;
}

function StatusIcon({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (ok) return <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />;
  if (warn) return <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />;
  return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
}

function Row({ label, ok, warn, value }: { label: string; ok: boolean; warn?: boolean; value?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div className="flex items-center gap-2.5">
        <StatusIcon ok={ok} warn={warn} />
        <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      </div>
      {value && <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{value}</span>}
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState<DiagnosticsResult | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/settings");
      setData(await res.json());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const checkedAt = data?.checkedAt
    ? (() => { try { return new Date(data.checkedAt).toLocaleString(); } catch { return data.checkedAt; } })()
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Settings</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Connection status and diagnostics
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="h-8">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Recheck
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-5 overflow-auto bg-gray-50 dark:bg-gray-950">
        {loading && !data ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full rounded-lg" />)}
          </div>
        ) : (
          <>
            {/* Spreadsheet connection */}
            <Card className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-none">
              <CardHeader className="pb-2 pt-5 px-5">
                <CardTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  Google Sheets
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs font-medium",
                      data?.connected
                        ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-400"
                        : "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-400"
                    )}
                  >
                    {data?.connected ? "Connected" : "Not connected"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-5">
                <Row
                  label="Service account email"
                  ok={!!data?.credentialsConfigured.serviceAccountEmail}
                  value={data?.credentialsConfigured.serviceAccountEmail ? "configured" : "missing"}
                />
                <Row
                  label="Private key"
                  ok={!!data?.credentialsConfigured.privateKey}
                  value={data?.credentialsConfigured.privateKey ? "configured" : "missing"}
                />
                <Row
                  label="Spreadsheet accessible"
                  ok={!!data?.connected}
                  value={data?.spreadsheetId
                    ? `${data.spreadsheetId.slice(0, 12)}…`
                    : undefined}
                />
                {data?.error && (
                  <p className="mt-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 rounded-md px-3 py-2">
                    {data.error}
                  </p>
                )}
                {data?.connected && (
                  <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Tabs found ({data.tabs.length})</span>
                      <a
                        href={`https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                      >
                        Open sheet <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {data.tabs.map((tab) => (
                        <Badge key={tab} variant="outline" className="text-xs bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                          {tab}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Column status */}
            {data?.connected && Object.keys(data.columnStatus).length > 0 && (
              <Card className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-none">
                <CardHeader className="pb-2 pt-5 px-5">
                  <CardTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100">Column Checks</CardTitle>
                </CardHeader>
                <CardContent className="px-5 pb-5 space-y-4">
                  {Object.entries(data.columnStatus).map(([tab, status]) => (
                    <div key={tab}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <StatusIcon ok={status.missing.length === 0} />
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{tab}</span>
                        <span className="text-xs text-gray-400">({status.found} columns)</span>
                      </div>
                      {status.missing.length > 0 ? (
                        <div className="ml-6">
                          <p className="text-xs text-red-600 dark:text-red-400 mb-1">Missing required columns:</p>
                          <div className="flex flex-wrap gap-1">
                            {status.missing.map((col) => (
                              <Badge key={col} variant="outline" className="text-xs bg-red-50 text-red-600 border-red-200 dark:bg-red-950 dark:text-red-400">
                                {col}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="ml-6 text-xs text-green-600 dark:text-green-400">All required columns present</p>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Automations */}
            <Card className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-none">
              <CardHeader className="pb-2 pt-5 px-5">
                <CardTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Automations
                </CardTitle>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  n8n workflows triggered by external services
                </p>
              </CardHeader>
              <CardContent className="px-5 pb-5 space-y-3">
                {data?.automations?.map((a) => (
                  <div
                    key={a.key}
                    className="border border-gray-100 dark:border-gray-800 rounded-md p-3 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                          {a.label}
                        </span>
                        <Badge
                          variant="outline"
                          className="text-xs bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                        >
                          {a.source}
                        </Badge>
                      </div>
                      <a
                        href={a.workflowUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 shrink-0"
                      >
                        Open in n8n <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 ml-6">{a.description}</p>
                    <p className="text-xs font-mono text-gray-400 dark:text-gray-500 ml-6 break-all">
                      {a.webhookUrl}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* App info */}
            <Card className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-none">
              <CardHeader className="pb-2 pt-5 px-5">
                <CardTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100">App Info</CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-5">
                <Row label="Environment" ok={true} value={data?.appEnv ?? "—"} />
                <Row label="Last checked" ok={true} value={checkedAt ?? "—"} />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
