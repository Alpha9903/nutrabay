const axios = require('axios');
const cheerio = require('cheerio');
const botConfig = require('../config/bot_prompts');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class ScraperService {
    constructor() {
        this.cacheFile = path.join(__dirname, '../memory/scraped_data.json');
        this.cache = this.loadCache();
        this.queue = [];
        this.processing = false;
        this.seenProductUrls = new Set();
        this.maxConcurrent = 3;
        this.retryLimit = 2;
        this.axiosConfig = {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': botConfig.company && botConfig.company.website_url ? botConfig.company.website_url : undefined
            },
            timeout: 10000,
            proxy: false
        };
    }

    loadCache() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            }
        } catch (e) {
            console.error('[Scraper] Failed to load cache:', e.message);
        }
        return { products: {}, knowledge: {} };
    }

    saveCache() {
        try {
            const dir = path.dirname(this.cacheFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
        } catch (e) {
            console.error('[Scraper] Failed to save cache:', e.message);
        }
    }

    async scrapeAll() {
        console.log('[Scraper] Starting full scrape...');
        this.cache = { products: {}, knowledge: {} };
        this.queue = [];
        this.seenProductUrls = new Set();
        
        const productUrls = botConfig.product_urls || [];
        const knowledgeUrls = botConfig.knowledge_urls || [];

        const productTasks = productUrls.map(url => ({ url, type: 'product' }));
        const knowledgeTasks = knowledgeUrls.map(url => ({ url, type: 'knowledge' }));

        this.queue.push(...productTasks, ...knowledgeTasks);
        await this.processQueue();
        
        this.saveCache();
        console.log('[Scraper] Full scrape complete.');
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        const workers = [];
        for (let i = 0; i < this.maxConcurrent; i++) {
            workers.push(this.worker());
        }

        await Promise.all(workers);
        this.processing = false;
    }

    async worker() {
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            if (!task) continue;

            let attempts = 0;
            let success = false;

            while (attempts <= this.retryLimit && !success) {
                try {
                    console.log(`[Scraper] Processing (${task.type}): ${task.url} (Attempt ${attempts + 1})`);
                    
                    if (task.type === 'product') {
                        await this.scrapeProduct(task.url);
                    } else {
                        await this.scrapeKnowledge(task.url);
                    }
                    
                    success = true;
                } catch (e) {
                    attempts++;
                    console.error(`[Scraper] Failed to scrape ${task.url}:`, e.message);
                    if (attempts <= this.retryLimit) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    }
                }
            }
        }
    }

    async scrapeProduct(url) {
        const normalizedUrl = this.normalizeUrl(url);
        if (!normalizedUrl) return;

        // If it's a JSON endpoint (Shopify)
        if (normalizedUrl.endsWith('.json')) {
            const { data } = await axios.get(normalizedUrl, this.axiosConfig);
            if (data && data.products) {
                data.products.forEach(p => {
                    const price = p.variants?.[0]?.price;
                    const compareAtPrice = p.variants?.[0]?.compare_at_price;
                    const onSale = compareAtPrice && parseFloat(compareAtPrice) > parseFloat(price);
                    
                    console.log(`[Scraper] Found product: ${p.title}`);
                    this.cache.products[p.id] = {
                        id: p.id,
                        title: p.title,
                        price: price,
                        compareAtPrice: compareAtPrice,
                        onSale: !!onSale,
                        description: p.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                        features: typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()) : (Array.isArray(p.tags) ? p.tags : []),
                        link: `${new URL(normalizedUrl).origin}/products/${p.handle}`,
                        image: p.images?.[0]?.src,
                        vendor: p.vendor,
                        productType: p.product_type,
                        lastScraped: Date.now()
                    };
                });
            }
            return;
        }

        const { data: html } = await axios.get(normalizedUrl, this.axiosConfig);
        const $ = cheerio.load(html);
        const productLinks = this.extractProductLinks($, normalizedUrl);

        if (!this.isDirectProductPage(normalizedUrl, $, productLinks)) {
            this.enqueueDiscoveredProducts(productLinks);
            return;
        }

        const product = this.parseProductPage(normalizedUrl, html, $);
        if (!product || !product.title || !product.price) return;
        this.cache.products[product.id] = product;
    }

    async scrapeKnowledge(url) {
        const { data: html } = await axios.get(url, this.axiosConfig);
        const $ = cheerio.load(html);

        // Remove noise
        $('script, style, nav, footer, header, svg, img, noscript').remove();
        
        const content = $('body').text()
            .replace(/\s+/g, ' ')
            .trim();

        this.cache.knowledge[url] = {
            url,
            content,
            lastScraped: Date.now()
        };
    }

    getProducts() {
        return Object.values(this.cache.products);
    }

    getKnowledge() {
        return Object.values(this.cache.knowledge);
    }

    normalizeUrl(rawUrl) {
        try {
            const resolved = new URL(rawUrl, botConfig.company.website_url);
            resolved.hash = '';
            if (resolved.pathname.includes('/product/')) {
                resolved.search = '';
            }
            return resolved.toString();
        } catch (e) {
            return '';
        }
    }

    cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    extractPrice(text) {
        const raw = this.cleanText(text);
        const range = raw.match(/₹\s?([\d,]+(?:\.\d{1,2})?)\s*-\s*₹\s?([\d,]+(?:\.\d{1,2})?)/);
        if (range) return `₹${range[1]}-₹${range[2]}`;
        const single = raw.match(/₹\s?([\d,]+(?:\.\d{1,2})?)/);
        return single ? `₹${single[1]}` : '';
    }

    extractNumericPrice(value) {
        const match = String(value || '').match(/([\d,]+(?:\.\d{1,2})?)/);
        return match ? (parseFloat(match[1].replace(/,/g, '')) || 0) : 0;
    }

    extractStructuredProduct($) {
        const nodes = $('script[type="application/ld+json"]').toArray();
        for (const node of nodes) {
            const raw = $(node).contents().text().trim();
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                    if (!item || typeof item !== 'object') continue;
                    const type = Array.isArray(item['@type']) ? item['@type'].join(',') : String(item['@type'] || '');
                    if (/Product/i.test(type)) {
                        return item;
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    extractProductLinks($, pageUrl) {
        const links = new Set();
        $('a[href]').each((_, el) => {
            const href = String($(el).attr('href') || '').trim();
            if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
            if (!/\/product\//i.test(href)) return;
            const normalized = this.normalizeUrl(new URL(href, pageUrl).toString());
            if (normalized) links.add(normalized);
        });
        return Array.from(links);
    }

    isDirectProductPage(url, $, productLinks) {
        try {
            const pathname = new URL(url).pathname.toLowerCase();
            if (pathname.includes('/product/')) return true;
        } catch (e) {}

        const ogType = String($('meta[property="og:type"]').attr('content') || '').toLowerCase();
        if (ogType.includes('product')) return true;
        if (this.extractStructuredProduct($)) return true;
        if (productLinks.length > 0) return false;
        return false;
    }

    enqueueDiscoveredProducts(links) {
        const tasks = [];
        links.slice(0, 80).forEach((link) => {
            const normalized = this.normalizeUrl(link);
            if (!normalized || this.seenProductUrls.has(normalized)) return;
            this.seenProductUrls.add(normalized);
            tasks.push({ url: normalized, type: 'product' });
        });
        if (tasks.length) {
            this.queue.push(...tasks);
        }
    }

    parseProductPage(url, html, $) {
        const pathname = (() => {
            try {
                return new URL(url).pathname;
            } catch (e) {
                return url;
            }
        })();
        const bodyText = this.cleanText($('body').text());
        const structured = this.extractStructuredProduct($);
        const title = this.cleanText(
            (structured && structured.name) ||
            $('meta[property="og:title"]').attr('content') ||
            $('h1').first().text() ||
            $('title').text().replace(/\s*\|\s*NUTRABAY.*$/i, '')
        );

        const structuredPrice = structured && structured.offers
            ? (Array.isArray(structured.offers) ? structured.offers[0]?.price : structured.offers.price)
            : null;
        const price = structuredPrice ? `₹${String(structuredPrice).replace(/[^\d.]/g, '')}` : this.extractPrice(bodyText);
        const compareAtMatch = bodyText.match(/MRP:\s*₹\s?([\d,]+(?:\.\d{1,2})?)/i);
        const compareAtPrice = compareAtMatch ? `₹${compareAtMatch[1]}` : null;
        const numericPrice = this.extractNumericPrice(price);
        const numericCompare = this.extractNumericPrice(compareAtPrice);
        const image = $('meta[property="og:image"]').attr('content') ||
            (structured && structured.image && (Array.isArray(structured.image) ? structured.image[0] : structured.image)) ||
            '';
        const description = this.cleanText(
            (structured && structured.description) ||
            $('meta[name="description"]').attr('content') ||
            ''
        );

        const features = [];
        $('li').each((_, el) => {
            const text = this.cleanText($(el).text());
            if (!text || text.length < 8 || text.length > 220) return;
            if (/^(home|menu|orders|account|login|register|cart)$/i.test(text)) return;
            if (!features.includes(text)) features.push(text);
        });

        const rating = structured && structured.aggregateRating && structured.aggregateRating.ratingValue
            ? parseFloat(structured.aggregateRating.ratingValue)
            : null;
        const reviewCount = structured && structured.aggregateRating && structured.aggregateRating.reviewCount
            ? parseInt(structured.aggregateRating.reviewCount, 10)
            : null;

        const promotions = [];
        const promotionMatches = bodyText.match(/Free shipping on orders above ₹\s?[\d,]+|Pay on Delivery|14 days return|100%\s*authentic/gi) || [];
        promotionMatches.forEach((value) => {
            const cleaned = this.cleanText(value);
            if (cleaned && !promotions.includes(cleaned)) promotions.push(cleaned);
        });

        if (!title || !price || numericPrice <= 0) return null;

        return {
            id: pathname.replace(/[^\w-]+/g, '_'),
            title,
            name: title,
            price,
            numericPrice,
            compareAtPrice,
            originalPrice: compareAtPrice,
            onSale: numericCompare > numericPrice && numericPrice > 0,
            isOnSale: numericCompare > numericPrice && numericPrice > 0,
            description,
            features: features.slice(0, 12),
            tags: features.slice(0, 12),
            link: url,
            image,
            images: image ? [image] : [],
            vendor: this.cleanText((structured && structured.brand && (structured.brand.name || structured.brand)) || 'Nutrabay'),
            productType: this.cleanText((structured && structured.category) || 'Supplements'),
            category: this.cleanText((structured && structured.category) || 'Supplements'),
            rating: Number.isFinite(rating) ? rating : null,
            reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
            promotions,
            shippingBadges: promotions.slice(),
            colors: [],
            sizes: [],
            lastScraped: Date.now()
        };
    }
}

module.exports = new ScraperService();
