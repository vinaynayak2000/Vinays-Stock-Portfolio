import { useState, useMemo, useEffect, useCallback } from "react";
import {
  TrendingUp, TrendingDown, Activity, Wallet, Target,
  BarChart2, Search, ChevronUp, ChevronDown, RefreshCw,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Outfit', system-ui, sans-serif";

// ── Google Sheet (public, anyone with link can view) ─────────────────────────
const SHEET_ID = "1bThGu10GvA9uZaySZ5P1NanE6PKjxYSu";
const SHEET_GID = "1859769580";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;
const REFRESH_INTERVAL_MS = 60_000; // 60 s auto-refresh

// ── Types ────────────────────────────────────────────────────────────────────
type Status = "Open" | "Closed" | "SL Hit";

interface Stock {
  id: number;
  date: string;
  name: string;
  ticker: string;
  entryPrice: number;
  exitPrice: number | null;
  sl: number | null;
  cmp: number;
  target: number;
  quantity: number;
  moneyInvested: number;
  status: Status;
  category: string;
}

type SortKey =
  | "date" | "name" | "entryPrice" | "exitPrice" | "sl"
  | "cmp" | "target" | "roi" | "quantity" | "invested" | "pnl";

// ── CSV parser (handles quoted fields with embedded newlines/commas) ──────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\n') { row.push(field); field = ""; rows.push(row); row = []; }
      else if (ch !== '\r') { field += ch; }
    }
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function toFloat(s: string): number | null {
  const v = parseFloat((s ?? "").replace(/[₹,%,\s]/g, ""));
  return isNaN(v) ? null : v;
}

