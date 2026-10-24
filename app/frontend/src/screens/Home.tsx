import type { Meta } from "../../../../contract/api_types";
import { ResearchPitch } from "../components/PitchNav";
import { MODEL_LABEL } from "../config";
import { go } from "../route";

export function HomeScreen({ meta, active=true }: { meta: Meta; active?:boolean }) {
  return <div className="home-screen">
    <div className="home-hero">
      <div className="home-intro">
        <div className="home-kicker">OXHACK ’26 / FOOTBALL RESEARCH</div>
        <h1><span>DOES</span><span>THE EDGE</span><em>SURVIVE?</em></h1>
        <p>A forecast is only the first whistle. Explore the market, challenge the decision and see what holds up.</p>
        <button type="button" className="btn solid home-cta" onClick={() => go("replay", { season: meta.seasons.includes("2024-25") ? "2024-25" : undefined })}>Replay a match <span aria-hidden="true">↗</span></button>
        <a className="home-secondary" href="#/evidence">Read the evidence <span aria-hidden="true">→</span></a>
        <div className="home-principle"><span aria-hidden="true">↳</span><p>The most useful answer can be<br /><strong>“no bet”.</strong></p></div>
      </div>
      <ResearchPitch active={active} onGo={(screen) => go(screen)} />
    </div>
    <div className="home-editorial">
      <div><span className="home-section-number">01 / OBSERVE</span><h2>Read the market.</h2><p>See how bookmaker probabilities behave across leagues and seasons.</p></div>
      <div><span className="home-section-number">02 / CHALLENGE</span><h2>Stress the decision.</h2><p>Inspect prices, model error and every reason a paper decision is rejected.</p></div>
      <div><span className="home-section-number">03 / VERIFY</span><h2>Follow the evidence.</h2><p>Compare forecasts and policies. Keep uncertainty and negative results in view.</p></div>
    </div>
    <div className="home-models"><span>MODELS IN THIS DATASET</span><p>{meta.models.length ? meta.models.map((model) => MODEL_LABEL[model] ?? model).join(" / ") : "Waiting for predictions.parquet"}</p></div>
  </div>;
}
