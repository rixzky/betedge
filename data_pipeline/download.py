"""One-time, polite fetch of Football-Data's official per-season CSV archives."""
from __future__ import annotations

import argparse
import json
import time
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import requests

from contract.schemas import LEAGUES

BASE_URL = "https://www.football-data.co.uk/mmz4281"
USER_AGENT = "OxHack student research; contact via project organiser"


def download_archives(
    raw_dir: Path,
    leagues: list[str],
    seasons: list[str],
    *,
    pause_seconds: float = 0.75,
    session: requests.Session | None = None,
) -> dict:
    """Download only missing league-season CSVs from the provider's season ZIPs.

    One small request per season, cached permanently in the ignored raw-data folder.
    This command is never called by the parser or main pipeline implicitly.
    """
    invalid_leagues = sorted(set(leagues) - set(LEAGUES))
    if invalid_leagues:
        raise ValueError(f"Unsupported leagues: {invalid_leagues}")
    http = session or requests.Session()
    http.headers.update({"User-Agent": USER_AGENT, "Accept": "application/zip"})
    archive_dir = raw_dir / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    fetched: list[str] = []
    cached: list[str] = []
    missing: list[str] = []
    requests_made = 0

    for season_index, season in enumerate(seasons):
        start = int(season[:4])
        season_code = f"{start % 100:02d}{(start + 1) % 100:02d}"
        targets = {league: raw_dir / season_code / f"{league}.csv" for league in leagues}
        wanted = [league for league, path in targets.items() if not (path.exists() and path.stat().st_size)]
        cached.extend(f"{season}/{league}" for league in leagues if league not in wanted)
        if not wanted:
            continue
        if requests_made:
            time.sleep(pause_seconds)
        url = f"{BASE_URL}/{season_code}/data.zip"
        requests_made += 1
        response = http.get(url, timeout=(10, 30))
        if response.status_code == 404:
            missing.extend(f"{season}/{league}" for league in wanted)
            continue
        response.raise_for_status()
        payload = response.content
        if not zipfile.is_zipfile(BytesIO(payload)):
            raise ValueError(f"Provider returned a non-ZIP response for {url}")
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            # Match by basename only and never extract untrusted archive paths.
            by_name = {Path(item.filename).name.upper(): item for item in archive.infolist() if not item.is_dir()}
            for league in wanted:
                info = by_name.get(f"{league}.CSV")
                if info is None:
                    missing.append(f"{season}/{league}")
                    continue
                destination = targets[league]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(info))
                fetched.append(f"{season}/{league}")

    return {
        "source": "football-data.co.uk season CSV archives",
        "source_url_pattern": f"{BASE_URL}/YYZZ/data.zip",
        "download_date_utc": started.date().isoformat(),
        "started_at_utc": started.isoformat().replace("+00:00", "Z"),
        "finished_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "fetched": fetched,
        "cached": cached,
        "missing": missing,
    }


def parse_seasons(value: str) -> list[str]:
    """Parse YYYY-YY:YYYY-YY inclusive (or one YYYY-YY)."""
    parts = value.split(":", 1)
    first = int(parts[0][:4])
    last = int(parts[-1][:4])
    if first > last:
        raise argparse.ArgumentTypeError("season range must be ascending")
    return [f"{year}-{(year + 1) % 100:02d}" for year in range(first, last + 1)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--leagues", nargs="+", default=["E0"])
    parser.add_argument("--seasons", default="2005-06:2025-26")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--pause-seconds", type=float, default=0.75)
    args = parser.parse_args()
    result = download_archives(args.raw_dir, args.leagues, parse_seasons(args.seasons), pause_seconds=args.pause_seconds)
    args.raw_dir.mkdir(parents=True, exist_ok=True)
    (args.raw_dir / "download_manifest.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Fetched {len(result['fetched'])} CSVs; reused {len(result['cached'])}; missing {len(result['missing'])}.")
    if result["missing"]:
        print("Unavailable files:")
        for item in result["missing"]:
            print(f"  {item}")


if __name__ == "__main__":
    main()
