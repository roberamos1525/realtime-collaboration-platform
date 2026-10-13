/**
 * Minimal Prometheus-compatible metrics registry (counters, gauges and
 * histograms with labels) rendered in the text exposition format.
 */

type Labels = Record<string, string | number>;

function labelKey(labels: Labels | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",");
}

interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge" | "histogram";
  render(): string[];
}

export class Counter implements Metric {
  readonly type = "counter" as const;
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels?: Labels, by = 1): void {
    if (by < 0) throw new Error("counters only increase");
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels?: Labels): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    if (this.values.size === 0) return [`${this.name} 0`];
    return [...this.values].map(([k, v]) => (k ? `${this.name}{${k}} ${v}` : `${this.name} ${v}`));
  }
}

export class Gauge implements Metric {
  readonly type = "gauge" as const;
  private readonly values = new Map<string, number>();
  private collector: (() => number) | null = null;
  constructor(readonly name: string, readonly help: string) {}

  set(value: number, labels?: Labels): void {
    this.values.set(labelKey(labels), value);
  }

  inc(labels?: Labels, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  dec(labels?: Labels, by = 1): void {
    this.inc(labels, -by);
  }

  /** Computes the (unlabelled) value lazily at scrape time. */
  collect(fn: () => number): this {
    this.collector = fn;
    return this;
  }

  get(labels?: Labels): number {
    if (this.collector && !labels) return this.collector();
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    if (this.collector) return [`${this.name} ${this.collector()}`];
    if (this.values.size === 0) return [`${this.name} 0`];
    return [...this.values].map(([k, v]) => (k ? `${this.name}{${k}} ${v}` : `${this.name} ${v}`));
  }
}

export class Histogram implements Metric {
  readonly type = "histogram" as const;
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  ) {}

  observe(value: number, labels?: Labels): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= (this.buckets[i] as number)) s.counts[i] = (s.counts[i] as number) + 1;
    s.sum += value;
    s.count++;
  }

  /** Starts a timer; calling the returned function records elapsed seconds. */
  startTimer(labels?: Labels): (extra?: Labels) => number {
    const start = process.hrtime.bigint();
    return (extra) => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.observe(seconds, { ...labels, ...extra });
      return seconds;
    };
  }

  count(labels?: Labels): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }

  render(): string[] {
    const lines: string[] = [];
    for (const [key, s] of this.series) {
      const sep = key ? `${key},` : "";
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(key ? `${this.name}_sum{${key}} ${s.sum}` : `${this.name}_sum ${s.sum}`);
      lines.push(key ? `${this.name}_count{${key}} ${s.count}` : `${this.name}_count ${s.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    return this.register(new Counter(name, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.register(new Gauge(name, help));
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.register(new Histogram(name, help, buckets));
  }

  private register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) throw new Error(`metric ${metric.name} already registered`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  render(): string {
    const out: string[] = [];
    for (const m of this.metrics.values()) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.render());
    }
    return `${out.join("\n")}\n`;
  }
}

/** All application metrics, created once per app instance. */
export function createAppMetrics(registry = new MetricsRegistry()) {
  return {
    registry,
    httpRequests: registry.counter("rcp_http_requests_total", "HTTP requests by method, route and status"),
    httpDuration: registry.histogram("rcp_http_request_duration_seconds", "HTTP request latency"),
    rateLimited: registry.counter("rcp_rate_limited_total", "Requests or messages rejected by rate limiting"),
    wsConnections: registry.gauge("rcp_ws_connections", "Open WebSocket connections"),
    wsMessagesIn: registry.counter("rcp_ws_messages_in_total", "WebSocket messages received by type"),
    wsMessagesOut: registry.counter("rcp_ws_messages_out_total", "WebSocket messages sent"),
    docOps: registry.counter("rcp_doc_ops_total", "CRDT operations integrated by kind"),
    docOpsRejected: registry.counter("rcp_doc_ops_rejected_total", "CRDT operations rejected by reason"),
    docSessions: registry.gauge("rcp_doc_sessions", "Documents loaded in memory"),
    docSnapshots: registry.counter("rcp_doc_snapshots_total", "Document snapshots written"),
    tombstonesCollected: registry.counter("rcp_crdt_tombstones_collected_total", "Tombstones removed by GC"),
    searchQueries: registry.counter("rcp_search_queries_total", "Search queries executed"),
    searchIndexSize: registry.gauge("rcp_search_index_entries", "Entries in the search index"),
    notificationsSent: registry.counter("rcp_notifications_total", "Notifications created by kind"),
    authEvents: registry.counter("rcp_auth_events_total", "Authentication events by outcome"),
  };
}

export type AppMetrics = ReturnType<typeof createAppMetrics>;
