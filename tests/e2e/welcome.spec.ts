import { expect, test } from "./fixtures.js";
import { forStory } from "./story-cases.js";

const details = forStory("KAN-72");
const heading = "Welcome to Agentic Demo Website";
const navigation = "KAN-72-TC-02: Navigate home by keyboard";
const responsive = "KAN-72-TC-03: Fit mobile and desktop viewports";

test(navigation, details(navigation), async ({ page }) => {
  await page.goto("/welcome.html");
  const home = page.getByRole("link", { name: "Go to Home", exact: true });
  await page.keyboard.press("Tab");
  await expect(home).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("heading", { level: 1, name: /Your space\./ }),
  ).toBeVisible();
});

test(responsive, details(responsive), async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/welcome.html");
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(
      page.getByText("We’re glad you’re here.", { exact: false }),
    ).toBeVisible();
    const home = page.getByRole("link", { name: "Go to Home", exact: true });
    await expect(home).toBeInViewport();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  }
});
