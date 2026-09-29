import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  officialWizardAsset,
  officialWizardVersionEditable,
} from "./officialWizardAsset.ts";
import {
  isManagedContestPath,
  resolveManagedContestAsset,
} from "../../lib/admin/contestAsset.ts";
const sha = "a".repeat(64),
  asset = `contest/lct-rshb-2026-09-15/sha256/aa/${sha}.webp`;
test("Wizard display uses explicit matching Package/track and fails closed while bindings differ", () => {
  assert.equal(officialWizardAsset(asset, asset, "historic"), asset);
  assert.equal(officialWizardAsset(asset, "historic", "historic"), null);
  assert.equal(officialWizardAsset(undefined, asset, "historic"), null);
  assert.equal(officialWizardAsset(null, null, "historic"), "historic");
});
test("admin asset proxy only accepts managed contest paths and rejects symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "contest-assets-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "contest-outside-"));
  try {
    assert.ok(isManagedContestPath(asset));
    const full = path.join(root, asset);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "preview");
    assert.equal(
      (await resolveManagedContestAsset(root, asset.split("/")))?.fullPath,
      full,
    );
    for (const bad of [
      "contest/../../secret",
      asset + "/..",
      asset.replace("/aa/", "/bb/"),
      asset.replace("lct-rshb-2026-09-15", "other"),
    ])
      assert.equal(
        await resolveManagedContestAsset(root, bad.split("/")),
        null,
      );
    await rm(full);
    await writeFile(path.join(outside, "secret"), "outside");
    await symlink(path.join(outside, "secret"), full);
    assert.equal(
      await resolveManagedContestAsset(root, asset.split("/")),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("official draft is editable without changing the historical active/default pointers", () => {
  const version = {
    id: "official",
    status: "draft",
    origin: "contest-official",
    annotationTrackId: "official-track",
  };
  assert.equal(
    officialWizardVersionEditable(
      version,
      "historical",
      "official-track",
      asset,
    ),
    true,
  );
  assert.equal(
    officialWizardVersionEditable(
      { ...version, status: "approved" },
      "historical",
      "official-track",
      asset,
    ),
    false,
  );
  assert.equal(
    officialWizardVersionEditable(version, "historical", "other-track", asset),
    false,
  );
  assert.equal(
    officialWizardVersionEditable(
      { ...version, id: "historical", origin: "manual" },
      "historical",
      "official-track",
      asset,
    ),
    false,
  );
});