// Detect column positions by header name — resilient to column reordering
function detectColumns(headers: string[]) {
  const h = headers.map(c => c.trim().toLowerCase());
  const find = (...candidates: string[]) => {
    for (const c of candidates) {
      const i = h.indexOf(c);
      if (i >= 0) return i;
    }
    // partial match fallback
    for (const c of candidates) {
      const i = h.findIndex(x => x.includes(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    date:          find("date"),
    name:          find("stock name", "name", "stock"),
    ticker:        find("ticker", "symbol"),
    entryPrice:    find("entry price", "entry", "buy price"),
    exitPrice:     find("exit price", "exit", "sell price"),
    sl:            find("sl", "stop loss", "stoploss"),
    cmp:           find("cmp", "current price", "ltp"),
    target:        find("target price", "target"),
    quantity:      find("quantity", "qty", "shares"),
    moneyInvested: find("money invested", "invested", "investment"),
    status:        find("status"),
    category:      find("category", "type", "asset type", "asset"),
  };
}

type ColMap = ReturnType<typeof detectColumns>;

function get(row: string[], idx: number): string {
  return idx >= 0 ? (row[idx] ?? "") : "";
}

function rowToStock(row: string[], id: number, cols: ColMap): Stock | null {
  if (row.length < 4) return null;
  const date = get(row, cols.date).trim();
  if (!date || date.toLowerCase() === "date") return null;

  const name   = get(row, cols.name).replace(/\s+/g, " ").trim();
  const ticker = get(row, cols.ticker).trim();
  const entry  = toFloat(get(row, cols.entryPrice));
  if (!entry || !ticker) return null;

  const exitPrice     = toFloat(get(row, cols.exitPrice));
  const sl            = toFloat(get(row, cols.sl));
  const cmp           = toFloat(get(row, cols.cmp)) ?? entry;
  const target        = toFloat(get(row, cols.target)) ?? entry;
  const quantity      = parseInt(get(row, cols.quantity)) || 0;
  const moneyInvested = toFloat(get(row, cols.moneyInvested)) ?? entry * quantity;

  const rawStatus = get(row, cols.status).trim().toLowerCase().replace(/\s+/g, " ");
  const status: Status =
    ["closed", "close", "done", "completed", "exited"].includes(rawStatus)
      ? "Closed"
    : ["sl hit", "sl-hit", "slhit", "stop loss"].includes(rawStatus)
      ? "SL Hit"
    : "Open";

  const category = get(row, cols.category).trim() || "Stocks";

  return { id, date, name, ticker, entryPrice: entry, exitPrice, sl, cmp, target, quantity, moneyInvested, status, category };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const effectivePrice = (s: Stock) => s.exitPrice ?? s.cmp;
const invested       = (s: Stock) => s.moneyInvested;
const pnl            = (s: Stock) => (effectivePrice(s) - s.entryPrice) * s.quantity;
const roi            = (s: Stock) => ((effectivePrice(s) - s.entryPrice) / s.entryPrice) * 100;
const toTarget       = (s: Stock) => ((s.target - s.cmp) / s.cmp) * 100;

const MONTH_MAP: Record<string, number> = {
  Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
  Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
};
function parseDateStr(d: string): number {
  const p = d.split(/[-\/]/);
  const mon = MONTH_MAP[p[1]];
  if (mon === undefined) return 0;
  return new Date(Number(p[2]), mon, Number(p[0])).getTime();
}

const inrFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const fmtINR = (n: number) => inrFmt.format(n);
const fmtNum = (n: number) => numFmt.format(n);

function gainColor(v: number) { return v >= 0 ? "#06d6a0" : "#f43f5e"; }
function gainPrefix(v: number) { return v >= 0 ? "+" : ""; }

const STATUS_TABS = ["All", "Open", "Closed", "SL Hit"] as const;

const STATUS_STYLE: Record<Status, string> = {
  Open:     "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  Closed:   "bg-sky-500/10 text-sky-400 border border-sky-500/25",
  "SL Hit": "bg-rose-500/10 text-rose-400 border border-rose-500/25",
};

const PALETTE = ["#06d6a0", "#fbbf24", "#a78bfa", "#38bdf8", "#f43f5e", "#fb923c"];

// ── Component ────────────────────────────────────────────────────────────────
export default function App() {
  const [stocks, setStocks]         = useState<Stock[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [statusFilter, setStatusFilter]     = useState<(typeof STATUS_TABS)[number]>("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [search, setSearch]                 = useState("");
  const [sortKey, setSortKey]               = useState<SortKey>("date");
  const [sortDir, setSortDir]               = useState<"asc" | "desc">("asc");

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(CSV_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const text = await res.text();
      const rows = parseCSV(text);
      const cols = detectColumns(rows[0] ?? []);
      const parsed = rows
        .slice(1)
        .map((r, i) => rowToStock(r, i + 1, cols))
        .filter((s): s is Stock => s !== null);
      if (parsed.length === 0) throw new Error("No data rows found in sheet. Check the sheet is shared publicly.");
      setStocks(parsed);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(() => fetchData(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchData]);

  // allCategories always from full list so tabs never disappear
  const allCategories = useMemo(
    () => ["All", ...Array.from(new Set(stocks.map(s => s.category)))],
    [stocks]
  );

  // viewStocks = category + status filtered (drives KPIs & charts)
  const viewStocks = useMemo(() =>
    stocks.filter(s => {
      if (statusFilter !== "All" && s.status !== statusFilter) return false;
      if (categoryFilter !== "All" && s.category !== categoryFilter) return false;
      return true;
    }),
    [stocks, statusFilter, categoryFilter]
  );

  // ── Derived stats (based on current filter selection) ─────────────────────
  const totalInvested   = useMemo(() => viewStocks.reduce((s, x) => s + invested(x), 0), [viewStocks]);
  const totalCurrentVal = useMemo(() => viewStocks.reduce((s, x) => s + effectivePrice(x) * x.quantity, 0), [viewStocks]);
  const totalPnL        = useMemo(() => viewStocks.reduce((s, x) => s + pnl(x), 0), [viewStocks]);
  const closedStocks    = useMemo(() => viewStocks.filter(x => x.status !== "Open"), [viewStocks]);
  const winRate         = useMemo(() => {
    const wins = closedStocks.filter(x => pnl(x) > 0).length;
    return closedStocks.length > 0 ? (wins / closedStocks.length) * 100 : null;
  }, [closedStocks]);
  const openCount  = useMemo(() => viewStocks.filter(x => x.status === "Open").length, [viewStocks]);
  const overallROI = totalInvested > 0 ? ((totalCurrentVal / totalInvested - 1) * 100) : 0;

  // ── Chart data (based on current filter selection) ─────────────────────────
  const pnlChartData = useMemo(() =>
    [...viewStocks].sort((a, b) => pnl(b) - pnl(a)).map(s => ({
      ticker: s.ticker,
      pnl: parseFloat(pnl(s).toFixed(2)),
      color: gainColor(pnl(s)),
    })), [viewStocks]);

  const allocationData = useMemo(() =>
    viewStocks.map(s => ({ name: s.ticker, fullName: s.name, value: invested(s) })),
    [viewStocks]);

  const targetData = useMemo(() =>
    [...viewStocks].map(s => ({
      ticker: s.ticker,
      pct: parseFloat(toTarget(s).toFixed(2)),
      color: toTarget(s) > 0 ? "#fbbf24" : "#f43f5e",
    })).sort((a, b) => b.pct - a.pct),
    [viewStocks]);

  // ── Table (viewStocks + search) ────────────────────────────────────────────
  const tableData = useMemo(() => {
    const filtered = viewStocks.filter(s => {
      if (search) {
        const q = search.toLowerCase();
        if (!s.name.toLowerCase().includes(q) && !s.ticker.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "roi":        return (roi(a) - roi(b)) * dir;
        case "pnl":        return (pnl(a) - pnl(b)) * dir;
        case "invested":   return (invested(a) - invested(b)) * dir;
        case "entryPrice": return (a.entryPrice - b.entryPrice) * dir;
        case "exitPrice":  return ((a.exitPrice ?? 0) - (b.exitPrice ?? 0)) * dir;
        case "sl":         return ((a.sl ?? 0) - (b.sl ?? 0)) * dir;
        case "cmp":        return (a.cmp - b.cmp) * dir;
        case "target":     return (a.target - b.target) * dir;
        case "quantity":   return (a.quantity - b.quantity) * dir;
        case "name":       return a.name.localeCompare(b.name) * dir;
        default:           return (parseDateStr(a.date) - parseDateStr(b.date)) * dir;
      }
    });
  }, [viewStocks, search, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIndicator({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronUp size={11} className="opacity-20" />;
    return sortDir === "asc"
      ? <ChevronUp size={11} style={{ color: "#06d6a0" }} />
      : <ChevronDown size={11} style={{ color: "#06d6a0" }} />;
  }

  const filteredPnL = tableData.reduce((s, x) => s + pnl(x), 0);

  const tooltipStyle = {
    background: "#0c1228",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "6px",
    fontSize: "11px",
    fontFamily: MONO,
  };

  // ── Loading screen ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" style={{ fontFamily: SANS }}>
        <div className="text-center space-y-4">
          <div
            className="w-10 h-10 rounded-full border-2 border-t-transparent animate-spin mx-auto"
            style={{ borderColor: "#06d6a0", borderTopColor: "transparent" }}
          />
          <p className="text-sm text-muted-foreground" style={{ fontFamily: MONO }}>
            Fetching Proni~ Trades…
          </p>
        </div>
      </div>
    );
  }

  // ── Error screen ───────────────────────────────────────────────────────────
  if (error && stocks.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6" style={{ fontFamily: SANS }}>
        <div className="bg-card border border-rose-500/25 rounded-lg p-6 max-w-md w-full text-center space-y-4">
          <div className="text-rose-400 text-sm font-semibold uppercase tracking-wider">Failed to load sheet</div>
          <p className="text-xs text-muted-foreground" style={{ fontFamily: MONO }}>{error}</p>
          <p className="text-xs text-muted-foreground">
            Make sure the sheet is set to <span className="text-foreground">"Anyone with the link can view"</span>.
          </p>
          <button
            onClick={() => fetchData()}
            className="px-4 py-2 text-xs rounded font-medium transition-opacity hover:opacity-80"
            style={{ background: "#06d6a0", color: "#06091a" }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const KPI_CARDS = [
    {
      label: "Total Invested",
      value: fmtINR(totalInvested),
      sub: `${viewStocks.length} position${viewStocks.length !== 1 ? "s" : ""}`,
      icon: <Wallet size={14} />,
      color: "#38bdf8",
    },
    {
      label: "Portfolio Value",
      value: fmtINR(totalCurrentVal),
      sub: `${gainPrefix(overallROI)}${overallROI.toFixed(2)}% overall`,
      icon: <BarChart2 size={14} />,
      color: "#a78bfa",
    },
    {
      label: "Unrealised P&L",
      value: `${gainPrefix(totalPnL)}${fmtINR(totalPnL)}`,
      sub: `${gainPrefix(overallROI)}${overallROI.toFixed(2)}% return`,
      icon: totalPnL >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />,
      color: gainColor(totalPnL),
    },
    {
      label: "Win Rate",
      value: winRate != null ? `${winRate.toFixed(0)}%` : "—",
      sub: closedStocks.length > 0
        ? `${closedStocks.filter(x => pnl(x) > 0).length} of ${closedStocks.length} closed`
        : "No closed trades yet",
      icon: <Target size={14} />,
      color: winRate != null ? (winRate >= 50 ? "#06d6a0" : "#f43f5e") : "#5c7399",
    },
    {
      label: "Open Trades",
      value: String(openCount),
      sub: `${closedStocks.length} closed · ${stocks.filter(x => x.status === "SL Hit").length} SL hit`,
      icon: <Activity size={14} />,
      color: "#fbbf24",
    },
  ];

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground" style={{ fontFamily: SANS }}>
      {/* Header */}
      <header
        className="sticky top-0 z-20 border-b border-border px-6 py-3 flex items-center justify-between"
        style={{ background: "rgba(6,9,26,0.94)", backdropFilter: "blur(14px)" }}
      >
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: "#06d6a0" }}>
            <Activity size={14} style={{ color: "#06091a" }} />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Proni~ Trades</h1>
            <p className="text-[10px] text-muted-foreground" style={{ fontFamily: MONO }}>
              NSE/BSE · {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {lastUpdated && (
            <span className="text-[10px] text-muted-foreground hidden sm:block" style={{ fontFamily: MONO }}>
              Updated {lastUpdated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          {error && (
            <span className="text-[10px] text-rose-400" style={{ fontFamily: MONO }}>Sync error</span>
          )}
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] border border-border transition-colors hover:border-white/15 disabled:opacity-50"
            style={{ color: "#8ba0c4" }}
          >
            <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "#06d6a0", fontFamily: MONO }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#06d6a0" }} />
            LIVE
          </span>
        </div>
      </header>

      <main className="px-4 md:px-6 py-5 max-w-[1700px] mx-auto space-y-5">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {KPI_CARDS.map(card => (
            <div
              key={card.label}
              className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2 transition-all hover:border-white/10"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider" style={{ color: card.color }}>
                {card.icon}
                {card.label}
              </div>
              <div className="text-[22px] font-semibold leading-none tracking-tight" style={{ color: card.color, fontFamily: MONO }}>
                {card.value}
              </div>
              <div className="text-[11px] text-muted-foreground">{card.sub}</div>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* P&L bar */}
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-4">
              Unrealised P&amp;L by Position
            </p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={pnlChartData} barSize={Math.max(18, Math.min(40, 120 / Math.max(pnlChartData.length, 1)))} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="ticker" tick={{ fontSize: 9, fill: "#5c7399", fontFamily: MONO }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "#5c7399", fontFamily: MONO }} axisLine={false} tickLine={false} width={48} tickFormatter={v => v >= 0 ? `+${fmtNum(v)}` : fmtNum(v)} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8ba0c4" }} formatter={(v: number) => [`${gainPrefix(v)}${fmtINR(v)}`, "P&L"]} />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                  {pnlChartData.map((e, i) => <Cell key={`pnl-${i}`} fill={e.color} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Upside to target */}
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-4">
              % Upside to Target
            </p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={targetData} layout="vertical" barSize={22} margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9, fill: "#5c7399", fontFamily: MONO }} axisLine={false} tickLine={false} tickFormatter={v => `${v > 0 ? "+" : ""}${v}%`} />
                <YAxis type="category" dataKey="ticker" tick={{ fontSize: 10, fill: "#5c7399", fontFamily: MONO }} axisLine={false} tickLine={false} width={72} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8ba0c4" }} formatter={(v: number) => [`${v > 0 ? "+" : ""}${v}%`, "To Target"]} />
                <Bar dataKey="pct" radius={[0, 4, 4, 0]}>
                  {targetData.map((e, i) => <Cell key={`tgt-${i}`} fill={e.color} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Capital allocation donut */}
          <div className="bg-card border border-border rounded-lg p-4 flex flex-col">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              Capital Allocation
            </p>
            <ResponsiveContainer width="100%" height={145}>
              <PieChart>
                <Pie data={allocationData} cx="50%" cy="50%" innerRadius={46} outerRadius={68} paddingAngle={4} dataKey="value" strokeWidth={0}>
                  {allocationData.map((_, i) => <Cell key={`alloc-${i}`} fill={PALETTE[i % PALETTE.length]} opacity={0.85} />)}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, _: string, props: { payload?: { fullName?: string } }) => [fmtINR(v), props.payload?.fullName ?? ""]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-auto space-y-2 max-h-28 overflow-y-auto">
              {allocationData.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                    <span className="text-muted-foreground truncate">{d.fullName}</span>
                  </div>
                  <span className="ml-2 shrink-0" style={{ fontFamily: MONO, color: PALETTE[i % PALETTE.length] }}>
                    {totalInvested > 0 ? ((d.value / totalInvested) * 100).toFixed(1) : "0"}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {/* Filters */}
          <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center gap-2">
            {/* Category — primary tabs */}
            <div className="flex gap-1 flex-wrap">
              {allCategories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className="px-3 py-1 text-[11px] rounded transition-all"
                  style={{
                    background: categoryFilter === cat ? "#06d6a0" : "transparent",
                    color:      categoryFilter === cat ? "#06091a" : "#5c7399",
                    fontWeight: categoryFilter === cat ? 600 : 400,
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
            <span className="w-px h-4 bg-border" />
            {/* Status — secondary compact pills */}
            <div className="flex gap-1">
              {STATUS_TABS.map(tab => (
                <button
                  key={tab}
                  onClick={() => setStatusFilter(tab)}
                  className="px-2.5 py-1 text-[11px] rounded border transition-all"
                  style={{
                    borderColor: statusFilter === tab ? "rgba(255,255,255,0.15)" : "transparent",
                    background:  statusFilter === tab ? "rgba(255,255,255,0.06)" : "transparent",
                    color:       statusFilter === tab ? "#dce6f5" : "#5c7399",
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="ml-auto relative">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "#5c7399" }} />
              <input
                type="text"
                placeholder="Search stock…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-secondary border border-border rounded pl-7 pr-3 py-1.5 text-[11px] w-44 focus:outline-none transition-colors placeholder:text-muted-foreground"
                style={{ color: "#dce6f5" }}
              />
            </div>
          </div>

          {/* Table body */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {(
                    [
                      { key: "date",       label: "Date"      },
                      { key: null,         label: "Stock"     },
                      { key: "entryPrice", label: "Entry ₹"  },
                      { key: "exitPrice",  label: "Exit ₹"   },
                      { key: "sl",         label: "SL ₹"     },
                      { key: "cmp",        label: "CMP ₹"    },
                      { key: "target",     label: "Target ₹" },
                      { key: "roi",        label: "ROI %"    },
                      { key: "quantity",   label: "Qty"      },
                      { key: "invested",   label: "Invested" },
                      { key: "pnl",        label: "P&L"      },
                      { key: null,         label: "Status"   },
                      { key: null,         label: "Category" },
                    ] as { key: SortKey | null; label: string }[]
                  ).map(col => (
                    <th
                      key={col.label}
                      onClick={() => col.key && handleSort(col.key)}
                      className="px-3 py-2.5 text-left whitespace-nowrap select-none"
                      style={{ fontSize: "10px", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", color: "#5c7399", cursor: col.key ? "pointer" : "default" }}
                    >
                      <div className="flex items-center gap-1">
                        {col.label}
                        {col.key && <SortIndicator col={col.key} />}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.map((stock, i) => {
                  const stockROI = roi(stock);
                  const stockPnL = pnl(stock);
                  return (
                    <tr
                      key={stock.id}
                      className="border-b border-border/40 transition-colors"
                      style={{ background: i % 2 === 0 ? "transparent" : "rgba(18,27,51,0.4)" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(18,27,51,0.7)")}
                      onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "rgba(18,27,51,0.4)")}
                    >
                      <td className="px-3 py-3 text-[11px] text-muted-foreground whitespace-nowrap" style={{ fontFamily: MONO }}>{stock.date}</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="text-[12px] font-medium text-foreground leading-tight">{stock.name}</div>
                        <div className="text-[10px] font-semibold tracking-widest mt-0.5" style={{ fontFamily: MONO, color: "#06d6a0" }}>{stock.ticker}</div>
                      </td>
                      <td className="px-3 py-3 text-[11px] text-foreground whitespace-nowrap" style={{ fontFamily: MONO }}>{fmtNum(stock.entryPrice)}</td>
                      <td className="px-3 py-3 text-[11px] text-muted-foreground whitespace-nowrap" style={{ fontFamily: MONO }}>{stock.exitPrice != null ? fmtNum(stock.exitPrice) : "—"}</td>
                      <td className="px-3 py-3 text-[11px] whitespace-nowrap" style={{ fontFamily: MONO, color: stock.sl != null ? "#f43f5e" : "#5c7399" }}>{stock.sl != null ? fmtNum(stock.sl) : "—"}</td>
                      <td className="px-3 py-3 text-[11px] font-semibold whitespace-nowrap" style={{ fontFamily: MONO, color: stock.cmp >= stock.entryPrice ? "#06d6a0" : "#f43f5e" }}>{fmtNum(stock.cmp)}</td>
                      <td className="px-3 py-3 text-[11px] whitespace-nowrap" style={{ fontFamily: MONO, color: "#fbbf24" }}>{fmtNum(stock.target)}</td>
                      <td className="px-3 py-3 text-[11px] font-semibold whitespace-nowrap" style={{ fontFamily: MONO, color: gainColor(stockROI) }}>{gainPrefix(stockROI)}{stockROI.toFixed(2)}%</td>
                      <td className="px-3 py-3 text-[11px] text-muted-foreground whitespace-nowrap" style={{ fontFamily: MONO }}>{stock.quantity}</td>
                      <td className="px-3 py-3 text-[11px] whitespace-nowrap" style={{ fontFamily: MONO, color: "#dce6f5" }}>{fmtINR(invested(stock))}</td>
                      <td className="px-3 py-3 text-[11px] font-semibold whitespace-nowrap" style={{ fontFamily: MONO, color: gainColor(stockPnL) }}>{gainPrefix(stockPnL)}{fmtINR(stockPnL)}</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className={`px-2 py-0.5 text-[10px] rounded-full ${STATUS_STYLE[stock.status]}`}>{stock.status}</span>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 text-[10px] rounded-full" style={{ background: "rgba(6,214,160,0.08)", color: "#06d6a0", border: "1px solid rgba(6,214,160,0.2)" }}>{stock.category}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {tableData.length === 0 && stocks.length > 0 && (
              <div className="py-14 text-center text-muted-foreground text-sm">No positions match the current filters.</div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {tableData.length} of {viewStocks.length} position{viewStocks.length !== 1 ? "s" : ""}
            </span>
            <span className="text-[11px] text-muted-foreground" style={{ fontFamily: MONO }}>
              Filtered P&L:{" "}
              <span style={{ color: gainColor(filteredPnL), fontWeight: 600 }}>
                {gainPrefix(filteredPnL)}{fmtINR(filteredPnL)}
              </span>
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
