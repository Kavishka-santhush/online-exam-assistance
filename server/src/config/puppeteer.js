/**
 * Puppeteer PDF + screenshot rendering.
 *
 * One browser instance is shared and re-launched on demand; a page is created
 * per render so concurrent certificate/report requests do not collide. When
 * Puppeteer cannot start (missing Chromium in a slim container) callers get a
 * clear `BROWSER_UNAVAILABLE` error rather than a hung request.
 */

const env = require('./env');
const logger = require('../utils/logger.util');

let puppeteerModule = null;
let puppeteerLoadError = null;
let browserPromise = null;

function loadPuppeteer() {
  if (puppeteerModule) return puppeteerModule;
  if (puppeteerLoadError) return null;
  try {
    // eslint-disable-next-line global-require
    puppeteerModule = require('puppeteer');
    return puppeteerModule;
  } catch (error) {
    puppeteerLoadError = error;
    logger.warn('puppeteer is not installed - PDF export endpoints will report unavailable', {
      error: error.message,
    });
    return null;
  }
}

async function getBrowser() {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) return null;

  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: env.isProduction ? 'new' : true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--font-render-hinting=none',
          ...(env.PUPPETEER_ARGS.length ? env.PUPPETEER_ARGS : ['--no-sandbox', '--disable-setuid-sandbox']),
        ],
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  const browser = await browserPromise;
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

async function withPage(run) {
  const browser = await getBrowser();
  if (!browser) {
    const error = new Error('PDF rendering is unavailable on this host (Chromium not installed)');
    error.code = 'BROWSER_UNAVAILABLE';
    throw error;
  }
  const page = await browser.newPage();
  page.setDefaultTimeout(env.PDF_TIMEOUT_MS);
  try {
    return await run(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Print-ready document from an HTML string (certificates, reports, sheets). */
async function htmlToPdf(html, options = {}) {
  const {
    format = 'A4',
    landscape = false,
    printBackground = true,
    margin = { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' },
    scale = 1,
    waitForFonts = true,
    extraWaitMs = 0,
  } = options;

  return withPage(async (page) => {
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: env.PDF_TIMEOUT_MS });
    if (waitForFonts) {
      await page.evaluateHandle('document.fonts ? document.fonts.ready : Promise.resolve()').catch(() => {});
    }
    if (extraWaitMs) await new Promise((resolve) => setTimeout(resolve, extraWaitMs));
    return page.pdf({ format, landscape, printBackground, margin, scale });
  });
}

async function urlToPdf(url, options = {}) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: env.PDF_TIMEOUT_MS });
    if (options.emulateScreen) await page.emulateMediaType('screen');
    return page.pdf({
      format: options.format ?? 'A4',
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      headerTemplate: options.headerTemplate,
      footerTemplate: options.footerTemplate,
      displayHeaderFooter: Boolean(options.headerTemplate || options.footerTemplate),
    });
  });
}

async function urlToScreenshot(url, { width = 1280, height = 720, fullPage = false } = {}) {
  return withPage(async (page) => {
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: env.PDF_TIMEOUT_MS });
    return page.screenshot({ fullPage, type: 'png' });
  });
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
}

function isAvailable() {
  return Boolean(loadPuppeteer());
}

module.exports = {
  closeBrowser,
  htmlToPdf,
  isAvailable,
  urlToPdf,
  urlToScreenshot,
};
