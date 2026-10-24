import type { CSSProperties, ReactNode } from "react";

export function Panel(props: {
  title?: ReactNode; sub?: ReactNode; right?: ReactNode; tone?: "amber" | "green" | "red";
  children: ReactNode; className?: string; style?: CSSProperties; id?: string;
}) {
  const cls = ["panel", props.tone ?? "", props.className ?? ""].join(" ").trim();
  return (
    <section className={cls} style={props.style} aria-labelledby={props.id}>
      {(props.title || props.right) && (
        <div className="panel-head">
          <div>
            {props.title && <h2 className="panel-title" id={props.id}>{props.title}</h2>}
            {props.sub && <div className="panel-sub">{props.sub}</div>}
          </div>
          {props.right}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function Kicker({ children, tone }: { children: ReactNode; tone?: "amber" }) {
  return <div className={`kicker ${tone ?? ""}`}><span>{children}</span></div>;
}

export function ScreenHead(props: { kicker: ReactNode; title: ReactNode; lede?: ReactNode; right?: ReactNode; tone?: "amber" }) {
  return (
    <div className="screen-head">
      <div>
        <Kicker tone={props.tone}>{props.kicker}</Kicker>
        <h1 className="title">{props.title}</h1>
        {props.lede && <p className="lede">{props.lede}</p>}
      </div>
      {props.right && <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>{props.right}</div>}
    </div>
  );
}

export function Seg<T extends string>(props: {
  value: T; options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={props.value === o.value} disabled={o.disabled}
          title={o.title} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field(props: { label: string; htmlFor: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="field" style={props.style}>
      <label htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="loading" role="status">Loading {what}…</div>;
}

export function ErrorBox({ error }: { error: string }) {
  return <div className="error" role="alert">{error}</div>;
}

export function Notes({ notes }: { notes?: string[] | null }) {
  if (!notes || notes.length === 0) return null;
  return (
    <ul className="notes">
      {notes.map((n) => <li key={n} className="note">{n}</li>)}
    </ul>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Ball({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#F4F7FB" stroke="#0A1628" strokeWidth="1" />
      <path d="M12 7.3l3.5 2.5-1.35 4.1h-4.3l-1.35-4.1z" fill="#0A1628" />
      <path d="M12 7.3V1.6M15.5 9.8l5.3-1.7M14.15 13.9l3.2 4.5M9.85 13.9l-3.2 4.5M8.5 9.8L3.2 8.1" stroke="#0A1628" strokeWidth="1" fill="none" />
    </svg>
  );
}
