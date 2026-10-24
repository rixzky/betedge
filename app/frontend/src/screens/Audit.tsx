import type { Audit } from "../../../../contract/api_types";
import { api, useApi } from "../api";
import { Empty, ErrorBox, Loading, Panel, ScreenHead } from "../components/ui";
import { int } from "../format";

const PRECISION: Record<string, { color: string; meaning: string }> = {
  EXACT: { color: "#3DDC97", meaning: "Exact time known." },
  WINDOW: { color: "#3FD0E0", meaning: "Captured inside a known window (e.g. pre-closing capture, closing at kickoff)." },
  DATE: { color: "#F5B84B", meaning: "Only the date is known." },
  UNKNOWN: { color: "#FF6B7A", meaning: "No usable observation time: these quotes fail the freshness check." },
};

function Bars({ data, max, tone }: { data: Record<string, number>; max?: number; tone?: string }) {
  const entries = Object.entries(data);
  if (!entries.length) return <Empty>None recorded.</Empty>;
  const top = max ?? Math.max(...entries.map(([, v]) => v), 1);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 170px) minmax(0, 1fr) 80px", gap: 10, alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 13 }}>{k}</span>
          <div className="bar" style={{ height: 10 }}><i style={{ width: `${(v / top) * 100}%`, background: tone ?? "var(--cyan)" }} /></div>
          <span className="mono" style={{ textAlign: "right" }}>{int(v)}</span>
        </div>
      ))}
    </div>
  );
}

export function AuditScreen() {
  const a = useApi<Audit>(() => api.audit(), []);
  return (
    <div className="screen">
      <ScreenHead
        kicker="04 · Data audit"
        title="Checked before it can count"
        lede="Every match and quote is validated before it reaches a model or a decision. Exclusions are decided without looking at match outcomes."
      />
      {a.error && <ErrorBox error={a.error} />}
      {!a.data && !a.error && <Loading what="data audit" />}
      {a.data && <AuditBody a={a.data} />}
    </div>
  );
}

function AuditBody({ a }: { a: Audit }) {
  const tables = Array.from(new Set([...Object.keys(a.raw_counts), ...Object.keys(a.accepted_counts)]));
  const prec = Object.entries(a.timestamp_precision_counts);
  return (
    <div className="grid">
      <div className="note"><b>Data mode {a.dataset_mode}.</b> {a.note}</div>
      <div className="row">
        <Panel title="Raw vs accepted" style={{ flex: "1 1 420px" }}>
          {!tables.length ? <Empty>No counts recorded.</Empty> : (
            <table className="data">
              <thead><tr><th>Table</th><th className="n">Raw</th><th className="n">Accepted</th><th style={{ width: "40%" }} /></tr></thead>
              <tbody>
                {tables.map((t) => {
                  const raw = a.raw_counts[t];
                  const acc = a.accepted_counts[t];
                  return (
                    <tr key={t}>
                      <td className="mono">{t}</td>
                      <td className="n">{int(raw)}</td>
                      <td className="n">{int(acc)}</td>
                      <td>
                        <div className="bar" style={{ height: 10 }}>
                          <i style={{ width: raw ? `${(acc / raw) * 100}%` : 0, background: "var(--green)" }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Duplicates removed</dt><dd className="mono">{int(a.duplicates_removed)}</dd>
          </dl>
        </Panel>
        <Panel title="Quote timestamp precision" sub="How well we know when each price was seen" style={{ flex: "1 1 420px" }}>
          {!prec.length ? <Empty>No precision counts recorded.</Empty> : (
            <>
              <div className="stack" role="img" aria-label={prec.map(([k, v]) => `${k} ${v}`).join(", ")}>
                {prec.map(([k, v]) => <i key={k} title={`${k}: ${v}`} style={{ flexGrow: v, background: PRECISION[k]?.color ?? "#8195B2" }} />)}
              </div>
              <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
                {prec.map(([k, v]) => (
                  <div key={k} style={{ display: "grid", gridTemplateColumns: "14px 90px 70px minmax(0, 1fr)", gap: 8, alignItems: "baseline", fontSize: 13 }}>
                    <i style={{ width: 12, height: 12, borderRadius: 2, background: PRECISION[k]?.color ?? "#8195B2", display: "inline-block" }} />
                    <span className="mono">{k}</span>
                    <span className="mono" style={{ textAlign: "right" }}>{int(v)}</span>
                    <span className="dim">{PRECISION[k]?.meaning ?? ""}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>
      </div>
      <div className="row">
        <Panel title="Invalid quotes by reason" style={{ flex: "1 1 360px" }}>
          <Bars data={a.invalid_quotes_by_reason} tone="var(--red)" />
        </Panel>
        <Panel title="Missing values" style={{ flex: "1 1 360px" }}>
          <Bars data={a.missing_value_counts} tone="var(--amber)" />
        </Panel>
      </div>
      <div className="row">
        <Panel title="Flagged outliers" style={{ flex: "1 1 420px" }}>
          {!a.flagged_outliers.length ? <Empty>No outliers flagged.</Empty> : (
            <table className="data"><thead><tr><th>Quote</th><th>Reason</th></tr></thead>
              <tbody>{a.flagged_outliers.map((o) => <tr key={o.quote_id + o.reason}><td className="mono">{o.quote_id}</td><td>{o.reason}</td></tr>)}</tbody></table>
          )}
        </Panel>
        <Panel title="Exclusions" sub="Decided without looking at outcomes" style={{ flex: "1 1 420px" }}>
          {!a.exclusions.length ? <Empty>No matches excluded.</Empty> : (
            <table className="data"><thead><tr><th>Match</th><th>Reason</th></tr></thead>
              <tbody>{a.exclusions.map((x) => <tr key={x.match_id + x.reason}><td className="mono">{x.match_id}</td><td>{x.reason}</td></tr>)}</tbody></table>
          )}
        </Panel>
      </div>
    </div>
  );
}
