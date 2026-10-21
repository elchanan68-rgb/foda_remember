const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');

test.beforeEach(async ({ page }) => {
  await page.route('**/public-config.js*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'window.FODA_PUBLIC_CONFIG = Object.freeze({ apiUrl: "", turnstileSiteKey: "" });'
  }));
  await page.goto('/');
});

test('smoke: core story flow, gallery navigation, and image-only data survives reload', async ({ page }) => {
  await expect(page.locator('#heroPortrait')).toBeVisible();
  await expect(page.locator('#heroPortrait')).toHaveJSProperty('complete', true);

  await page.locator('[data-open-form]').first().click();
  await page.locator('#memoryStory').fill('זיכרון בדיקת עשן');
  await page.locator('#memoryForm button[type="submit"]').click();
  await expect(page.locator('#memoryGrid')).toContainText('זיכרון בדיקת עשן');

  await page.reload();
  await expect(page.locator('#memoryGrid')).toContainText('זיכרון בדיקת עשן');
  await page.locator('[data-filter="photos"]').click();
  await expect(page.locator('#memoryGrid')).toContainText('לא מצאנו סיפור כזה');
});

test('photo-only memory can be saved locally and remains visible after reload', async ({ page }) => {
  const imageBuffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'foda-portrait.jpg'));
  await page.locator('[data-open-form]').first().click();
  await page.locator('#memoryPhoto').setInputFiles({ name: 'memory.jpg', mimeType: 'image/jpeg', buffer: imageBuffer });
  await expect(page.locator('#photoStatus')).toContainText('תמונה אחת מוכנה', { timeout: 15000 });
  await page.locator('#memoryForm button[type="submit"]').click();
  await expect(page.locator('#memoryGrid')).toContainText('תמונה – רגעים משפחתיים');
  await expect(page.locator('#galleryGrid img')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#memoryGrid')).toContainText('תמונה – רגעים משפחתיים');
  await expect(page.locator('#galleryGrid img')).toHaveCount(1);
});

for (const viewport of [
  { name: 'small phone', width: 360, height: 800 },
  { name: 'large phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 }
]) {
  test(`layout fits ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForLoadState('networkidle');
    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      portraitVisible: !!document.querySelector('#heroPortrait')?.getBoundingClientRect().width,
      navLinks: [...document.querySelectorAll('.main-nav a')].every((link) => link.getBoundingClientRect().width > 0),
      smallTargets: [...document.querySelectorAll('.main-nav a, .button, .filter-chip, .search-box, #managerToggle, .back-top')]
        .filter((target) => target.getClientRects().length)
        .filter((target) => { const rect = target.getBoundingClientRect(); return rect.width < 44 || rect.height < 44; })
        .map((target) => target.className || target.id)
    }));
    expect(dimensions.document, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.portraitVisible).toBe(true);
    expect(dimensions.navLinks).toBe(true);
    expect(dimensions.smallTargets, `touch targets below 44px at ${viewport.width}px`).toEqual([]);
  });
}

test('no automatically detectable accessibility violations on the landing page', async ({ page }) => {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, summary: node.failureSummary })) }))).toEqual([]);
});

test('upload picker allows up to ten images and announces an over-limit selection', async ({ page }) => {
  await page.locator('[data-open-form]').first().click();
  const imageBuffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'foda-portrait.jpg'));
  const files = Array.from({ length: 11 }, (_, index) => ({
    name: `image-${index}.jpg`,
    mimeType: 'image/jpeg',
    buffer: imageBuffer
  }));
  await page.locator('#memoryPhoto').setInputFiles(files);
  await expect(page.locator('#photoStatus')).toContainText(/אפשר לצרף עד 10 תמונות/, { timeout: 60000 });
  await expect(page.locator('#photoPreview .photo-thumb')).toHaveCount(10);
});

test('invalid image bytes are rejected before a memory can be saved', async ({ page }) => {
  await page.locator('[data-open-form]').first().click();
  await page.locator('#memoryPhoto').setInputFiles({
    name: 'not-an-image.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('this is not an image')
  });
  await expect(page.locator('#photoStatus')).toContainText('אפשר להעלות רק תמונות', { timeout: 5000 });
  await page.locator('#memoryForm button[type="submit"]').click();
  await expect(page.locator('#formMessage')).toContainText('צריך לצרף תמונה או לכתוב סיפור קצר.');
});
