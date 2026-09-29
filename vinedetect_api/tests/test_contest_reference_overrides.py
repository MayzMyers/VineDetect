from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest
from PIL import Image
from psycopg.types.json import Jsonb

from app import contest_reference_overrides as overrides
from tests.test_contest_import import db as db
from tests.test_contest_reference_assets import (
    bind_catalog,
    write,
)
from tests.test_contest_reference_assets import (
    data as contest_reference_data,
)


HISTORICAL_MANIFEST = Path(__file__).parent / "fixtures/dq2_superseded/reference-overrides.json"


def historical_manifest():
    """Explicit historical fixture; never the active organizer-truth input."""
    return overrides.load_manifest(HISTORICAL_MANIFEST)


@pytest.fixture
def reference_data(tmp_path):
    return contest_reference_data.__wrapped__(tmp_path)


def make_manifest(db, reference_data, status="replacement_confirmed"):
    bind_catalog(db, reference_data)
    write(db, reference_data)
    current = db.execute(
        "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
    ).fetchone()
    target = next(
        row
        for row in reference_data[0]["assignments"]
        if row["catalog_item_id"] == current["catalog_item_id"]
    )
    replacement_path = reference_data[1] / "replacement.png"
    Image.new("RGB", (14, 22), "green").save(replacement_path, format="PNG")
    raw = replacement_path.read_bytes()
    replacement = {
        "source_authority": "official_test_archive",
        "source_path": replacement_path.name,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "width": 14,
        "height": 22,
        "byte_size": len(raw),
        "mime_type": "image/png",
    }
    entry = {
        "catalog_item_id": current["catalog_item_id"],
        "official_slug": target["official_slug"],
        "status": status,
        "reason": "Human-confirmed test replacement",
        "expected_current": {
            "reference_asset_id": current["id"],
            "path": current["local_path"],
            "sha256": current["sha256"],
            "width": current["width"],
            "height": current["height"],
            "provenance": current["provenance"],
        },
        "candidate_assets": [],
        "replacement": replacement if status == "replacement_confirmed" else None,
    }
    return {
        "schema_version": "contest-reference-overrides/1",
        "contest_version": "lct-test-v1",
        "entries": [entry],
    }


def test_override_cannot_apply_without_explicit_confirmation(db, reference_data):
    manifest = make_manifest(db, reference_data, status="confirmed_bad")
    assert overrides.confirmed_entries(manifest) == []
    result = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=True,
        expected_count=3,
        expected_resolved_count=0,
    )
    assert result["would_update"] == result["updated"] == 0


def test_content_sha_verification_prevents_publication(db, reference_data):
    manifest = make_manifest(db, reference_data)
    manifest["entries"][0]["replacement"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="sha256 mismatch"):
        overrides.materialize(manifest, reference_data[1], reference_data[2])
    destination = reference_data[2] / overrides.managed_path(
        manifest, manifest["entries"][0]["replacement"]
    )
    assert not destination.exists()


