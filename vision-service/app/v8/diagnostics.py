"""Read-only catalog labels for diagnostics; never supplies scoring evidence."""


def label_identities(trace, catalog):
    for rows in trace.get("sources", {}).values():
        for row in rows:
            row["slug"] = catalog.by_id[row["id"]]["official_slug"]
    for key in ("nominations", "ordered"):
        for row in trace.get(key, []):
            row["slug"] = catalog.by_id[row["id"]]["official_slug"]
    return trace
