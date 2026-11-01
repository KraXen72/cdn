// Run with playwright-cli run-code after opening a local preview in an isolated session.
async function testBiblePlan(page) {
  const base = new URL("./", page.url()).href;
  const key = "kraxen-bible-plan-progress-v1";
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  await page.addInitScript(() => {
    window.confirm = () => true;
    window.testAlerts = [];
    window.alert = (message) => window.testAlerts.push(message);
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "part-1.html");
  await page.evaluate((key) => localStorage.removeItem(key), key);
  await page.reload();
  assert(
    (await page.locator("[data-type=reading]").count()) === 130,
    "static reading count",
  );
  assert((await page.locator("h2").count()) === 6, "months");
  assert((await page.locator("h3").count()) === 26, "weeks");
  await page.locator("#reading-1 input").check();
  assert(
    await page.locator("#week-1 input").evaluate((e) => e.indeterminate),
    "mixed week",
  );
  assert(
    await page.locator("#month-1 input").evaluate((e) => e.indeterminate),
    "mixed month",
  );
  assert(
    await page.locator("h1 input").evaluate((e) => e.indeterminate),
    "mixed part",
  );
  await page.reload();
  assert(
    await page.locator("#reading-1 input").isChecked(),
    "saved reading after reload",
  );
  await page.locator("#week-1 input").check();
  assert(
    (await page.locator("[data-type=reading]:checked").count()) === 5,
    "week toggles descendants",
  );
  await page.locator("#month-1 input").check();
  assert(
    (await page.locator("[data-type=reading]:checked").count()) === 20,
    "month toggles descendants",
  );
  await page.locator("#toast button").click();
  assert(
    (await page.locator("[data-type=reading]:checked").count()) === 5,
    "bulk undo",
  );
  await page.locator("h1 input").check();
  assert(
    (await page.locator("[data-type=reading]:checked").count()) === 130,
    "part toggles descendants",
  );
  await page.goto(base);
  await page.waitForURL("**/part-2.html");
  assert(
    (await page.locator("#total-count").textContent()) === "130 / 518",
    "progress shared across parts",
  );

  await page.locator("#backup-menu summary").click();
  const downloading = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloading;
  await download.saveAs("/tmp/bible-test-export.json");
  assert(download.suggestedFilename().endsWith(".json"), "JSON download");
  await page.locator("#reading-131 input").check();
  await page
    .locator("#import-file")
    .setInputFiles("/tmp/bible-test-export.json");
  await page.waitForFunction(
    () => document.getElementById("total-count").textContent === "130 / 518",
  );
  assert(
    !(await page.locator("#reading-131 input").isChecked()),
    "import replaces current progress",
  );
  await page.locator("#toast button").click();
  assert(await page.locator("#reading-131 input").isChecked(), "import undo");

  const invalid = {
    app: "kraxen-2-year-bible-plan",
    version: 1,
    completed: [519],
  };
  await page
    .locator("#import-file")
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(invalid)),
    });
  await page.waitForFunction(() => window.testAlerts.length === 1);
  assert(
    (await page.evaluate(() => window.testAlerts[0])).startsWith(
      "Import zlyhal",
    ),
    "invalid import rejected",
  );
  assert(
    await page.locator("#reading-131 input").isChecked(),
    "invalid import preserves progress",
  );

  const other = await page.context().newPage();
  await other.goto(base + "part-2.html");
  await page.locator("#reading-131 input").uncheck();
  await other.waitForFunction(
    () => !document.querySelector("#reading-131 input").checked,
  );
  await other.close();

  await page.goto(base + "part-4.html");
  assert(
    (await page.locator("[data-type=reading]").count()) === 128,
    "final part count",
  );
  assert(
    (await page.locator("#week-104 input").getAttribute("data-ids")) ===
      "516,517,518",
    "last week has three readings",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "no mobile overflow",
  );
  await page.screenshot({ path: "/tmp/bible-mobile.png" });

  const staticContext = await page
    .context()
    .browser()
    .newContext({ javaScriptEnabled: false });
  const staticPage = await staticContext.newPage();
  await staticPage.goto(base + "part-1.html");
  assert(
    (await staticPage.locator("[data-type=reading]").count()) === 130,
    "complete content without JS",
  );
  assert(
    (await staticPage.locator(".callout-title").textContent()) ===
      "How to use this plan",
    "callout rendered",
  );
  await staticContext.close();

  await page.goto(base + "part-1.html");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  await page.locator("#reading-1 input").click();
  assert(
    await page.locator("#reading-1 input").isChecked(),
    "failed save rolls back",
  );
  assert(await page.locator("#save-status").isVisible(), "failed save visible");
  await page.reload();
  await page.evaluate((key) => localStorage.removeItem(key), key);
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "/tmp/bible-local.png" });
  assert(errors.length === 0, "browser errors: " + errors.join(", "));
  return "PASS: hierarchy, persistence, routing, legacy backup roundtrip, validation, undo, cross-tab sync, unavailable storage, mobile, and no-JS rendering";
}