def test_dry_run_apply_replay_and_unchanged_non_targets(db, reference_data):
    manifest = make_manifest(db, reference_data)
    before = db.execute(
        "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
    ).fetchall()
    materialized = overrides.materialize(manifest, reference_data[1], reference_data[2])
    assert materialized["created_files"] == 1
    dry = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=True,
        expected_count=3,
        expected_resolved_count=0,
    )
    assert dry["would_update"] == 1 and dry["updated"] == 0
    assert (
        db.execute(
            "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
        ).fetchall()
        == before
    )
    applied = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=False,
        expected_count=3,
        expected_resolved_count=0,
    )
    assert applied["updated"] == 1
    assert applied["non_target_references_unchanged"] is True
    target_id = manifest["entries"][0]["catalog_item_id"]
    after = db.execute(
        "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
    ).fetchall()
    assert [row for row in before if row["catalog_item_id"] != target_id] == [
        row for row in after if row["catalog_item_id"] != target_id
    ]
    changed = next(row for row in after if row["catalog_item_id"] == target_id)
    assert changed["sha256"] == manifest["entries"][0]["replacement"]["sha256"]
    assert changed["provenance"]["schema_version"] == (
        "contest-reference-override-evidence/1"
    )
    assert changed["provenance"]["source_asset"] == {
        "original_filename": "replacement.png",
        "sha256": manifest["entries"][0]["replacement"]["sha256"],
        "mime_type": "image/png",
        "width": 14,
        "height": 22,
        "byte_size": manifest["entries"][0]["replacement"]["byte_size"],
        "reviewer_note": "Human-confirmed test replacement",
    }
    replay = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=False,
        expected_count=3,
        expected_resolved_count=0,
    )
    assert replay["updated"] == 0 and replay["already_applied"] == 1
    assert (
        after
        == db.execute(
            "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
        ).fetchall()
    )
    assert (
        reference_data[2] / manifest["entries"][0]["expected_current"]["path"]
    ).exists()


def test_guarded_materialized_wine_title_override_is_idempotent(db, reference_data):
    manifest = make_manifest(db, reference_data)
    entry = manifest["entries"][0]
    wine = db.execute(
        """
        INSERT INTO svoe_vino.wines (
            slug,title,manufacturer_name,category_name,source,external_id
        )
        VALUES (%s,%s,%s,%s,%s,%s)
        RETURNING id,slug,title,manufacturer_name,category_name,source,external_id
        """,
        (
            "display-wine",
            "Old display title",
            "Winery",
            "$>7>6>5",
            "vino-svoe",
            "display-wine",
        ),
    ).fetchone()
    db.execute(
        "UPDATE contest.item_links SET wine_id=%s,method='manual',confidence=1 "
        "WHERE catalog_item_id=%s",
        (wine["id"], entry["catalog_item_id"]),
    )
    entry["wine_metadata"] = {
        "wine_id": wine["id"],
        "expected": {key: wine[key] for key in overrides.WINE_METADATA_EXPECTED_FIELDS},
        "replacement": {"title": "Corrected display title"},
        "reviewer_note": "Human-confirmed label and catalog context",
    }
    overrides.materialize(manifest, reference_data[1], reference_data[2])
    dry = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=True,
        expected_count=3,
        expected_resolved_count=1,
    )
    assert dry["metadata_would_update"] == 1
    assert dry["metadata_updated"] == 0
    assert dry["metadata_diffs"][0]["old"]["title"] == "Old display title"
    assert dry["metadata_diffs"][0]["new"]["title"] == "Corrected display title"
    assert (
        db.execute(
            "SELECT title FROM svoe_vino.wines WHERE id=%s", (wine["id"],)
        ).fetchone()["title"]
        == "Old display title"
    )

    applied = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=False,
        expected_count=3,
        expected_resolved_count=1,
    )
    assert applied["metadata_updated"] == 1
    assert applied["non_target_wines_unchanged"] is True
    current = db.execute(
        "SELECT id,slug,title FROM svoe_vino.wines WHERE id=%s", (wine["id"],)
    ).fetchone()
    assert current == {
        "id": wine["id"],
        "slug": "display-wine",
        "title": "Corrected display title",
    }

    replay = overrides.write_overrides(
        db,
        manifest,
        reference_data[2],
        dry_run=False,
        expected_count=3,
        expected_resolved_count=1,
    )
    assert replay["metadata_updated"] == 0
    assert replay["metadata_already_applied"] == 1


