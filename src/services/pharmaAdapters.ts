/**
 * services/pharmaAdapters.ts
 *
 * One adapter per pharma company (config: src/config/scrapeSources.pharma.json).
 * Kept separate on purpose: when one site changes its markup only that
 * adapter breaks, and the scraper route logs it and carries on with the rest.
 *
 * Adapters only read what the public page shows. A field the page doesn't
 * carry stays null — nothing is inferred from the product name or invented.
 */

import { load } from "cheerio";
import { extractDosageForm, extractStrength } from "@/lib/pharmaText";
import { politeFetch, sitemapUrls } from "@/lib/scrapeSupport";

export interface PharmaCompanyConfig {
  id: string;
  name: string;
  website: string;
  adapter: string | null;
  catalogUrls: string[];
  productUrlPattern: string | null;
  selectors: Record<string, string>;
  enabled: boolean;
  lastFetched: string | null;
  notes: string;
}

export interface ScrapedMedicine {
  productName: string;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
  imageUrls: string[];
  sourceUrl: string;
}

export interface PharmaAdapter {
  /** Product page URLs, or fully parsed items for single-page catalogs. */
  list(config: PharmaCompanyConfig, userAgent: string): Promise<{ urls: string[] } | { items: ScrapedMedicine[] }>;
  /** Parse one product page (sitemap-based adapters). */
  parse?(html: string, url: string, config: PharmaCompanyConfig): ScrapedMedicine | null;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/[™®]/g, "").replace(/\s+/g, " ").trim();

/** Strip a "Name - Company - Tagline" <title> down to the product name. */
const titleName = (title: string, separators: RegExp) => clean(title.split(separators)[0]);

/** Product-page URLs from the company's sitemap(s), filtered by its pattern. */
async function listFromSitemaps(config: PharmaCompanyConfig, userAgent: string): Promise<{ urls: string[] }> {
  const pattern = config.productUrlPattern ? new RegExp(config.productUrlPattern) : null;
  const urls: string[] = [];
  for (const sitemap of config.catalogUrls) {
    const xml = await (await politeFetch(sitemap, userAgent)).text();
    urls.push(...sitemapUrls(xml).filter((u) => !pattern || pattern.test(u)));
  }
  return { urls: [...new Set(urls)] };
}

function absolute(src: string | undefined, base: string): string | null {
  if (!src) return null;
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

const getz: PharmaAdapter = {
  list: listFromSitemaps,
  parse(html, url, config) {
    const $ = load(html);
    const productName = titleName($(config.selectors.name).first().text(), /\s[-–]\s/);
    if (!productName) return null;
    const generic = clean($(config.selectors.generic).first().text()).replace(/^Generic Name:\s*/i, "") || null;
    const forms = $(config.selectors.form)
      .map((_, el) => clean($(el).text()))
      .get()
      .filter((t) => t && !/^select$/i.test(t));
    const strengths = $(config.selectors.strength)
      .map((_, el) => clean($(el).text()))
      .get()
      .filter((t) => extractStrength(t) && t.length < 60);
    return {
      productName,
      genericName: generic,
      strength: strengths.length ? strengths.join(", ") : null,
      dosageForm: forms[0] ? extractDosageForm(forms[0]) ?? forms[0] : null,
      // Getz product pages carry no pack images (checked 2026-11-03).
      imageUrls: [],
      sourceUrl: url,
    };
  },
};

const agp: PharmaAdapter = {
  list: listFromSitemaps,
  parse(html, url, config) {
    const $ = load(html);
    const productName = titleName($(config.selectors.name).first().text(), /\s[-–]\s/);
    if (!productName) return null;
    const info = clean($(config.selectors.info).first().text());
    const section = (label: string) =>
      info.match(new RegExp(`${label}:\\s*(.*?)\\s*(?:Generic:|Therapeutic Class:|Composition:|Description:|Indications:|$)`, "i"))?.[1] || null;
    const composition = section("Composition");
    const nameKey = productName.toLowerCase().split(" ")[0];
    const imageUrls = $(config.selectors.image)
      .map((_, el) => absolute($(el).attr("src"), url))
      .get()
      .filter((src): src is string => !!src && src.toLowerCase().includes(nameKey));
    return {
      productName,
      genericName: section("Generic"),
      strength: extractStrength(composition),
      dosageForm: extractDosageForm(composition) ?? extractDosageForm(productName),
      imageUrls: [...new Set(imageUrls)],
      sourceUrl: url,
    };
  },
};

const sami: PharmaAdapter = {
  list: listFromSitemaps,
  parse(html, url, config) {
    const $ = load(html);
    const heading = clean($(config.selectors.name).first().text());
    const match = heading.match(/^(.*?)\s*\((.*)\)\s*$/);
    const productName = clean(match ? match[1] : heading);
    if (!productName) return null;
    const nameKey = productName.toLowerCase().split(" ")[0];
    const imageUrls = $(config.selectors.image)
      .map((_, el) => absolute($(el).attr("src"), url))
      .get()
      .filter((src): src is string => {
        if (!src) return false;
        const file = src.split("/").pop()!.toLowerCase();
        return file.startsWith(nameKey) && !/smpc|logo|download/.test(file);
      });
    return {
      productName,
      genericName: match ? clean(match[2]) : null,
      // SAMI pages don't state the strength in their HTML.
      strength: extractStrength(heading),
      dosageForm: extractDosageForm(heading),
      imageUrls: [...new Set(imageUrls)],
      sourceUrl: url,
    };
  },
};

const gsk: PharmaAdapter = {
  async list(config, userAgent) {
    const items: ScrapedMedicine[] = [];
    for (const pageUrl of config.catalogUrls) {
      const $ = load(await (await politeFetch(pageUrl, userAgent)).text());
      $(config.selectors.row).each((_, tr) => {
        const cells = $(tr).find("td").map((_, td) => clean($(td).text())).get();
        if (cells.length < 2 || !cells[0]) return;
        const [trademark, generic] = cells;
        items.push({
          productName: trademark,
          genericName: generic || null,
          strength: extractStrength(generic) ?? extractStrength(trademark),
          dosageForm: extractDosageForm(trademark),
          imageUrls: [],
          sourceUrl: pageUrl,
        });
      });
    }
    return { items };
  },
};

export const PHARMA_ADAPTERS: Record<string, PharmaAdapter> = { getz, agp, sami, gsk };
