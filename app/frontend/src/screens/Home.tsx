import type { Meta } from "../../../../contract/api_types";
import { Pitch } from "../pitch/Pitch";
import type { Destination, DestId } from "../pitch/geometry";
import { go } from "../route";
import type { Mode } from "../types";

export function HomeScreen({
  researchOpen,
  activeDest,
  onOpen,
  mode,
}: {
  meta: Meta | null;
  researchOpen: boolean;
  activeDest: DestId | null;
  onOpen: (dest: Destination, opener: Element | null) => void;
  mode: Mode;
}) {
  return (
    <div className="home">
      <section className="stage">
        <header className="masthead">
          <h1>
            Find the edge.<br />
            <em>Beat the market.</em>
          </h1>
          <p className="masthead-lede">
            {mode === "normal"
              ? "Spot the matches where the bookmaker got the odds wrong."
              : "Pre-closing fair-value model: edges, calibration, and policy returns."}
          </p>
          <button
            type="button"
            className="btn solid home-cta"
            onClick={() => go("bets")}
          >
            See best bets ↗
          </button>
        </header>
        <Pitch researchOpen={researchOpen} onOpen={onOpen} activeDest={activeDest} />
      </section>
    </div>
  );
}
