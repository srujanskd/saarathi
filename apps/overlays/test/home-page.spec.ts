import { expect, test } from "./helpers/fixtures.js";

test("the home page links every page and registered overlay", async ({ page, pages, saarathi }) => {
  const home = `${pages.origin}/?server=${encodeURIComponent(saarathi.origin)}`;
  await page.goto(home);

  await expect(page.getByTestId("home-control")).toHaveAttribute(
    "href",
    new RegExp(`control\\.html.*server=.*${saarathi.port}`),
  );
  await expect(page.getByTestId("home-deck")).toHaveAttribute(
    "href",
    new RegExp(`deck\\.html.*server=.*${saarathi.port}`),
  );

  const overlays = ["wheel", "goals", "gains", "media"];
  for (const id of overlays) {
    const link = page.getByTestId(`home-overlay-${id}`);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /overlay\.html\?/);
    await expect(link).toHaveAttribute("href", new RegExp(`module=${id}`));
    await expect(link).toHaveAttribute("href", new RegExp(`server=.*${saarathi.port}`));
    await expect(link).toHaveAttribute("href", /access=[^&]+/);
  }
});