def test_override_schema_rejects_duplicate_and_unconfirmed_payload(db, reference_data):
    manifest = make_manifest(db, reference_data, status="pending_review")
    manifest["entries"][0]["replacement"] = {
        "source_authority": "official",
        "source_path": "replacement.png",
        "sha256": "a" * 64,
        "width": 1,
        "height": 1,
        "byte_size": 1,
        "mime_type": "image/png",
    }
    with pytest.raises(ValueError, match="Only replacement_confirmed"):
        overrides.validate_manifest(manifest)
    clean = copy.deepcopy(manifest)
    clean["entries"][0]["replacement"] = None
    clean["entries"].append(copy.deepcopy(clean["entries"][0]))
    with pytest.raises(ValueError, match="duplicate catalog_item_id"):
        overrides.validate_manifest(clean)


def test_canonical_manifest_and_exact_source_assets(tmp_path, capsys):
    manifest = historical_manifest()
    entries = {entry["catalog_item_id"]: entry for entry in manifest["entries"]}
    assert overrides.DEFAULT_MANIFEST == (
        overrides.PROJECT_DATA_ROOT / "lct-rshb-2026-09-15.json"
    )
    assert manifest["approval_manifest_sha256"] == (
        "dc6099769084620febdb123c85529c3cdd5b7a71b1cb873d8b14b807df4fb9d1"
    )
    assert set(entries) == {61, 106, 554, 566, 597, 605, 1185, 1399, 1681, 2050}
    assert (entries[1399]["official_slug"], entries[1399]["wine_id"]) == (
        "ona-skazala-da",
        3873,
    )
    assert (entries[1681]["official_slug"], entries[1681]["wine_id"]) == (
        "rozovoe-polusladkoe-2",
        3899,
    )
    assert entries[1399]["expected_current"]["sha256"] == (
        "f7dedb8b3922dbaa56a0c63535e99b569208a06b782483022f085061eeebbabd"
    )
    assert entries[1681]["expected_current"]["sha256"] == (
        "0281e2d0268e36f2f003c62bcb0663ea2b7762bf8df5c13b5db261cba2bc5f13"
    )
    assert entries[1399]["replacement"]["sha256"] == (
        "faafe52948561d0e773ff68c3268c1902a4b3cd4e153e7d2dbd79f8a518834b9"
    )
    assert entries[1681]["replacement"]["sha256"] == (
        "e9db843f732c131c80a3a9dcf095faf8cfae492256fdcaac3886db10d629e334"
    )
    assert entries[1399]["wine_metadata"]["replacement"]["title"] == (
        "Фанагория Она сказала Да! розовое полусладкое"
    )
    assert set(
        overrides.validate_sources(manifest, overrides.PROJECT_DATA_ROOT)
    ) == set(entries)

    assert overrides.main(["materialize", "--manifest", str(HISTORICAL_MANIFEST), "--source-root", str(overrides.PROJECT_DATA_ROOT), "--asset-root", str(tmp_path)]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["confirmed_replacements"] == 10
    assert output["created_files"] == 10


def _seed_canonical_override_state(db, manifest):
    db.execute(
        """
        INSERT INTO contest.import_runs (
            id,version,source_filename,source_sha256,source_bytes,
            parser_config,metadata,status,completed_at
        ) VALUES (1,%s,'official.csv',%s,%s,%s,%s,'completed',now())
        """,
        (
            manifest["contest_version"],
            "0" * 64,
            b"canonical override replay fixture",
            Jsonb({}),
            Jsonb({}),
        ),
    )
    for row_number, entry in enumerate(manifest["entries"], start=1):
        metadata = entry.get("wine_metadata", {}).get("expected") or {
            "slug": entry["official_slug"],
            "title": entry["official_slug"],
            "manufacturer_name": "Fixture winery",
            "category_name": "Fixture category",
            "source": "vino-svoe",
            "external_id": entry["official_slug"],
        }
        db.execute(
            """
            INSERT INTO svoe_vino.wines (
                id,slug,title,manufacturer_name,category_name,source,external_id
            ) VALUES (%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                entry["wine_id"],
                metadata["slug"],
                metadata["title"],
                metadata["manufacturer_name"],
                metadata["category_name"],
                metadata["source"],
                metadata["external_id"],
            ),
        )
        db.execute(
            """
            INSERT INTO contest_raw.catalog_rows (
                import_run_id,source_row_number,source_line_end,
                official_slug,raw_row,row_sha256
            ) VALUES (1,%s,%s,%s,%s,%s)
            """,
            (
                row_number,
                row_number + 1,
                entry["official_slug"],
                Jsonb({"slug": entry["official_slug"]}),
                f"{row_number:064x}",
            ),
        )
        db.execute(
            """
            INSERT INTO contest.catalog_items (
                id,import_run_id,official_slug,source_row_number,title,
                category,color,region,grapes,description,winery,photo_name
            ) VALUES (%s,1,%s,%s,%s,'','','','','','','source.webp')
            """,
            (
                entry["catalog_item_id"],
                entry["official_slug"],
                row_number,
                entry["official_slug"],
            ),
        )
        current = entry["expected_current"]
        db.execute(
            """
            INSERT INTO contest.reference_assets (
                id,catalog_item_id,original_filename,local_path,sha256,
                width,height,byte_size,mime_type,resolution_method,
                provenance,review_note
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,1,'image/webp',
                      'source_preserving_shared',%s,'pre-override fixture')
            """,
            (
                current["reference_asset_id"],
                entry["catalog_item_id"],
                Path(current["path"]).name,
                current["path"],
                current["sha256"],
                current["width"],
                current["height"],
                Jsonb(current["provenance"]),
            ),
        )
        db.execute(
            """
            INSERT INTO contest.item_links (
                catalog_item_id,wine_id,method,confidence,provenance
            ) VALUES (%s,%s,'manual',1,%s)
            """,
            (entry["catalog_item_id"], entry["wine_id"], Jsonb({})),
        )


def test_fresh_replay_from_canonical_manifest_applies_all(db, tmp_path):
    manifest = historical_manifest()
    _seed_canonical_override_state(db, manifest)
    asset_root = tmp_path / "asset-store"
    materialized = overrides.materialize(
        manifest, overrides.PROJECT_DATA_ROOT, asset_root
    )
    assert materialized["created_files"] == 10

    dry = overrides.write_overrides(
        db,
        manifest,
        asset_root,
        dry_run=True,
        expected_count=10,
        expected_resolved_count=10,
    )
    assert dry["would_update"] == 10
    assert dry["metadata_would_update"] == 1
    assert dry["changed_sha_catalog_item_ids"] == [
        61,
        106,
        554,
        566,
        597,
        605,
        1185,
        1399,
        1681,
        2050,
    ]

    applied = overrides.write_overrides(
        db,
        manifest,
        asset_root,
        dry_run=False,
        expected_count=10,
        expected_resolved_count=10,
    )
    assert applied["updated"] == 10
    assert applied["metadata_updated"] == 1
    assert db.execute(
        "SELECT catalog_item_id,sha256 FROM contest.reference_assets "
        "ORDER BY catalog_item_id"
    ).fetchall() == [
        {
            "catalog_item_id": entry["catalog_item_id"],
            "sha256": entry["replacement"]["sha256"],
        }
        for entry in manifest["entries"]
    ]
    assert (
        db.execute("SELECT title FROM svoe_vino.wines WHERE id=3873").fetchone()[
            "title"
        ]
        == "Фанагория Она сказала Да! розовое полусладкое"
    )

    replay = overrides.write_overrides(
        db,
        manifest,
        asset_root,
        dry_run=False,
        expected_count=10,
        expected_resolved_count=10,
    )
    assert replay["updated"] == 0
    assert replay["already_applied"] == 10
    assert replay["metadata_updated"] == 0
    assert replay["metadata_already_applied"] == 1


@pytest.mark.parametrize(
    ("command", "extra", "expected_dry_run"),
    [
        ("dry-run", [], True),
        ("apply", ["--apply"], False),
    ],
)
def test_database_cli_defaults_to_canonical_manifest(
    tmp_path, monkeypatch, capsys, command, extra, expected_dry_run
):
    captured = {}

    def fake_run(database_url, manifest, asset_root, *, dry_run):
        captured.update(
            database_url=database_url,
            manifest=manifest,
            asset_root=asset_root,
            dry_run=dry_run,
        )
        return {"ok": True}

    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")
    monkeypatch.setattr(overrides, "run_database", fake_run)
    assert overrides.main([command, *extra, "--asset-root", str(tmp_path)]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True}
    assert captured["database_url"] == "postgresql://unused"
    assert captured["asset_root"] == tmp_path
    assert captured["dry_run"] is expected_dry_run
    assert [entry["catalog_item_id"] for entry in captured["manifest"]["entries"]] == [1399, 1681]


def test_dq2_reviewed_replacements_preserve_identity_and_provenance():
    entries = {
        entry["catalog_item_id"]: entry
        for entry in historical_manifest()["entries"]
    }
    expected = {
        554: (
            "554_vibes-silvaner-2021.png",
            "e902f6668f455368e5142ade2eb315b42daee77153bf80851fe11220313aed8d",
            552,
            1853,
            972608,
            "image/png",
        ),
        605: (
            "605_vibes-vermentino-viognier-barrel-fermented-2022.png",
            "e78b466664c00ca4e798ab2f138a99a7e56f823905325d9bf2a1bd7743bbadc4",
            552,
            1853,
            1428460,
            "image/png",
        ),
        2050: (
            "2050_skalistyy-bereg_shepot-cvetov.webp",
            "215392797c16796600fbc0ef9b3184c4addf5514a2cf5fe8b8dd350d5681f8e7",
            278,
            1058,
            29610,
            "image/webp",
        ),
    }
    assert not set(entries) & {602, 603, 844, 1775}
    for catalog_id, values in expected.items():
        entry = entries[catalog_id]
        assert "wine_metadata" not in entry
        replacement = entry["replacement"]
        assert (
            tuple(
                replacement[field]
                for field in (
                    "source_path",
                    "sha256",
                    "width",
                    "height",
                    "byte_size",
                    "mime_type",
                )
            )
            == values
        )
        assert entry["status"] == "replacement_confirmed"
        assert entry["wine_id"] > 0
    assert entries[2050]["replacement"]["reviewer_note"] == (
        "Upstream source card appears to contain an incorrect product image.\n"
        "Reference locally corrected to the human-verified Шёпот цветов product "
        "image matching catalog item 1775."
    )
    for catalog_id in (554, 605):
        assert entries[catalog_id]["replacement"]["source_authority"] == (
            "human_verified_producer_product_image"
        )


def test_dq2_incremental_apply_changes_only_three_references(db, tmp_path):
    from app.contest_identity_state import fingerprint, read_rows

    manifest = historical_manifest()
    manifest["entries"] = [
        e
        for e in manifest["entries"]
        if e["catalog_item_id"] in (554, 605, 1399, 1681, 2050)
    ]
    _seed_canonical_override_state(db, manifest)
    asset_root = tmp_path / "assets"
    overrides.materialize(manifest, overrides.PROJECT_DATA_ROOT, asset_root)
    previous = {
        **manifest,
        "entries": [
            e for e in manifest["entries"] if e["catalog_item_id"] in (1399, 1681)
        ],
    }
    overrides.write_overrides(db, previous, asset_root, dry_run=False, expected_count=5)
    protected = (
        "contest.catalog_items",
        "contest.item_links",
        "svoe_vino.wines",
        "svoe_vino.wine_images",
        "svoe_vino.grapes",
        "svoe_vino.wine_grapes",
    )
    before = {name: fingerprint(read_rows(db, name)) for name in protected}
    refs = read_rows(db, "contest.reference_assets")
    dry = overrides.write_overrides(
        db, manifest, asset_root, dry_run=True, expected_count=5
    )
    assert dry["would_update"] == 3
    assert dry["metadata_would_update"] == 0
    assert dry["already_applied"] == 2
    assert [
        d["catalog_item_id"] for d in dry["diffs"] if d["state"] == "would_update"
    ] == [554, 605, 2050]
    assert fingerprint(read_rows(db, "contest.reference_assets")) == fingerprint(refs)
    applied = overrides.write_overrides(
        db, manifest, asset_root, dry_run=False, expected_count=5
    )
    assert applied["updated"] == 3
    assert applied["metadata_updated"] == 0
    assert [
        d["catalog_item_id"] for d in applied["diffs"] if d["state"] == "updated"
    ] == [554, 605, 2050]
    assert before == {name: fingerprint(read_rows(db, name)) for name in protected}
    after = read_rows(db, "contest.reference_assets")
    assert fingerprint([r for r in refs if r["catalog_item_id"] in (1399, 1681)]) == (
        fingerprint([r for r in after if r["catalog_item_id"] in (1399, 1681)])
    )
    replay = overrides.write_overrides(
        db, manifest, asset_root, dry_run=False, expected_count=5
    )
    assert replay["updated"] == replay["metadata_updated"] == 0
    assert replay["already_applied"] == 5
    assert fingerprint(read_rows(db, "contest.reference_assets")) == fingerprint(after)


ROUND2_REPLACEMENTS = [
    [
        61,
        "61_agora-yachting-cabernet-sauvignon.jpg",
        "7caa93fd269442e39f450e42af1beea6c9f119f431bd316f872260329f42dee0",
        "Agora Yachting Cabernet Sauvignon",
        65,
        "Sauvignon Blanc",
    ],
    [
        106,
        "106_az-abrau-bayanshira.webp",
        "f6f2735eed817b92abf89b53b3edab187f9b6c35c36ef970de6d4fb56b1aaf3c",
        "Az Abrau Bayanshira",
        107,
        "Madrasa",
    ],
    [
        566,
        "566_belmas-syrah-katya.png",
        "e60f45bc9ccb960d268ab0903f61e5a97cf1fef42125f3ebc53f2eb00691df8d",
        "Belmas Syrah Katya",
        515,
        "Riesling Katya",
    ],
    [
        597,
        "597_belmas-vi-viognier.png",
        "405e95fe401a49a48719d2a6ac3a70c93fd4733582b0c5626c0ae73508cc489e",
        "Belmas Vi / Viognier",
        464,
        "Pinot Noir Pn",
    ],
    [
        1185,
        "1185_chateau-le-grand-vostock-krasnostop-reserve.jpg",
        "40ac7cf00ad1e882aa724b21516704ef7608e57928b755a23b2b25f76d5fc3ef",
        "Château Le Grand Vostock Krasnostop Reserve",
        899,
        "Château Ay-Danil Grenache",
    ],
]
ROUND2_CONTROLS = [65, 107, 515, 464, 899, 1842, 1843, 1848]


def test_round2_canonical_sources_and_reviewed_provenance():
    manifest = historical_manifest()
    entries = {e["catalog_item_id"]: e for e in manifest["entries"]}
    assert not set(entries) & set(ROUND2_CONTROLS)
    for catalog_id, filename, expected_sha, product, peer, _ in ROUND2_REPLACEMENTS:
        entry = entries[catalog_id]
        replacement = entry["replacement"]
        assert entry["status"] == "replacement_confirmed"
        assert "wine_metadata" not in entry
        assert replacement["source_path"] == filename
        assert replacement["sha256"] == expected_sha
        assert replacement["source_authority"] == "human_verified_product_image"
        assert product in replacement["reviewer_note"]
        assert f"catalog item {peer}" in replacement["reviewer_note"]
        source = overrides.PROJECT_DATA_ROOT / filename
        assert hashlib.sha256(source.read_bytes()).hexdigest() == expected_sha
        with Image.open(source) as image:
            image.load()
            assert image.size == (replacement["width"], replacement["height"])
            assert Image.MIME[image.format] == replacement["mime_type"]
        assert source.stat().st_size == replacement["byte_size"]


def test_round2_only_five_references_change_and_controls_survive(db, tmp_path):
    from app.contest_identity_state import fingerprint, read_rows

    manifest = historical_manifest()
    targets = [r[0] for r in ROUND2_REPLACEMENTS]
    entries = {e["catalog_item_id"]: e for e in manifest["entries"]}
    seed = copy.deepcopy(manifest)
    peer_to_target = {r[4]: r[0] for r in ROUND2_REPLACEMENTS}
    for control in ROUND2_CONTROLS:
        # Protected peers start with the same reference as their reviewed target.
        template = copy.deepcopy(entries[peer_to_target.get(control, 61)])
        template.update(
            catalog_item_id=control,
            official_slug=f"protected-control-{control}",
            wine_id=100000 + control,
        )
        template["expected_current"]["reference_asset_id"] = 100000 + control
        seed["entries"].append(template)
    _seed_canonical_override_state(db, seed)
    count = len(seed["entries"])
    asset_root = tmp_path / "assets"
    overrides.materialize(manifest, overrides.PROJECT_DATA_ROOT, asset_root)
    previous = {
        **manifest,
        "entries": [
            e for e in manifest["entries"] if e["catalog_item_id"] not in targets
        ],
    }
    overrides.write_overrides(
        db, previous, asset_root, dry_run=False, expected_count=count
    )
    tables = (
        "contest.catalog_items",
        "contest.item_links",
        "svoe_vino.wines",
        "svoe_vino.wine_images",
        "svoe_vino.grapes",
        "svoe_vino.wine_grapes",
    )
    before = {name: fingerprint(read_rows(db, name)) for name in tables}
    refs_before = {
        r["catalog_item_id"]: r for r in read_rows(db, "contest.reference_assets")
    }
    dry = overrides.write_overrides(
        db, manifest, asset_root, dry_run=True, expected_count=count
    )
    assert dry["would_update"] == 5 and dry["already_applied"] == 5
    assert dry["metadata_would_update"] == 0
    assert [
        d["catalog_item_id"] for d in dry["diffs"] if d["state"] == "would_update"
    ] == targets
    assert refs_before == {
        r["catalog_item_id"]: r for r in read_rows(db, "contest.reference_assets")
    }
    applied = overrides.write_overrides(
        db, manifest, asset_root, dry_run=False, expected_count=count
    )
    assert applied["updated"] == 5 and applied["metadata_updated"] == 0
    refs_after = {
        r["catalog_item_id"]: r for r in read_rows(db, "contest.reference_assets")
    }
    assert sorted(k for k in refs_before if refs_before[k] != refs_after[k]) == targets
    for target, _, _, _, control, _ in ROUND2_REPLACEMENTS:
        assert refs_before[target]["sha256"] == refs_before[control]["sha256"]
        assert refs_after[target]["sha256"] != refs_after[control]["sha256"]
    for control in ROUND2_CONTROLS:
        assert refs_after[control] == refs_before[control]
    assert before == {name: fingerprint(read_rows(db, name)) for name in tables}
    replay = overrides.write_overrides(
        db, manifest, asset_root, dry_run=False, expected_count=count
    )
    assert replay["updated"] == replay["metadata_updated"] == 0
    assert replay["already_applied"] == 10
    assert refs_after == {
        r["catalog_item_id"]: r for r in read_rows(db, "contest.reference_assets")
    }


def test_organizer_truth_canonical_replay_excludes_only_rolled_back_ids():
    active = overrides.load_manifest()
    historical = historical_manifest()
    assert active["entries"] == [e for e in historical["entries"] if e["catalog_item_id"] in (1399, 1681)]
    assert {e["catalog_item_id"] for e in overrides.confirmed_entries(active)} == {1399, 1681}
