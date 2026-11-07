#!/usr/bin/env python3
"""Walk raw/netcdf and emit one manifest line per (domain, group, variable) unit.

Each line becomes one SLURM array task in 04_convert.py. A "unit" is either:
  - static:   a single <var>.nc file, no time dimension
  - temporal: a set of <YYYY>.nc files under a variable directory, stacked on time
"""

import json
import re
import sys
from pathlib import Path

RAW = Path("/projects/bjey/worldtensor/raw/netcdf")
OUT = Path("/projects/bjey/worldtensor/scripts/variables_manifest.jsonl")

YEAR_RE = re.compile(r"^(\d{4})\.nc$")


def main() -> None:
    units: list[dict[str, object]] = []
    for domain_dir in sorted(RAW.iterdir()):
        if not domain_dir.is_dir():
            continue
        domain = domain_dir.name
        # walk all subdirectories looking for leaf dirs containing .nc files
        for dirpath in [*sorted(p for p in domain_dir.rglob("*") if p.is_dir()), domain_dir]:
            nc_files = sorted(dirpath.glob("*.nc"))
            if not nc_files:
                continue
            # classify: year-named files -> one temporal variable per directory
            year_files = [(f, m.group(1)) for f in nc_files if (m := YEAR_RE.match(f.name))]
            year_paths = {f for f, _ in year_files}
            static_files = [f for f in nc_files if f not in year_paths]

            rel_group = dirpath.relative_to(domain_dir)
            group_parts = [] if str(rel_group) == "." else list(rel_group.parts)

            if year_files:
                var_name = group_parts[-1] if group_parts else domain
                out_group_parts = [domain, *group_parts[:-1], var_name]
                units.append(
                    {
                        "domain": domain,
                        "kind": "temporal",
                        "group_path": "/".join(out_group_parts),
                        "files": [str(f) for f, _ in sorted(year_files, key=lambda t: t[1])],
                        "years": [y for _, y in sorted(year_files, key=lambda t: t[1])],
                    }
                )
            for f in static_files:
                var_name = f.stem
                out_group_parts = [domain, *group_parts, var_name]
                units.append(
                    {
                        "domain": domain,
                        "kind": "static",
                        "group_path": "/".join(out_group_parts),
                        "files": [str(f)],
                        "years": [],
                    }
                )

    with OUT.open("w") as fh:
        for u in units:
            fh.write(json.dumps(u) + "\n")

    print(f"wrote {len(units)} variable units to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
